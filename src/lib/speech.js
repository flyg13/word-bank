// Web Speech API wrapper. Both halves are optional in any given browser, so
// every entry point here degrades to a no-op rather than throwing.

import { state } from './store.js';

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognizer = null;
if (SpeechRecognitionCtor) {
  recognizer = new SpeechRecognitionCtor();
  recognizer.continuous = false;
  recognizer.interimResults = false;
}

export const speechRecognitionSupported = Boolean(recognizer);

/**
 * Read text aloud so she can hear the target before attempting it.
 *
 * Tagged with the same language as the recogniser: the whole point is to give
 * her a pronunciation to copy, so it needs to be the one she is being scored
 * against.
 */
export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utteranceFor(text));
  } catch (e) {
    /* speech synthesis is a nicety, never a blocker */
  }
}

function utteranceFor(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = state.speechRate;
  utterance.lang = state.speechLang;
  // A voice chosen on one device may not exist on another, and a stale name
  // must not silence the app: an unmatched name simply leaves the browser's
  // default in place.
  const chosen = voiceNamed(state.speechVoice);
  if (chosen) utterance.voice = chosen;
  return utterance;
}

/** Every voice the browser will admit to, or [] before it has loaded them. */
export function allVoices() {
  if (!('speechSynthesis' in window)) return [];
  try {
    return window.speechSynthesis.getVoices() || [];
  } catch (e) {
    return [];
  }
}

function voiceNamed(name) {
  if (!name) return null;
  return allVoices().find((voice) => voice.name === name) || null;
}

/**
 * The voices worth offering for an accent.
 *
 * Matched on the language tag's first part as well as the whole thing: a
 * device set to en-AU may well have only en-GB and en-US voices installed, and
 * offering nothing would be worse than offering those. Exact matches come
 * first so the right accent is the easy choice.
 */
export function voicesForLang(lang) {
  const tag = String(lang || '').toLowerCase();
  const base = tag.split('-')[0];
  const matches = allVoices().filter((voice) => {
    const voiceTag = String(voice.lang || '').toLowerCase().replace('_', '-');
    return voiceTag === tag || voiceTag.split('-')[0] === base;
  });
  return matches.sort((a, b) => {
    const exact = (v) => (String(v.lang || '').toLowerCase().replace('_', '-') === tag ? 0 : 1);
    return exact(a) - exact(b) || a.name.localeCompare(b.name);
  });
}

/**
 * Whether a voice is one of the better ones iOS downloads on request.
 *
 * By name, because the API says nothing about quality. Apple labels them in
 * the voice name — "Karen (Enhanced)", "Serena (Premium)" — and that label is
 * the only thing there is to go on.
 */
export function isUpgradedVoice(voice) {
  return /\b(enhanced|premium|neural|natural)\b/i.test((voice && voice.name) || '');
}

/**
 * Run a callback when the voice list is ready, and again if it changes.
 *
 * `getVoices()` is empty on the first call in most browsers and fills in
 * asynchronously, so a picker built once on load would be built empty. Safari
 * in particular does not always fire `voiceschanged`, so there is a poll
 * behind it that gives up once voices arrive or after a few seconds.
 */
export function onVoicesReady(callback) {
  if (!('speechSynthesis' in window)) return;
  callback();
  try {
    window.speechSynthesis.addEventListener('voiceschanged', callback);
  } catch (e) {
    /* older browsers: the poll below is the whole mechanism */
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (allVoices().length || tries > 20) {
      clearInterval(timer);
      if (allVoices().length) callback();
    }
  }, 250);
}

// Which read-aloud is current. A later one silences an earlier one's callbacks
// rather than letting two highlights chase each other across the screen.
let readingId = 0;

/**
 * Read a run of words aloud, one utterance per word, saying which word is
 * being spoken as it starts.
 *
 * **One utterance per word, deliberately.** It looks like the wrong shape —
 * one utterance for the whole text would sound more natural — and it is the
 * only version that works on the device she uses. Safari on iPad silently
 * fails to speak a long utterance: a question spoke and a paragraph of her
 * answer did not, which is exactly what the parent reported. Short utterances
 * are the documented way around that.
 *
 * It also buys the highlight for free and buys it *exactly*. The alternative
 * is `SpeechSynthesisUtterance.onboundary`, which WebKit has never fired
 * reliably; here the word being highlighted is the word being spoken, because
 * they are the same utterance. See CLAUDE.md §15.
 *
 * @param {string[]} words in order. Whatever is on screen, so a caller that
 *   shows a multi-word replacement as one token passes it as one word.
 * @param {{onWord?: (index: number) => void, onDone?: () => void}} handlers
 * @returns {{stop: () => void}}
 */
export function readAloud(words, { onWord, onDone } = {}) {
  readingId += 1;
  const mine = readingId;
  const live = () => mine === readingId;
  const stop = () => {
    if (!live()) return;
    readingId += 1;
    try { window.speechSynthesis.cancel(); } catch (e) { /* nothing to cancel */ }
    if (onDone) onDone();
  };

  const list = (words || []).filter((word) => String(word).trim());
  if (!('speechSynthesis' in window) || !list.length) {
    if (onDone) onDone();
    return { stop() {} };
  }

  try {
    window.speechSynthesis.cancel();
    list.forEach((word, index) => {
      const utterance = utteranceFor(word);
      utterance.onstart = () => { if (live() && onWord) onWord(index); };
      // An utterance that failed is not a reason to stop reading the rest, but
      // the last one has to finish the run either way or the highlight would
      // be left sitting on a word nobody is saying.
      const finish = () => {
        if (live() && index === list.length - 1) stop();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    });
  } catch (e) {
    stop();
  }

  return { stop };
}

/**
 * A second recogniser, running alongside the recording, for a rough preview of
 * what she is saying while she says it.
 *
 * Its own instance, not the shared one above: the shared recogniser is the
 * fallback that stands in when the transcription service cannot be reached,
 * and reassigning its handlers from here would break that. Nothing this
 * produces is ever kept — see CLAUDE.md §15.
 *
 * @param {{onText: (text: string) => void}} handlers
 * @returns {{stop: () => void}}
 */
export function listenInterim({ onText }) {
  if (!SpeechRecognitionCtor) return { stop() {} };

  let instance;
  try {
    instance = new SpeechRecognitionCtor();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = state.speechLang;
  } catch (e) {
    return { stop() {} };
  }

  let stopped = false;
  instance.onresult = (e) => {
    if (stopped) return;
    let text = '';
    for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript;
    onText(text.trim());
  };
  // Every failure is silent. This is a preview; a device that will not give a
  // second recogniser should behave exactly as it did before there was one.
  instance.onerror = () => { stopped = true; };

  try {
    instance.start();
  } catch (e) {
    return { stop() {} };
  }

  return {
    stop() {
      stopped = true;
      try { instance.stop(); } catch (e) { /* already stopped */ }
      try { instance.abort(); } catch (e) { /* not all browsers have abort */ }
    }
  };
}

/**
 * Listen for a single utterance.
 *
 * There is one shared recognizer instance, so handlers are reassigned on each
 * call — same as the original, and the reason a listen already in flight is
 * simply restarted rather than queued. The language is applied per call rather
 * than once at construction, so changing it takes effect on the next tap
 * instead of needing a reload.
 *
 * @param {{
 *   onResult: (heard: string) => void,
 *   onError?: (code: string, message: string) => void,
 *   onEnd?: () => void
 * }} handlers
 */
export function listen({ onResult, onError, onEnd }) {
  if (!recognizer) return;

  recognizer.lang = state.speechLang;

  recognizer.onresult = (e) => {
    const heard = e.results[0][0].transcript.trim();
    onResult(heard);
  };
  recognizer.onerror = (e) => {
    // SpeechRecognitionErrorEvent.error is a short code: no-speech,
    // not-allowed, audio-capture, network, aborted, service-not-allowed,
    // language-not-supported. Passed through so the UI can name it.
    if (onError) onError((e && e.error) || 'unknown', (e && e.message) || '');
  };
  recognizer.onend = () => {
    if (onEnd) onEnd();
  };
  try {
    recognizer.start();
  } catch (e) {
    /* start() throws if already listening — harmless */
  }
}

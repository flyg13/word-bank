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
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.lang = state.speechLang;
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    /* speech synthesis is a nicety, never a blocker */
  }
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

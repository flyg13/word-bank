import { SENTENCE_MASTERY } from '../config.js';
import { alignWords, isCleanRead } from '../lib/align.js';
import { toWords, normalize } from '../lib/text.js';
import { wordsMatch } from '../lib/wordbank.js';
import { soundsLikeHerWord } from '../lib/phonicbank.js';
import { isKnownWord } from '../lib/known-words.js';
import { readAloud } from '../lib/speech.js';
import { openFixPanel } from './fix-panel.js';

// Sentences and Reading Passage differ only in where their text and progress
// live, so the read-and-score mechanics live here once.

/** Draw the "clean read" progress dots for a sentence. */
export function renderCleanDots(containerId, cleanCount) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  for (let i = 0; i < SENTENCE_MASTERY; i++) {
    const dot = document.createElement('div');
    dot.className = 'repeat-dot' + (i < cleanCount ? ' filled' : '');
    el.appendChild(dot);
  }
}

/**
 * Draw the target sentence as one span per word, so a word can light up as it
 * is read out. `textContent` still reads as the plain sentence, which is what
 * everything else about this element expects.
 */
export function renderTargetWords(targetId, text) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = '';
  speakableChunks(text).forEach((chunk, i) => {
    if (i) el.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    span.className = 'rtok';
    span.textContent = chunk;
    el.appendChild(span);
  });
}

/**
 * The sentence split for display and for speaking — the same split for both.
 *
 * Whitespace, not `toWords`: `toWords` strips punctuation, and the sentence
 * on screen is the thing she is trying to read, so it keeps its full stops
 * and apostrophes. Using one split for the spans and the utterances is what
 * makes the highlight land on the right word — §15 learned that the hard way
 * when a two-word correction put the highlight one word out from there on.
 */
function speakableChunks(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Read the target out, lighting each word as it is spoken.
 *
 * She substitutes words because she cannot reliably read the sentence off the
 * screen and is holding it in her head — so hearing it, as many times as she
 * wants, before and during the attempt, is the fix. The highlight is the same
 * reading support §15 added for her worksheet: seeing the word light up as
 * she hears it ties the sound to the written word.
 *
 * One utterance per word, for §15's reason: WebKit never fired boundary
 * events reliably, so the only way to light the *exact* word being spoken is
 * to make each word its own utterance. It uses her configured voice and
 * speed, because `readAloud` does.
 *
 * Tapping again stops, rather than starting a second reading over the top.
 */
export function bindSpeaker({ buttonId, targetId, getText }) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  let reading = null;

  const clear = () => {
    const el = document.getElementById(targetId);
    if (el) el.querySelectorAll('.rtok.saying').forEach((s) => s.classList.remove('saying'));
  };
  const finish = () => { reading = null; clear(); button.classList.remove('speaking'); };

  button.addEventListener('click', () => {
    if (reading) { reading.stop(); finish(); return; }
    const words = speakableChunks(getText());
    if (!words.length) return;
    // Drawn fresh: the words lit have to be the words on screen.
    renderTargetWords(targetId, getText());
    const spans = document.getElementById(targetId).querySelectorAll('.rtok');
    button.classList.add('speaking');
    reading = readAloud(words, {
      onWord: (i) => {
        clear();
        if (spans[i]) spans[i].classList.add('saying');
      },
      onDone: finish
    });
  });
}

export function clearReadOutput(outputId) {
  document.getElementById(outputId).innerHTML =
    '<span class="empty-note">Nothing yet.</span>';
}

function makeToken(className, text) {
  const span = document.createElement('span');
  span.className = 'wtok ' + className;
  span.textContent = text;
  return span;
}

/**
 * Score a heard utterance against the expected sentence and render the result.
 *
 * Words are aligned rather than compared position-by-position, so a dropped or
 * inserted word costs exactly one word instead of throwing off everything that
 * follows it. The comparison is bank-aware: a confirmed mispronunciation counts
 * as the word it stands for.
 *
 * A wrong word that sounds like a way she says the expected word is shown in
 * amber rather than red. That is a display annotation only — the alignment
 * itself and `isCleanRead` stay strict, so an approximate match never scores a
 * read as clean. Tapping the word banks the exact text, which is how the
 * precise correction accumulates towards going active.
 *
 * @returns {boolean} whether this was a clean read.
 */
export function renderReadResult(outputId, expectedSentence, heard) {
  const expectedWords = toWords(expectedSentence);
  const heardWords = toWords(heard);
  const ops = alignWords(expectedWords, heardWords, wordsMatch);

  const out = document.getElementById(outputId);
  out.innerHTML = '';
  let slips = 0;

  ops.forEach((op) => {
    let span;
    if (op.type === 'match') {
      span = makeToken('match', op.heard);
      span.dataset.rawKey = normalize(op.heard);
      span.dataset.expected = op.expected;
      span.addEventListener('click', () => openFixPanel(span, true));
    } else if (op.type === 'substitute') {
      const kind = classifySubstitution(op.expected, op.heard);
      span = makeToken(kind, op.heard);
      if (kind === 'close') {
        span.title =
          'Sounds like how she says “' + op.expected + '” — tap to confirm the correction';
      } else if (kind === 'slip') {
        slips += 1;
        span.title =
          '“' + op.heard + '” is a word she can say — this looks like she read “' +
          op.expected + '” as a different word rather than mispronouncing it. ' +
          'Not counted as a mispronunciation. Tap only if it really was one.';
      }
      span.dataset.rawKey = normalize(op.heard);
      span.dataset.expected = op.expected;
      span.addEventListener('click', () => openFixPanel(span, true));
    } else if (op.type === 'extra') {
      // A word with no counterpart in the sentence — often the recognizer
      // splitting one spoken word into two. Still worth being able to bank.
      span = makeToken('extra', op.heard);
      span.dataset.rawKey = normalize(op.heard);
      span.dataset.expected = '';
      span.title = 'Extra word — not in the sentence';
      span.addEventListener('click', () => openFixPanel(span, true));
    } else {
      // Missing: there is no heard text to attach a correction to, so this one
      // is informational only.
      span = makeToken('missing', op.expected);
      span.title = "Not heard — she may have skipped it";
    }
    out.appendChild(span);
    out.appendChild(document.createTextNode(' '));
  });

  return { clean: isCleanRead(ops) && heardWords.length > 0, slips };
}

/**
 * Was a substituted word a mispronunciation, or a different word entirely?
 *
 * Three answers, in order:
 *
 *  - **close** — it matches a sounded-out spelling the parent recorded for
 *    the expected word. This is the strongest signal there is that it was a
 *    mispronunciation, so it wins outright.
 *  - **slip** — the word is one the app knows to be real (her practice list,
 *    the sentences, her passage, her mastered words, what her bank corrects
 *    *to*). She said a word, correctly, that was not the one on the screen:
 *    a memory slip, not a speech error. It is marked differently and is not
 *    treated as a correction to bank.
 *  - **mismatch** — anything else, which is what everything used to be.
 *
 * **Why not a dictionary.** A general word list would call almost every
 * recogniser output a real word, including the real words it produces when it
 * mishears her — "liquor" for "little" is the app's own worked example, and
 * it has to stay a mispronunciation. The app's own vocabulary draws that line
 * in roughly the right place; a dictionary would erase it.
 *
 * **It is a guess, and the parent outranks it.** Nothing here can hear her,
 * so nothing here can know whether a word was well pronounced. A slip stays
 * tappable, so a parent who heard a mispronunciation can still bank it, and
 * the whole attempt can be thrown away with "Didn't mean that".
 */
export function classifySubstitution(expected, heard) {
  if (soundsLikeHerWord(expected, heard)) return 'close';
  return isKnownWord(heard) ? 'slip' : 'mismatch';
}

/**
 * Say that some words looked like memory slips rather than speech errors.
 *
 * Without this the read simply fails to count and nothing says why, which is
 * the same shape of problem §19 found in Voice Lock: a rule the card follows
 * but does not state.
 */
export function appendSlipNote(outputId, slips) {
  const note = document.createElement('div');
  note.className = 'read-note slip';
  note.textContent = slips === 1
    ? '1 word looked like a different word rather than a mispronunciation. ' +
      'It has not been added to her corrections.'
    : slips + ' words looked like different words rather than mispronunciations. ' +
      'They have not been added to her corrections.';
  document.getElementById(outputId).appendChild(note);
}

/**
 * The "Didn't mean that" control: throw the whole attempt away.
 *
 * The parent heard what happened and the app did not. When she recited the
 * sentence from memory and got a word wrong, no amount of classification
 * beats someone who was in the room — so there is a control that makes an
 * attempt score nothing at all, including undoing a clean read it had just
 * been given credit for.
 */
export function appendDiscard(outputId, onDiscard) {
  const row = document.createElement('div');
  row.className = 'discard-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-link discard-attempt';
  button.textContent = 'Didn’t mean that';
  button.title = 'Throw this attempt away — it scores nothing';
  button.addEventListener('click', () => {
    onDiscard();
    const out = document.getElementById(outputId);
    out.innerHTML = '<span class="empty-note">Attempt discarded — nothing was counted.</span>';
  });
  row.appendChild(button);
  document.getElementById(outputId).appendChild(row);
}

/** Append the "✓ Clean read (n/N)" note under a result. */
export function appendCleanNote(outputId, cleanCount) {
  const note = document.createElement('div');
  note.className = 'read-note clean';
  note.textContent =
    '✓ Clean read (' + Math.min(cleanCount, SENTENCE_MASTERY) + '/' + SENTENCE_MASTERY + ')';
  document.getElementById(outputId).appendChild(note);
}

// Phonetic keys for "do these two strings sound alike in English", via Double
// Metaphone (deterministic, no ML).
//
// What this does and does not do is worth being precise about, because it
// shapes how the feature can safely be used.
//
// It DOES absorb transcription variance. The recognizer hearing the same sound
// three times can emit "yo yo", "ye oh" and "yeyo" — all three key to "A", so
// they are recognisably the same utterance. That is the problem this feature
// exists to solve: a mispronunciation that never accumulates confirmations
// because it is transcribed differently every time.
//
// It does NOT model her articulation. Double Metaphone maps English spelling to
// sound; it has no idea that she says "wed" for "red" (RT vs AT) or "fink" for
// "think" (0NK vs FNK). The parent types how the word SOUNDS coming out of her
// mouth; Double Metaphone then absorbs however the recognizer chooses to spell
// that sound.
//
// It over-matches, badly, on short keys. Across the 355-word practice list
// there are 70 colliding key groups — "AT" alone covers it/at/what/out/eat/
// eight/idea/wait/white, and the single-character "A" covers you/we/way/who as
// well as the bare words a, i, oh and e. This is why nothing here is ever
// applied globally: every match is scoped to one expected word, and a phonetic
// hit is a suggestion for the parent to confirm, never a silent correction.

import { doubleMetaphone } from 'double-metaphone';

// Below this length a key collides with too much ordinary speech to be a
// trustworthy signal on its own. Such keys still match — they are just flagged
// in the UI so the parent knows the spelling they typed is a blunt instrument.
const WEAK_KEY_LENGTH = 2;

/**
 * Double Metaphone keys for a word or phrase, primary and secondary, deduped.
 * Spacing does not matter: "ye low", "yelow" and "yellow" all key alike.
 *
 * @returns {string[]} empty when there is nothing pronounceable in the input
 */
export function phoneticKeys(text) {
  const cleaned = (text || '')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const [primary, secondary] = doubleMetaphone(cleaned);
  return [...new Set([primary, secondary].filter(Boolean))];
}

/**
 * Whether two strings sound alike.
 *
 * Requires an exact key match, never a near one — the confidence buffer the
 * plan asks for. Primary and secondary keys cross-match, which is what catches
 * alternate pronunciations of the same spelling ("that" keys 0T/TT, "dat" keys
 * TT, so they meet on the secondary).
 */
export function soundsAlike(a, b) {
  const left = phoneticKeys(a);
  if (!left.length) return false;
  const right = phoneticKeys(b);
  if (!right.length) return false;
  return left.some((key) => right.includes(key));
}

/** True when a key is short enough to collide with common words. */
export function isWeakKey(key) {
  return key.length > 0 && key.length < WEAK_KEY_LENGTH;
}

/** True when everything a spelling keys to is collision-prone. */
export function isWeakSpelling(spelling) {
  const keys = phoneticKeys(spelling);
  return keys.length > 0 && keys.every(isWeakKey);
}

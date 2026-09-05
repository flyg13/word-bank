// How she says her words — the parent's own record of a pronunciation,
// entered proactively rather than waiting for the recognizer to happen to
// produce something correctable.
//
// Stored under its own Firestore field (`phonic_bank`), keyed by the word it
// describes. The existing `word_bank` — keyed by heard text — is untouched.
//
// Two fields rather than one, because the two halves answer different
// questions and are keyed differently:
//
//   word_bank    "the recognizer emitted this text; it means X"   (heard -> word)
//   phonic_bank  "X is the word she pronounces like this"         (word -> sounds)
//
// The plan's entry sketch put heardExamples and phonicSpelling on one object.
// That is the same logical model: an entry's heard examples are exactly the
// word_bank keys pointing at it. Splitting it keeps a schema with real synced
// data in it from needing a migration.

import { normalize } from './text.js';
import { phoneticKeys, soundsAlike, isWeakSpelling } from './phonetics.js';
import { wordsMatch, getBankEntry } from './wordbank.js';
import { state } from './store.js';

/**
 * @typedef {Object} PhonicEntry
 * @property {string} word        as the parent typed it, for display
 * @property {string[]} spellings how she says it, sounded out
 * @property {string[]} keys      derived Double Metaphone keys, stored so the
 *                                document is inspectable; matching always
 *                                recomputes from `spellings`, so a stale key
 *                                can never change behaviour
 * @property {string} added       ISO timestamp
 */

/**
 * Read one entry, tolerating a malformed one. This field is only ever written
 * by this app, but a partial sync or a hand-edit in the Firestore console
 * shouldn't be able to take out the whole Word Bank tab.
 *
 * @returns {PhonicEntry|null}
 */
export function getPhonicEntry(word) {
  return normalizeEntry(state.phonicBank[normalize(word)]);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const spellings = Array.isArray(entry.spellings)
    ? entry.spellings.filter((s) => typeof s === 'string' && s.trim())
    : [];
  if (!spellings.length || typeof entry.word !== 'string' || !entry.word) return null;
  return {
    word: entry.word,
    spellings,
    keys: Array.isArray(entry.keys) ? entry.keys : keysFor(spellings),
    added: typeof entry.added === 'string' ? entry.added : ''
  };
}

/** Every usable entry, as [key, entry] pairs sorted by word. */
export function phonicEntries() {
  return Object.entries(state.phonicBank)
    .map(([key, entry]) => [key, normalizeEntry(entry)])
    .filter(([, entry]) => entry !== null)
    .sort((a, b) => a[1].word.localeCompare(b[1].word));
}

function keysFor(spellings) {
  return [...new Set(spellings.flatMap(phoneticKeys))];
}

/**
 * Record another way she says a word. Adding a spelling that is already there
 * is a no-op rather than a duplicate.
 *
 * @returns {boolean} whether anything changed
 */
export function addSpelling(word, spelling) {
  const key = normalize(word);
  const cleaned = spelling.trim();
  if (!key || !cleaned) return false;
  if (!phoneticKeys(cleaned).length) return false; // nothing pronounceable

  const existing = getPhonicEntry(word);
  const spellings = existing ? existing.spellings.slice() : [];
  if (spellings.some((s) => s.toLowerCase() === cleaned.toLowerCase())) return false;
  spellings.push(cleaned);

  state.phonicBank[key] = {
    word: existing ? existing.word : word.trim(),
    spellings,
    keys: keysFor(spellings),
    added: existing ? existing.added : new Date().toISOString()
  };
  return true;
}

/** Drop one spelling; drops the whole entry when it was the last one. */
export function removeSpelling(word, spelling) {
  const key = normalize(word);
  const entry = getPhonicEntry(word);
  if (!entry) return false;
  const spellings = entry.spellings.filter((s) => s !== spelling);
  if (spellings.length === entry.spellings.length) return false;
  if (spellings.length === 0) {
    delete state.phonicBank[key];
  } else {
    state.phonicBank[key] = { ...entry, spellings, keys: keysFor(spellings) };
  }
  return true;
}

export function removePhonicEntry(word) {
  const key = normalize(word);
  if (!state.phonicBank[key]) return false;
  delete state.phonicBank[key];
  return true;
}

/**
 * Does `heardText` sound like one of the ways she says `expectedWord`?
 *
 * Deliberately scoped to a single expected word. There is no "which of her
 * words does this sound like" search anywhere in the app: Double Metaphone
 * collides far too much for that to be safe (see src/lib/phonetics.js). Asking
 * only "does this sound like how she says the word I already asked her for"
 * keeps the collision surface to one entry.
 */
export function soundsLikeHerWord(expectedWord, heardText) {
  const entry = getPhonicEntry(expectedWord);
  if (!entry || !heardText) return false;
  return entry.spellings.some((spelling) => soundsAlike(spelling, heardText));
}

/**
 * Every word she has either a recorded pronunciation or a correction for.
 *
 * Includes pending corrections as well as active ones: a correction that has
 * been seen once but not confirmed is precisely a word still needing work.
 * Words here need not be in the built-in practice list — a correction for a
 * word from her homework is exactly the kind of thing worth drilling.
 *
 * @returns {string[]} display forms, deduped by normalised key
 */
export function focusWords() {
  const seen = new Map();
  const remember = (word) => {
    const key = normalize(word);
    if (key && !seen.has(key)) seen.set(key, word);
  };

  phonicEntries().forEach(([, entry]) => remember(entry.word));
  Object.keys(state.wordBank).forEach((heard) => {
    const entry = getBankEntry(heard);
    if (entry) remember(entry.correct);
  });

  return [...seen.values()];
}

/**
 * What a loose word in Speech-To-Text probably was, or null.
 *
 * Speech-To-Text has no expected word to scope against, which is why phonetics is
 * kept out of the matching there entirely. This is the one narrow exception,
 * and it is a suggestion the parent taps to accept — never applied on its own:
 *
 *  - Spellings flagged as loose are excluded. A key like "A" collides with
 *    ordinary speech, and unscoped it would underline half a sentence.
 *  - If two different words match, nothing is suggested. Picking one silently
 *    would be a guess presented as knowledge.
 *
 * @returns {string|null} the word it probably was
 */
export function suggestFromSound(heardWord) {
  const key = normalize(heardWord);
  if (!key) return null;

  const matches = new Map();
  phonicEntries().forEach(([, entry]) => {
    if (normalize(entry.word) === key) return; // already that word
    const trustworthy = entry.spellings.filter((s) => !isWeakSpelling(s));
    if (trustworthy.some((spelling) => soundsAlike(spelling, heardWord))) {
      matches.set(normalize(entry.word), entry.word);
    }
  });

  return matches.size === 1 ? [...matches.values()][0] : null;
}

/**
 * Is this recognizer output already understood as `word`?
 *
 * True when it is the word itself, when a confirmed correction maps it there,
 * or when a recorded pronunciation already covers it. The one gate for "is
 * there anything left to record here" — used by Practice's "Teach how she says
 * it" and by the mic in Word Bank, so the two cannot drift apart.
 */
export function alreadyRecognised(word, heard) {
  if (!word || !heard) return false;
  return wordsMatch(word, heard) || soundsLikeHerWord(word, heard);
}


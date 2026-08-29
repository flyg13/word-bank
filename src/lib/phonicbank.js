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
import { phoneticKeys, soundsAlike } from './phonetics.js';
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


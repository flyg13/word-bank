import { MASTERY_THRESHOLD } from '../config.js';
import { normalize } from './text.js';
import { state } from './store.js';

// A freshly banked correction starts PENDING — seen once, not yet trusted.
// It only becomes ACTIVE (auto-applied everywhere) once the same heard→correct
// pairing shows up a second time, whether that's a retry in Practice or a
// matching correction made in Sentences/Reading/Speech-To-Text. This stops a single
// noisy mishearing from silently rewriting every future correct instance of a
// common word.
const ACTIVATION_THRESHOLD = 2;

/**
 * Read one bank entry, normalising the legacy shape on the way out.
 * Entries written by the original single-file app were bare strings; those
 * predate the pending/active flow and stay trusted.
 *
 * @returns {{correct:string,count:number,active:boolean}|null}
 */
export function getBankEntry(key) {
  const value = state.wordBank[key];
  if (!value) return null;
  if (typeof value === 'string') {
    return { correct: value, count: MASTERY_THRESHOLD, active: true };
  }
  return value;
}

/**
 * Record that `key` was heard where `target` was meant. Repeating the same
 * pairing promotes the entry to active; a different target resets it.
 */
export function recordBankObservation(key, target) {
  const existing = getBankEntry(key);
  if (existing && normalize(existing.correct) === normalize(target)) {
    const count = (existing.count || 1) + 1;
    state.wordBank[key] = {
      correct: target,
      count,
      active: existing.active || count >= ACTIVATION_THRESHOLD
    };
  } else {
    state.wordBank[key] = { correct: target, count: 1, active: false };
  }
}

/** Apply an active correction to a single word, if one exists. */
export function applyBankToWord(word) {
  const entry = getBankEntry(normalize(word));
  return entry && entry.active ? entry.correct : word;
}

/**
 * Word comparison that knows her bank: a heard word counts as the expected one
 * when it is either literally that word or a confirmed way she says it.
 */
export function wordsMatch(expectedWord, heardWord) {
  if (!heardWord) return false;
  return normalize(applyBankToWord(heardWord)) === normalize(expectedWord);
}

/**
 * Tokenise text into display parts, applying active corrections.
 * Whitespace is preserved as its own part so the original spacing survives.
 */
export function applyBankToText(text) {
  return text.split(/(\s+)/).map((token) => {
    const key = normalize(token);
    const entry = getBankEntry(key);
    if (key && entry && entry.active) {
      return { raw: token, display: entry.correct, fixed: true, key };
    }
    return { raw: token, display: token, fixed: false, key };
  });
}

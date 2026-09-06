// Vocabulary hints for the transcription provider.
//
// The provider's prompt field biases the decoder toward spellings it contains.
// Her bank is exactly the right thing to put there: it is a list of the words
// this child, on this device, actually works on — "yellow" and "there" rather
// than a general English prior.
//
// Two sources, both already in state:
//   active corrections   the correct word an entry resolves to
//   pronunciations       the word each phonic entry describes
//
// Deliberately NOT included: the heard text of a correction, and the sounded-
// out spellings. Those are not words — priming the decoder with "yeyo" invites
// it to emit "yeyo", and the whole point is that it should emit a real word
// which the bank then maps back.

import { VOCAB_HINT_LIMIT } from '../config.js';
import { state } from './store.js';
import { getBankEntry } from './wordbank.js';
import { phonicEntries } from './phonicbank.js';
import { normalize } from './text.js';

/**
 * Build the hint list.
 *
 * @param {string} [expected] the word or line she is being asked for. Always
 *   goes first, so the word that matters most survives the cap.
 * @returns {string[]}
 */
export function vocabularyHints(expected) {
  const out = [];
  const seen = new Set();

  const add = (word) => {
    const value = typeof word === 'string' ? word.trim() : '';
    if (!value) return;
    const key = normalize(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  // The expected text first — a sentence contributes each of its words.
  String(expected || '').split(/\s+/).forEach(add);

  phonicEntries().forEach(([, entry]) => add(entry.word));

  Object.keys(state.wordBank).forEach((key) => {
    const entry = getBankEntry(key);
    if (entry && entry.active) add(entry.correct);
  });

  return out.slice(0, VOCAB_HINT_LIMIT);
}

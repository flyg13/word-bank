// Words the app already knows are real words.
//
// This exists for one judgement, in reading-engine.js: when she says a word
// that is not the target, was it a *mispronunciation* of the target or a
// different word said perfectly well? "Likes" for "loves" is the second kind
// — a memory slip, not a speech error — and scoring it as a mispronunciation
// teaches the bank something untrue about her speech. See CLAUDE.md §20.
//
// **What this can and cannot do.** It cannot hear her, so it cannot know
// whether a word was pronounced correctly; it can only say whether the word
// the recogniser produced is one that exists in her world. That is a real
// limitation and the reason the parent also gets an explicit "didn't mean
// that" control — a human who heard it is the only reliable judge.
//
// Deliberately not a dictionary. A general word list would call almost
// everything a real word, including the real words the recogniser produces
// when it mishears her ("liquor" for "little") — which is exactly the case
// that must stay a mispronunciation. The vocabulary here is the app's own:
// her practice list, the sentences and passage she is reading, the words she
// has already mastered, and the words her bank is about. A word outside all
// of that falls through to the behaviour that was there before.

import { PRACTICE_WORDS } from '../data/practice-words.js';
import { SENTENCES } from '../data/sentences.js';
import { state } from './store.js';
import { normalize, toWords } from './text.js';
import { getBankEntry } from './wordbank.js';

let builtIn = null;

/** The fixed half: the practice list and the sentence corpus. Built once. */
function builtInWords() {
  if (builtIn) return builtIn;
  builtIn = new Set();
  PRACTICE_WORDS.forEach((word) => builtIn.add(normalize(word)));
  SENTENCES.forEach((sentence) => {
    toWords(sentence).forEach((word) => builtIn.add(normalize(word)));
  });
  builtIn.delete('');
  return builtIn;
}

/**
 * Is this a word the app knows to be a real one?
 *
 * The moving half — her passage, her mastered words, her bank — is read live
 * rather than cached, because all three change while she is using the app.
 */
export function isKnownWord(word) {
  const key = normalize(word);
  if (!key) return false;
  if (builtInWords().has(key)) return true;

  if ((state.verifiedWords || []).some((w) => normalize(w) === key)) return true;

  // The passage she is reading now: its own words are plainly real words.
  if ((state.readingSentences || []).some((line) =>
    toWords(line).some((w) => normalize(w) === key))) return true;

  // A word her bank corrects *to* is a real word. A word it corrects *from*
  // is the opposite — that is the misheard text, and treating it as real
  // would turn every known mispronunciation into a memory slip.
  const bank = state.wordBank || {};
  return Object.keys(bank).some((raw) => {
    const entry = getBankEntry(raw);
    return entry && normalize(entry.correct) === key;
  });
}

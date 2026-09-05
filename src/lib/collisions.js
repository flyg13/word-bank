// Which real words a phonic spelling cannot be told apart from.
//
// The warning this feeds used to describe one hardcoded example, which was
// wrong for every entry except that example. What the parent needs is the
// actual list for the spelling in front of them.

import { PRACTICE_WORDS } from '../data/practice-words.js';
import { phoneticKeys } from './phonetics.js';
import { normalize } from './text.js';

// The practice list is the app's own vocabulary, so collisions inside it are
// the ones that bite. But it deliberately excludes homophones and bare vowel
// sounds (see CLAUDE.md §2) — and those are exactly what a recognizer emits
// when an utterance is unclear, so they have to be in the corpus even though
// she never practises them.
const COMMON_ECHOES = [
  // Vowel sounds and interjections, the usual output for a garbled attempt.
  'a', 'I', 'oh', 'ah', 'eh', 'uh', 'um', 'er', 'ooh', 'aw', 'hey',
  // Homophones and near-homophones pulled from the practice list.
  'to', 'too', 'two', 'of', 'off', 'see', 'sea', 'be', 'bee', 'buy', 'bye',
  'no', 'know', 'new', 'knew', 'one', 'won', 'for', 'four', 'your', 'you’re',
  'there', 'their', 'here', 'hear', 'right', 'write', 'son', 'sun', 'our',
  'hour', 'blue', 'blew', 'would', 'wood', 'so', 'sew', 'week', 'weak'
];

let index = null;

function keyIndex() {
  if (index) return index;
  index = new Map();
  const seen = new Set();
  [...PRACTICE_WORDS, ...COMMON_ECHOES].forEach((word) => {
    const key = normalize(word);
    if (!key || seen.has(key)) return;
    seen.add(key);
    phoneticKeys(word).forEach((phonetic) => {
      if (!index.has(phonetic)) index.set(phonetic, []);
      index.get(phonetic).push(word);
    });
  });
  return index;
}

/**
 * Real words that key the same as `spelling`, so the matcher cannot tell them
 * apart from it. The spelling itself is excluded.
 *
 * @param {string} spelling
 * @param {number} [limit] most-useful few, not the exhaustive set
 * @returns {string[]}
 */
export function collidingWords(spelling, limit = 4) {
  const keys = phoneticKeys(spelling);
  if (!keys.length) return [];

  const self = normalize(spelling);
  const out = [];
  const seen = new Set([self]);

  keys.forEach((key) => {
    (keyIndex().get(key) || []).forEach((word) => {
      const id = normalize(word);
      if (seen.has(id)) return;
      seen.add(id);
      out.push(word);
    });
  });

  // Shortest first: the short common words are the ones that actually get
  // emitted for an unclear utterance.
  out.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return out.slice(0, limit);
}

/** "by, be, bee and buy" */
export function listSentence(words) {
  if (words.length <= 1) return words.join('');
  return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
}

/**
 * Why a spelling is a blunt instrument, naming the actual words it cannot be
 * told apart from.
 *
 * Double Metaphone drops vowels, so a spelling that is mostly vowels produces a
 * key barely a character long, and a key that short collides with a great deal
 * of ordinary speech. There is nothing to fix in that case beyond adding a
 * consonant if she actually makes one, so this says so rather than pretending
 * a better spelling always exists.
 *
 * @returns {{heading: string, body: string}}
 */
export function describeWeakSpelling(spelling) {
  const others = collidingWords(spelling);
  const collides = others.length
    ? 'the matcher hears it the same as ' + listSentence(others) + '.'
    : 'there is very little in it for the matcher to go on.';
  return {
    heading: '\u201c' + spelling + '\u201d matches loosely.',
    body:
      'This spelling is mostly vowels, so ' +
      collides +
      ' If she makes a consonant sound in there, include it. If not, this one ' +
      'will need confirming each time it fires \u2014 that\u2019s expected.'
  };
}

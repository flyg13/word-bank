// Sequence alignment between what she was asked to read and what the
// recognizer heard.
//
// The previous implementation compared heardWords[i] against expectedWords[i].
// One dropped word — or a recognizer that split "a lot" into two tokens or
// merged two words into one — shifted everything after it, so a read that was
// almost perfect scored as almost entirely wrong. That mattered less when
// sentences were a supplement; now that sentence work is the primary way the
// bank gets built, a false wall of red is actively misleading.
//
// This replaces positional indexing with a Levenshtein alignment over words,
// so a dropped word costs exactly one word.

import { characterSimilarity } from './similarity.js';

// Costs are scaled integers so the backtrace below can compare with === and
// never trip over floating-point drift.
const GAP_COST = 10; // a word dropped, or a word inserted
const SUBSTITUTION_COST = 10; // one word said in place of another
// A substitution normally costs the same as a gap, which leaves ambiguous reads
// tied — "the cat sat on the mat" read as "the cot on a the mat" scores the
// same whether you call it three wrong words or one wrong word plus a dropped
// one plus an inserted one. The second reading is the truthful one, so pairing
// two words that bear no resemblance to each other costs a little extra. Words
// that do resemble each other still pair up, which is the common case: a
// genuine mispronunciation sounds like the word it replaced.
const DISSIMILAR_PENALTY = 1;
const SIMILARITY_FLOOR = 0.5;

function substitutionCost(expectedWord, heardWord, similarity) {
  const resemblance = similarity(expectedWord, heardWord);
  return SUBSTITUTION_COST + (resemblance >= SIMILARITY_FLOOR ? 0 : DISSIMILAR_PENALTY);
}

/**
 * @typedef {Object} AlignOp
 * @property {'match'|'substitute'|'missing'|'extra'} type
 *   match      — heard word satisfies the expected word
 *   substitute — a different word was heard in this slot
 *   missing    — an expected word she didn't say (or wasn't picked up)
 *   extra      — a heard word with no expected counterpart
 * @property {string|null} expected      the expected word ('missing'/'substitute'/'match')
 * @property {string|null} heard         the heard word ('extra'/'substitute'/'match')
 * @property {number} expectedIndex      index into `expected`, or -1
 * @property {number} heardIndex         index into `heard`, or -1
 */

/**
 * Align two word sequences.
 *
 * @param {string[]} expected
 * @param {string[]} heard
 * @param {(expectedWord: string, heardWord: string) => boolean} [isEqual]
 *   Word equality. Pass a bank-aware comparator so a known mispronunciation
 *   counts as a match rather than dragging the alignment out of step.
 * @param {(a: string, b: string) => number} [similarity]
 *   How much two unequal words resemble each other, 0-1. Only affects which of
 *   two equally-priced alignments is chosen, never whether a word matched.
 * @returns {AlignOp[]} ops in reading order.
 */
export function alignWords(
  expected,
  heard,
  isEqual = (a, b) => a === b,
  similarity = characterSimilarity
) {
  const n = expected.length;
  const m = heard.length;

  // cost[i][j] = cheapest alignment of expected[0..i) with heard[0..j).
  // All costs are integers, so the backtrace below can compare with ===.
  const cost = [];
  for (let i = 0; i <= n; i++) {
    cost.push(new Array(m + 1).fill(0));
    cost[i][0] = i * GAP_COST;
  }
  for (let j = 0; j <= m; j++) cost[0][j] = j * GAP_COST;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = isEqual(expected[i - 1], heard[j - 1]);
      const diagonal =
        cost[i - 1][j - 1] +
        (same ? 0 : substitutionCost(expected[i - 1], heard[j - 1], similarity));
      const skipExpected = cost[i - 1][j] + GAP_COST;
      const skipHeard = cost[i][j - 1] + GAP_COST;
      cost[i][j] = Math.min(diagonal, skipExpected, skipHeard);
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = isEqual(expected[i - 1], heard[j - 1]);
      const diagonal =
        cost[i - 1][j - 1] +
        (same ? 0 : substitutionCost(expected[i - 1], heard[j - 1], similarity));
      // Diagonal first: on a tie, prefer pairing words up over calling one
      // dropped and the next one extra.
      if (cost[i][j] === diagonal) {
        ops.push({
          type: same ? 'match' : 'substitute',
          expected: expected[i - 1],
          heard: heard[j - 1],
          expectedIndex: i - 1,
          heardIndex: j - 1
        });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && cost[i][j] === cost[i - 1][j] + GAP_COST) {
      ops.push({
        type: 'missing',
        expected: expected[i - 1],
        heard: null,
        expectedIndex: i - 1,
        heardIndex: -1
      });
      i--;
      continue;
    }
    ops.push({
      type: 'extra',
      expected: null,
      heard: heard[j - 1],
      expectedIndex: -1,
      heardIndex: j - 1
    });
    j--;
  }

  ops.reverse();
  return ops;
}

/** True when every expected word was heard and nothing extra crept in. */
export function isCleanRead(ops) {
  return ops.length > 0 && ops.every((op) => op.type === 'match');
}

import { describe, it, expect, beforeEach } from 'vitest';
import { alignWords, isCleanRead } from '../lib/align.js';
import { toWords, normalize } from '../lib/text.js';
import { state } from '../lib/store.js';
import { wordsMatch, recordBankObservation, getBankEntry } from '../lib/wordbank.js';

const loose = (a, b) => normalize(a) === normalize(b);
const align = (expected, heard) => alignWords(toWords(expected), toWords(heard), loose);
const types = (ops) => ops.map((op) => op.type);

describe('alignWords', () => {
  it('matches an identical read word for word', () => {
    const ops = align('The cat sat on the mat.', 'the cat sat on the mat');
    expect(types(ops)).toEqual(['match', 'match', 'match', 'match', 'match', 'match']);
    expect(isCleanRead(ops)).toBe(true);
  });

  it('charges a dropped word exactly one word — the rest still line up', () => {
    // The bug this replaces: positional indexing shifted every word after
    // "sat", so five correct words scored as wrong.
    const ops = align('The cat sat on the mat.', 'the cat on the mat');
    expect(types(ops)).toEqual(['match', 'match', 'missing', 'match', 'match', 'match']);
    expect(ops[2].expected).toBe('sat');
    expect(isCleanRead(ops)).toBe(false);
  });

  it('charges an inserted word exactly one word', () => {
    const ops = align('there are two ducks', 'there are two big ducks');
    expect(types(ops)).toEqual(['match', 'match', 'match', 'extra', 'match']);
    expect(ops[3].heard).toBe('big');
  });

  it('reports a genuinely wrong word as a substitution in place', () => {
    const ops = align('the cat sat', 'the dog sat');
    expect(types(ops)).toEqual(['match', 'substitute', 'match']);
    expect(ops[1]).toMatchObject({ expected: 'cat', heard: 'dog' });
  });

  it('handles a word the recognizer split into two', () => {
    const ops = align('I see a yellow bird', 'I see a ye oh bird');
    // "yellow" pairs with one of the halves; the other is extra. Either way the
    // words around it stay matched.
    expect(types(ops).filter((t) => t === 'match')).toHaveLength(4);
    expect(types(ops)).toContain('extra');
  });

  it('handles two words the recognizer merged into one', () => {
    const ops = align('we go to the park', 'we goto the park');
    expect(types(ops).filter((t) => t === 'match')).toHaveLength(3);
    expect(types(ops)).toContain('missing');
  });

  it('marks every expected word missing when nothing was heard', () => {
    const ops = align('the cat sat', '');
    expect(types(ops)).toEqual(['missing', 'missing', 'missing']);
    expect(isCleanRead(ops)).toBe(false);
  });

  it('marks every heard word extra when nothing was expected', () => {
    const ops = align('', 'the cat sat');
    expect(types(ops)).toEqual(['extra', 'extra', 'extra']);
  });

  it('is empty, and not a clean read, when both sides are empty', () => {
    const ops = align('', '');
    expect(ops).toEqual([]);
    expect(isCleanRead(ops)).toBe(false);
  });

  it('ignores punctuation and casing differences', () => {
    const ops = align('Please put your shoes on.', 'please put your shoes on');
    expect(isCleanRead(ops)).toBe(true);
  });

  it('keeps ops in reading order with indices pointing back at the inputs', () => {
    const expected = toWords('the cat sat on the mat');
    const heard = toWords('the cat on the mat');
    const ops = alignWords(expected, heard, loose);
    ops.forEach((op) => {
      if (op.expectedIndex >= 0) expect(expected[op.expectedIndex]).toBe(op.expected);
      if (op.heardIndex >= 0) expect(heard[op.heardIndex]).toBe(op.heard);
    });
    const heardIndices = ops.filter((o) => o.heardIndex >= 0).map((o) => o.heardIndex);
    expect(heardIndices).toEqual([...heardIndices].sort((a, b) => a - b));
  });

  it('uses the supplied comparator, so a banked mispronunciation counts as a match', () => {
    const bankAware = (expected, heard) =>
      normalize(expected) === normalize(heard) || (expected === 'yellow' && heard === 'yeyo');
    const ops = alignWords(toWords('a yellow bird'), toWords('a yeyo bird'), bankAware);
    expect(isCleanRead(ops)).toBe(true);
  });
});

describe('alignWords tie-breaking', () => {
  it('prefers "dropped a word" over a chain of unrelated substitutions', () => {
    // Equal-cost under plain Levenshtein; the similarity-weighted substitution
    // cost picks the reading that actually explains what happened.
    const ops = align('The cat sat on the mat.', 'the cot on a the mat');
    expect(types(ops)).toEqual(['match', 'substitute', 'missing', 'match', 'extra', 'match', 'match']);
    expect(ops[1]).toMatchObject({ expected: 'cat', heard: 'cot' });
    expect(ops[2].expected).toBe('sat');
    expect(ops[4].heard).toBe('a');
  });

  it('still pairs a plainly wrong word in place rather than splitting it', () => {
    const ops = align('the cat sat', 'the dog sat');
    expect(types(ops)).toEqual(['match', 'substitute', 'match']);
  });

  it('pairs a near-miss mispronunciation with the word it replaced', () => {
    const ops = align('she has a red hat', 'she has a wed hat');
    expect(types(ops)).toEqual(['match', 'match', 'match', 'substitute', 'match']);
    expect(ops[3]).toMatchObject({ expected: 'red', heard: 'wed' });
  });
});

// The aligner takes a comparator, and the app passes the bank-aware one. These
// pin the trust boundary: a correction that has NOT been confirmed twice must
// not make a read score as correct, in alignment or anywhere else. §3's
// phonetic matching must keep this property.
describe('alignment only trusts confirmed (active) corrections', () => {
  const alignWithBank = (expected, heard) =>
    alignWords(toWords(expected), toWords(heard), wordsMatch);

  beforeEach(() => {
    state.wordBank = {};
  });

  it('does not treat a pending correction as a match', () => {
    recordBankObservation('yeyo', 'yellow'); // seen once -> pending
    expect(getBankEntry('yeyo').active).toBe(false);

    const ops = alignWithBank('a yellow bird', 'a yeyo bird');
    expect(types(ops)).toEqual(['match', 'substitute', 'match']);
    expect(isCleanRead(ops)).toBe(false);
  });

  it('treats it as a match only after the second confirmation', () => {
    recordBankObservation('yeyo', 'yellow');
    recordBankObservation('yeyo', 'yellow'); // -> active
    expect(getBankEntry('yeyo').active).toBe(true);

    const ops = alignWithBank('a yellow bird', 'a yeyo bird');
    expect(types(ops)).toEqual(['match', 'match', 'match']);
    expect(isCleanRead(ops)).toBe(true);
  });

  it('stops trusting a correction that was reassigned and went pending again', () => {
    recordBankObservation('yeyo', 'yellow');
    recordBankObservation('yeyo', 'yellow');
    expect(isCleanRead(alignWithBank('a yellow bird', 'a yeyo bird'))).toBe(true);

    recordBankObservation('yeyo', 'yolk'); // reassigned -> pending again
    expect(isCleanRead(alignWithBank('a yellow bird', 'a yeyo bird'))).toBe(false);
    expect(isCleanRead(alignWithBank('a yolk bird', 'a yeyo bird'))).toBe(false);
  });

  it('does not let a pending correction sway the tie-break either', () => {
    // The similarity used for tie-breaking is purely orthographic and never
    // consults the bank, so a pending entry cannot change how words pair up.
    const before = types(alignWithBank('the cat sat on the mat', 'the cot on a the mat'));
    recordBankObservation('cot', 'sat');
    recordBankObservation('on', 'cat');
    const after = types(alignWithBank('the cat sat on the mat', 'the cot on a the mat'));
    expect(after).toEqual(before);
  });

  it('keeps trusting a legacy bare-string entry, as the original app did', () => {
    // Entries written before the pending/active flow existed have no count and
    // were always applied. Changing that would silently drop real corrections.
    state.wordBank.yeyo = 'yellow';
    expect(isCleanRead(alignWithBank('a yellow bird', 'a yeyo bird'))).toBe(true);
  });
});

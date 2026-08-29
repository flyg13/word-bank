import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../lib/store.js';
import {
  getBankEntry,
  recordBankObservation,
  applyBankToWord,
  applyBankToText,
  wordsMatch
} from '../lib/wordbank.js';

beforeEach(() => {
  state.wordBank = {};
});

describe('getBankEntry', () => {
  it('returns null for an unknown key', () => {
    expect(getBankEntry('nope')).toBeNull();
  });

  it('treats a legacy bare-string entry as already trusted', () => {
    state.wordBank.yoyo = 'yellow';
    expect(getBankEntry('yoyo')).toMatchObject({ correct: 'yellow', active: true });
  });
});

describe('recordBankObservation', () => {
  it('starts a new correction pending, not active', () => {
    recordBankObservation('yoyo', 'yellow');
    expect(getBankEntry('yoyo')).toMatchObject({ correct: 'yellow', count: 1, active: false });
  });

  it('activates on the second matching observation', () => {
    recordBankObservation('yoyo', 'yellow');
    recordBankObservation('yoyo', 'yellow');
    expect(getBankEntry('yoyo')).toMatchObject({ correct: 'yellow', count: 2, active: true });
  });

  it('ignores casing when deciding whether an observation repeats', () => {
    recordBankObservation('yoyo', 'yellow');
    recordBankObservation('yoyo', 'Yellow');
    expect(getBankEntry('yoyo').active).toBe(true);
  });

  it('resets to pending when the same sound is reassigned to a different word', () => {
    recordBankObservation('yoyo', 'yellow');
    recordBankObservation('yoyo', 'yellow');
    recordBankObservation('yoyo', 'yolk');
    expect(getBankEntry('yoyo')).toMatchObject({ correct: 'yolk', count: 1, active: false });
  });
});

describe('applying the bank', () => {
  it('leaves a word alone while its correction is still pending', () => {
    recordBankObservation('yoyo', 'yellow');
    expect(applyBankToWord('yoyo')).toBe('yoyo');
    expect(wordsMatch('yellow', 'yoyo')).toBe(false);
  });

  it('applies the correction once it is active', () => {
    recordBankObservation('yoyo', 'yellow');
    recordBankObservation('yoyo', 'yellow');
    expect(applyBankToWord('yoyo')).toBe('yellow');
    expect(wordsMatch('yellow', 'yoyo')).toBe(true);
  });

  it('matches a word against itself without any bank entry', () => {
    expect(wordsMatch('yellow', 'Yellow!')).toBe(true);
    expect(wordsMatch('yellow', '')).toBe(false);
  });

  it('preserves spacing when correcting a whole sentence', () => {
    state.wordBank.yoyo = 'yellow';
    const parts = applyBankToText('a  yoyo bird');
    expect(parts.map((p) => p.display).join('')).toBe('a  yellow bird');
    expect(parts.find((p) => p.fixed).raw).toBe('yoyo');
  });
});

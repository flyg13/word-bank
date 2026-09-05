import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../lib/store.js';
import { foldSnapshot } from '../lib/snapshot.js';
import { addSpelling, focusWords, suggestFromSound } from '../lib/phonicbank.js';
import { recordBankObservation } from '../lib/wordbank.js';

beforeEach(() => {
  foldSnapshot(state, {});
  state.focusMode = false;
  state.pinnedWord = null;
});

describe('focusWords', () => {
  it('is empty before anything has been recorded', () => {
    expect(focusWords()).toEqual([]);
  });

  it('collects words with a recorded pronunciation', () => {
    addSpelling('yellow', 'yeyo');
    expect(focusWords()).toEqual(['yellow']);
  });

  it('collects words with a correction, pending as well as active', () => {
    recordBankObservation('yoyo', 'yellow'); // pending — still needs work
    recordBankObservation('wibble', 'wobble');
    recordBankObservation('wibble', 'wobble'); // active
    expect(focusWords().sort()).toEqual(['wobble', 'yellow']);
  });

  it('counts a word once however many ways it is recorded', () => {
    addSpelling('yellow', 'yeyo');
    addSpelling('yellow', 'lellow');
    recordBankObservation('yoyo', 'Yellow');
    expect(focusWords()).toHaveLength(1);
  });

  it('reads corrections stored in the original bare-string format', () => {
    state.wordBank = { yoyo: 'yellow' };
    expect(focusWords()).toEqual(['yellow']);
  });

  it('includes words that are not in the built-in practice list', () => {
    // A correction for something from her homework is exactly what is worth
    // drilling, and the built-in list will never contain it.
    addSpelling('stegosaurus', 'steggo');
    expect(focusWords()).toContain('stegosaurus');
  });
});

describe('suggestFromSound', () => {
  beforeEach(() => {
    addSpelling('wobble', 'wibble');
  });

  it('suggests the word a strong pronunciation points at', () => {
    expect(suggestFromSound('wibble')).toBe('wobble');
  });

  it('excludes loose spellings, which unscoped would match half a sentence', () => {
    addSpelling('yellow', 'yeyo'); // keys to "A"
    expect(suggestFromSound('yo yo')).toBeNull();
    expect(suggestFromSound('a')).toBeNull();
    expect(suggestFromSound('oh')).toBeNull();
  });

  it('suggests nothing when two different words would both fit', () => {
    // Picking one silently would present a guess as knowledge.
    addSpelling('wabble', 'wibble');
    expect(suggestFromSound('wibble')).toBeNull();
  });

  it('does not suggest a word for itself', () => {
    expect(suggestFromSound('wobble')).toBeNull();
  });

  it('suggests nothing for unknown or empty input', () => {
    expect(suggestFromSound('zzzz')).toBeNull();
    expect(suggestFromSound('')).toBeNull();
    expect(suggestFromSound('!!!')).toBeNull();
  });

  it('still only suggests once a correction is pending — it never auto-applies', () => {
    // Accepting is one sighting. Until the second, the word stays a suggestion
    // rather than being rewritten, exactly as a confirmation in Practice does.
    recordBankObservation('wibble', 'wobble');
    expect(suggestFromSound('wibble')).toBe('wobble');
  });
});

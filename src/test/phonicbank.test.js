import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../lib/store.js';
import {
  getPhonicEntry,
  phonicEntries,
  addSpelling,
  removeSpelling,
  removePhonicEntry,
  soundsLikeHerWord
} from '../lib/phonicbank.js';
import { wordsMatch, recordBankObservation } from '../lib/wordbank.js';
import { alignWords, isCleanRead } from '../lib/align.js';
import { toWords } from '../lib/text.js';

beforeEach(() => {
  state.phonicBank = {};
  state.wordBank = {};
});

describe('recording how she says a word', () => {
  it('stores the spelling, the derived keys and the word as typed', () => {
    addSpelling('Yellow', 'yeyo');
    const entry = getPhonicEntry('yellow');
    expect(entry).toMatchObject({ word: 'Yellow', spellings: ['yeyo'], keys: ['A'] });
    expect(typeof entry.added).toBe('string');
  });

  it('keys the entry by the normalised word, so casing and punctuation do not split it', () => {
    addSpelling('Yellow!', 'yeyo');
    expect(getPhonicEntry('yellow')).not.toBeNull();
    expect(phonicEntries()).toHaveLength(1);
  });

  it('accumulates several ways she says the same word', () => {
    addSpelling('yellow', 'yeyo');
    addSpelling('yellow', 'lellow');
    expect(getPhonicEntry('yellow').spellings).toEqual(['yeyo', 'lellow']);
    expect(getPhonicEntry('yellow').keys).toEqual(['A', 'LL', 'LLF']);
  });

  it('ignores a duplicate spelling rather than storing it twice', () => {
    expect(addSpelling('yellow', 'yeyo')).toBe(true);
    expect(addSpelling('yellow', 'YeYo')).toBe(false);
    expect(getPhonicEntry('yellow').spellings).toEqual(['yeyo']);
  });

  it('refuses a spelling with nothing pronounceable in it', () => {
    expect(addSpelling('yellow', '!!!')).toBe(false);
    expect(addSpelling('yellow', '   ')).toBe(false);
    expect(addSpelling('', 'yeyo')).toBe(false);
    expect(phonicEntries()).toHaveLength(0);
  });

  it('recomputes keys when a spelling is removed, and drops the last one entirely', () => {
    addSpelling('yellow', 'yeyo');
    addSpelling('yellow', 'lellow');
    removeSpelling('yellow', 'lellow');
    expect(getPhonicEntry('yellow').keys).toEqual(['A']);
    removeSpelling('yellow', 'yeyo');
    expect(getPhonicEntry('yellow')).toBeNull();
  });

  it('removes a whole entry', () => {
    addSpelling('yellow', 'yeyo');
    expect(removePhonicEntry('yellow')).toBe(true);
    expect(removePhonicEntry('yellow')).toBe(false);
  });

  it('ignores a malformed entry rather than breaking the list', () => {
    addSpelling('yellow', 'yeyo');
    state.phonicBank.broken = { word: 'broken' };            // no spellings
    state.phonicBank.alsoBroken = { spellings: ['x'] };       // no word
    state.phonicBank.notAnObject = 'nonsense';
    expect(phonicEntries().map(([, e]) => e.word)).toEqual(['yellow']);
    expect(getPhonicEntry('broken')).toBeNull();
    expect(soundsLikeHerWord('broken', 'anything')).toBe(false);
  });

  it('derives keys for an entry that was stored without them', () => {
    state.phonicBank.yellow = { word: 'yellow', spellings: ['yeyo'] };
    expect(getPhonicEntry('yellow').keys).toEqual(['A']);
    expect(soundsLikeHerWord('yellow', 'yo yo')).toBe(true);
  });
});

describe('matching is scoped to one expected word', () => {
  beforeEach(() => {
    addSpelling('yellow', 'yeyo'); // keys to "A"
  });

  it('matches the transcription variants against the word it was recorded for', () => {
    ['yo yo', 'ye oh', 'yoyo'].forEach((heard) => {
      expect(soundsLikeHerWord('yellow', heard)).toBe(true);
    });
  });

  it('does not match a different expected word, even on a colliding key', () => {
    // "you", "we", "way" and "who" all key to "A", exactly as "yeyo" does.
    // A global scan would call every one of these a hit; scoping means the
    // entry is only ever consulted for the word it describes.
    ['you', 'we', 'way', 'who'].forEach((other) => {
      expect(soundsLikeHerWord(other, 'yo yo')).toBe(false);
    });
  });

  it('returns false when the word has no recorded pronunciation', () => {
    expect(soundsLikeHerWord('purple', 'yo yo')).toBe(false);
  });

  it('returns false for empty heard text', () => {
    expect(soundsLikeHerWord('yellow', '')).toBe(false);
  });
});

describe('a phonetic hit never counts as a confirmed correction', () => {
  beforeEach(() => {
    addSpelling('yellow', 'yeyo');
  });

  it('does not make the strict comparator match', () => {
    // wordsMatch drives alignment and clean-read scoring. It only ever trusts
    // an active word_bank entry — phonetics must not leak into it.
    expect(soundsLikeHerWord('yellow', 'yo yo')).toBe(true);
    expect(wordsMatch('yellow', 'yo yo')).toBe(false);
  });

  it('does not score a sentence as a clean read', () => {
    const ops = alignWords(toWords('a yellow bird'), toWords('a yo yo bird'), wordsMatch);
    expect(isCleanRead(ops)).toBe(false);
  });

  it('still requires two exact-text sightings before the correction goes active', () => {
    recordBankObservation('yoyo', 'yellow');
    expect(wordsMatch('yellow', 'yoyo')).toBe(false); // pending
    recordBankObservation('yoyo', 'yellow');
    expect(wordsMatch('yellow', 'yoyo')).toBe(true); // active, on exact text
    // The other transcription is still only a phonetic suggestion.
    expect(wordsMatch('yellow', 'ye oh')).toBe(false);
    expect(soundsLikeHerWord('yellow', 'ye oh')).toBe(true);
  });
});

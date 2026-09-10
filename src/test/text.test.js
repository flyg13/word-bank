import { describe, it, expect } from 'vitest';
import { normalize, toWords, shuffle, parsePassage, fitReplacement } from '../lib/text.js';

describe('normalize', () => {
  it('lowercases and strips punctuation but keeps apostrophes', () => {
    expect(normalize("Don't!")).toBe("don't");
    expect(normalize('Cat.')).toBe('cat');
    expect(normalize(undefined)).toBe('');
  });
});

describe('toWords', () => {
  it('splits on whitespace and drops sentence punctuation', () => {
    expect(toWords('The cat, sat!')).toEqual(['The', 'cat', 'sat']);
  });
  it('returns an empty array for empty input', () => {
    expect(toWords('   ')).toEqual([]);
    expect(toWords('')).toEqual([]);
  });
});

describe('shuffle', () => {
  it('keeps every element and does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('parsePassage', () => {
  it('splits a passage into sentences on terminal punctuation', () => {
    expect(parsePassage('The cat sat. It was warm! Was it? ')).toEqual([
      'The cat sat.',
      'It was warm!',
      'Was it?'
    ]);
  });
  it('returns an empty array for an empty passage', () => {
    expect(parsePassage('')).toEqual([]);
  });
});

describe('fitReplacement', () => {
  // The first real test: "Dad brought a bottle of liquor." came back as
  // "Little", capitalised mid-sentence and with the full stop gone. The
  // replacement takes the case and the punctuation of the word it replaces.
  it('copies a lower-case original, even when the replacement arrived capitalised', () => {
    expect(fitReplacement('liquor', 'Little')).toBe('little');
    expect(fitReplacement('liquor', 'LITTLE')).toBe('little');
  });

  it('keeps the original\'s sentence punctuation around the replacement', () => {
    expect(fitReplacement('liquor.', 'Little')).toBe('little.');
    expect(fitReplacement('"liquor,"', 'little')).toBe('"little,"');
    expect(fitReplacement('liquor?', 'little.')).toBe('little?');
  });

  it('capitalises at a sentence start and follows an all-capitals original', () => {
    expect(fitReplacement('Liquor', 'little')).toBe('Little');
    expect(fitReplacement('LIQUOR!', 'little')).toBe('LITTLE!');
  });

  it('leaves a mixed-case original\'s replacement alone, and copes with odd input', () => {
    expect(fitReplacement('iPad', 'iPod')).toBe('iPod');
    expect(fitReplacement('I', 'a')).toBe('A');
    expect(fitReplacement('...', 'little')).toBe('...little');
    expect(fitReplacement('', 'little')).toBe('little');
    expect(fitReplacement('liquor', '')).toBe('');
  });
});

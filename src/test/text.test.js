import { describe, it, expect } from 'vitest';
import { normalize, toWords, shuffle, parsePassage } from '../lib/text.js';

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

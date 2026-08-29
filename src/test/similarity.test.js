import { describe, it, expect } from 'vitest';
import { characterSimilarity } from '../lib/similarity.js';

describe('characterSimilarity', () => {
  it('scores identical words 1, ignoring case and punctuation', () => {
    expect(characterSimilarity('cat', 'Cat!')).toBe(1);
  });
  it('scores a near miss high', () => {
    expect(characterSimilarity('cat', 'cot')).toBeCloseTo(2 / 3);
    expect(characterSimilarity('red', 'wed')).toBeCloseTo(2 / 3);
  });
  it('scores unrelated words low', () => {
    expect(characterSimilarity('sat', 'on')).toBe(0);
    expect(characterSimilarity('cat', 'dog')).toBe(0);
  });
  it('handles empty input without dividing by zero', () => {
    expect(characterSimilarity('', '')).toBe(1);
    expect(characterSimilarity('cat', '')).toBe(0);
  });
});

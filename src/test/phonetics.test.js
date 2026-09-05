import { describe, it, expect } from 'vitest';
import { phoneticKeys, soundsAlike, isWeakKey, isWeakSpelling } from '../lib/phonetics.js';
import { PRACTICE_WORDS } from '../data/practice-words.js';

describe('phoneticKeys', () => {
  it('is blind to spacing, so a split transcription keys like the whole word', () => {
    expect(phoneticKeys('ye low')).toEqual(phoneticKeys('yellow'));
    expect(phoneticKeys('butter fly')).toEqual(phoneticKeys('butterfly'));
  });

  it('returns no keys for input with nothing pronounceable in it', () => {
    expect(phoneticKeys('')).toEqual([]);
    expect(phoneticKeys('   ')).toEqual([]);
    expect(phoneticKeys('!!! 123')).toEqual([]);
    expect(phoneticKeys(undefined)).toEqual([]);
  });

  it('returns primary and secondary keys, deduped', () => {
    expect(phoneticKeys('that')).toEqual(['0T', 'TT']); // two pronunciations
    expect(phoneticKeys('cat')).toEqual(['KT']); // one, not duplicated
  });
});

describe('soundsAlike', () => {
  it('collapses the transcription variants this feature exists for', () => {
    // The recognizer spells one sound several ways across attempts; all of
    // them key alike, which is what lets a correction accumulate at all.
    ['yo yo', 'ye oh', 'yoyo', 'yeoh'].forEach((heard) => {
      expect(soundsAlike('yeyo', heard)).toBe(true);
    });
  });

  it('cross-matches primary against secondary, catching alternate pronunciations', () => {
    expect(soundsAlike('that', 'dat')).toBe(true);
  });

  it('never matches when either side has no keys', () => {
    expect(soundsAlike('yeyo', '')).toBe(false);
    expect(soundsAlike('', 'yeyo')).toBe(false);
    expect(soundsAlike('yeyo', '!!!')).toBe(false);
  });

  it('does NOT model her articulation errors — only transcription variance', () => {
    // Double Metaphone maps spelling to sound. It has no idea she says "wed"
    // for "red". The parent types how it SOUNDS; this absorbs however the
    // recognizer chooses to spell that sound. Documented here because it sets
    // expectations for what a phonic spelling has to contain.
    expect(soundsAlike('red', 'wed')).toBe(false);
    expect(soundsAlike('think', 'fink')).toBe(false);
    // The word itself does not sound like the way she says it — which is the
    // whole point of recording a separate spelling.
    expect(soundsAlike('yellow', 'yeyo')).toBe(false);
  });
});

describe('collision risk (why nothing is matched globally)', () => {
  it('short keys collide with large numbers of ordinary words', () => {
    expect(phoneticKeys('a')).toEqual(phoneticKeys('oh'));
    expect(phoneticKeys('a')).toEqual(phoneticKeys('i'));
    expect(phoneticKeys('to')).toEqual(phoneticKeys('two'));
    expect(phoneticKeys('cat')).toEqual(phoneticKeys('cot'));
  });

  it('collides on most of the practice list, so a global scan is unsafe', () => {
    const byKey = new Map();
    PRACTICE_WORDS.forEach((word) => {
      const key = phoneticKeys(word)[0];
      byKey.set(key, [...(byKey.get(key) || []), word]);
    });
    const colliding = [...byKey.values()].filter((words) => words.length > 1);
    // Not a target to hit — a fact being pinned. If this ever drops to zero,
    // the scoping rationale below it needs revisiting.
    expect(colliding.length).toBeGreaterThan(50);
    const worst = colliding.sort((a, b) => b.length - a.length)[0];
    expect(worst.length).toBeGreaterThan(5);
  });

  it('flags one-character keys as weak', () => {
    expect(isWeakKey('A')).toBe(true);
    expect(isWeakKey('KT')).toBe(false);
    expect(isWeakKey('')).toBe(false);
    expect(isWeakSpelling('yeyo')).toBe(true); // keys to "A"
    expect(isWeakSpelling('butterfly')).toBe(false);
  });
});

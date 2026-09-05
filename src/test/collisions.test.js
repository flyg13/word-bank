import { describe, it, expect } from 'vitest';
import { collidingWords, listSentence, describeWeakSpelling } from '../lib/collisions.js';

describe('collidingWords', () => {
  it('names real words the matcher cannot tell the spelling apart from', () => {
    expect(collidingWords('boo')).toContain('be');
    expect(collidingWords('boo')).toContain('buy');
    expect(collidingWords('moo')).toContain('me');
    expect(collidingWords('yeyo')).toContain('a');
  });

  it('includes bare vowel sounds, which the practice list deliberately omits', () => {
    // The recognizer emits these constantly for an unclear utterance, so they
    // are the collisions that matter most — and none of them are practice words.
    const hits = collidingWords('yeyo');
    expect(hits.some((w) => ['a', 'I', 'ah', 'oh', 'uh'].includes(w))).toBe(true);
  });

  it('never lists the spelling as colliding with itself', () => {
    expect(collidingWords('moo').map((w) => w.toLowerCase())).not.toContain('moo');
    expect(collidingWords('blue').map((w) => w.toLowerCase())).not.toContain('blue');
  });

  it('is empty for a spelling distinctive enough not to collide', () => {
    expect(collidingWords('buttafly')).toEqual([]);
  });

  it('returns nothing for input with no pronounceable content', () => {
    expect(collidingWords('')).toEqual([]);
    expect(collidingWords('!!!')).toEqual([]);
  });

  it('prefers short words — the ones actually emitted for an unclear attempt', () => {
    const hits = collidingWords('ess', 8);
    expect(hits[0].length).toBeLessThanOrEqual(hits[hits.length - 1].length);
  });
});

describe('listSentence', () => {
  it('reads as English', () => {
    expect(listSentence(['be'])).toBe('be');
    expect(listSentence(['be', 'by'])).toBe('be and by');
    expect(listSentence(['be', 'by', 'bee'])).toBe('be, by and bee');
  });
  it('handles an empty list', () => {
    expect(listSentence([])).toBe('');
  });
});

describe('describeWeakSpelling', () => {
  it('names the spelling being warned about, not an example', () => {
    // The bug this replaces: the text was hardcoded to the yeyo example, so a
    // "Boo" entry was told about words it has nothing to do with.
    const boo = describeWeakSpelling('Boo');
    expect(boo.heading).toContain('Boo');
    expect(boo.heading + boo.body).not.toMatch(/yeyo/i);
  });

  it('lists that spelling’s own colliding words', () => {
    expect(describeWeakSpelling('Boo').body).toContain('be');
    expect(describeWeakSpelling('moo').body).toContain('me');
    // And they really are different entries, not one shared string.
    expect(describeWeakSpelling('Boo').body).not.toEqual(describeWeakSpelling('moo').body);
  });

  it('offers no spelling advice beyond adding a consonant she actually makes', () => {
    const { body } = describeWeakSpelling('yeyo');
    expect(body).toContain('If she makes a consonant sound in there, include it');
    expect(body).not.toMatch(/yeyoh/i); // the old, invented "better spelling"
  });

  it('says the limit is expected rather than implying it must be fixed', () => {
    const { body } = describeWeakSpelling('moo');
    expect(body).toContain('will need confirming each time it fires');
    expect(body).toContain('that’s expected');
  });

  it('still explains itself when nothing collides', () => {
    const { body } = describeWeakSpelling('aaa');
    expect(body).toContain('This spelling is mostly vowels');
    expect(body.length).toBeGreaterThan(40);
  });
});

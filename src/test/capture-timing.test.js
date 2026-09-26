// @vitest-environment jsdom
// How long the app waits before deciding she has finished, and what it shows
// while it turns the clip into text. Both came back from real use on the iPad
// as "it looks like it has frozen" — see CLAUDE.md §13.
import { describe, it, expect } from 'vitest';

const { CAPTURE_MODES, NO_SPEECH_MS, envMs } = await import('../config.js');

describe('the pause before a recording stops on its own', () => {
  it('is short in Speech-To-Text, where a cut-off costs one extra tap', async () => {
    // Recordings add to the end rather than replacing (§12), so stopping
    // early ends that sentence and the next tap carries on. 3500ms read as
    // the app having frozen.
    expect(CAPTURE_MODES.freeform.silenceMs).toBeLessThanOrEqual(1500);
  });

  it('stays long where a cut-off costs her a whole retry', async () => {
    // Sentences and Reading are scored against a target: cutting her off
    // mid-sentence means doing it again, which is a worse failure than a wait.
    expect(CAPTURE_MODES.sentence.silenceMs).toBeGreaterThanOrEqual(2000);
    expect(CAPTURE_MODES.passage.silenceMs).toBeGreaterThanOrEqual(CAPTURE_MODES.sentence.silenceMs);
  });

  it('is shortest of all for one word, which has nothing to pause inside', () => {
    expect(CAPTURE_MODES.word.silenceMs).toBeLessThanOrEqual(CAPTURE_MODES.sentence.silenceMs);
  });

  it('still keeps a hard ceiling on every mode, so nothing runs forever', () => {
    Object.values(CAPTURE_MODES).forEach((limits) => {
      expect(limits.maxMs).toBeGreaterThan(limits.silenceMs);
      expect(limits.maxMs).toBeLessThanOrEqual(60000);
    });
  });

  it('waits a sane time for her to start at all', () => {
    expect(NO_SPEECH_MS).toBeGreaterThan(1000);
    expect(NO_SPEECH_MS).toBeLessThanOrEqual(10000);
  });
});

describe('tuning the pause from the environment', () => {
  it('takes the value the build was given, in place of the default', () => {
    expect(envMs('VITE_SILENCE_MS_FREEFORM', 1500, { env: { VITE_SILENCE_MS_FREEFORM: '900' } }))
      .toBe(900);
    expect(envMs('VITE_SILENCE_MS_FREEFORM', 1500, { env: { VITE_SILENCE_MS_FREEFORM: 2200 } }))
      .toBe(2200);
  });

  it('ignores anything that is not a number in a sane range', () => {
    // A typo in Netlify must not be what leaves a recording running for a
    // minute, or stops it before she has drawn breath.
    const bad = ['quickly', '', '  ', '50', '999999', '-1', 'NaN', null, undefined, {}];
    bad.forEach((value) => {
      expect(envMs('X', 1500, { env: { X: value } })).toBe(1500);
    });
  });

  it('falls back when the environment has nothing to say', () => {
    expect(envMs('X', 1500, { env: {} })).toBe(1500);
    expect(envMs('X', 1500, { env: null })).toBe(1500);
  });

  it('gives every mode a pause the build can set', () => {
    ['word', 'sentence', 'passage', 'freeform'].forEach((mode) => {
      expect(typeof CAPTURE_MODES[mode].silenceMs).toBe('number');
      expect(CAPTURE_MODES[mode].silenceMs).toBeGreaterThan(0);
    });
  });
});

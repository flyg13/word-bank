// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONTEXT_TIMEOUT_MS, CORRECTION_LOG_LIMIT } from '../config.js';
import { correctWithContext, splitForCorrection, correctionPatterns, ContextError }
  from '../lib/context-correct.js';
import { recordContextChanges, readCorrectionLog, markReverted, markReapplied, clearCorrectionLog }
  from '../lib/correction-log.js';
import { state, setSaver } from '../lib/store.js';
import { foldSnapshot } from '../lib/snapshot.js';

describe('lining words up with what is on screen', () => {
  it('numbers only the words, and keeps the spacing between them', () => {
    // A word index here and a token on screen have to mean the same thing, or
    // a change lands on the wrong word.
    const split = splitForCorrection('the  liquor\nbottle');
    expect(split.words).toEqual(['the', 'liquor', 'bottle']);
    expect(split.parts.join('')).toBe('the  liquor\nbottle');
    expect(split.wordIndexOfPart.filter((i) => i >= 0)).toEqual([0, 1, 2]);
  });

  it('handles empty and whitespace-only text', () => {
    expect(splitForCorrection('').words).toEqual([]);
    expect(splitForCorrection('   ').words).toEqual([]);
  });
});

describe('the patterns sent for weighing', () => {
  beforeEach(() => { state.wordBank = {}; state.phonicBank = {}; });

  it('sends confirmed corrections, never pending ones', () => {
    state.wordBank = {
      liquor: { correct: 'little', count: 2, active: true },
      wobble: { correct: 'wonder', count: 1, active: false }
    };
    const { corrections } = correctionPatterns();
    expect(corrections).toEqual([{ heard: 'liquor', means: 'little' }]);
  });

  it('sends every recorded pronunciation', () => {
    state.phonicBank = {
      yellow: { word: 'yellow', spellings: ['yeyo', 'yo yo'], keys: ['A'], added: '' }
    };
    expect(correctionPatterns().pronunciations)
      .toEqual([{ word: 'yellow', spellings: ['yeyo', 'yo yo'] }]);
  });
});

describe('sending a transcript for context', () => {
  beforeEach(() => {
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    state.phonicBank = {};
  });
  afterEach(() => { delete globalThis.fetch; });

  const ok = (changes) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ changes }), { status: 200 }));
  };

  it('names the word it is replacing, so the log and the undo can', async () => {
    ok([{ index: 1, to: 'little', reason: 'why' }]);
    const { changes } = await correctWithContext('the liquor one');
    expect(changes).toEqual([{ index: 1, from: 'liquor', to: 'little', reason: 'why' }]);
  });

  it('drops a change this browser cannot line up, whatever the server said', async () => {
    // Both sides check. Neither takes the other on trust.
    ok([
      { index: 99, to: 'little', reason: '' },
      { index: 1, to: 'liquor', reason: '' },
      { index: 0, to: '', reason: '' }
    ]);
    expect((await correctWithContext('the liquor one')).changes).toEqual([]);
  });

  it('never asks about an empty transcript', async () => {
    globalThis.fetch = vi.fn();
    expect((await correctWithContext('   ')).changes).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports the function\'s own error code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'not-authorised' }), { status: 502 }));
    await expect(correctWithContext('the liquor one'))
      .rejects.toMatchObject({ code: 'not-authorised' });
  });

  it('calls a dead network offline', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(correctWithContext('hello')).rejects.toBeInstanceOf(ContextError);
  });

  it('gives up rather than leaving the corrected panel empty', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url, init) => new Promise((_res, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const settled = expect(correctWithContext('hello')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(CONTEXT_TIMEOUT_MS + 10);
    await settled;
    vi.useRealTimers();
  });

  it('does not bother the network when the device knows it is offline', async () => {
    globalThis.fetch = vi.fn();
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(correctWithContext('hello')).rejects.toMatchObject({ code: 'offline' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the rolling log', () => {
  let saved;
  beforeEach(() => {
    state.contextLog = [];
    saved = [];
    setSaver(async (key, value) => { saved.push({ key, value }); });
  });
  afterEach(() => { setSaver(null); });

  it('is the parent\'s fifty, most recent first', () => {
    expect(CORRECTION_LOG_LIMIT).toBe(50);
  });

  it('keeps the newest and drops the oldest', () => {
    for (let i = 0; i < CORRECTION_LOG_LIMIT + 10; i += 1) {
      recordContextChanges([{ from: 'w' + i, to: 'x', reason: '' }]);
    }
    const log = readCorrectionLog();
    expect(log).toHaveLength(CORRECTION_LOG_LIMIT);
    expect(log[0].from).toBe('w' + (CORRECTION_LOG_LIMIT + 9));
  });

  it('is written to the family document as context_log, and nothing else', () => {
    recordContextChanges([{ from: 'a', to: 'b', reason: 'why' }]);
    expect(saved.map((s) => s.key)).toEqual(['context_log']);
    expect(saved[0].value).toHaveLength(1);
    expect(saved[0].value[0]).toMatchObject({ from: 'a', to: 'b', reason: 'why', reverted: false });
    // The capped list is what goes over, so the document can never grow past it.
    for (let i = 0; i < CORRECTION_LOG_LIMIT + 10; i += 1) {
      recordContextChanges([{ from: 'w' + i, to: 'x', reason: '' }]);
    }
    expect(saved[saved.length - 1].value).toHaveLength(CORRECTION_LOG_LIMIT);
  });

  it('marks one entry undone without touching the others', () => {
    const ids = recordContextChanges([
      { from: 'a', to: 'b', reason: '' },
      { from: 'c', to: 'd', reason: '' }
    ]);
    markReverted(ids[1]);
    const log = readCorrectionLog();
    expect(log.find((e) => e.from === 'c').reverted).toBe(true);
    expect(log.find((e) => e.from === 'a').reverted).toBe(false);
    expect(saved[saved.length - 1].key).toBe('context_log');
  });

  it('unmarks one entry without touching the others', () => {
    const ids = recordContextChanges([
      { from: 'a', to: 'b', reason: '' },
      { from: 'c', to: 'd', reason: '' }
    ]);
    markReverted(ids[0]);
    markReverted(ids[1]);
    markReapplied(ids[1]);
    const log = readCorrectionLog();
    expect(log.find((e) => e.from === 'c').reverted).toBe(false);
    expect(log.find((e) => e.from === 'a').reverted).toBe(true);
  });

  it('ignores an id it does not hold, without a write', () => {
    recordContextChanges([{ from: 'a', to: 'b', reason: '' }]);
    const writes = saved.length;
    markReverted('nope');
    markReapplied('nope');
    expect(saved).toHaveLength(writes);
  });

  it('survives the document holding nonsense', () => {
    foldSnapshot(state, { context_log: 'not a list' });
    expect(readCorrectionLog()).toEqual([]);
    foldSnapshot(state, { context_log: [{ junk: true }, null, { from: 'a', to: 'b' }] });
    expect(readCorrectionLog()).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('is read from the snapshot like every other synced field', () => {
    foldSnapshot(state, {});
    expect(state.contextLog).toEqual([]);
    foldSnapshot(state, { context_log: [{ id: '1', from: 'a', to: 'b', reason: '', at: 'x', reverted: false }] });
    expect(readCorrectionLog()[0].from).toBe('a');
  });

  it('clears, and says so to the document', () => {
    recordContextChanges([{ from: 'a', to: 'b', reason: '' }]);
    clearCorrectionLog();
    expect(readCorrectionLog()).toEqual([]);
    expect(saved[saved.length - 1]).toEqual({ key: 'context_log', value: [] });
  });
});

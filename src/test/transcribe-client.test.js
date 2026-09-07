// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TRANSCRIBE_TIMEOUT_MS, VOCAB_HINT_LIMIT } from '../config.js';
import { transcribeClip, TranscribeError } from '../lib/transcribe.js';
import { state } from '../lib/store.js';
import { vocabularyHints } from '../lib/vocab.js';

const clip = () => ({ blob: new Blob(['audio']), mimeType: 'audio/mp4' });

describe('sending a clip', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('posts the audio, the language and the hints, and returns the text', async () => {
    let body = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = init.body;
      return new Response(JSON.stringify({ text: 'the cat sat', provider: 'openai', model: 'm' }),
        { status: 200 });
    });

    const out = await transcribeClip(clip(), { language: 'en-AU', hints: ['cat'] });
    expect(out.text).toBe('the cat sat');
    expect(out.provider).toBe('openai');
    expect(body.get('language')).toBe('en-AU');
    expect(body.get('mimeType')).toBe('audio/mp4');
    expect(JSON.parse(body.get('hints'))).toEqual(['cat']);
  });

  it('never sends the API key, because it does not have one', async () => {
    // The browser talks to our function, not to the provider.
    let url = null;
    globalThis.fetch = vi.fn(async (u) => {
      url = u;
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 });
    });
    await transcribeClip(clip(), {});
    expect(url).toBe('/.netlify/functions/transcribe');
  });

  it('reports the function\'s own error code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'not-authorised' }), { status: 502 }));
    await expect(transcribeClip(clip(), {})).rejects.toMatchObject({ code: 'not-authorised' });
  });

  it('falls back on a status with no code in the body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('gateway', { status: 503 }));
    await expect(transcribeClip(clip(), {})).rejects.toMatchObject({ code: 'http-503' });
  });

  it('calls a dead network offline, not a server error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(transcribeClip(clip(), {})).rejects.toMatchObject({ code: 'offline' });
  });

  it('gives up rather than leaving her waiting', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    // Attach the expectation before advancing: the rejection lands during the
    // advance, and an unhandled one fails the run.
    const settled = expect(transcribeClip(clip(), {})).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS + 10);
    await settled;
    vi.useRealTimers();
  });

  it('does not bother the network when the device knows it is offline', async () => {
    globalThis.fetch = vi.fn();
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(transcribeClip(clip(), {})).rejects.toMatchObject({ code: 'offline' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses to send an empty clip', async () => {
    globalThis.fetch = vi.fn();
    await expect(transcribeClip({ blob: new Blob([]) }, {})).rejects
      .toBeInstanceOf(TranscribeError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('vocabulary hints', () => {
  beforeEach(() => {
    state.wordBank = {};
    state.phonicBank = {};
  });

  it('puts what she was asked for first, so the cap can never drop it', () => {
    // Letters only: bank keys are normalised to letters, so numbered words
    // would all collapse onto one another.
    const name = (i) => 'w' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));
    for (let i = 0; i < VOCAB_HINT_LIMIT + 40; i += 1) {
      state.wordBank[name(i)] = { correct: name(i), count: 2, active: true };
    }
    const hints = vocabularyHints('yellow');
    expect(hints[0]).toBe('yellow');
    expect(hints).toHaveLength(VOCAB_HINT_LIMIT);
  });

  it('takes each word of a sentence, not the sentence as one hint', () => {
    expect(vocabularyHints('the cat sat')).toEqual(['the', 'cat', 'sat']);
  });

  it('includes the words she has pronunciations for', () => {
    state.phonicBank = { yellow: { word: 'yellow', spellings: ['yeyo'], keys: ['A'], added: '' } };
    expect(vocabularyHints('')).toContain('yellow');
  });

  it('includes the correct side of active corrections, and not pending ones', () => {
    state.wordBank = {
      yeyo: { correct: 'yellow', count: 2, active: true },
      wobble: { correct: 'wonder', count: 1, active: false }
    };
    const hints = vocabularyHints('');
    expect(hints).toContain('yellow');
    expect(hints).not.toContain('wonder');
  });

  it('never sends the heard text or a sounded-out spelling', () => {
    // Priming the decoder with "yeyo" invites it to emit "yeyo". The bank's
    // job is to map a real word back; it cannot do that for a non-word.
    state.wordBank = { yeyo: { correct: 'yellow', count: 2, active: true } };
    state.phonicBank = { yellow: { word: 'yellow', spellings: ['yeyo'], keys: ['A'], added: '' } };
    expect(vocabularyHints('')).not.toContain('yeyo');
  });

  it('says each word once', () => {
    state.wordBank = { yeyo: { correct: 'yellow', count: 2, active: true } };
    state.phonicBank = { yellow: { word: 'Yellow', spellings: ['yeyo'], keys: ['A'], added: '' } };
    const hints = vocabularyHints('yellow');
    expect(hints.filter((w) => w.toLowerCase() === 'yellow')).toHaveLength(1);
  });
});

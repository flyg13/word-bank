// The Netlify Function, exercised directly. Nothing here reaches OpenAI: the
// provider is replaced, so what is under test is the function's own contract —
// what it accepts, what it refuses, and what it does and does not say back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import handler from '../../netlify/functions/transcribe.mjs';
import { buildPrompt, extensionFor, transcribe, ProviderError }
  from '../../netlify/functions/providers/openai.mjs';

const ROOT = resolve(__dirname, '../..');

function post(fields = {}, { method = 'POST' } = {}) {
  const form = new FormData();
  const { audio, ...rest } = fields;
  if (audio !== null) form.append('audio', audio || new Blob(['x'.repeat(64)], { type: 'audio/webm' }), 'speech');
  Object.entries(rest).forEach(([k, v]) => form.append(k, v));
  const init = method === 'GET' || method === 'HEAD' ? { method } : { method, body: form };
  return new Request('https://example.test/.netlify/functions/transcribe', init);
}

describe('the transcription function', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_TRANSCRIBE_MODEL;
    delete process.env.TRANSCRIBE_PROVIDER;
  });

  const stubProvider = (impl) => {
    globalThis.fetch = vi.fn(impl);
  };

  it('returns the provider\'s text, and names the provider and model', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    stubProvider(async () => new Response(JSON.stringify({ text: '  the cat sat  ' }), { status: 200 }));

    const res = await handler(post({ language: 'en-AU', hints: JSON.stringify(['cat']) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ text: 'the cat sat', provider: 'openai', model: 'gpt-4o-transcribe' });
  });

  it('passes the language, the hints and the audio through to the provider', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let sent = null;
    stubProvider(async (url, init) => {
      sent = { url, form: init.body, auth: init.headers.Authorization };
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });

    await handler(post({ language: 'en-AU', hints: JSON.stringify(['yellow', 'there']) }));
    expect(sent.url).toContain('api.openai.com');
    expect(sent.auth).toBe('Bearer sk-test');
    // The API takes the base language; the locale survives in the prompt,
    // which is the only place the accent can be stated.
    expect(sent.form.get('language')).toBe('en');
    expect(sent.form.get('prompt')).toContain('en-AU');
    expect(sent.form.get('prompt')).toContain('yellow, there');
    expect(sent.form.get('temperature')).toBe('0');
    expect(sent.form.get('file').size).toBeGreaterThan(0);
  });

  it('refuses anything but POST', async () => {
    const res = await handler(post({}, { method: 'GET' }));
    expect(res.status).toBe(405);
    expect((await res.json()).error).toBe('method-not-allowed');
  });

  it('refuses a request with no audio', async () => {
    const res = await handler(post({ audio: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no-audio');
  });

  it('refuses an empty clip', async () => {
    const res = await handler(post({ audio: new Blob([], { type: 'audio/webm' }) }));
    expect((await res.json()).error).toBe('empty-audio');
  });

  it('refuses a clip over the size limit', async () => {
    const big = new Blob([new Uint8Array(13 * 1024 * 1024)], { type: 'audio/webm' });
    const res = await handler(post({ audio: big }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('too-large');
  });

  it('says so, distinctly, when no key is configured', async () => {
    // The one failure a redeploy will not fix, so it must not look like a
    // generic outage on the mic label.
    const res = await handler(post({}));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('not-configured');
  });

  it('maps a rejected key to its own code', async () => {
    process.env.OPENAI_API_KEY = 'sk-bad';
    stubProvider(async () => new Response('bad key', { status: 401 }));
    const res = await handler(post({}));
    expect((await res.json()).error).toBe('not-authorised');
  });

  it('maps rate limiting to its own code', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    stubProvider(async () => new Response('slow down', { status: 429 }));
    const res = await handler(post({}));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate-limited');
  });

  it('never echoes the provider\'s own message back to the browser', async () => {
    // Provider errors can carry request ids and key fragments.
    process.env.OPENAI_API_KEY = 'sk-test';
    stubProvider(async () => new Response('key sk-secret-1234 is invalid', { status: 400 }));
    const res = await handler(post({}));
    const text = await res.text();
    expect(text).not.toContain('sk-secret');
    expect(text).toContain('provider-error');
  });

  it('ignores hints that are not a list of strings', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let form = null;
    stubProvider(async (_url, init) => {
      form = init.body;
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });
    await handler(post({ language: 'en-AU', hints: '{"not":"a list"}' }));
    expect(form.get('prompt')).toBe('Speech in en-AU.');
  });

  it('caps how many hints it will forward', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let form = null;
    stubProvider(async (_url, init) => {
      form = init.body;
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });
    const many = Array.from({ length: 500 }, (_, i) => 'word' + i);
    await handler(post({ hints: JSON.stringify(many) }));
    expect(form.get('prompt')).toContain('word119');
    expect(form.get('prompt')).not.toContain('word120');
  });

  it('honours a model override without a code change', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_TRANSCRIBE_MODEL = 'whisper-1';
    let form = null;
    stubProvider(async (_url, init) => {
      form = init.body;
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });
    const res = await handler(post({}));
    expect(form.get('model')).toBe('whisper-1');
    expect((await res.json()).model).toBe('whisper-1');
  });
});

describe('the provider interface', () => {
  it('names the container from the mime type, because the API reads the filename', () => {
    expect(extensionFor('audio/mp4;codecs=mp4a.40.2')).toBe('mp4');
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionFor('audio/wav')).toBe('wav');
    expect(extensionFor('')).toBe('webm');
  });

  it('states the accent and her vocabulary, and instructs nothing', () => {
    const prompt = buildPrompt('en-AU', ['yellow', 'there']);
    expect(prompt).toContain('en-AU');
    expect(prompt).toContain('yellow, there');
    // The prompt biases spelling. Asking the model to "correct" or "fix"
    // anything would defeat an app whose job is recording what she said.
    expect(prompt.toLowerCase()).not.toMatch(/correct|fix|improve|clean/);
  });

  it('refuses to run without its key rather than sending an unauthenticated call', async () => {
    const before = globalThis.fetch;
    globalThis.fetch = vi.fn();
    await expect(transcribe({ audio: new Blob(['x']), mimeType: 'audio/webm', env: {} }))
      .rejects.toMatchObject({ code: 'not-configured' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    globalThis.fetch = before;
  });

  it('is swappable in one file, by contract', () => {
    // The function must not reach past the provider's interface.
    const source = readFileSync(resolve(ROOT, 'netlify/functions/transcribe.mjs'), 'utf8');
    expect(source).not.toContain('api.openai.com');
    expect(source).not.toContain('OPENAI_API_KEY');
    expect(source).toMatch(/provider\.transcribe\(/);
  });
});

describe('the key never reaches the repo or the bundle', () => {
  it('is read only inside the function', () => {
    const clientFiles = ['src/lib/transcribe.js', 'src/lib/capture.js', 'src/config.js'];
    clientFiles.forEach((file) => {
      expect(readFileSync(resolve(ROOT, file), 'utf8')).not.toContain('OPENAI_API_KEY');
    });
  });

  it('has no key committed anywhere in the source', () => {
    const files = ['netlify.toml', 'src/config.js', 'netlify/functions/providers/openai.mjs'];
    files.forEach((file) => {
      expect(readFileSync(resolve(ROOT, file), 'utf8')).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    });
  });
});

// POST audio here, get text back.
//
// This exists so the API key can live in a Netlify environment variable
// instead of the browser bundle. It is deliberately thin: it validates the
// request, picks a provider, and hands the audio over. Everything the app does
// with the text — corrections, pronunciations, phonetic matching, the bank —
// is unchanged and still happens in the browser.
//
// Swapping provider is a one-file job: add a module next to openai.mjs that
// exports the same `transcribe({audio, mimeType, language, hints, signal, env})`
// and register it in PROVIDERS.

import * as openai from './providers/openai.mjs';

const PROVIDERS = { openai };

// A single word is a few tens of kilobytes; the longest passage mode allows
// 45 seconds. 12 MB is far above either and still refuses anything that is
// plainly not a recording from this app.
const MAX_BYTES = 12 * 1024 * 1024;

// Cap on the vocabulary hints accepted from the client. The browser already
// caps them; this is the server not trusting that.
const MAX_HINTS = 120;
const MAX_HINT_LENGTH = 40;

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return fail('method-not-allowed', 'POST only', 405);

  const env = process.env;
  const provider = PROVIDERS[env.TRANSCRIBE_PROVIDER || 'openai'];
  if (!provider) return fail('no-provider', 'unknown TRANSCRIBE_PROVIDER', 500);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return fail('bad-request', 'expected multipart/form-data', 400);
  }

  const audio = form.get('audio');
  if (!audio || typeof audio.arrayBuffer !== 'function') {
    return fail('no-audio', 'no audio field', 400);
  }
  if (audio.size === 0) return fail('empty-audio', 'audio was empty', 400);
  if (audio.size > MAX_BYTES) return fail('too-large', 'audio over the size limit', 413);

  const language = clean(form.get('language')).slice(0, 20);
  const mimeType = clean(form.get('mimeType')) || audio.type || 'audio/webm';
  const hints = parseHints(form.get('hints'));

  // The provider gets its own deadline, shorter than Netlify's function
  // timeout, so a slow provider surfaces as a timeout the app can fall back
  // from rather than as the platform killing the function mid-flight.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  try {
    const { text, model } = await provider.transcribe({
      audio, mimeType, language, hints, signal: abort.signal, env
    });
    return json({ text, provider: provider.name, model }, 200);
  } catch (e) {
    // Never echo the provider's message to the browser: it can contain
    // request ids and key fragments. The code is enough for the mic label,
    // and the detail goes to the function log.
    console.error('transcribe failed', e && e.message);
    return fail(e && e.code ? e.code : 'provider-error', 'transcription failed',
      e && e.status ? e.status : 502);
  } finally {
    clearTimeout(timer);
  }
}

function parseHints(raw) {
  const value = clean(raw);
  if (!value) return [];
  let list;
  try {
    list = JSON.parse(value);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.trim().slice(0, MAX_HINT_LENGTH))
    .slice(0, MAX_HINTS);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function fail(code, message, status) {
  return json({ error: code, message }, status);
}

// Client for the transcription function.
//
// The browser never holds the provider's key and never talks to the provider:
// it posts the clip to a Netlify Function in this repo, which does both. What
// comes back is text, which is all the rest of the app has ever operated on.

import { TRANSCRIBE_ENDPOINT, TRANSCRIBE_TIMEOUT_MS } from '../config.js';

export class TranscribeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Send a clip for transcription.
 *
 * @param {{blob: Blob, mimeType: string}} clip
 * @param {{language?: string, hints?: string[]}} options
 * @returns {Promise<{text: string, provider: string, model: string}>}
 * @throws {TranscribeError} with a short code the mic label can name:
 *   offline, timeout, http-4xx/5xx, or whatever the function reported.
 */
export async function transcribeClip(clip, { language, hints } = {}) {
  if (!clip || !clip.blob || !clip.blob.size) throw new TranscribeError('empty-audio');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new TranscribeError('offline');
  }

  const form = new FormData();
  form.append('audio', clip.blob, 'speech');
  form.append('mimeType', clip.mimeType || clip.blob.type || '');
  if (language) form.append('language', language);
  if (hints && hints.length) form.append('hints', JSON.stringify(hints));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
  } catch (e) {
    // An aborted fetch is our own timeout firing; anything else at this stage
    // is the network, since the request never got a status back.
    throw new TranscribeError(e && e.name === 'AbortError' ? 'timeout' : 'offline');
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new TranscribeError(body.error || 'http-' + response.status);
  }
  if (typeof body.text !== 'string') throw new TranscribeError('bad-response');

  return { text: body.text.trim(), provider: body.provider || '', model: body.model || '' };
}

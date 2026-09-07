// OpenAI transcription provider.
//
// Model choice: gpt-4o-transcribe, with OPENAI_TRANSCRIBE_MODEL as a one-
// variable escape hatch to whisper-1. The reasoning is in CLAUDE.md §9; the
// short version is that whisper-1's documented failure mode is hallucinating
// text on near-silent or very short clips, and Practice sends single words of
// about a second — the exact input that triggers it.
//
// temperature 0 because this is transcription, not writing: the same clip
// should give the same text every time, or the two-sightings rule in the bank
// is counting noise.

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-transcribe';

// OpenAI infers the container from the filename, so the extension has to be
// right. iOS Safari's MediaRecorder emits audio/mp4; Chrome emits webm/opus.
const EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a'
};

export const name = 'openai';

/** Which env var must be set for this provider to work. */
export const keyVar = 'OPENAI_API_KEY';

export function extensionFor(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return EXTENSIONS[base] || 'webm';
}

/**
 * The provider interface, and the only thing transcribe.mjs knows about a
 * provider: audio in, language hint in, vocabulary hints in, text out.
 *
 * @param {{
 *   audio: Blob,
 *   mimeType: string,
 *   language?: string,
 *   hints?: string[],
 *   signal?: AbortSignal,
 *   env: Record<string,string|undefined>
 * }} request
 * @returns {Promise<{text:string, model:string}>}
 */
export async function transcribe({ audio, mimeType, language, hints, signal, env }) {
  const key = env[keyVar];
  if (!key) throw new ProviderError('not-configured', keyVar + ' is not set', 503);

  const model = env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_MODEL;

  const form = new FormData();
  form.append('file', audio, 'speech.' + extensionFor(mimeType));
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // The API wants the base language, not the locale: "en", not "en-AU". The
  // regional part still matters — it is passed in the prompt below, because
  // that is the only place the accent can be stated.
  if (language) form.append('language', String(language).split('-')[0].toLowerCase());
  const prompt = buildPrompt(language, hints);
  if (prompt) form.append('prompt', prompt);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ProviderError('timeout', 'provider timed out', 504);
    throw new ProviderError('unreachable', 'could not reach the provider', 502);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // 401/403 is a key problem and worth naming separately: it is the one
    // failure a redeploy will not fix.
    const code = response.status === 401 || response.status === 403 ? 'not-authorised'
      : response.status === 429 ? 'rate-limited'
      : 'provider-error';
    throw new ProviderError(code, 'provider returned ' + response.status + ' ' + detail.slice(0, 300),
      response.status === 429 ? 429 : 502);
  }

  const body = await response.json().catch(() => ({}));
  return { text: typeof body.text === 'string' ? body.text.trim() : '', model };
}

/**
 * The provider's hint mechanism is a free-text prompt: it biases the decoder
 * toward spellings it contains. Two things go in — the accent, which cannot be
 * expressed by the `language` field, and her own vocabulary.
 *
 * Deliberately not phrased as an instruction to correct anything. The prompt
 * biases spelling; asking the model to "fix" what it hears would defeat the
 * point of an app whose whole job is recording what she actually said.
 */
export function buildPrompt(language, hints) {
  const parts = [];
  const locale = String(language || '').trim();
  if (locale) parts.push('Speech in ' + locale + '.');
  const words = (hints || []).filter((w) => typeof w === 'string' && w.trim());
  if (words.length) parts.push('Words that may appear: ' + words.join(', ') + '.');
  return parts.join(' ');
}

export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

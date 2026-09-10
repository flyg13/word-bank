// Transcript in, corrections out — decided with the sentence in view.
//
// The bank on its own has no context: a confirmed "liquor -> little" rewrites
// every "liquor", including a real one. This asks Claude to weigh the same
// patterns against the sentence instead of firing them blindly. See CLAUDE.md
// §10.
//
// Thin, like the transcription function: validate, pick a provider, hand over.
// Swapping model or platform is one file in providers/.

import * as bedrockClaude from './providers/bedrock-claude.mjs';

const PROVIDERS = { 'bedrock-claude': bedrockClaude };

// A Speech-To-Text entry is a sentence or two. These are far above anything
// the app produces and still refuse a request that is plainly not from it.
const MAX_TOKENS = 400;
const MAX_WORD_LENGTH = 60;
const MAX_PATTERNS = 200;

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return fail('method-not-allowed', 'POST only', 405);

  const env = process.env;
  const provider = PROVIDERS[env.CONTEXT_PROVIDER || 'bedrock-claude'];
  if (!provider) return fail('no-provider', 'unknown CONTEXT_PROVIDER', 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail('bad-request', 'expected JSON', 400);
  }

  const tokens = cleanTokens(body && body.tokens);
  if (!tokens.length) return fail('no-text', 'no words to correct', 400);
  if (tokens.length > MAX_TOKENS) return fail('too-long', 'too many words', 413);

  const pronunciations = cleanPronunciations(body && body.pronunciations);
  const corrections = cleanCorrections(body && body.corrections);

  // Nothing to weigh: no round trip, and the caller keeps the text as heard.
  if (!pronunciations.length && !corrections.length) {
    return json({ changes: [], provider: provider.name, model: '' }, 200);
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  try {
    const { changes, model } = await provider.correct({
      tokens, pronunciations, corrections, signal: abort.signal, env
    });
    return json({ changes: validateChanges(changes, tokens), provider: provider.name, model }, 200);
  } catch (e) {
    // The provider's own message can carry request ids and key fragments; the
    // code is enough for the note the parent sees, and the rest goes to the log.
    console.error('contextual correction failed', e && e.message);
    return fail(e && e.code ? e.code : 'provider-error', 'correction failed',
      e && e.status ? e.status : 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The model's answer is data, not instruction. A change is kept only if it
 * points at a real word position and actually changes something; anything else
 * is dropped rather than trusted, because a bad index would silently rewrite
 * the wrong word.
 */
export function validateChanges(changes, tokens) {
  if (!Array.isArray(changes)) return [];
  const seen = new Set();
  return changes
    .filter((change) => change && typeof change === 'object')
    .map((change) => ({
      index: Number(change.index),
      to: typeof change.to === 'string' ? change.to.trim() : '',
      reason: typeof change.reason === 'string' ? change.reason.trim().slice(0, 300) : ''
    }))
    .filter((change) => {
      if (!Number.isInteger(change.index)) return false;
      if (change.index < 0 || change.index >= tokens.length) return false;
      if (!change.to || change.to.length > MAX_WORD_LENGTH) return false;
      // One word out, one word in — a replacement that adds words would change
      // the shape of the sentence, which this is not allowed to do.
      if (/\s/.test(change.to)) return false;
      // "Liquor" for "liquor." is the same word in a different coat; the
      // browser fits case and punctuation to the original, so a change that
      // only differs there would fit back to no change at all.
      if (bareWord(change.to) === bareWord(tokens[change.index])) return false;
      if (seen.has(change.index)) return false;
      seen.add(change.index);
      return true;
    });
}

function bareWord(word) {
  return String(word).replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').toLowerCase();
}

function cleanTokens(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((word) => typeof word === 'string' && word.trim())
    .map((word) => word.trim().slice(0, MAX_WORD_LENGTH));
}

function cleanPronunciations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.word === 'string' && Array.isArray(entry.spellings))
    .map((entry) => ({
      word: entry.word.trim().slice(0, MAX_WORD_LENGTH),
      spellings: entry.spellings
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, MAX_WORD_LENGTH))
        .slice(0, 12)
    }))
    .filter((entry) => entry.word && entry.spellings.length)
    .slice(0, MAX_PATTERNS);
}

function cleanCorrections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.heard === 'string' && typeof entry.means === 'string')
    .map((entry) => ({
      heard: entry.heard.trim().slice(0, MAX_WORD_LENGTH),
      means: entry.means.trim().slice(0, MAX_WORD_LENGTH)
    }))
    .filter((entry) => entry.heard && entry.means)
    .slice(0, MAX_PATTERNS);
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

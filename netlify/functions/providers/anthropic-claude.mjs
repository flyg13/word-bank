// Context-aware correction provider: Claude Opus 5 on the direct Anthropic
// API (api.anthropic.com).
//
// Why this and not Bedrock (parent's decision, September 2026): the Bedrock
// account has a model agreement for Claude Sonnet 4.5 only — Opus 4.8 answers
// 403 "not available for this account" — and Sonnet 4.5 failed the context
// test twice, changing "a bottle of liquor" to "a bottle of little" even after
// the prompt was made to read the original first. This is a judgement task,
// and the judgement was the failure; the fix is a stronger model, and the
// direct API is where Opus 5 is available today. The Bedrock provider stays
// in the next file, selected by CONTEXT_PROVIDER, for when the account's
// Sonnet 5 access comes through — the residency reasoning in CLAUDE.md §10
// still stands, and it is one variable away.
//
// The key is read here and nowhere else. It is the standard Anthropic API key
// (ANTHROPIC_API_KEY), set in Netlify, never in the repo or the bundle.

import Anthropic from '@anthropic-ai/sdk';
import { DECIDE, SYSTEM, buildPrompt } from './claude-prompt.mjs';

// The prompt is shared with the Bedrock provider; re-exported so a test can
// read it from either.
export { buildPrompt };

// Opus 5 thinks before it answers when the request carries no `thinking`
// parameter (adaptive thinking is its default), which is exactly what a
// judgement call wants and what Sonnet 4.5 could not do here. Override with
// ANTHROPIC_MODEL; an older model given the same request simply answers
// without thinking, because the request names no thinking form at all.
const DEFAULT_MODEL = 'claude-opus-5';

// Thinking and the answer share this cap. The answer is a short tool call;
// the rest is room to think about a sentence, not a budget to fill.
const MAX_TOKENS = 8192;

// How hard the model thinks before it answers. The API's own default is
// `high`, and that is what the first session on Opus 5 complained about: the
// pause before the corrected text settles is too long with a nine-year-old
// sitting there waiting for it. `medium` is one notch down — the first step
// that buys latency back, and the level to try before giving up depth.
//
// This is the tuning dial, not a decision made once: ANTHROPIC_EFFORT moves it
// without a deploy of new code, so if `medium` ever gets one of her sentences
// wrong the answer is `high` in Netlify, and if it is still too slow the
// answer is `low`. A value that is not a real level is ignored rather than
// sent — the API would refuse it, and a typo in an environment variable must
// not be what silently drops her back to the blind find-and-replace.
const DEFAULT_EFFORT = 'medium';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function effortFrom(env) {
  const asked = String((env && env.ANTHROPIC_EFFORT) || '').trim().toLowerCase();
  return EFFORT_LEVELS.includes(asked) ? asked : DEFAULT_EFFORT;
}

export const name = 'anthropic-claude';
export const keyVar = 'ANTHROPIC_API_KEY';

export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The provider interface: words in, decisions out. The one file to replace to
 * change model or platform; nothing above it knows which API answered.
 *
 * @param {{
 *   tokens: string[],
 *   pronunciations: Array<{word: string, spellings: string[]}>,
 *   corrections: Array<{heard: string, means: string}>,
 *   signal?: AbortSignal,
 *   env: Record<string, string|undefined>
 * }} request
 * @returns {Promise<{changes: Array<{index:number,to:string,reason:string}>, model: string}>}
 */
export async function correct({ tokens, pronunciations, corrections, signal, env }) {
  const key = env[keyVar];
  if (!key) throw new ProviderError('not-configured', keyVar + ' is not set', 503);

  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: key, maxRetries: 1 });

  let message;
  try {
    message = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        // No thinking parameter, on purpose: see DEFAULT_MODEL. No sampling
        // parameters either — Opus 5 rejects non-default ones, and a
        // judgement should not be a dice roll anyway. Effort is how deeply it
        // thinks while it does think; see DEFAULT_EFFORT.
        output_config: { effort: effortFrom(env) },
        tools: [DECIDE],
        tool_choice: { type: 'tool', name: DECIDE.name },
        messages: [{ role: 'user', content: buildPrompt(tokens, pronunciations, corrections) }]
      },
      { signal }
    );
  } catch (e) {
    throw asProviderError(e, signal);
  }

  // A safety classifier can end the turn before any content; that is not a
  // decision, and the caller falls back rather than pretending it was.
  const call = (message.content || []).find((block) => block.type === 'tool_use');
  if (!call || !call.input || !Array.isArray(call.input.changes)) {
    throw new ProviderError('bad-response', 'model did not report any decision');
  }
  return { changes: call.input.changes, model };
}

// ---------------------------------------------------------------------------
// Diagnosis: what this key can see on the direct API.
//
// Smaller than Bedrock's, because there is less to go wrong: no region, no
// inference profiles, no per-model agreement. The questions left are whether
// the key is accepted, whether the configured model ID resolves, and — on
// request — what one tiny request through the same endpoint correction uses
// actually says. Every failure is reported as a status and a redacted
// message rather than thrown; the point is to see the failures.
// ---------------------------------------------------------------------------

/**
 * @param {{ env: Record<string, string|undefined>, probe?: string|null }} request
 *   `probe` — when present, send a one-token request to this model ID (or, if
 *   empty, to the configured one) and report exactly what came back.
 */
export async function diagnose({ env, probe }) {
  const key = env[keyVar];
  const configured = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const report = {
    provider: name,
    keyConfigured: Boolean(key),
    configuredModel: configured,
    configuredEffort: effortFrom(env),
    endpoint: 'https://api.anthropic.com',
    calls: {}
  };
  if (!key) {
    report.error = 'not-configured';
    return report;
  }

  const redact = (text) => String(text == null ? '' : text).split(key).join('[key]').slice(0, 400);
  const client = new Anthropic({ apiKey: key, maxRetries: 0 });

  // 1. The models this key can see. Also the cheapest possible check that the
  //    key is accepted at all: a rejected key fails here without spending a
  //    token.
  const models = [];
  try {
    for await (const info of client.models.list({ limit: 100 })) {
      models.push({ id: info.id, name: info.display_name });
      if (models.length >= 200) break;
    }
    report.calls.listModels = { status: 200, error: null };
    report.models = models;
  } catch (e) {
    report.calls.listModels = { status: statusOf(e), error: redact(e && e.message) };
    report.models = null;
  }

  // 2. Does the configured ID resolve? Aliases such as `claude-opus-5` come
  //    back with the ID the API resolves them to, which is worth seeing.
  try {
    const info = await client.models.retrieve(configured);
    report.configuredModelResolves = true;
    report.calls.retrieveModel = { status: 200, error: null };
    report.configuredModelInfo = { id: info.id, name: info.display_name };
  } catch (e) {
    report.configuredModelResolves = false;
    report.calls.retrieveModel = { status: statusOf(e), error: redact(e && e.message) };
  }

  // 3. Optionally, ask the Messages endpoint itself — the one correction uses
  //    — with the smallest request there is, and report exactly what it says.
  if (probe !== undefined && probe !== null) {
    const model = probe || configured;
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      });
      report.probe = { model, ok: true, answeredBy: message && message.model };
    } catch (e) {
      report.probe = {
        model,
        ok: false,
        status: statusOf(e),
        code: asProviderError(e).code,
        message: redact(e && e.message)
      };
    }
  }

  return report;
}

function statusOf(e) {
  return e && typeof e.status === 'number' ? e.status : 0;
}

function asProviderError(e, signal) {
  // The SDK's abort error carries no status; the signal is the reliable tell.
  if ((signal && signal.aborted) || (e && e.name === 'AbortError')) {
    return new ProviderError('timeout', 'provider timed out', 504);
  }
  const status = statusOf(e);
  if (status === 401 || status === 403) {
    return new ProviderError('not-authorised', 'provider rejected the key', status);
  }
  // 529 is the API's own "overloaded"; to the banner it is the same thing as
  // busy, and worth trying again in a moment.
  if (status === 429 || status === 529) return new ProviderError('rate-limited', 'provider is busy', 429);
  if (status === 404) return new ProviderError('model-not-found', 'provider has no such model', 502);
  if (status >= 400) return new ProviderError('provider-error', 'provider returned ' + status, 502);
  return new ProviderError('unreachable', 'could not reach the provider', 502);
}

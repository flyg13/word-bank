// Context-aware correction provider: Claude on Amazon Bedrock, through the
// classic InvokeModel endpoint, ap-southeast-2 (Sydney).
//
// Why Bedrock and not the first-party API: the parent's decision, and the same
// reasoning as CLAUDE.md §9's residency note — a school asking where a child's
// speech is processed gets an Australian region as the answer.
//
// Why the classic endpoint and not the Messages-API one (bedrock-mantle): this
// account is not enabled for the newer endpoint. Every model there answered
// 403 "not available for this account, contact AWS Sales", and the older
// models 404. The classic endpoint is proven on the same account — the
// parent's worksheet generator runs Claude Sonnet 4.5 through it in Sydney —
// so this is the official Bedrock SDK's classic client, which posts the same
// Messages-API body to /model/{id}/invoke. Nothing above the provider knows.
//
// Auth is a Bedrock API key (bearer token), not SigV4: the classic client
// takes it as `apiKey` and sends `Authorization: Bearer`. Netlify reserves
// AWS_-prefixed variable names, hence BEDROCK_API_KEY rather than
// AWS_BEARER_TOKEN_BEDROCK.

import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { DECIDE, SYSTEM, buildPrompt } from './claude-prompt.mjs';

// The prompt is shared with the direct-API provider; re-exported so a test
// can read it from either.
export { buildPrompt };

const DEFAULT_REGION = 'ap-southeast-2';

// An inference-profile ID, because the classic endpoint serves newer Claude
// models only through cross-region inference — a bare `anthropic.` ID is
// refused with a 400 asking for a profile. `au.` routes within the Australian
// regions. The versioned Sonnet 4.5 ID is the one this account is known to
// have; the diagnostic (context-diagnose) lists what else it can see. Override
// with BEDROCK_MODEL, and change BEDROCK_REGION with it: the profiles a region
// offers depend on the region.
const DEFAULT_MODEL = 'au.anthropic.claude-sonnet-4-5-20250929-v1:0';

export const name = 'bedrock-claude';
export const keyVar = 'BEDROCK_API_KEY';

export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The provider interface: words in, decisions out. The one file to replace to
 * change model or platform; nothing above it knows Bedrock exists.
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

  const region = env.BEDROCK_REGION || DEFAULT_REGION;
  const model = env.BEDROCK_MODEL || DEFAULT_MODEL;

  const client = new AnthropicBedrock({ apiKey: key, awsRegion: region, maxRetries: 1 });

  let message;
  try {
    message = await client.messages.create(
      {
        model,
        max_tokens: 2048,
        system: SYSTEM,
        // No thinking parameter: Sonnet 4.5 takes the older budget form, the
        // 4.6+ models the adaptive form, and the ID is configurable — so the
        // request stays on the surface every Claude model accepts. The
        // judgement is small, and a child is waiting for the screen to fill in.
        tools: [DECIDE],
        tool_choice: { type: 'tool', name: DECIDE.name },
        messages: [{ role: 'user', content: buildPrompt(tokens, pronunciations, corrections) }]
      },
      { signal }
    );
  } catch (e) {
    throw asProviderError(e);
  }

  const call = message.content.find((block) => block.type === 'tool_use');
  if (!call || !call.input || !Array.isArray(call.input.changes)) {
    throw new ProviderError('bad-response', 'model did not report any decision');
  }
  return { changes: call.input.changes, model };
}

// ---------------------------------------------------------------------------
// Diagnosis: what this account can actually see in this region.
//
// The first two model IDs tried in Sydney were both answered with a 404 (see
// the region note above), and
// the console's inference-profile list showed no Anthropic entries at all. Two
// different problems produce that picture — the account has not been granted
// access to Anthropic models in the region, or the ID is simply not one this
// endpoint routes — and guessing IDs cannot tell them apart. These are the
// read-only control-plane calls that can: the models offered in the region,
// the system-defined inference profiles, and the per-model availability record
// (which says outright whether the account is authorised). Same bearer key,
// sent to AWS's control plane as a bearer token.
//
// Nothing here is cached and nothing is written; every failure is reported as
// a status and a redacted message rather than thrown, because the whole point
// is to see the failures.
// ---------------------------------------------------------------------------

const GEO_PREFIX = /^(global|us|eu|jp|apac|au)\./;

/**
 * @param {{ env: Record<string, string|undefined>, probe?: string|null }} request
 *   `probe` — when present, send a one-token request to this model ID (or, if
 *   empty, to the configured one) and report exactly what came back.
 */
export async function diagnose({ env, probe }) {
  const key = env[keyVar];
  const region = env.BEDROCK_REGION || DEFAULT_REGION;
  const configured = env.BEDROCK_MODEL || DEFAULT_MODEL;
  const report = {
    provider: name,
    region,
    keyConfigured: Boolean(key),
    configuredModel: configured,
    invokeEndpoint: 'https://bedrock-runtime.' + region + '.amazonaws.com',
    calls: {}
  };
  if (!key) {
    report.error = 'not-configured';
    return report;
  }

  const redact = (text) => String(text == null ? '' : text).split(key).join('[key]').slice(0, 400);
  const control = 'https://bedrock.' + region + '.amazonaws.com';
  const get = async (path) => {
    try {
      const res = await fetch(control + path, {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* not JSON — kept as the error text */ }
      return { status: res.status, data: res.ok ? data : null, error: res.ok ? null : redact(text) };
    } catch (e) {
      return { status: 0, data: null, error: redact(e && e.message) };
    }
  };

  // 1. Anthropic foundation models offered in this region.
  const models = await get('/foundation-models?byProvider=anthropic');
  report.calls.foundationModels = { status: models.status, error: models.error };
  report.foundationModels = models.data
    ? (models.data.modelSummaries || []).map((m) => ({
      id: m.modelId,
      name: m.modelName,
      inferenceTypes: m.inferenceTypesSupported || [],
      lifecycle: m.modelLifecycle && m.modelLifecycle.status
    }))
    : null;

  // 2. Every system-defined inference profile, all pages, then only Anthropic's.
  const profiles = [];
  let next = null;
  let pages = 0;
  let profileStatus = null;
  let profileError = null;
  do {
    const page = await get(
      '/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000' +
      (next ? '&nextToken=' + encodeURIComponent(next) : '')
    );
    profileStatus = page.status;
    profileError = page.error;
    if (!page.data) break;
    profiles.push(...(page.data.inferenceProfileSummaries || []));
    next = page.data.nextToken || null;
    pages += 1;
  } while (next && pages < 20);
  report.calls.inferenceProfiles = { status: profileStatus, error: profileError, pages };
  report.inferenceProfileCount = profileError && !profiles.length ? null : profiles.length;
  report.anthropicInferenceProfiles = profileError && !profiles.length ? null : profiles
    .filter((p) => /anthropic/i.test(p.inferenceProfileId || '') || /claude/i.test(p.inferenceProfileName || ''))
    .map((p) => ({
      id: p.inferenceProfileId,
      name: p.inferenceProfileName,
      status: p.status,
      regions: (p.models || []).map((m) => (String(m.modelArn || '').split(':')[3] || '')).filter(Boolean)
    }));

  // 3. Is the account authorised for the IDs it might use here?
  const bare = configured.replace(GEO_PREFIX, '');
  const candidates = [...new Set([configured, bare, 'global.' + bare, 'au.' + bare, 'apac.' + bare])];
  report.availability = {};
  for (const id of candidates) {
    const avail = await get('/foundation-model-availability/' + encodeURIComponent(id));
    report.availability[id] = avail.data
      ? {
        authorizationStatus: avail.data.authorizationStatus,
        entitlementAvailability: avail.data.entitlementAvailability,
        regionAvailability: avail.data.regionAvailability,
        agreementAvailability: avail.data.agreementAvailability
      }
      : { status: avail.status, error: avail.error };
  }

  // 4. Optionally, ask the InvokeModel endpoint itself — the one correction
  //    uses — with the smallest request there is, and report exactly what it
  //    says.
  if (probe !== undefined && probe !== null) {
    const model = probe || configured;
    const client = new AnthropicBedrock({ apiKey: key, awsRegion: region, maxRetries: 0 });
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
        status: e && typeof e.status === 'number' ? e.status : 0,
        code: asProviderError(e).code,
        message: redact(e && e.message)
      };
    }
  }

  return report;
}

function asProviderError(e) {
  if (e && e.name === 'AbortError') return new ProviderError('timeout', 'provider timed out', 504);
  const status = e && typeof e.status === 'number' ? e.status : 0;
  if (status === 401 || status === 403) {
    return new ProviderError('not-authorised', 'provider rejected the key', status);
  }
  if (status === 429) return new ProviderError('rate-limited', 'provider is busy', 429);
  // Bedrock answers 404 when the model ID has no route in the region — a bare
  // model ID where an inference profile is needed, or a model not offered
  // there. Named on its own so the banner says which, not just "a problem".
  if (status === 404) return new ProviderError('model-not-found', 'provider has no such model in this region', 502);
  // The classic endpoint's own way of saying the same thing: a 400 telling
  // you to "retry your request with the ID or ARN of an inference profile".
  if (status === 400 && /inference profile/i.test(String(e && e.message))) {
    return new ProviderError('needs-inference-profile', 'model ID needs an inference profile here', 502);
  }
  if (status >= 400) return new ProviderError('provider-error', 'provider returned ' + status, 502);
  return new ProviderError('unreachable', 'could not reach the provider', 502);
}

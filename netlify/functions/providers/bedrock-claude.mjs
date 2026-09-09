// Context-aware correction provider: Claude Sonnet 5 on Amazon Bedrock,
// ap-southeast-2 (Sydney).
//
// Why Bedrock and not the first-party API: the parent's decision, and the same
// reasoning as CLAUDE.md §9's residency note — a school asking where a child's
// speech is processed gets "Sydney" as the answer.
//
// Auth is a Bedrock API key (bearer token), not SigV4. The Messages-API Bedrock
// endpoint accepts that as `x-api-key`, which is exactly what the standard
// Anthropic client sends — so this is the official SDK pointed at a base URL,
// not a hand-rolled HTTP call. Netlify reserves AWS_-prefixed variable names,
// hence BEDROCK_API_KEY rather than AWS_BEARER_TOKEN_BEDROCK.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_REGION = 'ap-southeast-2';

// An inference-profile ID, not the bare model ID. Sydney has no in-region
// endpoint for Claude on Bedrock — only Melbourne (ap-southeast-4) does — so a
// request for `anthropic.claude-sonnet-5` in ap-southeast-2 is answered with a
// 404, which is what the Netlify log showed on the first real device. The `au.`
// profile routes within the Australian regions (Sydney and Melbourne), which
// keeps the residency answer "Australia". There is no `apac.` profile for this
// model, and `global.` would route anywhere. Override with BEDROCK_MODEL.
const DEFAULT_MODEL = 'au.anthropic.claude-sonnet-5';

export const name = 'bedrock-claude';
export const keyVar = 'BEDROCK_API_KEY';

export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// The one thing the model must return. A tool call rather than free text
// because Bedrock does not support structured outputs, and this is the next
// most reliable way to get a shape back. Every field is still validated after.
const DECIDE = {
  name: 'report_corrections',
  description: 'Report which numbered words are the child mispronouncing a different word.',
  input_schema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'Only words that should change. Leave empty if none should.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The number shown beside the word.' },
            to: { type: 'string', description: 'The word she meant.' },
            reason: {
              type: 'string',
              description: 'One short sentence: what in the sentence made this the right call.'
            }
          },
          required: ['index', 'to', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['changes'],
    additionalProperties: false
  }
};

// Deliberately narrow. The bank is the only source of what may change; without
// this the model becomes a general autocorrect, and an app whose whole job is
// noticing how she actually speaks would start hiding it.
const SYSTEM = [
  'You are helping a parent read a speech-to-text transcript of their 9-year-old daughter.',
  'She has a speech difficulty, and the recogniser sometimes writes a different real word',
  'than the one she meant. The parent has recorded which words she says unusually.',
  '',
  'You are given the transcript as numbered words, plus two lists from her records:',
  'how she pronounces certain words, and mishearings the parent has already confirmed.',
  '',
  'For each numbered word, decide from the surrounding sentence whether it is her saying',
  'a different word, or whether it is genuinely the word written. Report only the words',
  'that should change.',
  '',
  'Rules you must follow:',
  '- Only change a word that one of the two lists covers. Never fix spelling, grammar,',
  '  punctuation or word choice you were not given a pattern for.',
  '- A pattern is evidence, not an instruction. If the sentence reads naturally with the',
  '  word as written, leave it, even when a pattern matches it.',
  '- When the sentence does not settle it, leave the word alone. A missed correction is',
  '  recoverable; a wrong one is not, because the parent may not notice it.',
  '- Keep her wording. Do not reorder, add or remove words.'
].join('\n');

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

  const client = new Anthropic({
    apiKey: key,
    baseURL: 'https://bedrock-mantle.' + region + '.api.aws/anthropic',
    maxRetries: 1
  });

  let message;
  try {
    message = await client.messages.create(
      {
        model,
        max_tokens: 2048,
        system: SYSTEM,
        // Adaptive thinking, at the lowest effort: the judgement is real but
        // small, and a child is waiting for the screen to fill in.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
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

/**
 * Numbering the words is what makes this safe: the model reports decisions
 * against positions rather than rewriting the sentence, so it cannot quietly
 * reorder, drop or add words, and nothing has to be re-aligned afterwards.
 */
export function buildPrompt(tokens, pronunciations, corrections) {
  const lines = [];

  lines.push('Transcript, one numbered word per line:');
  tokens.forEach((word, index) => lines.push(index + '. ' + word));

  lines.push('', 'How she says certain words:');
  if (pronunciations.length) {
    pronunciations.forEach((entry) =>
      lines.push('- "' + entry.word + '" she says as: ' + entry.spellings.join(', '))
    );
  } else {
    lines.push('- (none recorded)');
  }

  lines.push('', 'Mishearings the parent has already confirmed:');
  if (corrections.length) {
    corrections.forEach((entry) =>
      lines.push('- the recogniser writes "' + entry.heard + '" when she means "' + entry.means + '"')
    );
  } else {
    lines.push('- (none confirmed)');
  }

  lines.push(
    '',
    'Report only the numbered words that should change.'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Diagnosis: what this account can actually see in this region.
//
// The first two model IDs tried in Sydney were both answered with a 404, and
// the console's inference-profile list showed no Anthropic entries at all. Two
// different problems produce that picture — the account has not been granted
// access to Anthropic models in the region, or the ID is simply not one this
// endpoint routes — and guessing IDs cannot tell them apart. These are the
// read-only control-plane calls that can: the models offered in the region,
// the system-defined inference profiles, and the per-model availability record
// (which says outright whether the account is authorised). Same bearer key,
// sent as a bearer token rather than as x-api-key, because these are AWS's own
// APIs rather than the Messages-API endpoint.
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
    messagesEndpoint: 'https://bedrock-mantle.' + region + '.api.aws/anthropic',
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
  const candidates = [...new Set([configured, bare, 'global.' + bare, 'au.' + bare])];
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

  // 4. Optionally, ask the Messages endpoint itself, with the smallest request
  //    there is, and report exactly what it says.
  if (probe !== undefined && probe !== null) {
    const model = probe || configured;
    const client = new Anthropic({ apiKey: key, baseURL: report.messagesEndpoint, maxRetries: 0 });
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
  if (status >= 400) return new ProviderError('provider-error', 'provider returned ' + status, 502);
  return new ProviderError('unreachable', 'could not reach the provider', 502);
}

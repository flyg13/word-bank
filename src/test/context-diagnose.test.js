// The diagnostic function: what the account can see, reported without guessing
// and without the key. Nothing reaches AWS — fetch and the SDK are replaced.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options) {
      this.options = options;
      this.messages = { create };
      create.lastClient = options;
    }
  }
}));

const { default: handler } = await import('../../netlify/functions/context-diagnose.mjs');
const ROOT = resolve(__dirname, '../..');
const KEY = 'bedrock-secret-token-9f8e';

const get = (query = '') =>
  handler(new Request('https://example.test/.netlify/functions/context-diagnose' + query, { method: 'GET' }));

/** A fake control plane: routes by path, records every request. */
function serveBedrock(routes) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    const path = new URL(url).pathname + new URL(url).search;
    const hit = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    const answer = hit ? routes[hit](path) : { status: 404, body: { message: 'no route ' + path } };
    return new Response(
      typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
      { status: answer.status }
    );
  });
  return calls;
}

const OFFERED = {
  modelSummaries: [
    { modelId: 'anthropic.claude-sonnet-5', modelName: 'Claude Sonnet 5',
      inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'ACTIVE' } },
    { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', modelName: 'Claude Haiku 4.5',
      inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'ACTIVE' } }
  ]
};

const PROFILES_PAGE_1 = {
  inferenceProfileSummaries: [
    { inferenceProfileId: 'au.amazon.nova-lite-v1:0', inferenceProfileName: 'AU Nova Lite', status: 'ACTIVE', models: [] },
    { inferenceProfileId: 'au.anthropic.claude-sonnet-4-5-20250929-v1:0', inferenceProfileName: 'AU Anthropic Claude Sonnet 4.5',
      status: 'ACTIVE',
      models: [
        { modelArn: 'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0' },
        { modelArn: 'arn:aws:bedrock:ap-southeast-4::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0' }
      ] }
  ],
  nextToken: 'page-2'
};
const PROFILES_PAGE_2 = {
  inferenceProfileSummaries: [
    { inferenceProfileId: 'au.anthropic.claude-sonnet-5', inferenceProfileName: 'AU Anthropic Claude Sonnet 5',
      status: 'ACTIVE', models: [{ modelArn: 'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-sonnet-5' }] }
  ]
};

describe('the diagnostic function', () => {
  beforeEach(() => {
    create.mockReset();
    process.env.BEDROCK_API_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.BEDROCK_API_KEY;
    delete process.env.BEDROCK_REGION;
    delete process.env.BEDROCK_MODEL;
    delete globalThis.fetch;
  });

  it('is GET only', async () => {
    const res = await handler(new Request('https://example.test/x', { method: 'POST' }));
    expect(res.status).toBe(405);
  });

  it('says so, and asks nothing, when there is no key', async () => {
    delete process.env.BEDROCK_API_KEY;
    globalThis.fetch = vi.fn();
    const report = await (await get()).json();
    expect(report.keyConfigured).toBe(false);
    expect(report.error).toBe('not-configured');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('asks the region’s control plane with the key as a bearer token', async () => {
    const calls = serveBedrock({
      '/foundation-models': () => ({ status: 200, body: OFFERED }),
      '/inference-profiles': (path) => ({ status: 200, body: path.includes('nextToken=page-2') ? PROFILES_PAGE_2 : PROFILES_PAGE_1 }),
      '/foundation-model-availability/': () => ({ status: 200, body: { authorizationStatus: 'AUTHORIZED', entitlementAvailability: 'AVAILABLE', regionAvailability: 'AVAILABLE', agreementAvailability: { status: 'AVAILABLE' } } })
    });
    const report = await (await get()).json();
    expect(report.region).toBe('ap-southeast-2');
    calls.forEach((call) => {
      expect(call.url.startsWith('https://bedrock.ap-southeast-2.amazonaws.com/')).toBe(true);
      expect(call.headers.Authorization).toBe('Bearer ' + KEY);
    });
  });

  it('lists the Anthropic models offered, and only the Anthropic profiles, across every page', async () => {
    serveBedrock({
      '/foundation-models': () => ({ status: 200, body: OFFERED }),
      '/inference-profiles': (path) => ({ status: 200, body: path.includes('nextToken=page-2') ? PROFILES_PAGE_2 : PROFILES_PAGE_1 }),
      '/foundation-model-availability/': () => ({ status: 200, body: { authorizationStatus: 'AUTHORIZED' } })
    });
    const report = await (await get()).json();
    expect(report.foundationModels.map((m) => m.id)).toEqual([
      'anthropic.claude-sonnet-5', 'anthropic.claude-haiku-4-5-20251001-v1:0'
    ]);
    expect(report.inferenceProfileCount).toBe(3);
    expect(report.calls.inferenceProfiles.pages).toBe(2);
    expect(report.anthropicInferenceProfiles.map((p) => p.id)).toEqual([
      'au.anthropic.claude-sonnet-4-5-20250929-v1:0', 'au.anthropic.claude-sonnet-5'
    ]);
    // The regions a profile routes to are what "stays in Australia" rests on.
    expect(report.anthropicInferenceProfiles[0].regions).toEqual(['ap-southeast-2', 'ap-southeast-4']);
  });

  it('checks authorisation for the configured ID, its bare form, and the global and AU forms', async () => {
    process.env.BEDROCK_MODEL = 'au.anthropic.claude-sonnet-5';
    const asked = [];
    serveBedrock({
      '/foundation-models': () => ({ status: 200, body: OFFERED }),
      '/inference-profiles': () => ({ status: 200, body: PROFILES_PAGE_2 }),
      '/foundation-model-availability/': (path) => {
        asked.push(decodeURIComponent(path.split('/foundation-model-availability/')[1]));
        return { status: 200, body: { authorizationStatus: 'NOT_AUTHORIZED', entitlementAvailability: 'NOT_AVAILABLE', regionAvailability: 'AVAILABLE' } };
      }
    });
    const report = await (await get()).json();
    expect(asked).toEqual([
      'au.anthropic.claude-sonnet-5', 'anthropic.claude-sonnet-5', 'global.anthropic.claude-sonnet-5'
    ]);
    expect(report.availability['anthropic.claude-sonnet-5'].authorizationStatus).toBe('NOT_AUTHORIZED');
  });

  it('reports a refused control-plane call as a status and message, never a crash', async () => {
    serveBedrock({
      '/foundation-models': () => ({ status: 403, body: { message: 'User is not authorized to perform bedrock:ListFoundationModels' } }),
      '/inference-profiles': () => ({ status: 403, body: { message: 'denied' } }),
      '/foundation-model-availability/': () => ({ status: 403, body: { message: 'denied' } })
    });
    const res = await get();
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.foundationModels).toBeNull();
    expect(report.anthropicInferenceProfiles).toBeNull();
    expect(report.calls.foundationModels.status).toBe(403);
    expect(report.calls.foundationModels.error).toContain('ListFoundationModels');
  });

  it('never lets the key into the report, even when the provider echoes it', async () => {
    serveBedrock({
      '/foundation-models': () => ({ status: 401, body: { message: 'bad token ' + KEY } }),
      '/inference-profiles': () => ({ status: 401, body: 'bad token ' + KEY }),
      '/foundation-model-availability/': () => ({ status: 401, body: { message: KEY } })
    });
    create.mockRejectedValue(Object.assign(new Error('rejected ' + KEY), { status: 404 }));
    const text = await (await get('?probe')).text();
    expect(text).not.toContain(KEY);
    expect(text).toContain('[key]');
  });

  it('probes the Messages endpoint on request, with one token, and says what came back', async () => {
    serveBedrock({
      '/foundation-models': () => ({ status: 200, body: OFFERED }),
      '/inference-profiles': () => ({ status: 200, body: PROFILES_PAGE_2 }),
      '/foundation-model-availability/': () => ({ status: 200, body: { authorizationStatus: 'AUTHORIZED' } })
    });
    create.mockRejectedValue(Object.assign(new Error('model not found'), { status: 404 }));
    const report = await (await get('?probe=anthropic.claude-sonnet-5')).json();
    expect(create.lastClient.baseURL).toBe('https://bedrock-mantle.ap-southeast-2.api.aws/anthropic');
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'anthropic.claude-sonnet-5', max_tokens: 1 });
    expect(report.probe).toMatchObject({ model: 'anthropic.claude-sonnet-5', ok: false, status: 404, code: 'model-not-found' });

    create.mockResolvedValue({ model: 'claude-sonnet-5' });
    const ok = await (await get('?probe')).json();
    expect(create.mock.calls[1][0].model).toBe('au.anthropic.claude-sonnet-5');
    expect(ok.probe).toEqual({ model: 'au.anthropic.claude-sonnet-5', ok: true, answeredBy: 'claude-sonnet-5' });
  });

  it('does not probe unless asked — a diagnosis must not spend tokens by default', async () => {
    serveBedrock({
      '/foundation-models': () => ({ status: 200, body: OFFERED }),
      '/inference-profiles': () => ({ status: 200, body: PROFILES_PAGE_2 }),
      '/foundation-model-availability/': () => ({ status: 200, body: {} })
    });
    const report = await (await get()).json();
    expect(create).not.toHaveBeenCalled();
    expect(report.probe).toBeUndefined();
  });

  it('follows the region override', async () => {
    process.env.BEDROCK_REGION = 'ap-southeast-4';
    const calls = serveBedrock({
      '/foundation-models': () => ({ status: 200, body: OFFERED }),
      '/inference-profiles': () => ({ status: 200, body: PROFILES_PAGE_2 }),
      '/foundation-model-availability/': () => ({ status: 200, body: {} })
    });
    const report = await (await get()).json();
    expect(report.region).toBe('ap-southeast-4');
    expect(report.messagesEndpoint).toBe('https://bedrock-mantle.ap-southeast-4.api.aws/anthropic');
    expect(calls.every((c) => c.url.startsWith('https://bedrock.ap-southeast-4.amazonaws.com/'))).toBe(true);
  });

  it('is swappable in one file, like its siblings', () => {
    const source = readFileSync(resolve(ROOT, 'netlify/functions/context-diagnose.mjs'), 'utf8');
    expect(source).not.toContain('bedrock-mantle');
    expect(source).not.toContain('amazonaws');
    expect(source).not.toContain('BEDROCK_API_KEY');
    expect(source).not.toContain('claude-sonnet');
    expect(source).toMatch(/provider\.diagnose\(/);
  });
});

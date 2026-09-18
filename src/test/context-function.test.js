// The contextual-correction function and its providers, exercised directly.
// Nothing reaches Anthropic or AWS: both SDKs are replaced, so what is under
// test is this repo's own contract — what it accepts, what it refuses, and
// what it refuses to believe from the model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The direct API — the default provider.
const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options) {
      this.options = options;
      this.messages = { create };
      // Exposed so a test can assert what the client was built with.
      create.lastClient = options;
    }
  }
}));

// Bedrock — kept, and selected by CONTEXT_PROVIDER.
const createBedrock = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  AnthropicBedrock: class {
    constructor(options) {
      this.options = options;
      this.messages = { create: createBedrock };
      createBedrock.lastClient = options;
    }
  }
}));

const { default: handler, validateChanges } = await import('../../netlify/functions/contextual-correct.mjs');
const { buildPrompt } = await import('../../netlify/functions/providers/anthropic-claude.mjs');
const bedrock = await import('../../netlify/functions/providers/bedrock-claude.mjs');
const prompt = await import('../../netlify/functions/providers/claude-prompt.mjs');

const ROOT = resolve(__dirname, '../..');

const PATTERNS = {
  pronunciations: [{ word: 'little', spellings: ['liddle'] }],
  corrections: [{ heard: 'liquor', means: 'little' }]
};

function post(body, { method = 'POST' } = {}) {
  const init = method === 'GET' ? { method } : {
    method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
  };
  return new Request('https://example.test/.netlify/functions/contextual-correct', init);
}

const answers = (changes) => {
  create.mockResolvedValue({
    content: [{ type: 'tool_use', name: 'report_corrections', input: { changes } }]
  });
};

describe('the contextual-correction function', () => {
  beforeEach(() => {
    create.mockReset();
    createBedrock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_EFFORT;
    delete process.env.CONTEXT_PROVIDER;
  });

  it('returns the changes the model reported', async () => {
    answers([{ index: 1, to: 'little', reason: 'A bottle in a child’s sentence.' }]);
    const res = await handler(post({ tokens: ['the', 'liquor', 'bottle'], ...PATTERNS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes).toEqual([
      { index: 1, to: 'little', reason: 'A bottle in a child’s sentence.' }
    ]);
    expect(body.provider).toBe('anthropic-claude');
    expect(body.model).toBe('claude-opus-5');
    expect(createBedrock).not.toHaveBeenCalled();
  });

  it('asks the direct API, with the key from ANTHROPIC_API_KEY and no base URL of its own', async () => {
    // The parent's decision (CLAUDE.md §10): Opus 5 on api.anthropic.com,
    // because the Bedrock account only has Sonnet 4.5 and its judgement was
    // the failure. The SDK's default endpoint is the endpoint.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.lastClient.apiKey).toBe('anthropic-test-key');
    expect(create.lastClient.baseURL).toBeUndefined();
    expect(create.lastClient.awsRegion).toBeUndefined();
  });

  it('sends the sentence and both pattern lists, numbered', async () => {
    answers([]);
    await handler(post({ tokens: ['the', 'liquor', 'bottle'], ...PATTERNS }));
    const request = create.mock.calls[0][0];
    expect(request.model).toBe('claude-opus-5');
    const content = request.messages[0].content;
    expect(content).toContain('1. liquor');
    expect(content).toContain('"little" she says as: liddle');
    expect(content).toContain('writes "liquor" when she means "little"');
  });

  it('tells the model the bank is evidence, not an instruction', async () => {
    // Without this it becomes a general autocorrect, and an app whose job is
    // noticing how she actually speaks would start hiding it.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    const system = create.mock.calls[0][0].system;
    expect(system).toContain('evidence, not an instruction');
    expect(system).toContain('Never fix spelling, grammar');
    expect(system).toMatch(/leave the word alone|leave it/);
  });

  it('makes the model read the word as written before it reaches for a replacement', async () => {
    // The first real test: told "liquor" means "little", it changed "a bottle
    // of liquor" to "a bottle of little" — it matched the pattern without ever
    // asking whether the original already made sense. The order is the fix.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    const request = create.mock.calls[0][0];
    const system = request.system;
    const asWritten = system.indexOf('Read the sentence with the word exactly as written');
    const replacement = system.indexOf('read the sentence with the replacement');
    expect(asWritten).toBeGreaterThan(-1);
    expect(replacement).toBeGreaterThan(asWritten);
    expect(system).toContain('reads clearly better than');
    expect(system).toContain('Reporting no changes is the normal answer');
    expect(system).toContain('same case as the word it replaces');
    // The worked example must not be her own bank entry, or her re-test of
    // "liquor" would be proving the example rather than the rule.
    expect(system).not.toMatch(/liquor|little/);
    // And the user turn repeats the order, right where the words are.
    expect(request.messages[0].content).toContain('read it as written first');
    // The tool asks for the reason before the replacement, for the same reason.
    const item = request.tools[0].input_schema.properties.changes.items;
    expect(Object.keys(item.properties)).toEqual(['index', 'reason', 'to']);
    expect(request.tools[0].description).toContain('empty list is the usual answer');
  });

  it('makes the model answer in a shape, not in prose', async () => {
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    const request = create.mock.calls[0][0];
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_corrections' });
    expect(request.tools[0].input_schema.properties.changes.items.required)
      .toEqual(['index', 'reason', 'to']);
  });

  it('spends nothing when there is nothing to weigh', async () => {
    const res = await handler(post({ tokens: ['the', 'cat', 'sat'], pronunciations: [], corrections: [] }));
    expect((await res.json()).changes).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses anything but POST', async () => {
    const res = await handler(post({}, { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('refuses a request with no words', async () => {
    const res = await handler(post({ tokens: [], ...PATTERNS }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no-text');
  });

  it('refuses a transcript far longer than the app can produce', async () => {
    const many = Array.from({ length: 401 }, () => 'word');
    const res = await handler(post({ tokens: many, ...PATTERNS }));
    expect(res.status).toBe(413);
  });

  it('says so, distinctly, when no key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('not-configured');
    expect(create).not.toHaveBeenCalled();
  });

  it('maps a rejected key to its own code', async () => {
    create.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('not-authorised');
  });

  it('never echoes the provider\'s own message back to the browser', async () => {
    create.mockRejectedValue(Object.assign(new Error('key sk-ant-secret-1234 invalid'), { status: 400 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(await res.text()).not.toContain('sk-ant-secret');
  });

  it('lets Opus 5 think, by sending no thinking parameter, with room to do it', async () => {
    // Omitting `thinking` is adaptive thinking on Opus 5 — the judgement the
    // switch was made for — and no thinking at all on an older model named
    // through ANTHROPIC_MODEL, which is the one shape every model accepts.
    // Thinking and the answer share max_tokens, so it is not the small cap a
    // tool call alone would need. No sampling parameters: Opus 5 rejects
    // non-default ones.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    const request = create.mock.calls[0][0];
    expect(request.thinking).toBeUndefined();
    expect(request.temperature).toBeUndefined();
    expect(request.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_corrections' });
    // The request has a deadline, and it is the function's, not the SDK's.
    expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('asks for less thinking than the API would give by default', async () => {
    // The first session on Opus 5: the pause before the corrected text settles
    // is too long with her sitting there. The API's default is `high`; this is
    // one notch down, and it is the whole latency fix.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.mock.calls[0][0].output_config).toEqual({ effort: 'medium' });
  });

  it('takes the effort level from the environment, so tuning needs no deploy', async () => {
    process.env.ANTHROPIC_EFFORT = 'low';
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.mock.calls[0][0].output_config).toEqual({ effort: 'low' });
  });

  it('accepts every level the model has, however it is typed', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      create.mockReset();
      answers([]);
      process.env.ANTHROPIC_EFFORT = ' ' + level.toUpperCase() + ' ';
      await handler(post({ tokens: ['hello'], ...PATTERNS }));
      expect(create.mock.calls[0][0].output_config).toEqual({ effort: level });
    }
  });

  it('ignores an effort level that is not real, rather than letting the API refuse it', async () => {
    // A typo in a Netlify variable must not be the thing that silently drops
    // her back to the blind find-and-replace: the API would answer 400, the
    // banner would say provider-error, and nothing would say why.
    process.env.ANTHROPIC_EFFORT = 'quickly';
    answers([]);
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].output_config).toEqual({ effort: 'medium' });
  });

  it('names a 404 as model-not-found rather than a generic provider error', async () => {
    create.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('model-not-found');
  });

  it('treats overloaded like rate-limited: try again, not broken', async () => {
    create.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('rate-limited');
  });

  it('reports a refusal or an empty answer as bad-response, never as a decision', async () => {
    create.mockResolvedValue({ stop_reason: 'refusal', content: [] });
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('bad-response');
  });

  it('honours a model override without a code change', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
    answers([]);
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-5');
    expect((await res.json()).model).toBe('claude-sonnet-5');
  });

  it('refuses an unknown CONTEXT_PROVIDER rather than guessing', async () => {
    process.env.CONTEXT_PROVIDER = 'someone-else';
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('no-provider');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the Bedrock provider, kept one variable away', () => {
  // Not deleted, not the default. When the account's Sonnet 5 access on
  // Bedrock comes through, CONTEXT_PROVIDER=bedrock-claude is the whole
  // switch back — so everything it did before must still hold under it.
  const answersBedrock = (changes) => {
    createBedrock.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'report_corrections', input: { changes } }]
    });
  };

  beforeEach(() => {
    create.mockReset();
    createBedrock.mockReset();
    process.env.CONTEXT_PROVIDER = 'bedrock-claude';
    process.env.BEDROCK_API_KEY = 'bedrock-test-token';
    // Present on purpose: the switch must not depend on the other key's absence.
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';
  });
  afterEach(() => {
    delete process.env.CONTEXT_PROVIDER;
    delete process.env.BEDROCK_API_KEY;
    delete process.env.BEDROCK_REGION;
    delete process.env.BEDROCK_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('is selected by CONTEXT_PROVIDER, and the direct API is not touched', async () => {
    answersBedrock([{ index: 1, to: 'little', reason: 'A bottle in a child’s sentence.' }]);
    const res = await handler(post({ tokens: ['the', 'liquor', 'bottle'], ...PATTERNS }));
    const body = await res.json();
    expect(body.provider).toBe('bedrock-claude');
    expect(body.model).toBe('au.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(body.changes).toEqual([{ index: 1, to: 'little', reason: 'A bottle in a child’s sentence.' }]);
    expect(create).not.toHaveBeenCalled();
  });

  it('asks Sydney, through the classic Bedrock client, with the bearer token', async () => {
    // The residency promise in CLAUDE.md §10 is this line of configuration.
    // The classic client builds bedrock-runtime.<region>.amazonaws.com from the
    // region and sends apiKey as a bearer token; no base URL is hand-built.
    answersBedrock([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(createBedrock.lastClient.awsRegion).toBe('ap-southeast-2');
    expect(createBedrock.lastClient.apiKey).toBe('bedrock-test-token');
    expect(createBedrock.lastClient.baseURL).toBeUndefined();
  });

  it('sends the very same prompt and tool as the direct API', async () => {
    // One prompt, two doors. A fix to how the model is asked must reach both.
    answersBedrock([]);
    await handler(post({ tokens: ['the', 'liquor', 'bottle'], ...PATTERNS }));
    const request = createBedrock.mock.calls[0][0];
    expect(request.system).toBe(prompt.SYSTEM);
    expect(request.tools).toEqual([prompt.DECIDE]);
    expect(request.messages[0].content).toBe(buildPrompt(['the', 'liquor', 'bottle'], PATTERNS.pronunciations, PATTERNS.corrections));
    expect(bedrock.buildPrompt).toBe(buildPrompt);
  });

  it('says so, distinctly, when its own key is not configured', async () => {
    delete process.env.BEDROCK_API_KEY;
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('not-configured');
    expect(createBedrock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('asks for an inference-profile ID, and sends no thinking parameter', async () => {
    // The classic endpoint serves newer Claude models only through
    // cross-region inference, so a bare `anthropic.` ID is refused. And the
    // model is configurable across generations with different thinking
    // parameters, so the request carries none.
    answersBedrock([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    const request = createBedrock.mock.calls[0][0];
    expect(request.model).toMatch(/^au\.anthropic\./);
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_corrections' });
  });

  it('names the classic endpoint’s “use an inference profile” 400 on its own', async () => {
    createBedrock.mockRejectedValue(Object.assign(
      new Error("Invocation of model ID anthropic.claude-sonnet-4-5-20250929-v1:0 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model."),
      { status: 400 }
    ));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('needs-inference-profile');
  });

  it('names a 404 as model-not-found rather than a generic provider error', async () => {
    createBedrock.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('model-not-found');
  });

  it('honours a model and region override without a code change', async () => {
    process.env.BEDROCK_MODEL = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
    process.env.BEDROCK_REGION = 'ap-southeast-4';
    answersBedrock([]);
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(createBedrock.mock.calls[0][0].model).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(createBedrock.lastClient.awsRegion).toBe('ap-southeast-4');
    expect((await res.json()).model).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });
});

describe('what the model says is checked, not trusted', () => {
  const tokens = ['the', 'liquor', 'bottle'];

  it('drops a change pointing outside the sentence', () => {
    // The failure this prevents is the worst one available: a bad index would
    // silently rewrite a word nobody looked at.
    expect(validateChanges([{ index: 9, to: 'little', reason: '' }], tokens)).toEqual([]);
    expect(validateChanges([{ index: -1, to: 'little', reason: '' }], tokens)).toEqual([]);
    expect(validateChanges([{ index: 1.5, to: 'little', reason: '' }], tokens)).toEqual([]);
  });

  it('drops a change that would add or remove words', () => {
    // One word out, one word in. Anything else reshapes her sentence.
    expect(validateChanges([{ index: 1, to: 'a little', reason: '' }], tokens)).toEqual([]);
    expect(validateChanges([{ index: 1, to: '', reason: '' }], tokens)).toEqual([]);
  });

  it('drops a change that changes nothing, and a repeated one', () => {
    expect(validateChanges([{ index: 1, to: 'liquor', reason: '' }], tokens)).toEqual([]);
    // Same word in a different coat: the browser fits case and punctuation to
    // the original, so these would fit back to no change at all.
    expect(validateChanges([{ index: 1, to: 'Liquor', reason: '' }], tokens)).toEqual([]);
    expect(validateChanges([{ index: 1, to: 'liquor.', reason: '' }], tokens)).toEqual([]);
    expect(validateChanges([{ index: 0, to: 'Dad' }], ['dad.', 'liquor'])).toEqual([]);
    expect(validateChanges(
      [{ index: 1, to: 'little', reason: 'a' }, { index: 1, to: 'litter', reason: 'b' }], tokens
    )).toHaveLength(1);
  });

  it('survives a malformed answer entirely', () => {
    expect(validateChanges(null, tokens)).toEqual([]);
    expect(validateChanges(['nonsense', 42, {}], tokens)).toEqual([]);
  });
});

describe('the provider interface', () => {
  it('numbers the words so the model cannot reshape the sentence', () => {
    const prompt = buildPrompt(['the', 'cat'], [], []);
    expect(prompt).toContain('0. the');
    expect(prompt).toContain('1. cat');
    expect(prompt).toContain('(none recorded)');
    expect(prompt).toContain('(none confirmed)');
  });

  it('is swappable in one file, by contract', () => {
    const source = readFileSync(resolve(ROOT, 'netlify/functions/contextual-correct.mjs'), 'utf8');
    expect(source).not.toContain('bedrock-mantle');
    expect(source).not.toContain('bedrock-runtime');
    expect(source).not.toContain('BEDROCK_API_KEY');
    expect(source).not.toContain('claude-sonnet');
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('api.anthropic.com');
    expect(source).not.toContain('claude-opus');
    expect(source).toMatch(/provider\.correct\(/);
  });

  it('keeps the prompt in one place, shared by every Claude provider', () => {
    // The prompt is the load-bearing part (CLAUDE.md §10). Two copies would
    // drift, and the one not in use would drift unnoticed.
    ['anthropic-claude', 'bedrock-claude'].forEach((file) => {
      const source = readFileSync(resolve(ROOT, 'netlify/functions/providers/' + file + '.mjs'), 'utf8');
      expect(source).toContain("from './claude-prompt.mjs'");
      expect(source).not.toContain('evidence, not an instruction');
    });
    const shared = readFileSync(resolve(ROOT, 'netlify/functions/providers/claude-prompt.mjs'), 'utf8');
    expect(shared).not.toContain('@anthropic-ai/');
    expect(shared).not.toContain('_API_KEY');
  });

  it('keeps the SDK out of the browser entirely', () => {
    // Importing it from src/ would work and would be wrong: it would put an
    // API client — and its whole dependency tree — into a page a child loads.
    const { execSync } = require('node:child_process');
    const hits = execSync(
      "grep -rl \"@anthropic-ai/\" src/ || true",
      { cwd: ROOT, encoding: 'utf8' }
    ).trim().split('\n').filter((line) => line && !line.includes('/test/'));
    expect(hits).toEqual([]);
  });

  it('keeps the keys out of the repo and out of the bundle', () => {
    ['src/lib/context-correct.js', 'src/config.js', 'src/features/freewrite.js'].forEach((file) => {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source).not.toContain('BEDROCK_API_KEY');
      expect(source).not.toContain('ANTHROPIC_API_KEY');
    });
    const toml = readFileSync(resolve(ROOT, 'netlify.toml'), 'utf8');
    expect(toml).not.toMatch(/BEDROCK_API_KEY\s*=/);
    expect(toml).not.toMatch(/ANTHROPIC_API_KEY\s*=/);
  });
});

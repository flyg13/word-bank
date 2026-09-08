// The contextual-correction function and its provider, exercised directly.
// Nothing reaches Bedrock: the Anthropic SDK is replaced, so what is under test
// is this repo's own contract — what it accepts, what it refuses, and what it
// refuses to believe from the model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options) {
      this.options = options;
      this.messages = { create };
      // Exposed so a test can assert where the request was pointed.
      create.lastClient = options;
    }
  }
}));

const { default: handler, validateChanges } = await import('../../netlify/functions/contextual-correct.mjs');
const { buildPrompt } = await import('../../netlify/functions/providers/bedrock-claude.mjs');

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
    process.env.BEDROCK_API_KEY = 'bedrock-test-token';
  });
  afterEach(() => {
    delete process.env.BEDROCK_API_KEY;
    delete process.env.BEDROCK_REGION;
    delete process.env.BEDROCK_MODEL;
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
    expect(body.provider).toBe('bedrock-claude');
    expect(body.model).toBe('au.anthropic.claude-sonnet-5');
  });

  it('asks Sydney, over the Bedrock endpoint, with the bearer token', async () => {
    // The residency promise in CLAUDE.md §10 is this line of configuration.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.lastClient.baseURL).toBe('https://bedrock-mantle.ap-southeast-2.api.aws/anthropic');
    expect(create.lastClient.apiKey).toBe('bedrock-test-token');
  });

  it('sends the sentence and both pattern lists, numbered', async () => {
    answers([]);
    await handler(post({ tokens: ['the', 'liquor', 'bottle'], ...PATTERNS }));
    const request = create.mock.calls[0][0];
    expect(request.model).toBe('au.anthropic.claude-sonnet-5');
    const prompt = request.messages[0].content;
    expect(prompt).toContain('1. liquor');
    expect(prompt).toContain('"little" she says as: liddle');
    expect(prompt).toContain('writes "liquor" when she means "little"');
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

  it('makes the model answer in a shape, not in prose', async () => {
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    const request = create.mock.calls[0][0];
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_corrections' });
    expect(request.tools[0].input_schema.properties.changes.items.required)
      .toEqual(['index', 'to', 'reason']);
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
    delete process.env.BEDROCK_API_KEY;
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
    create.mockRejectedValue(Object.assign(new Error('token bedrock-secret-1234 invalid'), { status: 400 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(await res.text()).not.toContain('bedrock-secret');
  });

  it('asks for the AU inference profile, because Sydney has no in-region route', async () => {
    // The first real device got a 404: Bedrock has no single-region endpoint
    // for Claude in ap-southeast-2, only the AU profile (Sydney + Melbourne)
    // or global. The bare model ID is exactly the thing that fails.
    answers([]);
    await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.mock.calls[0][0].model).toBe('au.anthropic.claude-sonnet-5');
    expect(create.mock.calls[0][0].model).not.toMatch(/^anthropic\./);
  });

  it('names a 404 as model-not-found rather than a generic provider error', async () => {
    create.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect((await res.json()).error).toBe('model-not-found');
  });

  it('honours a model and region override without a code change', async () => {
    process.env.BEDROCK_MODEL = 'anthropic.claude-haiku-4-5';
    process.env.BEDROCK_REGION = 'ap-southeast-4';
    answers([]);
    const res = await handler(post({ tokens: ['hello'], ...PATTERNS }));
    expect(create.mock.calls[0][0].model).toBe('anthropic.claude-haiku-4-5');
    expect(create.lastClient.baseURL).toContain('ap-southeast-4');
    expect((await res.json()).model).toBe('anthropic.claude-haiku-4-5');
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
    expect(source).not.toContain('BEDROCK_API_KEY');
    expect(source).not.toContain('claude-sonnet');
    expect(source).toMatch(/provider\.correct\(/);
  });

  it('keeps the SDK out of the browser entirely', () => {
    // Importing it from src/ would work and would be wrong: it would put an
    // API client — and its whole dependency tree — into a page a child loads.
    const { execSync } = require('node:child_process');
    const hits = execSync(
      "grep -rl \"@anthropic-ai/sdk\" src/ || true",
      { cwd: ROOT, encoding: 'utf8' }
    ).trim().split('\n').filter((line) => line && !line.includes('/test/'));
    expect(hits).toEqual([]);
  });

  it('keeps the key out of the repo and out of the bundle', () => {
    ['src/lib/context-correct.js', 'src/config.js', 'src/features/freewrite.js'].forEach((file) => {
      expect(readFileSync(resolve(ROOT, file), 'utf8')).not.toContain('BEDROCK_API_KEY');
    });
    expect(readFileSync(resolve(ROOT, 'netlify.toml'), 'utf8')).not.toMatch(/BEDROCK_API_KEY\s*=/);
  });
});

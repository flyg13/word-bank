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
const DEFAULT_MODEL = 'anthropic.claude-sonnet-5';

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

function asProviderError(e) {
  if (e && e.name === 'AbortError') return new ProviderError('timeout', 'provider timed out', 504);
  const status = e && typeof e.status === 'number' ? e.status : 0;
  if (status === 401 || status === 403) {
    return new ProviderError('not-authorised', 'provider rejected the key', status);
  }
  if (status === 429) return new ProviderError('rate-limited', 'provider is busy', 429);
  if (status >= 400) return new ProviderError('provider-error', 'provider returned ' + status, 502);
  return new ProviderError('unreachable', 'could not reach the provider', 502);
}

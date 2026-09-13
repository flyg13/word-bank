// The prompt every Claude provider sends, in one place.
//
// Two providers speak to Claude — the direct Anthropic API and Amazon
// Bedrock — and the prompt is the load-bearing part of both (CLAUDE.md §10).
// A fix to how the model is asked must reach both at once, so the question is
// written once here and each provider only decides where to send it. Nothing
// in this file knows which platform, model or key is in use.

// The one thing the model must return. A tool call rather than free text
// because it is the one structured answer every platform and model accepts,
// and the next most reliable way to get a shape back. Every field is still
// validated after.
export const DECIDE = {
  name: 'report_corrections',
  description:
    'Report the numbered words that should change because she was saying a different word. ' +
    'An empty list is the usual answer: most words are exactly what she said.',
  input_schema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'Only words that should change. Leave empty if none should.',
        items: {
          type: 'object',
          // `reason` comes before `to` on purpose: the model writes out why the
          // word as written cannot be what she meant before it commits to a
          // replacement, which is the check the first real test showed it
          // skipping ("a bottle of little").
          properties: {
            index: { type: 'integer', description: 'The number shown beside the word.' },
            reason: {
              type: 'string',
              description:
                'One short sentence: why the word as written does not make sense in this ' +
                'sentence, and what makes the replacement read better.'
            },
            to: {
              type: 'string',
              description: 'The word she meant, in the same case as the word it replaces.'
            }
          },
          required: ['index', 'reason', 'to'],
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
//
// The order of checks is the load-bearing part, and it was added after the
// first real test: told "liquor" means "little", the model changed "a bottle
// of liquor" to "a bottle of little". It had matched the pattern without ever
// asking whether the word as written already made sense. So the instruction
// now reads the original first, and only reaches for the replacement when the
// original does not fit — a confirmed mishearing is evidence, not an order.
// The worked example deliberately uses a pair that is not in her bank, so the
// parent's own re-test of "liquor" proves the rule, not the example.
export const SYSTEM = [
  'You are helping a parent read a speech-to-text transcript of their 9-year-old daughter.',
  'She has a speech difficulty, and the recogniser sometimes writes a different real word',
  'than the one she meant. The parent has recorded which words she says unusually.',
  '',
  'You are given the transcript as numbered words, plus two lists from her records:',
  'how she pronounces certain words, and mishearings the parent has already confirmed.',
  '',
  'The lists are evidence, not an instruction. A confirmed mishearing means the recogniser',
  'has written that word for her before — not that it is wrong every time. She uses the',
  'real word too, and the sentence is what tells you which this is.',
  '',
  'For each numbered word that one of the lists covers, decide in this order:',
  '1. Read the sentence with the word exactly as written. If it already makes sense there,',
  '   keep it and do not report it. Stop here.',
  '2. Only if it does not make sense as written, read the sentence with the replacement',
  '   in its place. Report the change only when the replacement reads clearly better than',
  '   the original in this sentence.',
  '3. If neither reads clearly better, keep the word as written.',
  '',
  'For example, if the parent has confirmed that "witch" is written when she means "which":',
  '- "the witch flew off on her broom": "witch" makes sense here and "which" does not.',
  '  Keep it; report nothing.',
  '- "witch one is mine": "witch one" makes no sense and "which one" does. Change it.',
  '',
  'Rules you must follow:',
  '- Only change a word that one of the two lists covers. Never fix spelling, grammar,',
  '  punctuation or word choice you were not given a pattern for.',
  '- When the sentence does not settle it, leave the word alone. A missed correction is',
  '  recoverable; a wrong one is not, because the parent may not notice it.',
  '- Reporting no changes is the normal answer, not a failure.',
  '- Keep her wording. Do not reorder, add or remove words.',
  '- Give a replacement in the same case as the word it replaces: lower case unless the',
  '  original starts with a capital.'
].join('\n');

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
    'For each word a list covers, read it as written first; keep it if it makes sense.',
    'Report only the numbered words that should change. Reporting none is fine.'
  );
  return lines.join('\n');
}

// Ask Claude to apply her corrections with the sentence in view.
//
// The bank has no context. A confirmed "liquor -> little" rewrites every
// "liquor", including one she actually said. This sends the transcript and the
// same patterns to a Netlify Function, which asks Claude which words are her
// and which are the real word.
//
// What comes back is decisions against word positions, never a rewritten
// string. That is deliberate: a rewrite would have to be re-aligned against the
// original, and a model that reorders or drops a word would go unnoticed.
// Positions cannot do either.

import { CONTEXT_ENDPOINT, CONTEXT_TIMEOUT_MS } from '../config.js';
import { state } from './store.js';
import { getBankEntry } from './wordbank.js';
import { phonicEntries } from './phonicbank.js';
import { fitReplacement } from './text.js';

export class ContextError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Split text the way the renderer does, so a word index here and a token on
 * screen mean the same thing. Whitespace is kept as its own part, and word
 * positions count only the parts that are not whitespace.
 *
 * @returns {{parts: string[], words: string[], wordIndexOfPart: number[]}}
 */
export function splitForCorrection(text) {
  const parts = String(text || '').split(/(\s+)/);
  const words = [];
  const wordIndexOfPart = [];
  parts.forEach((part) => {
    if (part === '' || /^\s+$/.test(part)) {
      wordIndexOfPart.push(-1);
      return;
    }
    wordIndexOfPart.push(words.length);
    words.push(part);
  });
  return { parts, words, wordIndexOfPart };
}

/** Everything the parent has taught the app, as patterns for Claude to weigh. */
export function correctionPatterns() {
  const pronunciations = phonicEntries().map(([, entry]) => ({
    word: entry.word,
    spellings: entry.spellings
  }));

  // Only confirmed corrections. A pending one has been seen once and is not
  // yet trusted to fire on its own here either.
  const corrections = [];
  Object.keys(state.wordBank).forEach((heard) => {
    const entry = getBankEntry(heard);
    if (entry && entry.active) corrections.push({ heard, means: entry.correct });
  });

  return { pronunciations, corrections };
}

/**
 * @param {string} text the transcript, as heard
 * @returns {Promise<{changes: Array<{index:number, from:string, to:string, reason:string}>}>}
 * @throws {ContextError} offline, timeout, or whatever the function reported
 */
export async function correctWithContext(text) {
  const { words } = splitForCorrection(text);
  if (!words.length) return { changes: [] };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ContextError('offline');
  }

  const { pronunciations, corrections } = correctionPatterns();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(CONTEXT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: words, pronunciations, corrections }),
      signal: controller.signal
    });
  } catch (e) {
    throw new ContextError(e && e.name === 'AbortError' ? 'timeout' : 'offline');
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ContextError(body.error || 'http-' + response.status);
  if (!Array.isArray(body.changes)) throw new ContextError('bad-response');

  // Checked again here, against this browser's own copy of the words. The
  // function validated the same things; neither side takes the other on trust.
  //
  // The replacement is fitted to the word it replaces before anything else
  // sees it: the original's punctuation stays, and its case is copied, so a
  // "Little" the model capitalised lands as "little" mid-sentence and a
  // sentence-ending "liquor." keeps its full stop. A change that fits back to
  // the original word is no change at all, and is dropped.
  const changes = body.changes
    .filter((change) => change && Number.isInteger(change.index))
    .filter((change) => change.index >= 0 && change.index < words.length)
    .filter((change) => typeof change.to === 'string' && change.to.trim())
    .map((change) => ({
      index: change.index,
      from: words[change.index],
      to: fitReplacement(words[change.index], change.to.trim()),
      reason: typeof change.reason === 'string' ? change.reason.trim() : ''
    }))
    .filter((change) => change.to !== change.from);

  return { changes };
}

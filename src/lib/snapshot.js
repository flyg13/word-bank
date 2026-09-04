// Folding a Firestore snapshot into app state.
//
// This lives on its own because it is the one place where the stored document
// shape and the in-memory shape meet. Keeping a second copy of it anywhere —
// including in tests — means the two can drift; adding a field here is enough
// for every caller to pick it up.

import { SENTENCES } from '../data/sentences.js';
import { DEFAULT_SPEECH_LANG, SPEECH_LANGS } from '../config.js';
import { parsePassage } from './text.js';

/** A stored position can outlive the list it points into. */
function clampIndex(value, length) {
  const index = Number(value) || 0;
  if (!length) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/**
 * Apply a Firestore document to the given state object, in place.
 *
 * @param {object} state the shared store state
 * @param {object} data  the raw document, or {} when it does not exist yet
 */
export function foldSnapshot(state, data) {
  state.wordBank = data.word_bank || {};
  state.verifiedWords = data.verified_words || [];
  state.confirmCounts = data.confirm_counts || {};
  state.sessionLog = data.session_log || [];
  state.sentenceProgress = data.sentence_progress || {};
  state.sentenceIndex = clampIndex(data.sentence_index, SENTENCES.length);
  state.readingPassage = data.reading_passage || '';
  state.readingSentences = state.readingPassage ? parsePassage(state.readingPassage) : [];
  state.readingProgress = data.reading_progress || {};
  state.readingIndex = clampIndex(data.reading_index, state.readingSentences.length);
  state.attemptLog = data.attempt_log || {};
  state.phonicBank = data.phonic_bank || {};
  state.speechLang = validLang(data.speech_lang);
}

/** Fall back rather than hand the recognizer something it will reject. */
function validLang(lang) {
  return SPEECH_LANGS.some((l) => l.code === lang) ? lang : DEFAULT_SPEECH_LANG;
}

/** Every Firestore field the app reads. */
export const SYNCED_FIELDS = [
  'attempt_log',
  'confirm_counts',
  'phonic_bank',
  'reading_index',
  'reading_passage',
  'reading_progress',
  'sentence_index',
  'sentence_progress',
  'session_log',
  'speech_lang',
  'verified_words',
  'word_bank'
];

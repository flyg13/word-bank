// Her schoolwork, kept so a sheet can be picked up again tomorrow.
//
// A sheet is one piece of schoolwork: a name, and one or more question-and-
// answer pairs. The question is what she pasted in from Seesaw; the answer is
// what she said, as the recogniser heard it.
//
// Deliberately only what she said, never what Claude made of it. Claude's
// changes are a display layer over the words — CLAUDE.md §10 — and freezing
// them into storage would make a guess indistinguishable from a transcript the
// next time the sheet is opened. What that costs is set out in §14: a reopened
// answer shows her confirmed corrections applied the blind way until she
// records into it again.
//
// A rolling five, newest first, on the family document, so the sheet she
// started on the iPad is on the parent's device too. The whole list is written
// on every change, which is what bounds the field: five sheets is what the
// parent asked for and there is no long history to grow into.

import { SHEET_LIMIT } from '../config.js';
import { state, save } from './store.js';

let counter = 0;

/** An id that is unique within this device's lifetime, and stable once stored. */
function freshId(prefix) {
  counter += 1;
  return prefix + '-' + Date.now().toString(36) + '-' + counter;
}

export function newQuestion() {
  return { id: freshId('q'), question: '', answer: '' };
}

export function newSheet() {
  return {
    id: freshId('s'),
    title: '',
    updated: new Date().toISOString(),
    questions: [newQuestion()]
  };
}

function cleanQuestion(item, index) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : 'q' + index,
    question: typeof item.question === 'string' ? item.question : '',
    answer: typeof item.answer === 'string' ? item.answer : ''
  };
}

/** A stored sheet, defensively: a hand-edited document must not take out the tab. */
function cleanSheet(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) return null;
  const questions = (Array.isArray(item.questions) ? item.questions : [])
    .map(cleanQuestion)
    .filter(Boolean);
  return {
    id: item.id,
    title: typeof item.title === 'string' ? item.title : '',
    updated: typeof item.updated === 'string' ? item.updated : '',
    // A sheet with no questions left cannot be shown, so it gets an empty one
    // rather than rendering as nothing at all.
    questions: questions.length ? questions : [newQuestion()]
  };
}

/** Newest first. */
export function readSheets() {
  const list = state.sheets;
  return (Array.isArray(list) ? list : []).map(cleanSheet).filter(Boolean);
}

/** Whether this sheet has anything in it worth keeping. */
export function sheetHasContent(sheet) {
  return Boolean(sheet) && (
    Boolean((sheet.title || '').trim()) ||
    (sheet.questions || []).some((q) => (q.question || '').trim() || (q.answer || '').trim())
  );
}

/**
 * Store a sheet, newest first.
 *
 * An empty sheet is not stored: opening the tab makes one, and a blank sheet
 * pushing a real one off the end of a five-long list would be a bad trade.
 */
export function saveSheet(sheet) {
  if (!sheetHasContent(sheet)) return readSheets();
  const kept = readSheets().filter((item) => item.id !== sheet.id);
  const next = [{ ...sheet, updated: new Date().toISOString() }]
    .concat(kept)
    .slice(0, SHEET_LIMIT);
  state.sheets = next;
  // Fire-and-forget, like every other save: the screen never waits on it.
  save('sheets', next);
  return next;
}

export function deleteSheet(id) {
  const next = readSheets().filter((item) => item.id !== id);
  state.sheets = next;
  save('sheets', next);
  return next;
}

/**
 * The whole sheet as plain text: every question with its answer beneath it, in
 * order.
 *
 * @param {object} sheet
 * @param {(question: object) => string} answerText what to use for an answer —
 *   the live corrected text where a question is on screen, its stored words
 *   otherwise. The caller owns that, because only the page knows which
 *   corrections are currently showing.
 */
export function sheetAsText(sheet, answerText) {
  return (sheet.questions || [])
    .map((question) => {
      const asked = (question.question || '').trim();
      const said = (answerText ? answerText(question) : question.answer || '').trim();
      return [asked, said].filter(Boolean).join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

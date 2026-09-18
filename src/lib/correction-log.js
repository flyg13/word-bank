// A rolling record of what Claude changed, and why.
//
// The point is to make a silent step visible. Context correction rewrites words
// without being asked, so the parent needs somewhere to look for a pattern —
// and to catch anything systematic, like one word being "corrected" every time
// when it never should be.
//
// It is a synced Firestore field, `context_log`, on the family document — the
// parent's decision, so the log can be read from any device rather than only
// the one that showed the change. It is purely additive: nothing in the app
// reads it to decide a correction, and the ten original fields are untouched
// (schema-parity.test.js pins that). The whole list is written on every change,
// capped at CORRECTION_LOG_LIMIT newest-first, which is what makes it a rolling
// log rather than an ever-growing one.
//
// A log this app first kept in localStorage is not migrated: it was a record of
// one device's screen, and there was never more than a few sessions of it.

import { CORRECTION_LOG_LIMIT } from '../config.js';
import { state, save } from './store.js';

function isEntry(entry) {
  return Boolean(
    entry && typeof entry === 'object' &&
    typeof entry.from === 'string' && entry.from &&
    typeof entry.to === 'string' && entry.to
  );
}

/** The synced list, defensively: a hand-edited document must not take out the tab. */
function current() {
  const list = state.contextLog;
  return Array.isArray(list) ? list.filter(isEntry) : [];
}

function write(list) {
  state.contextLog = list.slice(0, CORRECTION_LOG_LIMIT);
  // Fire-and-forget, like every other save: the screen never waits on it.
  save('context_log', state.contextLog);
}

/** Newest first. */
export function readCorrectionLog() {
  return current();
}

/**
 * Record what Claude changed on one transcript.
 * @param {Array<{from:string,to:string,reason:string}>} changes
 * @returns {string[]} an id per change, in the order given, for markReverted
 */
export function recordContextChanges(changes) {
  if (!changes || !changes.length) return [];
  const at = new Date().toISOString();
  const entries = changes.map((change, i) => ({
    id: at + '#' + i,
    from: change.from,
    to: change.to,
    reason: change.reason || '',
    at,
    reverted: false
  }));
  write(entries.concat(current()));
  return entries.map((entry) => entry.id);
}

function setReverted(id, reverted) {
  const list = current();
  if (!list.some((item) => item.id === id)) return;
  // A new object rather than a mutation, so a snapshot the store still holds
  // a reference to is never edited behind Firestore's back.
  write(list.map((item) => (item.id === id ? { ...item, reverted } : item)));
}

/**
 * Note that the parent put a word back. Worth keeping rather than deleting: a
 * change that keeps being reverted is exactly the pattern this log exists to
 * surface.
 */
export function markReverted(id) {
  setReverted(id, true);
}

/**
 * And note that they put Claude's word back again.
 *
 * The entry carries one flag, not a tally of taps, so it describes how the
 * change stands rather than every time it was toggled. Leaving it marked undone
 * after it has been reapplied would make the log say the opposite of the screen
 * — and a curious tap-and-tap-back by a nine-year-old would otherwise leave a
 * permanent mark on a change the parent never objected to, which is exactly the
 * signal this log exists to keep clean.
 */
export function markReapplied(id) {
  setReverted(id, false);
}

export function clearCorrectionLog() {
  write([]);
}

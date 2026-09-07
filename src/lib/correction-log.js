// A rolling record of what Claude changed, and why.
//
// The point is to make a silent step visible. Context correction rewrites words
// without being asked, so the parent needs somewhere to look for a pattern —
// and to catch anything systematic, like one word being "corrected" every time
// when it never should be.
//
// Stored in localStorage, not Firestore, for two reasons. It is a record of
// what this device showed, so syncing it across devices would mix two different
// screens into one history. And the Firestore schema is deliberately unchanged
// by this feature: nothing here can affect what her bank holds.

import { CORRECTION_LOG_LIMIT } from '../config.js';

const KEY = 'word_bank_context_log';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch (e) {
    // A private window, cleared site data, or something hand-edited. The log is
    // a convenience; losing it must never take out the tab it renders in.
    return [];
  }
}

function isEntry(entry) {
  return Boolean(
    entry && typeof entry === 'object' &&
    typeof entry.from === 'string' && entry.from &&
    typeof entry.to === 'string' && entry.to
  );
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, CORRECTION_LOG_LIMIT)));
  } catch (e) {
    /* storage full or blocked — the feature still works, the history just doesn't keep */
  }
}

/** Newest first. */
export function readCorrectionLog() {
  return read();
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
  write(entries.concat(read()));
  return entries.map((entry) => entry.id);
}

/**
 * Note that the parent put a word back. Worth keeping rather than deleting: a
 * change that keeps being reverted is exactly the pattern this log exists to
 * surface.
 */
export function markReverted(id) {
  const list = read();
  const entry = list.find((item) => item.id === id);
  if (!entry) return;
  entry.reverted = true;
  write(list);
}

export function clearCorrectionLog() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    /* nothing to do */
  }
}

import { DEFAULT_SPEECH_LANG } from '../config.js';

/**
 * All synced app state in one place. Feature modules read from and write to
 * this object directly (as the original single-file script did with its
 * module-level `let`s); `save()` is the only path to persistence.
 */
export const state = {
  // Synced
  wordBank: {},
  verifiedWords: [],
  confirmCounts: {},
  sessionLog: [],
  sentenceProgress: {},
  sentenceIndex: 0,
  readingPassage: '',
  readingSentences: [],
  readingProgress: {},
  readingIndex: 0,
  attemptLog: {},
  phonicBank: {},
  speechLang: DEFAULT_SPEECH_LANG,

  // Local only — not persisted
  practiceQueue: [],
  // Limits the queue to words she has a pronunciation or a correction for.
  // Deliberately not synced: it is "what am I working on right now", not a
  // family setting, and one device forcing it on another would be surprising.
  focusMode: false,
  // A word sent to the front of the queue from Word Bank. Held separately so a
  // background snapshot cannot strip it — reconcileQueue drops mastered words,
  // and a word worth revisiting is quite often already mastered.
  pinnedWord: null,
  sessionActive: false,
  sessionAttempted: 0,
  sessionMasteredStart: 0
};

let onSaveError = () => {};
let saver = null;

/** Route save failures to whatever is showing sync status. */
export function setSaveErrorHandler(fn) {
  onSaveError = fn;
}

/**
 * Install the persistence backend. The Firebase SDK is loaded lazily so the
 * app shell paints first, which means saves before it lands are dropped — the
 * same as the original, where writes before the family doc resolved were no-ops.
 */
export function setSaver(fn) {
  saver = fn;
}

/** Persist one field. Fire-and-forget by design: the UI never waits on it. */
export function save(key, value) {
  if (!saver) return Promise.resolve();
  return saver(key, value).catch(() => onSaveError());
}

// ---------- Render registry ----------
// Feature modules register a render function instead of importing each other's
// renderers. That keeps features independent and lets a Firestore snapshot (or
// any cross-feature change) refresh the whole UI with one call.
const renderers = [];

export function onRender(fn) {
  renderers.push(fn);
}

export function renderAll() {
  renderers.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error('render failed', e);
    }
  });
}

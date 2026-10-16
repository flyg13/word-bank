// What Voice Lock remembers, and the rules about it.
//
// One synced field, `voice_lock`, additive like every field added since the
// port. Kept separate from the feature so the shape can be reasoned about and
// tested without a browser, a model or a microphone.
//
//   enabled      the gate itself. Off unless a classroom switched it on.
//   calibrating  a calibration session is open: a thing you start, work
//                through and finish, not a mode left switched on.
//   calibratedAt when one was last finished. The gate cannot be switched on
//                before that, because a threshold nobody measured is a
//                threshold that locks her out.
//   threshold    how alike is alike enough.
//   print        her enrolment: several embeddings and what made them.
//   log          scores from the calibration session, each already attributed
//                to her or to someone else when it was recorded.

import {
  VOICE_THRESHOLD_DEFAULT, VOICE_THRESHOLD_MIN, VOICE_THRESHOLD_MAX, VOICE_LOG_LIMIT
} from '../config.js';
import { state, save } from './store.js';

export function blankVoiceLock() {
  return {
    enabled: false,
    calibrating: false,
    calibratedAt: '',
    threshold: VOICE_THRESHOLD_DEFAULT,
    print: null,
    log: []
  };
}

function validThreshold(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= VOICE_THRESHOLD_MIN && n <= VOICE_THRESHOLD_MAX
    ? n : VOICE_THRESHOLD_DEFAULT;
}

/** One enrolment embedding, defensively: a hand-edited document must not throw. */
function cleanEmbedding(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const nums = values.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

/**
 * Read a print, in either shape, defensively.
 *
 * Stored flat, used as rows. Firestore has no nested arrays at all — an
 * `embeddings: [[...], [...]]` write is refused outright with "Nested arrays
 * are not supported" — so the enrolment goes to the document as one flat run
 * of numbers plus the width to cut it at. That is a storage detail: everything
 * above this function sees `embeddings` as rows, the way `bestScore` wants it.
 *
 * The old nested shape is still read, so a document written by hand, or by an
 * export taken before this, still opens.
 */
function cleanPrint(print) {
  if (!print || typeof print !== 'object') return null;

  let embeddings;
  if (Array.isArray(print.flat)) {
    const width = Number(print.dim);
    if (!Number.isInteger(width) || width <= 0) return null;
    const nums = print.flat.map(Number);
    // A run that does not divide by the width means nothing can be cut out of
    // it with any confidence, so it is treated as no print at all.
    if (!nums.length || nums.length % width !== 0) return null;
    if (!nums.every(Number.isFinite)) return null;
    embeddings = [];
    for (let i = 0; i < nums.length; i += width) embeddings.push(nums.slice(i, i + width));
  } else {
    embeddings = (Array.isArray(print.embeddings) ? print.embeddings : [])
      .map(cleanEmbedding)
      .filter(Boolean);
  }

  if (!embeddings.length) return null;
  // Every embedding in one print must be the same length, or a comparison
  // silently means nothing. A mixed print is treated as no print at all.
  const dim = embeddings[0].length;
  if (!embeddings.every((e) => e.length === dim)) return null;
  return {
    embeddings,
    dim,
    model: typeof print.model === 'string' ? print.model : '',
    enrolledAt: typeof print.enrolledAt === 'string' ? print.enrolledAt : '',
    seconds: Number.isFinite(Number(print.seconds)) ? Number(print.seconds) : 0
  };
}

/** The same print, flattened for storage. See cleanPrint for why. */
function storedPrint(print) {
  if (!print) return null;
  const flat = [];
  for (const row of print.embeddings) for (const n of row) flat.push(n);
  return {
    flat,
    dim: print.dim,
    count: print.embeddings.length,
    model: print.model,
    enrolledAt: print.enrolledAt,
    seconds: print.seconds
  };
}

function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const score = Number(entry.score);
  if (!Number.isFinite(score)) return null;
  return {
    score,
    at: typeof entry.at === 'string' ? entry.at : '',
    where: typeof entry.where === 'string' ? entry.where : '',
    // What the parent said this attempt was: 'her', 'other', or '' for untagged.
    who: entry.who === 'her' || entry.who === 'other' ? entry.who : ''
  };
}

/** The setting as it stands, defensively. */
export function voiceLock() {
  const raw = state.voiceLock;
  if (!raw || typeof raw !== 'object') return blankVoiceLock();
  return {
    enabled: raw.enabled === true,
    calibrating: raw.calibrating === true,
    calibratedAt: typeof raw.calibratedAt === 'string' ? raw.calibratedAt : '',
    threshold: validThreshold(raw.threshold),
    print: cleanPrint(raw.print),
    log: (Array.isArray(raw.log) ? raw.log : [])
      .map(cleanEntry).filter(Boolean).slice(0, VOICE_LOG_LIMIT)
  };
}

function write(next) {
  // What goes to the document, and into state, is the stored shape — the same
  // thing a snapshot will hand back. Keeping a richer object in memory than
  // the one that syncs is how a field comes to work on the device that wrote
  // it and nowhere else.
  const stored = { ...next, print: storedPrint(next.print) };
  state.voiceLock = stored;
  save('voice_lock', stored);
  return next;
}

/** Change some of it, leaving the rest. */
export function updateVoiceLock(changes) {
  return write({ ...voiceLock(), ...changes });
}

/**
 * Store an enrolment.
 *
 * Replaces whatever was there: children's voices change, so re-enrolling is
 * expected to happen again and again, and keeping the old one would only
 * invite a comparison against a voice she has grown out of.
 */
export function saveEnrolment({ embeddings, model, seconds }) {
  const print = cleanPrint({ embeddings, model, seconds, enrolledAt: new Date().toISOString() });
  return updateVoiceLock({ print });
}

export function clearEnrolment() {
  // Turning the gate off with it: a gate with nothing to compare against can
  // only refuse, and refusing her in front of a class is the failure that
  // matters most.
  //
  // The calibration goes too. Every score is a comparison against the print
  // that has just been thrown away, so keeping the numbers would mean
  // offering a threshold measured against a voice the app no longer holds.
  return updateVoiceLock({
    print: null, enabled: false, calibrating: false, calibratedAt: '', log: []
  });
}

/**
 * Open a calibration session.
 *
 * It starts empty. Scores are only meaningful against the print they were
 * measured from, and a session that inherited the last one's numbers would
 * quietly mix two sets of readings into one range.
 */
export function startCalibration() {
  return updateVoiceLock({ calibrating: true, log: [] });
}

/** Finish one, adopting the threshold it arrived at. */
export function finishCalibration(threshold) {
  return updateVoiceLock({
    calibrating: false,
    calibratedAt: new Date().toISOString(),
    threshold: validThreshold(threshold)
  });
}

/** Abandon one. Nothing is kept: half a session is not evidence. */
export function cancelCalibration() {
  return updateVoiceLock({ calibrating: false, log: [] });
}

/** Note a score. Newest first, capped — this is tuning data, not history. */
export function logScore({ score, where, who }) {
  const current = voiceLock();
  const entry = cleanEntry({ score, where, who: who || '', at: new Date().toISOString() });
  if (!entry) return current;
  return write({ ...current, log: [entry].concat(current.log).slice(0, VOICE_LOG_LIMIT) });
}

/** Say who an already-logged attempt was, so the scores can be read apart. */
export function tagScore(at, who) {
  const current = voiceLock();
  return write({
    ...current,
    log: current.log.map((entry) => (entry.at === at ? { ...entry, who } : entry))
  });
}

export function clearLog() {
  return updateVoiceLock({ log: [] });
}

/**
 * A threshold suggested by the scores actually recorded.
 *
 * Only ever advisory, and only offered once both kinds have been heard. It
 * sits midway between the quietest "her" and the loudest "not her" — and when
 * those two overlap it says so rather than inventing a number, because an
 * overlap is the finding, not a problem to be averaged away.
 *
 * @returns {{ok:true, value:number, hers:number, others:number, margin:number}
 *          |{ok:false, reason:string, hers:number, others:number, overlap?:number}}
 */
export function suggestThreshold(log = voiceLock().log) {
  const hers = log.filter((e) => e.who === 'her').map((e) => e.score);
  const others = log.filter((e) => e.who === 'other').map((e) => e.score);
  const span = (xs) => (xs.length
    ? { low: Number(Math.min(...xs).toFixed(2)), high: Number(Math.max(...xs).toFixed(2)) }
    : null);
  // The two ranges are shown whether or not a threshold can be suggested yet:
  // seeing them fill in is how the parent knows the session is going anywhere.
  const ranges = { herRange: span(hers), otherRange: span(others) };
  if (hers.length < 2 || others.length < 1) {
    return {
      ok: false, reason: 'not-enough', hers: hers.length, others: others.length, ...ranges
    };
  }
  const lowestHer = Math.min(...hers);
  const highestOther = Math.max(...others);
  if (lowestHer <= highestOther) {
    return {
      ok: false, reason: 'overlap', hers: hers.length, others: others.length,
      overlap: Number((highestOther - lowestHer).toFixed(3)), ...ranges
    };
  }
  return {
    ok: true,
    value: Number(((lowestHer + highestOther) / 2).toFixed(2)),
    hers: hers.length,
    others: others.length,
    margin: Number((lowestHer - highestOther).toFixed(3)),
    ...ranges
  };
}

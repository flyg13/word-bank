// What Voice Lock remembers, and the rules about it.
//
// One synced field, `voice_lock`, additive like every field added since the
// port. Kept separate from the feature so the shape can be reasoned about and
// tested without a browser, a model or a microphone.
//
//   enabled      the gate itself. Off unless a classroom switched it on.
//   calibrating  show the score for every attempt and gate nothing.
//   threshold    how alike is alike enough.
//   print        her enrolment: several embeddings and what made them.
//   log          recent scores, for setting the threshold from real voices.

import {
  VOICE_THRESHOLD_DEFAULT, VOICE_THRESHOLD_MIN, VOICE_THRESHOLD_MAX, VOICE_LOG_LIMIT
} from '../config.js';
import { state, save } from './store.js';

export function blankVoiceLock() {
  return {
    enabled: false,
    calibrating: false,
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

function cleanPrint(print) {
  if (!print || typeof print !== 'object') return null;
  const embeddings = (Array.isArray(print.embeddings) ? print.embeddings : [])
    .map(cleanEmbedding)
    .filter(Boolean);
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
    threshold: validThreshold(raw.threshold),
    print: cleanPrint(raw.print),
    log: (Array.isArray(raw.log) ? raw.log : [])
      .map(cleanEntry).filter(Boolean).slice(0, VOICE_LOG_LIMIT)
  };
}

function write(next) {
  state.voiceLock = next;
  save('voice_lock', next);
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
  return updateVoiceLock({ print: null, enabled: false });
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
  if (hers.length < 2 || others.length < 1) {
    return { ok: false, reason: 'not-enough', hers: hers.length, others: others.length };
  }
  const lowestHer = Math.min(...hers);
  const highestOther = Math.max(...others);
  if (lowestHer <= highestOther) {
    return {
      ok: false, reason: 'overlap', hers: hers.length, others: others.length,
      overlap: Number((highestOther - lowestHer).toFixed(3))
    };
  }
  return {
    ok: true,
    value: Number(((lowestHer + highestOther) / 2).toFixed(2)),
    hers: hers.length,
    others: others.length,
    margin: Number((lowestHer - highestOther).toFixed(3))
  };
}

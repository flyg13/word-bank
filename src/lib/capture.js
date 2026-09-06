// Record, check, send. The one place that knows the order those happen in.
//
// The clip is a first-class value here, not a detail hidden inside the upload.
// It is handed to every registered gate, and kept as the last clip, *before
// anything is sent* — which is the seam Voice Lock needs: enrol her voice,
// register a gate that compares a clip against the stored fingerprint, and
// audio that is not hers never leaves the device.

import { CAPTURE_MODES } from '../config.js';
import { state } from './store.js';
import { startRecording, mediaRecordingSupported } from './recorder.js';
import { transcribeClip, TranscribeError } from './transcribe.js';
import { vocabularyHints } from './vocab.js';

export { mediaRecordingSupported };

// How long a recording has to run before "the analyser never heard anything"
// is trusted enough to refuse the send. Five polls at recorder.js's 100ms.
const JUDGE_AFTER_MS = 500;

export class CaptureError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------- The gate seam ----------

const gates = [];
let lastClip = null;

/**
 * Register a check that runs on the recorded clip before it is sent.
 *
 * @param {(clip: {blob:Blob, mimeType:string, durationMs:number}) =>
 *   (Promise<{ok:boolean, code?:string}>|{ok:boolean, code?:string})} gate
 */
export function addClipGate(gate) {
  gates.push(gate);
}

/** The most recent recording, whether or not it was sent. */
export function lastRecordedClip() {
  return lastClip;
}

async function passesGates(clip) {
  for (const gate of gates) {
    // Sequential on purpose: a gate exists to stop the clip going further, so
    // there is nothing to gain from running the next one once one has refused.
    const verdict = await gate(clip);
    if (verdict && verdict.ok === false) {
      throw new CaptureError(verdict.code || 'blocked', 'a clip gate refused the recording');
    }
  }
}

// ---------- Capture ----------

/**
 * Start a capture. Resolves once the microphone is live; the transcript
 * arrives on the returned `result` promise.
 *
 * @param {{mode?: string, expected?: string}} options
 *   mode selects the silence and length limits from CAPTURE_MODES.
 *   expected is what she was asked to say, used only as a vocabulary hint.
 * @returns {Promise<{stop: () => void, result: Promise<{
 *   text: string, clip: object, provider: string, model: string
 * }>}>}
 */
export async function startCapture({ mode = 'word', expected = '' } = {}) {
  if (!mediaRecordingSupported()) throw new CaptureError('no-recorder');

  const limits = CAPTURE_MODES[mode] || CAPTURE_MODES.word;

  let recording;
  try {
    recording = await startRecording(limits);
  } catch (e) {
    // getUserMedia's own names, mapped to the same vocabulary the browser
    // recogniser uses, so the mic label needs one set of explanations.
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CaptureError('not-allowed');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CaptureError('audio-capture');
    throw new CaptureError('mic-failed', e && e.message);
  }

  const result = (async () => {
    const clip = await recording.done;
    lastClip = clip;

    // A recording with nothing in it is not worth a round trip, and a
    // transcription model's answer to near-silence is the least trustworthy
    // thing it produces — inventing a plausible sentence is the documented
    // failure mode. So silence is refused here rather than sent.
    //
    // The level check only gets a veto once the recording is long enough to
    // have been sampled a few times: a word said and stopped inside a couple
    // of hundred milliseconds could fall between polls, and calling that
    // silence would be worse than spending a request on it.
    const judged = clip.heardSpeech === false && clip.durationMs >= JUDGE_AFTER_MS;
    if (clip.reason === 'quiet' || judged || !clip.blob.size) throw new CaptureError('no-speech');

    await passesGates(clip);

    try {
      const { text, provider, model } = await transcribeClip(clip, {
        language: state.speechLang,
        hints: vocabularyHints(expected)
      });
      if (!text) throw new CaptureError('no-speech');
      return { text, clip, provider, model };
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      if (e instanceof TranscribeError) throw new CaptureError(e.code, e.message);
      throw new CaptureError('transcribe-failed', e && e.message);
    }
  })();

  return { stop: recording.stop, result };
}

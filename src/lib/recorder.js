// Capture audio from the microphone, and decide when she has finished.
//
// The recorder's only job is to produce a clip. It does not know what a
// transcript is, which provider will see it, or whether it will be sent at
// all — see capture.js for the seam where a future Voice Lock check sits
// between "recorded" and "sent".
//
// Stopping, in priority order:
//   tap      the parent or Harlie taps the mic again. Always immediate.
//   silence  silenceMs of quiet after she has actually said something.
//   quiet    NO_SPEECH_MS with nothing said at all.
//   max      the mode's hard ceiling. The recording cannot outlive this.

import { SILENCE_RMS, NO_SPEECH_MS } from '../config.js';

// In preference order. Safari on iOS only offers mp4; Chrome and Firefox give
// opus, which is smaller for the same speech.
const FORMATS = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4'
];

/** Whether this browser can record at all. Distinct from recognition support. */
export function mediaRecordingSupported() {
  return Boolean(
    typeof MediaRecorder !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

function pickFormat() {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f)) || '';
}

/**
 * Start recording.
 *
 * @param {{silenceMs:number, maxMs:number, onLevel?:(rms:number)=>void}} options
 * @returns {Promise<{
 *   done: Promise<{blob:Blob, mimeType:string, durationMs:number, reason:string}>,
 *   stop: (reason?: string) => void
 * }>}
 *   Resolves once the microphone is live, so the caller can show "Recording"
 *   only when it is true. Rejects if permission is refused.
 */
export async function startRecording({ silenceMs, maxMs, onLevel }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });

  const mimeType = pickFormat();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const startedAt = Date.now();

  let reason = 'tap';
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const analyser = attachAnalyser(stream);

  // Timers. `quietSince` is null while she is audible; the moment she goes
  // quiet it becomes a timestamp, and the trailing-pause rule measures from it.
  let heardSpeech = false;
  let quietSince = null;

  const tick = () => {
    if (settled) return;
    const rms = analyser ? analyser.level() : 1;
    if (onLevel) onLevel(rms);
    const now = Date.now();

    if (rms >= SILENCE_RMS) {
      heardSpeech = true;
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = now;
    }

    if (heardSpeech && quietSince !== null && now - quietSince >= silenceMs) {
      stop('silence');
    } else if (!heardSpeech && now - startedAt >= NO_SPEECH_MS) {
      stop('quiet');
    } else if (now - startedAt >= maxMs) {
      stop('max');
    }
  };

  // 100ms is fine grained enough for a 1.2s pause and cheap enough to run on
  // an old iPad. Without an analyser (no Web Audio) only the tap and the
  // ceiling stop it, which is why maxMs is not optional.
  const poll = setInterval(tick, 100);
  const ceiling = setTimeout(() => stop('max'), maxMs);

  function stop(why) {
    if (settled) return;
    settled = true;
    reason = why || 'tap';
    clearInterval(poll);
    clearTimeout(ceiling);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
      else finish();
    } catch (e) {
      finish();
    }
  }

  function finish() {
    if (analyser) analyser.close();
    stream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) { /* already ended */ }
    });
    const type = recorder.mimeType || mimeType || 'audio/webm';
    resolveDone({
      blob: new Blob(chunks, { type }),
      mimeType: type,
      durationMs: Date.now() - startedAt,
      reason,
      // Whether anything above the silence floor was ever heard. null where
      // there was no analyser to say — "unknown", not "no".
      heardSpeech: analyser ? heardSpeech : null
    });
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = finish;
  recorder.onerror = () => stop('error');

  recorder.start();
  return { done, stop };
}

/**
 * RMS level from a Web Audio analyser, or null where Web Audio is missing.
 * Silence detection is a convenience, so its absence must not stop recording.
 */
function attachAnalyser(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  let ctx;
  try {
    ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      level() {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
        return Math.sqrt(sum / buffer.length);
      },
      close() {
        try { ctx.close(); } catch (e) { /* already closed */ }
      }
    };
  } catch (e) {
    if (ctx) { try { ctx.close(); } catch (e2) { /* ignore */ } }
    return null;
  }
}

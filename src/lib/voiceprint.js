// Turning a recorded clip into a voiceprint, and comparing two of them.
//
// This is the whole of Voice Lock's maths, and deliberately none of its policy.
// It knows how to get from a clip to a 192-ish dimensional vector and how to
// score two vectors against each other. It does not know what score is good
// enough, whether the gate is on, or what to say when it refuses — those live
// in features/voicelock.js, because they are decisions and this is arithmetic.
//
// **Everything here runs on the device.** The model and its runtime are served
// from this origin, the audio is a Blob the browser already has, and nothing
// is uploaded. In a classroom that is the difference between "we check it is
// her" and "we send a recording of your children somewhere" — see CLAUDE.md
// §18. It is also why the harder browser build was worth doing.

import { VOICE_MODEL_URL, VOICE_MIN_CLIP_SECONDS } from '../config.js';

// The engine: load the runtime, hand it the model, get an extractor. Injectable
// so the tests can drive the whole feature without a 12 MB WASM download and
// without the weights, which is what made it possible to build this before the
// model existed in the repo.
let engineFactory = defaultEngine;
let engine = null;
let engineError = null;

/** Swap the engine. Tests use this; nothing in the app does. */
export function setVoiceEngine(factory) {
  engineFactory = factory || defaultEngine;
  engine = null;
  engineError = null;
}

/**
 * The real engine: sherpa-onnx's speaker-embedding build, as WebAssembly.
 *
 * Loaded on first use rather than at startup. It is a large download and most
 * sessions never need it — Voice Lock is off unless a classroom switched it
 * on, and a family using this at home should not pay for it at all.
 */
async function defaultEngine() {
  const [{ createExtractor, initSpeakerIdentificationModule }, { loadVirtualData }] =
    await Promise.all([
      import('@sherpaw/speaker-identification'),
      import('@sherpaw/preloader')
    ]);

  const response = await fetch(VOICE_MODEL_URL);
  if (!response.ok) throw new Error('model-missing');
  const bytes = new Uint8Array(await response.arrayBuffer());

  const module = await initSpeakerIdentificationModule();
  loadVirtualData({ module, virtualData: { 'speaker.onnx': bytes } });
  const extractor = createExtractor(module, {
    model: 'speaker.onnx',
    minDurationSeconds: VOICE_MIN_CLIP_SECONDS
  });
  return {
    extract: (samples, sampleRate) => extractor.extract(samples, sampleRate),
    dispose: () => extractor.dispose()
  };
}

async function getEngine() {
  if (engineError) throw engineError;
  if (engine) return engine;
  try {
    engine = await engineFactory();
    return engine;
  } catch (e) {
    // Remembered, so a missing model is reported once rather than retried on
    // every word she says. `forgetVoiceEngine` is the way back.
    engineError = e instanceof Error ? e : new Error(String(e));
    throw engineError;
  }
}

/** Forget a failed or loaded engine, so the next call tries again. */
export function forgetVoiceEngine() {
  if (engine && engine.dispose) {
    try { engine.dispose(); } catch (e) { /* already gone */ }
  }
  engine = null;
  engineError = null;
}

/**
 * Decode a recorded clip to mono PCM.
 *
 * The recorder hands over webm/opus, ogg/opus or mp4 depending on the browser;
 * `decodeAudioData` takes all three. Note what this is *not*: it is not a
 * microphone. Voice Lock runs on a clip the recorder has already finished with,
 * so it is not a third thing competing for the microphone — see CLAUDE.md §18.
 *
 * @returns {Promise<{samples: Float32Array, sampleRate: number, seconds: number}>}
 */
export async function clipToPcm(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('no-audio-context');
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const samples = mixToMono(buffer);
    return { samples, sampleRate: buffer.sampleRate, seconds: buffer.duration };
  } finally {
    try { ctx.close(); } catch (e) { /* already closed */ }
  }
}

/** Average the channels. A mono microphone gives one; iPads sometimes give two. */
function mixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= buffer.numberOfChannels;
  return out;
}

/** A voiceprint for one clip. */
export async function embedClip(blob) {
  const { samples, sampleRate, seconds } = await clipToPcm(blob);
  const runtime = await getEngine();
  const values = runtime.extract(samples, sampleRate);
  return { values: Float32Array.from(values), seconds };
}

/**
 * How alike two voiceprints are, from -1 to 1.
 *
 * Cosine similarity, which is what every speaker-embedding model is trained to
 * make meaningful. Mismatched lengths score 0 rather than throwing: that means
 * the stored print came from a different model, and "no idea" is the honest
 * answer, not a crash in the middle of her spelling practice.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Score a clip's print against an enrolment of several.
 *
 * The best of them, not the average of them. Each enrolment clip is a
 * legitimate example of her voice — one a bit further from the microphone, one
 * after she has been running around — and a clip that strongly matches any one
 * of them is hers. Averaging would let a poor enrolment clip drag every future
 * attempt down.
 */
export function bestScore(values, enrolled) {
  if (!values || !enrolled || !enrolled.length) return 0;
  return enrolled.reduce((best, print) => Math.max(best, cosine(values, print)), -1);
}

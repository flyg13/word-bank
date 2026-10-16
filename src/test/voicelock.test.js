// @vitest-environment jsdom
// Voice Lock: the classroom gate. Driven against an injected stand-in engine,
// so every decision the feature makes is exercised without the 12 MB runtime
// and without the model weights. See CLAUDE.md §18.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeRecognition { start() {} stop() {} abort() {} }
window.SpeechRecognition = FakeRecognition;
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; }
  start() { this.state = 'recording'; this.ondataavailable({ data: new Blob(['a']) }); }
  stop() { this.state = 'inactive'; this.onstop(); }
}
globalThis.MediaRecorder = FakeMediaRecorder;
navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };

// A stand-in voice: decodeAudioData yields PCM whose first sample names the
// speaker, and the engine turns that into a vector. Meaningless acoustically,
// exact for testing every decision around it.
let decodeFails = false;
// Long enough to count by default; flipped on to make a clip too short.
let shortClips = false;
window.AudioContext = class {
  decodeAudioData(buf) {
    if (decodeFails) return Promise.reject(new Error('bad-audio'));
    const who = new Uint8Array(buf)[0];
    const data = new Float32Array(16000);
    data.fill(who / 255);
    return Promise.resolve({
      numberOfChannels: 1, length: data.length, sampleRate: 16000,
      duration: shortClips ? 1.2 : 11, getChannelData: () => data
    });
  }
  close() {}
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(1); } }; }
  createMediaStreamSource() { return { connect() {} }; }
};
/** A clip "spoken by" someone: the byte is the identity. */
const clipOf = (who) => ({ blob: new Blob([new Uint8Array([who])]) });

const store = await import('../lib/store.js');
const { state } = store;
const { setVoiceEngine, cosine, bestScore, embedClip } = await import('../lib/voiceprint.js');
const vs = await import('../lib/voicelock-state.js');
const vl = await import('../features/voicelock.js');
const { SYNCED_FIELDS, foldSnapshot } = await import('../lib/snapshot.js');
const { VOICE_LOG_LIMIT, VOICE_THRESHOLD_DEFAULT, VOICE_MIN_CLIP_SECONDS,
        CAPTURE_MODES, VOICE_ENROL_TARGET_SECONDS, VOICE_ENROL_MIN_SECONDS,
        VOICE_ENROL_CLIPS } = await import('../config.js');

let engineCalls;
/** Identity-in, vector-out: the same speaker always gives the same vector. */
function standIn(dim = 192) {
  return async () => ({
    extract: (samples) => {
      engineCalls += 1;
      const who = Math.round(samples[0] * 255);
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i += 1) v[i] = Math.sin((who + 1) * (i + 1));
      return v;
    },
    dispose() {}
  });
}

let saved;
beforeEach(() => {
  engineCalls = 0;
  decodeFails = false;
  shortClips = false;
  vl.resetEnrolment();
  saved = [];
  state.voiceLock = null;
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  setVoiceEngine(standIn());
});
afterEach(() => { setVoiceEngine(null); });

/** Enrol "speaker 10" the way the feature does. */
async function enrol(who = 10, dim = 192) {
  setVoiceEngine(standIn(dim));
  const prints = [];
  for (let i = 0; i < 3; i += 1) prints.push(await embedClip(clipOf(who).blob));
  return vs.saveEnrolment({
    embeddings: prints.map((p) => Array.from(p.values)), model: 'stand-in', seconds: 12
  });
}

describe('comparing voiceprints', () => {
  it('scores a voice against itself as 1 and a different one lower', async () => {
    const a = await embedClip(clipOf(10).blob);
    const a2 = await embedClip(clipOf(10).blob);
    const b = await embedClip(clipOf(200).blob);
    expect(cosine(a.values, a2.values)).toBeCloseTo(1, 6);
    expect(cosine(a.values, b.values)).toBeLessThan(0.99);
  });

  it('says nothing rather than crashing when the prints do not match up', () => {
    // A stored print from a different model. "No idea" is the honest answer;
    // a throw here would land mid-lesson.
    expect(cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
    expect(cosine(null, null)).toBe(0);
    expect(cosine(new Float32Array([0, 0]), new Float32Array([0, 0]))).toBe(0);
  });

  it('takes the best enrolment clip, not the average of them', () => {
    // Each enrolment clip is a real example of her; one poor one must not drag
    // every later attempt down.
    const query = new Float32Array([1, 0, 0]);
    const good = [1, 0, 0];
    const poor = [0, 1, 0];
    expect(bestScore(query, [poor, good])).toBeCloseTo(1, 6);
    expect(bestScore(query, [poor])).toBeCloseTo(0, 6);
    expect(bestScore(query, [])).toBe(0);
  });
});

describe('the gate', () => {
  it('lets everything through when it is switched off', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: false, calibrating: false });
    const verdict = await vl.judgeClip(clipOf(200));
    expect(verdict.ok).toBe(true);
    // Not merely allowed — never even consulted.
    const before = engineCalls;
    await vl.judgeClip(clipOf(200));
    expect(engineCalls).toBe(before);
  });

  it('accepts her and refuses somebody else once it is on', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    expect((await vl.judgeClip(clipOf(10))).ok).toBe(true);

    const refused = await vl.judgeClip(clipOf(200));
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe(vl.NOT_HER);
    expect(typeof refused.score).toBe('number');
  });

  it('lets her through when nothing has been enrolled', async () => {
    // A gate with nothing to compare against can only refuse, and refusing
    // her in front of a class is the failure that matters most.
    vs.updateVoiceLock({ enabled: true });
    const verdict = await vl.judgeClip(clipOf(200));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toBe('no-enrolment');
  });

  it('lets her through when the model or the clip fails', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    decodeFails = true;
    const verdict = await vl.judgeClip(clipOf(200));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toBe('unavailable');
  });

  it('lets her through when the stored print came from another model', async () => {
    await enrol(10, 192);
    setVoiceEngine(standIn(128));
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    const verdict = await vl.judgeClip(clipOf(200));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toBe('model-changed');
  });

  it('never refuses while a calibration session is open', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, calibrating: true, threshold: 0.99 });
    const verdict = await vl.judgeClip(clipOf(200));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toBe('calibrating');
  });

  it('and does not quietly file her ordinary recordings into the session', async () => {
    // Calibration used to log every gated clip. It is now a set of recordings
    // the parent made on purpose, having said who each one was; an untagged
    // score from her Practice would belong to neither group and would only
    // muddy the two ranges the whole session exists to produce.
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, calibrating: true, threshold: 0.99 });
    await vl.judgeClip(clipOf(200));
    await vl.judgeClip(clipOf(10));
    expect(vs.voiceLock().log).toHaveLength(0);
  });

  it('logs a refusal too, so a gate that fires too often is visible', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    await vl.judgeClip(clipOf(200));
    expect(vs.voiceLock().log[0].where).toBe('refused');
  });
});

describe('what it remembers', () => {
  it('is a synced field, and additive', async () => {
    expect(SYNCED_FIELDS).toContain('voice_lock');
    await enrol(10);
    expect(saved.some((w) => w.key === 'voice_lock')).toBe(true);
    const fresh = {};
    foldSnapshot(fresh, {});
    expect(fresh.voiceLock).toBe(null);
  });

  it('is off by default, on a document that has never seen it', () => {
    const fresh = {};
    foldSnapshot(fresh, {});
    state.voiceLock = fresh.voiceLock;
    const setting = vs.voiceLock();
    expect(setting.enabled).toBe(false);
    expect(setting.calibrating).toBe(false);
    expect(setting.print).toBe(null);
    expect(setting.threshold).toBe(VOICE_THRESHOLD_DEFAULT);
  });

  it('survives a document hand-edited into nonsense', () => {
    state.voiceLock = {
      enabled: 'yes', threshold: 99, log: 'nope',
      print: { embeddings: [[1, 2], ['x'], [1, 2, 3]] }
    };
    const setting = vs.voiceLock();
    expect(setting.enabled).toBe(false);          // only true is true
    expect(setting.threshold).toBe(VOICE_THRESHOLD_DEFAULT);
    expect(setting.log).toEqual([]);
    // Mixed lengths in one print mean nothing can be compared: no print.
    expect(setting.print).toBe(null);
  });

  it('forgetting her voice switches the gate off with it', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true });
    vs.clearEnrolment();
    expect(vs.voiceLock().print).toBe(null);
    expect(vs.voiceLock().enabled).toBe(false);
  });

  it('re-enrolling replaces the old voice rather than adding to it', async () => {
    await enrol(10);
    const first = vs.voiceLock().print.embeddings.length;
    await enrol(90);
    expect(vs.voiceLock().print.embeddings).toHaveLength(first);
    // And the new voice is the one that matches now.
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    expect((await vl.judgeClip(clipOf(90))).ok).toBe(true);
    expect((await vl.judgeClip(clipOf(10))).ok).toBe(false);
  });

  it('caps the score log, because it is tuning data and not history', () => {
    for (let i = 0; i < VOICE_LOG_LIMIT + 12; i += 1) vs.logScore({ score: i / 100, where: 'attempt' });
    expect(vs.voiceLock().log).toHaveLength(VOICE_LOG_LIMIT);
  });
});

describe('suggesting a threshold from real voices', () => {
  const log = (rows) => rows.map(([score, who], i) =>
    ({ score, who, at: 'T' + i, where: 'attempt' }));

  it('asks for more until both kinds have been heard', () => {
    expect(vs.suggestThreshold(log([[0.9, 'her']])).reason).toBe('not-enough');
    expect(vs.suggestThreshold(log([[0.9, 'her'], [0.88, 'her']])).reason).toBe('not-enough');
  });

  it('lands between the quietest her and the loudest not-her', () => {
    const out = vs.suggestThreshold(log([[0.90, 'her'], [0.80, 'her'], [0.40, 'other']]));
    expect(out.ok).toBe(true);
    expect(out.value).toBeCloseTo(0.6, 2);
    expect(out.margin).toBeCloseTo(0.4, 2);
  });

  it('reports an overlap rather than inventing a number', () => {
    // The finding that matters most, and the one a mean would hide: a
    // nine-year-old against other children is exactly where this can happen.
    const out = vs.suggestThreshold(log([[0.70, 'her'], [0.60, 'her'], [0.75, 'other']]));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('overlap');
    expect(out.overlap).toBeCloseTo(0.15, 2);
  });

  it('ignores untagged scores, which mean nothing on their own', () => {
    const out = vs.suggestThreshold(log([[0.9, ''], [0.8, ''], [0.1, '']]));
    expect(out.ok).toBe(false);
    expect(out.hers).toBe(0);
  });
});

describe('being refused, on screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="voice-refused" id="voiceRefusal"></div>';
  });

  it('never falls back to the browser recogniser', async () => {
    // The fallback exists for a transcription service that cannot be reached.
    // If a refusal took it, the browser recogniser would transcribe the clip
    // anyway and the gate would be a decoration.
    const { shouldFallBack } = await import('../features/mic.js');
    expect(shouldFallBack(vl.NOT_HER)).toBe(false);
  });

  it('says so kindly, and does not claim it heard nothing', async () => {
    const { micErrorLabel } = await import('../features/mic.js');
    const label = micErrorLabel(vl.NOT_HER);
    expect(label).toContain('I didn\u2019t hear your voice that time');
    expect(label).toContain('tap to try again');
    expect(label).not.toContain("Didn't catch that");
  });

  it('puts the refusal and its way out on screen, from the gate itself', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    await vl.judgeClip(clipOf(200));

    const box = document.getElementById('voiceRefusal');
    expect(box.classList.contains('show')).toBe(true);
    expect(box.textContent).toContain('Have another go');
    // The escape hatch is on the refusal, not buried in a settings tab.
    const off = box.querySelector('.voice-off');
    expect(off).toBeTruthy();

    off.click();
    expect(vs.voiceLock().enabled).toBe(false);
    expect(box.classList.contains('show')).toBe(false);
    // And it really is off now, not just hidden.
    expect((await vl.judgeClip(clipOf(200))).ok).toBe(true);
  });

  it('clears itself when she is recognised again', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    await vl.judgeClip(clipOf(200));
    expect(document.getElementById('voiceRefusal').classList.contains('show')).toBe(true);
    await vl.judgeClip(clipOf(10));
    expect(document.getElementById('voiceRefusal').classList.contains('show')).toBe(false);
  });
});

describe('the numbers the gate runs on', () => {
  it('will judge a clip as short as a single practice word', () => {
    // sherpa's own minimum is a full second, which is about how long one word
    // takes. Left at its default the gate would quietly never run in Practice
    // — the mode she uses most — and nothing on screen would say so.
    expect(VOICE_MIN_CLIP_SECONDS).toBeLessThan(1);
    // Practice stops on its trailing silence (§17), so the shortest clip it
    // can produce is around that. The gate has to fit under the shortest mode,
    // whatever the deploy has tuned them to.
    const shortest = Math.min(...Object.values(CAPTURE_MODES).map((m) => m.silenceMs));
    expect(VOICE_MIN_CLIP_SECONDS * 1000).toBeLessThan(shortest);
  });

  it('starts just under the measured midpoint, biased towards letting her in', () => {
    // Measured on real speech through this model: same speaker 0.689-0.736,
    // different speakers 0.109-0.370, midpoint 0.53. Under it on purpose.
    expect(VOICE_THRESHOLD_DEFAULT).toBeLessThan(0.53);
    expect(VOICE_THRESHOLD_DEFAULT).toBeGreaterThan(0.37);
  });
});

describe('the model is redistributed with its licence', () => {
  // Apache-2.0 section 4 is the condition on having this model in the repo at
  // all: the licence text and the upstream copyright notice have to travel
  // with the file. `npm run voice:verify` checks this too, but that is a
  // script someone has to remember to run — this is in the suite that runs on
  // every change, because a tidy-up that deleted either file would otherwise
  // leave the project distributing NVIDIA's work without the terms that allow
  // it, and nothing would say so.
  const read = async (name) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../../public/voicelock/' + name, import.meta.url), 'utf8');
  };

  it('ships the full Apache 2.0 text', async () => {
    const text = await read('LICENSE');
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0, January 2004');
    // Not just the title block: the conditions themselves have to be there.
    expect(text).toContain('4. Redistribution');
    expect(text).toContain('END OF TERMS AND CONDITIONS');
  });

  it('keeps NVIDIA\u2019s copyright notice, which is what 4(a) asks for', async () => {
    const notice = await read('NOTICE');
    expect(notice).toContain('Copyright (c) 2020, NVIDIA CORPORATION & AFFILIATES');
    expect(notice).toContain('Apache-2.0');
  });

  it('records the provenance: an ONNX export of NeMo TitaNet-small', async () => {
    const notice = await read('NOTICE');
    expect(notice).toMatch(/ONNX\s+export/);
    expect(notice).toContain('TitaNet');
    expect(notice).toContain('NeMo');
    // And who did the converting, since it was not this project.
    expect(notice).toContain('Xiaomi Corp');
    expect(notice).toContain('sherpa-onnx');
  });

  it('says plainly that this project changed nothing', async () => {
    // 4(b) only bites on files you modify. The claim that we modified nothing
    // is load-bearing, so it is stated in NOTICE and pinned by the hash.
    const notice = await read('NOTICE');
    expect(notice).toContain('byte for byte');
    const manifest = JSON.parse(await read('model.json'));
    expect(manifest.modifiedByThisProject).toBe(false);
    expect(notice).toContain(manifest.sha256);
  });

  it('declares the licence in the manifest, with the files it points to', async () => {
    const manifest = JSON.parse(await read('model.json'));
    expect(manifest.licence).toBe('Apache-2.0');
    expect(manifest.copyright).toContain('NVIDIA CORPORATION');
    // The manifest must not point at files that are not there.
    await expect(read(manifest.licenceFile)).resolves.toBeTruthy();
    await expect(read(manifest.noticeFile)).resolves.toBeTruthy();
  });
});

describe('what gets written to Firestore', () => {
  // The bug the iPad found: enrolment looked saved, then the gate could not be
  // switched on and calibration logged nothing. Both because the write failed.
  // The fake saver above accepts anything; Firestore does not, so these tests
  // apply its actual rule.
  //
  // From @firebase/firestore, in the bundle the browser loads:
  //   throw t.createError("Nested arrays are not supported")
  const firestoreCheck = (value, path, inArray) => {
    if (Array.isArray(value)) {
      if (inArray) throw new Error('Nested arrays are not supported, at ' + path);
      value.forEach((v, i) => firestoreCheck(v, path + '[' + i + ']', true));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) firestoreCheck(v, path + '.' + k, false);
    }
  };

  /** A saver that refuses what Firestore refuses. */
  const strictSaver = (written) => async (key, value) => {
    firestoreCheck(value, key, false);
    written.push({ key, value });
  };

  it('stores an enrolment in a shape Firestore will accept', async () => {
    const written = [];
    store.setSaver(strictSaver(written));
    await expect(enrol(10)).resolves.toBeTruthy();
    expect(written.some((w) => w.key === 'voice_lock')).toBe(true);
  });

  it('survives the round trip back through a snapshot', async () => {
    // This is the whole failure. The write is fire-and-forget, so local state
    // looks right until the next snapshot replaces it with what the server
    // actually holds. If the write was refused, that is nothing.
    const written = [];
    store.setSaver(strictSaver(written));
    await enrol(10);

    const stored = written.filter((w) => w.key === 'voice_lock').pop().value;
    const fresh = {};
    foldSnapshot(fresh, { voice_lock: stored });
    state.voiceLock = fresh.voiceLock;

    const after = vs.voiceLock();
    expect(after.print).not.toBe(null);
    expect(after.print.embeddings).toHaveLength(3);
    expect(after.print.dim).toBe(192);
  });

  it('still recognises her after that round trip, and scores a stranger lower', async () => {
    const written = [];
    store.setSaver(strictSaver(written));
    await enrol(10);
    const stored = written.filter((w) => w.key === 'voice_lock').pop().value;
    const fresh = {};
    foldSnapshot(fresh, { voice_lock: stored });
    state.voiceLock = fresh.voiceLock;

    vs.updateVoiceLock({ enabled: true, threshold: 0.99 });
    expect((await vl.judgeClip(clipOf(10))).ok).toBe(true);
    expect((await vl.judgeClip(clipOf(200))).ok).toBe(false);
  });

  it('records a calibration score after the round trip', async () => {
    // The reported symptom, stated as a test: with calibration on and her
    // voice enrolled, a recording must add a score.
    const written = [];
    store.setSaver(strictSaver(written));
    await enrol(10);
    const stored = written.filter((w) => w.key === 'voice_lock').pop().value;
    const fresh = {};
    foldSnapshot(fresh, { voice_lock: stored });
    state.voiceLock = fresh.voiceLock;

    vs.startCalibration();
    document.body.innerHTML = '<div id="voiceCalNote"></div>';
    const score = await vl.scoreForCalibration(clipOf(200), 'other');
    expect(typeof score).toBe('number');
    expect(vs.voiceLock().log).toHaveLength(1);
    expect(vs.voiceLock().log[0].who).toBe('other');
  });

  it('keeps every later write Firestore-safe too, not just the enrolment', async () => {
    const written = [];
    await enrol(10);
    store.setSaver(strictSaver(written));
    expect(() => vs.logScore({ score: 0.7, where: 'attempt' })).not.toThrow();
    expect(() => vs.tagScore(vs.voiceLock().log[0].at, 'her')).not.toThrow();
    expect(() => vs.updateVoiceLock({ threshold: 0.6 })).not.toThrow();
    // Each of those rewrites the whole field, print included.
    for (const w of written) firestoreCheck(w.value, w.key, false);
    expect(written.length).toBeGreaterThanOrEqual(3);
  });
});

describe('enrolling her voice actually enrols it', () => {
  // The other half of the iPad bug. The enrolment mic was bound without
  // `localOnly`, so bindMic took the transcript branch and never called
  // `onClip` — nothing was ever enrolled, however many times she recorded.
  // It also meant her enrolment audio was uploaded for transcription, which
  // CLAUDE.md section 18 says plainly never happens.
  const CARD = `
    <div id="voiceLockCard">
      <div id="voiceEnrolState"></div>
      <button id="voiceEnrolMic"></button>
      <span id="voiceEnrolMicLabel"></span>
      <button id="voiceForget"></button>
      <div id="voiceEnrolTimer" hidden></div>
      <div id="voiceEnrolNote"></div>
      <div id="voiceCalIdle"><button id="voiceCalStart"></button></div>
      <div id="voiceCalRunning" hidden>
        <p id="voiceCalStep"></p>
        <button id="voiceCalHerMic"></button><span id="voiceCalHerLabel"></span>
        <button id="voiceCalOtherMic"></button><span id="voiceCalOtherLabel"></span>
        <div id="voiceCalNote"></div>
        <div id="voiceCalHerGroup"></div><div id="voiceCalOtherGroup"></div>
        <div id="voiceCalVerdict"></div>
        <button id="voiceCalCancel"></button><button id="voiceCalFinish"></button>
      </div>
      <div id="voiceCalDone" hidden>
        <div id="voiceCalDoneNote"></div><button id="voiceCalAgain"></button>
      </div>
      <input type="checkbox" id="voiceLockOn">
      <input type="range" id="voiceThreshold">
      <div id="voiceThresholdNote"></div>
    </div>
    <div class="voice-refused" id="voiceRefusal"></div>`;

  let uploads;
  beforeEach(() => {
    uploads = 0;
    document.body.innerHTML = CARD;
  });

  /** Tap a mic, wait for the capture to settle. */
  async function tap(id) {
    document.getElementById(id).click();
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById(id).click();
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  it('files a recording under whoever it was, chosen before recording', async () => {
    // Who is decided by which button was tapped, not tagged afterwards. By
    // the third row of bare numbers there was no way to remember which was
    // which.
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    vs.startCalibration();

    expect(typeof await scoreForCalibration(clipOf(10), 'her')).toBe('number');
    expect(typeof await scoreForCalibration(clipOf(200), 'other')).toBe('number');
    const log = vs.voiceLock().log;
    expect(log.map((e) => e.who).sort()).toEqual(['her', 'other']);
    expect(log.every((e) => e.where === 'calibrate')).toBe(true);
    // It scored, and it gated nothing.
    expect(vs.voiceLock().enabled).toBe(false);
  });

  it('lets the parent record as many as they like, of as many people as they like', async () => {
    // Reported as "capped at three". Nothing was capped — but every
    // confirmation was overwritten by the standing advice the instant the
    // card re-rendered, so recording again looked like it did nothing.
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    vs.startCalibration();

    for (let i = 0; i < 5; i += 1) await scoreForCalibration(clipOf(10), 'her');
    // Five different other people, not one.
    for (let i = 0; i < 5; i += 1) await scoreForCalibration(clipOf(40 + i * 30), 'other');

    const log = vs.voiceLock().log;
    expect(log).toHaveLength(10);
    expect(log.filter((e) => e.who === 'her')).toHaveLength(5);
    expect(log.filter((e) => e.who === 'other')).toHaveLength(5);
    // And the per-recording line still says what just happened.
    expect(document.getElementById('voiceCalNote').textContent).toContain('Recorded');
  });

  it('refuses to score before her voice is saved, and says why', async () => {
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    state.voiceLock = null;
    expect(await scoreForCalibration(clipOf(200), 'her')).toBe(null);
    expect(vs.voiceLock().log).toHaveLength(0);
    expect(document.getElementById('voiceCalNote').textContent).toContain('Save her voice first');
  });

  it('a card score and a gate score are the same number for the same voice', async () => {
    // They must be, or the threshold tuned here would not be the threshold
    // the gate applies.
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    const fromCard = await scoreForCalibration(clipOf(200), 'other');
    vs.updateVoiceLock({ calibrating: true });
    const fromGate = await vl.judgeClip(clipOf(200));
    expect(fromCard).toBeCloseTo(fromGate.score, 6);
  });

  it('will not score against a print from another model, and says so', async () => {
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10, 192);
    setVoiceEngine(standIn(128));
    expect(await scoreForCalibration(clipOf(200), 'her')).toBe(null);
    // A number comparing 128 values against 192 would be meaningless, and
    // tuning a threshold on it would be worse than having no score.
    expect(vs.voiceLock().log).toHaveLength(0);
    expect(document.getElementById('voiceCalNote').textContent).toContain('different model');
  });

  it('never counts past the number of recordings it asked for', async () => {
    // Enrolment needs three recordings AND nine seconds in them. Short clips
    // meet the count but not the seconds, and the note used to read
    // "Recording 4 of 3 saved" while still asking for more.
    const { initVoiceLock } = await import('../features/voicelock.js');
    initVoiceLock();
    for (let i = 0; i < 5; i += 1) {
      await tap('voiceEnrolMic');
      const note = document.getElementById('voiceEnrolNote').textContent;
      expect(note).not.toMatch(/Recording [4-9] of 3/);
    }
  });

  it('records three clips without uploading any of them, and saves a print', async () => {
    const transcribe = await import('../lib/transcribe.js');
    const spy = vi.spyOn(transcribe, 'transcribeClip').mockImplementation(async () => {
      uploads += 1;
      return { text: 'should never happen', provider: 'x', model: 'y' };
    });

    const { initVoiceLock } = await import('../features/voicelock.js');
    initVoiceLock();

    for (let i = 0; i < 3; i += 1) await tap('voiceEnrolMic');

    // The thing the parent could not get to happen.
    expect(vs.voiceLock().print).not.toBe(null);
    // And the promise that makes this feature acceptable in a school.
    expect(uploads).toBe(0);
    spy.mockRestore();
  });
});

describe('a stored print that does not add up', () => {
  it('is refused when the flat run does not divide by its width', () => {
    // Belt and braces: a ragged run is caught by the equal-length rule even
    // if the divisibility guard goes, but a print nothing can be cut out of
    // must never come back as a usable one.
    state.voiceLock = { print: { flat: [1, 2, 3, 4, 5], dim: 2 } };
    expect(vs.voiceLock().print).toBe(null);
  });

  it('is refused when the width is missing or senseless', () => {
    for (const dim of [0, -4, 1.5, 'wide', undefined]) {
      state.voiceLock = { print: { flat: [1, 2, 3, 4], dim } };
      expect(vs.voiceLock().print).toBe(null);
    }
  });

  it('cuts a sound flat run back into the rows it went in as', () => {
    state.voiceLock = { print: { flat: [1, 0, 0, 1, 0.5, 0.5], dim: 2 } };
    const print = vs.voiceLock().print;
    expect(print.embeddings).toEqual([[1, 0], [0, 1], [0.5, 0.5]]);
    expect(print.dim).toBe(2);
  });

  it('still opens a print written in the old nested shape', () => {
    // Nothing ever managed to store one, since Firestore refused the write,
    // but a hand-made document or an old export should still open.
    state.voiceLock = { print: { embeddings: [[1, 0], [0, 1]] } };
    expect(vs.voiceLock().print.embeddings).toEqual([[1, 0], [0, 1]]);
  });
});

describe('the enrolment recording says how long it has been going', () => {
  // The parent timed the first enrolment on their phone. The card asked for
  // "about ten seconds" and then showed nothing: no elapsed time, no target,
  // and no stop.
  it('stops itself at the target rather than running on', () => {
    // The ceiling IS the target here, unlike every other mode where it is a
    // safety net several times longer than the expected recording.
    expect(CAPTURE_MODES.enrol.maxMs).toBe(VOICE_ENROL_TARGET_SECONDS * 1000);
  });

  it('waits long enough through a thinking pause to get there', () => {
    // She is talking freely about nothing in particular and will stop to
    // think. Cut that short and the recording is too short to count, which
    // is the silent failure being fixed.
    expect(CAPTURE_MODES.enrol.silenceMs).toBeGreaterThan(CAPTURE_MODES.sentence.silenceMs);
    expect(CAPTURE_MODES.enrol.silenceMs).toBeLessThan(CAPTURE_MODES.enrol.maxMs);
  });

  it('counts the seconds up on screen while recording', async () => {
    document.body.innerHTML = '<div id="voiceEnrolTimer" hidden></div>';
    const { showEnrolTimer } = await import('../features/voicelock.js');
    const box = document.getElementById('voiceEnrolTimer');

    showEnrolTimer(1000);
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('1s');
    // Below the minimum, it does not yet claim to be usable.
    expect(box.textContent).not.toContain('long enough');

    showEnrolTimer(VOICE_ENROL_MIN_SECONDS * 1000);
    expect(box.textContent).toContain('long enough');
    expect(box.className).toContain('enough');
  });
});

describe('a recording too short to use says so', () => {
  const FIXTURE = '<div id="voiceEnrolNote"></div><div id="voiceEnrolTimer" hidden></div>';

  it('is refused by name, and is not half-counted', async () => {
    // The old rule wanted three clips AND nine seconds between them, so a
    // short clip was counted towards one and not the other: the card could
    // sit on "3 of 3" and still ask for more, with nothing saying which
    // recording was the problem.
    document.body.innerHTML = FIXTURE;
    const { collectEnrolment } = await import('../features/voicelock.js');

    shortClips = true;
    await collectEnrolment(clipOf(10));
    shortClips = false;

    const note = document.getElementById('voiceEnrolNote').textContent;
    expect(note).toContain('seconds');
    expect(note).toMatch(/not been counted|at least/);
    expect(vs.voiceLock().print).toBe(null);
  });

  it('and a full-length one is counted and said so', async () => {
    document.body.innerHTML = FIXTURE;
    const { collectEnrolment } = await import('../features/voicelock.js');
    await collectEnrolment(clipOf(10));
    expect(document.getElementById('voiceEnrolNote').textContent)
      .toContain('1 of ' + VOICE_ENROL_CLIPS);
  });
});

describe('calibration is a session, not a mode left switched on', () => {
  const mount = () => {
    document.body.innerHTML = `
      <div id="voiceLockCard">
        <div id="voiceEnrolState"></div><button id="voiceEnrolMic"></button>
        <span id="voiceEnrolMicLabel"></span><button id="voiceForget"></button>
        <div id="voiceEnrolTimer" hidden></div><div id="voiceEnrolNote"></div>
        <div id="voiceCalIdle"><button id="voiceCalStart"></button></div>
        <div id="voiceCalRunning" hidden>
          <p id="voiceCalStep"></p>
          <button id="voiceCalHerMic"></button><span id="voiceCalHerLabel"></span>
          <button id="voiceCalOtherMic"></button><span id="voiceCalOtherLabel"></span>
          <div id="voiceCalNote"></div>
          <div id="voiceCalHerGroup"></div><div id="voiceCalOtherGroup"></div>
          <div id="voiceCalVerdict"></div>
          <button id="voiceCalCancel"></button><button id="voiceCalFinish"></button>
        </div>
        <div id="voiceCalDone" hidden>
          <div id="voiceCalDoneNote"></div><button id="voiceCalAgain"></button>
        </div>
        <input type="checkbox" id="voiceLockOn">
        <input type="range" id="voiceThreshold"><div id="voiceThresholdNote"></div>
      </div><div class="voice-refused" id="voiceRefusal"></div>`;
  };
  const vis = (id) => !document.getElementById(id).hidden;

  it('walks idle to running to done, one visible at a time', async () => {
    mount();
    const { initVoiceLock, renderVoiceLock, scoreForCalibration } =
      await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);

    renderVoiceLock();
    expect([vis('voiceCalIdle'), vis('voiceCalRunning'), vis('voiceCalDone')])
      .toEqual([true, false, false]);

    document.getElementById('voiceCalStart').click();
    expect([vis('voiceCalIdle'), vis('voiceCalRunning'), vis('voiceCalDone')])
      .toEqual([false, true, false]);

    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(200), 'other');
    document.getElementById('voiceCalFinish').click();
    expect([vis('voiceCalIdle'), vis('voiceCalRunning'), vis('voiceCalDone')])
      .toEqual([false, false, true]);
  });

  it('tells you what to do next at each point', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    document.getElementById('voiceCalStart').click();
    const step = () => document.getElementById('voiceCalStep').textContent;

    expect(step()).toContain('Record Harlie');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    expect(step()).toContain('somebody else');
    await scoreForCalibration(clipOf(200), 'other');
    expect(step()).toMatch(/Enough|finish/i);
  });

  it('shows the scores grouped by who they belong to', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    document.getElementById('voiceCalStart').click();
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(200), 'other');

    expect(document.getElementById('voiceCalHerGroup').textContent).toContain('Harlie · 2');
    expect(document.getElementById('voiceCalOtherGroup').textContent).toContain('Someone else · 1');
  });

  it('shows both ranges and says plainly whether they overlap', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    document.getElementById('voiceCalStart').click();
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(200), 'other');

    const verdict = document.getElementById('voiceCalVerdict').textContent;
    expect(verdict).toContain('Harlie');
    expect(verdict).toContain('Others');
    // These two voices separate, so it should say so and name a number.
    expect(verdict).toMatch(/do not overlap/);
  });

  it('calls an overlap an overlap rather than inventing a threshold', async () => {
    mount();
    const { initVoiceLock, renderVoiceLock } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    vs.startCalibration();
    // Hand-built so the two genuinely overlap.
    vs.logScore({ score: 0.70, where: 'calibrate', who: 'her' });
    vs.logScore({ score: 0.60, where: 'calibrate', who: 'her' });
    vs.logScore({ score: 0.75, where: 'calibrate', who: 'other' });
    renderVoiceLock();
    expect(document.getElementById('voiceCalVerdict').textContent).toContain('overlap');
    // And finishing on an overlap is still allowed — the parent may want the
    // finding recorded and the gate left off.
    expect(document.getElementById('voiceCalFinish').disabled).toBe(false);
  });

  it('finishing fills the threshold in and opens the gate setting', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration, renderVoiceLock } =
      await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    renderVoiceLock();

    // Before calibrating, the gate cannot be switched on at all.
    expect(document.getElementById('voiceLockOn').disabled).toBe(true);

    document.getElementById('voiceCalStart').click();
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(200), 'other');
    const suggested = vs.suggestThreshold(vs.voiceLock().log).value;
    document.getElementById('voiceCalFinish').click();

    expect(document.getElementById('voiceLockOn').disabled).toBe(false);
    expect(vs.voiceLock().threshold).toBeCloseTo(suggested, 6);
    expect(vs.voiceLock().calibratedAt).not.toBe('');
  });

  it('cancelling keeps nothing, because half a session is not evidence', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    document.getElementById('voiceCalStart').click();
    await scoreForCalibration(clipOf(10), 'her');
    document.getElementById('voiceCalCancel').click();

    expect(vs.voiceLock().calibrating).toBe(false);
    expect(vs.voiceLock().log).toHaveLength(0);
    expect(vs.voiceLock().calibratedAt).toBe('');
  });

  it('forgetting her voice throws the calibration away with it', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    document.getElementById('voiceCalStart').click();
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(200), 'other');
    document.getElementById('voiceCalFinish').click();
    vs.updateVoiceLock({ enabled: true });

    // Every score was a comparison against the print being thrown away.
    window.confirm = () => true;
    document.getElementById('voiceForget').click();
    const after = vs.voiceLock();
    expect(after.print).toBe(null);
    expect(after.enabled).toBe(false);
    expect(after.calibratedAt).toBe('');
    expect(after.log).toHaveLength(0);
  });

  it('the gate stays a single switch that turns off at any time', async () => {
    mount();
    const { initVoiceLock, scoreForCalibration } = await import('../features/voicelock.js');
    initVoiceLock();
    await enrol(10);
    document.getElementById('voiceCalStart').click();
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(10), 'her');
    await scoreForCalibration(clipOf(200), 'other');
    document.getElementById('voiceCalFinish').click();

    const gate = document.getElementById('voiceLockOn');
    gate.checked = true;
    gate.dispatchEvent(new Event('change'));
    expect(vs.voiceLock().enabled).toBe(true);
    gate.checked = false;
    gate.dispatchEvent(new Event('change'));
    expect(vs.voiceLock().enabled).toBe(false);
  });
});

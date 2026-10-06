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
window.AudioContext = class {
  decodeAudioData(buf) {
    if (decodeFails) return Promise.reject(new Error('bad-audio'));
    const who = new Uint8Array(buf)[0];
    const data = new Float32Array(16000);
    data.fill(who / 255);
    return Promise.resolve({
      numberOfChannels: 1, length: data.length, sampleRate: 16000,
      duration: 4, getChannelData: () => data
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
        CAPTURE_MODES } = await import('../config.js');

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

  it('never refuses while calibrating, and records the score instead', async () => {
    await enrol(10);
    vs.updateVoiceLock({ enabled: true, calibrating: true, threshold: 0.99 });
    const verdict = await vl.judgeClip(clipOf(200));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toBe('calibrating');
    expect(vs.voiceLock().log).toHaveLength(1);
    expect(vs.voiceLock().log[0].score).toBeCloseTo(verdict.score, 6);
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

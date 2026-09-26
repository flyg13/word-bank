// @vitest-environment jsdom
// The gap between the recording ending and the words appearing.
//
// It is several seconds, and it used to look identical to recording — the
// button kept its gold "listening" fill the whole time, and an auto-stop never
// even changed the label. On the iPad that reads as the app having frozen,
// which is what the parent reported. See CLAUDE.md §13.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeRecognition { start() {} stop() {} }
window.SpeechRecognition = FakeRecognition;

// A microphone the test stops itself, so the auto-stop path — the one with no
// tap behind it — can be driven directly.
let recorder = null;
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; recorder = this; }
  start() { this.state = 'recording'; this.ondataavailable({ data: new Blob(['audio']) }); }
  stop() { this.state = 'inactive'; this.onstop(); }
}
globalThis.MediaRecorder = FakeMediaRecorder;
navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
window.AudioContext = class {
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(1); } }; }
  createMediaStreamSource() { return { connect() {} }; }
  close() {}
};

const { bindMic, MIC_IDLE, MIC_RECORDING, MIC_WORKING } = await import('../features/mic.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const button = () => document.getElementById('m');
const label = () => document.getElementById('l');
const tap = () => button().click();

/** Hold the transcription open so the working state can be looked at. */
function serviceHangs() {
  let release;
  globalThis.fetch = vi.fn(() => new Promise((resolve) => {
    release = () => resolve(new Response(
      JSON.stringify({ text: 'yellow', provider: 'p', model: 'm' }), { status: 200 }));
  }));
  return () => release();
}

describe('while the clip is being turned into text', () => {
  let heard;
  let working;

  beforeEach(() => {
    document.body.innerHTML =
      '<button id="m"></button><div id="l"></div><div id="accuracyBanner"></div>';
    heard = [];
    working = 0;
    bindMic({
      buttonId: 'm', labelId: 'l', mode: 'word',
      onWorking: () => { working += 1; },
      onResult: (t) => heard.push(t)
    });
  });
  afterEach(() => { delete globalThis.fetch; });

  it('stops looking like it is still recording', async () => {
    const release = serviceHangs();
    tap();
    await settle();
    expect(button().classList.contains('listening')).toBe(true);

    tap();
    await settle();
    // The whole complaint: this used to stay true for the entire upload.
    expect(button().classList.contains('listening')).toBe(false);
    expect(button().classList.contains('working')).toBe(true);
    expect(label().textContent).toBe(MIC_WORKING);
    expect(label().classList.contains('working')).toBe(true);

    release();
    await settle();
    expect(heard).toEqual(['yellow']);
  });

  it('says so when the recording stopped on its own, with no tap behind it', async () => {
    // The auto-stop path had no feedback at all: nothing in the app knew the
    // recording had ended until the transcript came back.
    const release = serviceHangs();
    tap();
    await settle();
    expect(label().textContent).toBe(MIC_RECORDING);

    recorder.stop();
    await settle();
    expect(button().classList.contains('working')).toBe(true);
    expect(button().classList.contains('listening')).toBe(false);
    expect(label().textContent).toBe(MIC_WORKING);
    expect(working).toBe(1);

    release();
    await settle();
    expect(heard).toEqual(['yellow']);
  });

  it('clears the working state once the words arrive', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'yellow', provider: 'p', model: 'm' }), { status: 200 }));
    tap();
    await settle();
    tap();
    await settle();
    expect(button().classList.contains('working')).toBe(false);
    expect(label().classList.contains('working')).toBe(false);
    expect(label().textContent).toBe(MIC_IDLE);
  });

  it('clears it when the recording failed rather than leaving it spinning', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 }));
    tap();
    await settle();
    tap();
    await settle(); await settle();
    expect(button().classList.contains('working')).toBe(false);
    expect(label().classList.contains('working')).toBe(false);
    expect(label().textContent).not.toBe(MIC_WORKING);
  });

  it('tells the screen, so a tab can say so where the parent is looking', async () => {
    const release = serviceHangs();
    tap();
    await settle();
    tap();
    await settle();
    expect(working).toBe(1);
    release();
    await settle();
  });

  it('never lets a broken indicator take out a recording', async () => {
    // onWorking runs inside the capture. A screen that throws must not be
    // what loses her clip.
    document.body.innerHTML =
      '<button id="m2"></button><div id="l2"></div><div id="accuracyBanner"></div>';
    const got = [];
    bindMic({
      buttonId: 'm2', labelId: 'l2', mode: 'word',
      onWorking: () => { throw new Error('the screen blew up'); },
      onResult: (t) => got.push(t)
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'yellow', provider: 'p', model: 'm' }), { status: 200 }));

    document.getElementById('m2').click();
    await settle();
    recorder.stop();
    await settle(); await settle();
    expect(got).toEqual(['yellow']);
  });
});

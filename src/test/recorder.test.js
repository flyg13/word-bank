// @vitest-environment jsdom
// The recorder's whole job is deciding when she has finished. These drive it
// through each of the four ways that can happen.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SILENCE_RMS, NO_SPEECH_MS } from '../config.js';

// ---------- A microphone that does what it is told ----------

let level = 0; // what the analyser will report, set by each test

class FakeRecorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || '';
    this.state = 'inactive';
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
    // One chunk, as a real recorder would deliver on stop.
    setTimeout(() => this.ondataavailable && this.ondataavailable({ data: new Blob(['audio']) }), 0);
  }
  stop() {
    this.state = 'inactive';
    if (this.onstop) this.onstop();
  }
}

const tracks = [];
function installMic() {
  tracks.length = 0;
  globalThis.MediaRecorder = FakeRecorder;
  const track = { stop: vi.fn() };
  tracks.push(track);
  navigator.mediaDevices = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => tracks }))
  };
  const analyser = {
    fftSize: 2048,
    getFloatTimeDomainData(buffer) { buffer.fill(level); }
  };
  window.AudioContext = class {
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; }
  };
}

const { startRecording, mediaRecordingSupported } = await import('../lib/recorder.js');

const LOUD = SILENCE_RMS * 4;
const QUIET = 0;

describe('the recorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMic();
    level = LOUD;
  });

  const run = async (options) => {
    const handle = await startRecording({ silenceMs: 500, maxMs: 5000, ...options });
    // Let MediaRecorder deliver its chunk.
    await vi.advanceTimersByTimeAsync(0);
    return handle;
  };

  it('records until it is told to stop, and that is immediate', async () => {
    const { done, stop } = await run();
    await vi.advanceTimersByTimeAsync(3000);
    stop('tap');
    const clip = await done;
    expect(clip.reason).toBe('tap');
    expect(clip.blob.size).toBeGreaterThan(0);
  });

  it('stops on its own once she has stopped talking', async () => {
    const { done } = await run({ silenceMs: 500 });
    await vi.advanceTimersByTimeAsync(400); // still talking
    level = QUIET;
    await vi.advanceTimersByTimeAsync(600);
    expect((await done).reason).toBe('silence');
  });

  it('does not mistake the pause before she starts for the pause after', async () => {
    // The failure this prevents: tapping, taking a breath, and the recorder
    // having already given up.
    level = QUIET;
    const { done, stop } = await run({ silenceMs: 500 });
    await vi.advanceTimersByTimeAsync(1500);
    level = LOUD;
    await vi.advanceTimersByTimeAsync(200);
    stop('tap');
    expect((await done).reason).toBe('tap');
  });

  it('gives up if she never says anything at all', async () => {
    level = QUIET;
    const { done } = await run({ silenceMs: 500, maxMs: 60000 });
    await vi.advanceTimersByTimeAsync(NO_SPEECH_MS + 200);
    expect((await done).reason).toBe('quiet');
  });

  it('cannot be left running past the ceiling', async () => {
    // Talking continuously, so only maxMs can end it.
    const { done } = await run({ silenceMs: 500, maxMs: 2000 });
    await vi.advanceTimersByTimeAsync(2200);
    expect((await done).reason).toBe('max');
  });

  it('always releases the microphone', async () => {
    const { done, stop } = await run();
    stop('tap');
    await done;
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('picks a container the browser actually supports', async () => {
    await run();
    expect(FakeRecorder.last.mimeType).toBe('audio/webm;codecs=opus');
  });

  it('still records where Web Audio is missing, with only tap and the ceiling', async () => {
    // Silence detection is a convenience; losing it must not lose recording.
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
    const { done } = await run({ silenceMs: 500, maxMs: 1000 });
    await vi.advanceTimersByTimeAsync(1200);
    expect((await done).reason).toBe('max');
  });

  it('knows when the browser cannot record at all', () => {
    expect(mediaRecordingSupported()).toBe(true);
    const saved = globalThis.MediaRecorder;
    globalThis.MediaRecorder = undefined;
    expect(mediaRecordingSupported()).toBe(false);
    globalThis.MediaRecorder = saved;
  });
});

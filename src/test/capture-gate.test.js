// @vitest-environment jsdom
// The seam Voice Lock (CLAUDE.md §5) will sit in: the clip exists, and is
// offered to every registered check, before anything is sent anywhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; }
  start() { this.state = 'recording'; this.ondataavailable({ data: new Blob(['her voice']) }); }
  stop() { this.state = 'inactive'; this.onstop(); }
}
globalThis.MediaRecorder = FakeMediaRecorder;
const stopped = [];
navigator.mediaDevices = {
  getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] })
};
window.AudioContext = class {
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(1); } }; }
  createMediaStreamSource() { return { connect() {} }; }
  close() {}
};

const { startCapture, addClipGate, lastRecordedClip, CaptureError } =
  await import('../lib/capture.js');

// One gate, registered once — as Voice Lock would be — with the verdict it
// returns set per test. Registration is deliberately permanent in capture.js:
// a check that can be unregistered is a check that can be bypassed.
let verdict = { ok: true };
const seen = [];
let fetchCallsWhenGateRan = null;
addClipGate((clip) => {
  seen.push(clip);
  fetchCallsWhenGateRan = globalThis.fetch ? globalThis.fetch.mock.calls.length : 0;
  return verdict;
});

describe('the clip gate', () => {
  beforeEach(() => {
    stopped.length = 0;
    seen.length = 0;
    fetchCallsWhenGateRan = null;
    verdict = { ok: true };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'yellow' }), { status: 200 }));
  });
  afterEach(() => { delete globalThis.fetch; });

  const capture = async () => {
    const handle = await startCapture({ mode: 'word', expected: 'yellow' });
    handle.stop('tap');
    return handle.result;
  };

  it('hands the recorded audio to a gate before it is sent', async () => {
    await capture();
    expect(seen).toHaveLength(1);
    expect(seen[0].blob).toBeInstanceOf(Blob);
    expect(seen[0].blob.size).toBeGreaterThan(0);
    expect(seen[0].mimeType).toBeTruthy();
    // The whole point: nothing had left the device when the gate ran.
    expect(fetchCallsWhenGateRan).toBe(0);
  });

  it('sends nothing at all when a gate refuses', async () => {
    verdict = { ok: false, code: 'not-her-voice' };
    await expect(capture()).rejects.toMatchObject({ code: 'not-her-voice' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports a refusal as its own code, not as a service failure', async () => {
    // Otherwise the mic's fallback would quietly transcribe, through a second
    // route, audio that a gate had just rejected.
    verdict = { ok: false, code: 'not-her-voice' };
    const error = await capture().catch((e) => e);
    expect(error).toBeInstanceOf(CaptureError);
    expect(error.code).toBe('not-her-voice');
  });

  it('keeps the clip available to the app whether or not it was sent', async () => {
    verdict = { ok: false, code: 'not-her-voice' };
    await capture().catch(() => {});
    expect(lastRecordedClip().blob.size).toBeGreaterThan(0);
    expect(lastRecordedClip().durationMs).toBeGreaterThanOrEqual(0);
  });

  it('releases the microphone even when a gate refuses', async () => {
    verdict = { ok: false, code: 'not-her-voice' };
    await capture().catch(() => {});
    expect(stopped.length).toBeGreaterThan(0);
  });
});

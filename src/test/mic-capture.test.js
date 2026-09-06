// @vitest-environment jsdom
// The mic button's state machine: tap to record, tap to stop, and what happens
// when the speech service is not there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The browser recogniser has to exist before speech.js is imported — it is the
// fallback, so every test here needs it available.
class FakeRecognition {
  start() {
    setTimeout(() => {
      if (FakeRecognition.nextError) {
        if (this.onerror) this.onerror({ error: FakeRecognition.nextError, message: '' });
      } else if (this.onresult) {
        this.onresult({ results: [[{ transcript: FakeRecognition.nextTranscript }]] });
      }
      if (this.onend) this.onend();
    }, 0);
  }
  stop() {}
}
FakeRecognition.nextTranscript = 'browser heard this';
FakeRecognition.nextError = null;
window.SpeechRecognition = FakeRecognition;

// A microphone that records whatever the test says, when the test says.
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

const { bindMic, MIC_IDLE, MIC_RECORDING, shouldFallBack } = await import('../features/mic.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const label = () => document.getElementById('l').textContent;
const banner = () => document.getElementById('accuracyBanner');
const tap = () => document.getElementById('m').click();

describe('the mic button', () => {
  let heard;

  beforeEach(() => {
    document.body.innerHTML =
      '<button id="m"></button><div id="l"></div><div id="accuracyBanner" class="banner"></div>';
    heard = [];
    FakeRecognition.nextError = null;
    bindMic({ buttonId: 'm', labelId: 'l', mode: 'word', onResult: (t) => heard.push(t) });
  });

  afterEach(() => { delete globalThis.fetch; });

  const serviceReturns = (text) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ text, provider: 'openai', model: 'm' }), { status: 200 }));
  };
  const serviceFails = (status, body) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body || {}), { status }));
  };

  it('records on the first tap and says so', async () => {
    serviceReturns('yellow');
    tap();
    await settle();
    expect(label()).toBe(MIC_RECORDING);
    expect(document.getElementById('m').classList.contains('listening')).toBe(true);
    expect(heard).toEqual([]);
  });

  it('stops on the second tap and hands back the service\'s text', async () => {
    serviceReturns('yellow');
    tap();
    await settle();
    tap();
    await settle();
    expect(heard).toEqual(['yellow']);
    expect(label()).toBe(MIC_IDLE);
    expect(document.getElementById('m').classList.contains('listening')).toBe(false);
  });

  it('stops on its own when she goes quiet, without a second tap', async () => {
    serviceReturns('yellow');
    // Speech, then silence past the word mode's 1.2s pause.
    window.AudioContext = class {
      createAnalyser() {
        let calls = 0;
        return { fftSize: 2048, getFloatTimeDomainData(b) { calls += 1; b.fill(calls < 3 ? 1 : 0); } };
      }
      createMediaStreamSource() { return { connect() {} }; }
      close() {}
    };
    tap();
    await new Promise((r) => setTimeout(r, 2000));
    expect(heard).toEqual(['yellow']);
  }, 10000);

  it('sends the audio it recorded, not a transcript', async () => {
    let body = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = init.body;
      return new Response(JSON.stringify({ text: 'yellow' }), { status: 200 });
    });
    tap();
    await settle();
    tap();
    await settle();
    expect(body.get('audio')).toBeInstanceOf(Blob);
    expect(body.get('audio').size).toBeGreaterThan(0);
  });

  describe('when the speech service cannot be reached', () => {
    it('falls back to the browser recogniser rather than losing the attempt', async () => {
      serviceFails(503, { error: 'not-configured' });
      tap();
      await settle();
      tap();
      await settle();
      await settle();
      expect(heard).toEqual(['browser heard this']);
    });

    it('says out loud that it is running in reduced accuracy, naming the code', async () => {
      serviceFails(503, { error: 'not-configured' });
      tap();
      await settle();
      tap();
      await settle();
      expect(banner().classList.contains('show')).toBe(true);
      expect(banner().textContent).toContain('Reduced accuracy');
      expect(banner().textContent).toContain('not-configured');
    });

    it('never pretends the fallback is the real thing', async () => {
      serviceFails(500);
      tap();
      await settle();
      tap();
      await settle();
      // The notice names the browser recogniser as what she was being
      // misheard by before — it does not present it as an equal.
      expect(banner().textContent).toContain('browser');
      expect(banner().textContent).toContain('less reliable');
    });

    it('clears the notice as soon as a real transcript comes back', async () => {
      serviceFails(500);
      tap();
      await settle();
      tap();
      await settle();
      await settle();
      expect(banner().classList.contains('show')).toBe(true);

      serviceReturns('yellow');
      tap();          // consumes the armed fallback
      await settle();
      await settle();
      tap();          // back on the service
      await settle();
      tap();
      await settle();
      expect(banner().classList.contains('show')).toBe(false);
      expect(heard[heard.length - 1]).toBe('yellow');
    });
  });

  describe('what is worth falling back for', () => {
    it('falls back for the service being down, not for the microphone being blocked', () => {
      ['offline', 'timeout', 'not-configured', 'rate-limited', 'http-502']
        .forEach((code) => expect(shouldFallBack(code)).toBe(true));
      // Re-recording cannot fix these, and a gate refusing a clip must not be
      // quietly worked around.
      ['not-allowed', 'audio-capture', 'no-speech', 'blocked', 'no-recorder']
        .forEach((code) => expect(shouldFallBack(code)).toBe(false));
    });

    it('does not fall back when she simply did not speak', async () => {
      globalThis.fetch = vi.fn();
      // An analyser that only ever reports silence: nothing was said.
      window.AudioContext = class {
        createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0); } }; }
        createMediaStreamSource() { return { connect() {} }; }
        close() {}
      };
      tap();
      // Long enough for the level check to be trusted, then tap to stop.
      await new Promise((r) => setTimeout(r, 700));
      tap();
      await settle();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(banner().classList.contains('show')).toBe(false);
      expect(label()).toContain('(no-speech)');
    });
  });
});

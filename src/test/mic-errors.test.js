// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The recognizer has to exist before speech.js is imported.
class FakeRecognition {
  start() {
    if (this.onerror) this.onerror({ error: FakeRecognition.nextError, message: '' });
    if (this.onend) this.onend();
  }
  stop() {}
}
window.SpeechRecognition = FakeRecognition;

const { micErrorLabel, bindMic, MIC_IDLE } = await import('../features/mic.js');

describe('micErrorLabel', () => {
  it('always names the raw code', () => {
    ['no-speech', 'not-allowed', 'network', 'audio-capture', 'service-not-allowed'].forEach(
      (code) => expect(micErrorLabel(code)).toContain('(' + code + ')')
    );
  });

  it('explains what each code means, not just the code', () => {
    expect(micErrorLabel('no-speech')).toContain("Didn't hear anything");
    expect(micErrorLabel('not-allowed')).toContain('permission is blocked');
    expect(micErrorLabel('audio-capture')).toContain('No microphone found');
    expect(micErrorLabel('network')).toContain('Network problem');
  });

  it('names the language when the browser has no recogniser for it', () => {
    // The failure mode the en-AU default can actually cause.
    const label = micErrorLabel('language-not-supported', 'en-AU');
    expect(label).toContain('en-AU');
    expect(label).toContain('(language-not-supported)');
    expect(label).toContain('Word Bank');
  });

  it('still names an unrecognised code', () => {
    expect(micErrorLabel('some-new-code')).toBe(
      "Didn't catch that (some-new-code) — tap to try again"
    );
  });

  it('does not tell you to retry what retrying cannot fix', () => {
    expect(micErrorLabel('not-allowed')).not.toContain('tap to try again');
    expect(micErrorLabel('audio-capture')).not.toContain('tap to try again');
    expect(micErrorLabel('no-speech')).toContain('tap to try again');
  });
});

describe('bindMic error handling', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="m"></button><div id="l"></div>';
  });

  const press = async (code) => {
    FakeRecognition.nextError = code;
    bindMic({ buttonId: 'm', labelId: 'l', onResult: () => {} });
    document.getElementById('m').click();
    await new Promise((r) => setTimeout(r, 0));
    return document.getElementById('l').textContent;
  };

  it('shows the code on the mic label', async () => {
    expect(await press('no-speech')).toBe("Didn't hear anything (no-speech) — tap to try again");
  });

  it('clears the listening state on error', async () => {
    await press('network');
    expect(document.getElementById('m').classList.contains('listening')).toBe(false);
  });

  it('treats a cancelled listen as ordinary, not as a failure', async () => {
    // `aborted` fires when the user taps away or a new listen starts. Reporting
    // it would put a scary message on screen for a non-event.
    expect(await press('aborted')).toBe(MIC_IDLE);
  });
});

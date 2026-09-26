// @vitest-environment jsdom
// The rough live preview of what she is saying, from the browser's own
// recogniser running alongside the recording. It exists to cover the wait, and
// it is a preview and nothing else — CLAUDE.md §15.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A browser recogniser the test drives: interim results on demand.
let live = null;
class FakeRecognition {
  constructor() { this.continuous = false; this.interimResults = false; }
  start() { live = this; FakeRecognition.started += 1; }
  stop() { if (live === this) live = null; }
  abort() { if (live === this) live = null; }
  /** Push a rough guess, the way a real recogniser does as she talks. */
  say(text) {
    if (this.onresult) this.onresult({ results: [[{ transcript: text }]] });
  }
  fail() { if (this.onerror) this.onerror({ error: 'not-allowed' }); }
}
FakeRecognition.started = 0;
window.SpeechRecognition = FakeRecognition;

let recorder = null;
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; recorder = this; }
  start() { this.state = 'recording'; this.ondataavailable({ data: new Blob(['a']) }); }
  stop() { this.state = 'inactive'; this.onstop(); }
}
globalThis.MediaRecorder = FakeMediaRecorder;
navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
window.AudioContext = class {
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(1); } }; }
  createMediaStreamSource() { return { connect() {} }; }
  close() {}
};
window.speechSynthesis = { cancel() {}, speak(u) { if (u.onstart) u.onstart(); if (u.onend) u.onend(); } };
window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

const { state } = await import('../lib/store.js');
const { createAnswer } = await import('../features/answer.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const IDS = {
  input: 'rawInput', output: 'correctedOutput', contextNote: 'contextNote',
  writeNote: 'writeNote', copyNote: 'copyNote', interim: 'interimBox',
  mic: 'writeMic', micLabel: 'writeMicLabel', copy: 'copyBtn',
  clear: 'clearBtn', readBack: 'readBackBtn'
};
const DOM = `
  <nav class="tabs"><div class="tab" data-tab="write"></div></nav>
  <div id="tab-write"></div>
  <textarea id="rawInput"></textarea>
  <button id="writeMic"></button><div id="writeMicLabel"></div>
  <div class="interim" id="interimBox"></div>
  <div id="correctedOutput"></div>
  <div class="context-note" id="contextNote"></div>
  <div class="write-note" id="writeNote"></div>
  <button id="copyBtn"></button><button id="clearBtn"></button>
  <button id="readBackBtn"></button><span class="copy-note" id="copyNote"></span>
  <div class="fix-panel" id="fixPanel">
    <span id="fixingWord"></span><input id="fixInput">
    <button id="saveFix"></button><button id="cancelFix"></button>
  </div>
  <div id="accuracyBanner"></div>`;

const interim = () => document.getElementById('interimBox');
const out = () => document.getElementById('correctedOutput');
const raw = () => document.getElementById('rawInput');
let answer;
let sent;

/** Hold the transcription open so the wait it covers can be looked at. */
function serviceHangs(text) {
  let release;
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).includes('contextual-correct')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ changes: [] }), { status: 200 });
    }
    return new Promise((resolve) => {
      release = () => resolve(new Response(
        JSON.stringify({ text, provider: 'p', model: 'm' }), { status: 200 }));
    });
  });
  return () => { if (release) release(); };
}

beforeEach(() => {
  state.wordBank = {};
  state.phonicBank = {};
  state.contextLog = [];
  live = null;
  sent = [];
  FakeRecognition.started = 0;
  document.body.innerHTML = DOM;
  answer = createAnswer({ ids: IDS });
  answer.render();
});
afterEach(() => { delete globalThis.fetch; });

describe('a rough preview while she is still talking', () => {
  it('shows what the browser thinks it heard, as she says it', async () => {
    const release = serviceHangs('i found a big chest');
    document.getElementById('writeMic').click();
    await settle();

    expect(live).not.toBe(null);
    expect(live.interimResults).toBe(true);
    live.say('i found');
    expect(interim().textContent).toBe('i found');
    expect(interim().classList.contains('show')).toBe(true);
    live.say('i found a big');
    expect(interim().textContent).toBe('i found a big');

    release();
    await settle();
  });

  it('is visibly provisional, not presented as her answer', async () => {
    // Greyed and italic, in its own box, with a leading ellipsis. It must not
    // read as the thing she is about to hand in.
    const release = serviceHangs('hello');
    document.getElementById('writeMic').click();
    await settle();
    live.say('rough words');
    expect(interim().id).not.toBe(out().id);
    // Her answer panel is untouched: the rough words are somewhere else
    // entirely, in a box styled as provisional.
    expect(out().textContent).not.toContain('rough words');
    expect(out().textContent).toContain('Nothing here yet');
    release();
    await settle();
  });

  it('stays up through the wait for the real transcript, then is replaced', async () => {
    // The wait it covers begins when she stops talking, so it must not vanish
    // at that moment — that is the gap the parent said felt too long.
    const release = serviceHangs('i found a big chest');
    document.getElementById('writeMic').click();
    await settle();
    live.say('i found a big chest');
    document.getElementById('writeMic').click();
    await settle();

    expect(interim().textContent).toBe('i found a big chest');
    expect(live).toBe(null); // no longer listening, still on screen

    release();
    await settle(); await settle();
    expect(interim().textContent).toBe('');
    expect(interim().classList.contains('show')).toBe(false);
    expect(out().textContent).toBe('i found a big chest');
  });

  it('never reaches her answer, so it cannot be saved or copied', async () => {
    const release = serviceHangs('the real words');
    const changes = [];
    answer = createAnswer({ ids: IDS, onChange: (t) => changes.push(t) });
    document.getElementById('writeMic').click();
    await settle();
    live.say('a rough guess at it');
    expect(interim().textContent).toBe('a rough guess at it');

    // The box everything is read from is untouched, so nothing downstream can
    // see the preview: saving, Copy and Read it to me all read this.
    expect(raw().value).toBe('');
    expect(answer.plainText()).toBe('');
    expect(changes).toEqual([]);

    document.getElementById('writeMic').click();
    await settle();
    release();
    await settle(); await settle();
    expect(raw().value).toBe('the real words');
    expect(answer.plainText()).toBe('the real words');
  });

  it('is never sent to be checked in context', async () => {
    const release = serviceHangs('the real words');
    document.getElementById('writeMic').click();
    await settle();
    live.say('a rough guess');
    document.getElementById('writeMic').click();
    await settle();
    release();
    await settle(); await settle(); await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].tokens).toEqual(['the', 'real', 'words']);
  });

  it('is cleared when the recording fails, not left looking like an answer', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 }));
    document.getElementById('writeMic').click();
    await settle();
    live.say('a rough guess');
    expect(interim().textContent).toBe('a rough guess');

    document.getElementById('writeMic').click();
    await settle(); await settle();
    expect(interim().textContent).toBe('');
    expect(raw().value).toBe('');
  });

  it('carries on silently when the browser will not give a second recogniser', async () => {
    // The fallback the parent asked for: the old behaviour, with the working
    // indicator, and no preview.
    const release = serviceHangs('the real words');
    document.getElementById('writeMic').click();
    await settle();
    live.fail();
    live.say('this should not show');
    expect(interim().textContent).toBe('');

    document.getElementById('writeMic').click();
    await settle();
    release();
    await settle(); await settle();
    expect(raw().value).toBe('the real words');
  });

  it('starts a fresh preview for each recording', async () => {
    const release = serviceHangs('one');
    document.getElementById('writeMic').click();
    await settle();
    document.getElementById('writeMic').click();
    await settle();
    release();
    await settle(); await settle();

    const release2 = serviceHangs('two');
    document.getElementById('writeMic').click();
    await settle();
    expect(FakeRecognition.started).toBe(2);
    expect(live).not.toBe(null);
    release2();
    await settle();
  });
});

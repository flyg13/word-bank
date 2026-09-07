// @vitest-environment jsdom
// Context-aware correction, driven through the real Speech-To-Text flow: tap
// the mic, a transcript comes back, and Claude reads it with the sentence in
// view. Both functions are stubbed at fetch, the way the recogniser already is.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- the recording stack, as in mic-capture.test.js ---
class FakeRecognition { start() {} stop() {} }
window.SpeechRecognition = FakeRecognition;
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
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

const { state } = await import('../lib/store.js');
const { initFreeWrite } = await import('../features/freewrite.js');
const { readCorrectionLog } = await import('../lib/correction-log.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const out = () => document.getElementById('correctedOutput');
const note = () => document.getElementById('contextNote').textContent;
const shown = () => [...out().querySelectorAll('.wtok')].map((el) => el.textContent).join(' ');
const marked = () => [...out().querySelectorAll('.wtok.ctx-fixed')].map((el) => el.textContent);

const DOM = `
  <nav class="tabs"><div class="tab" data-tab="write"></div></nav>
  <div id="tab-write"></div>
  <textarea id="rawInput"></textarea>
  <button id="writeMic"></button><div id="writeMicLabel"></div>
  <div id="correctedOutput"></div>
  <div class="context-note" id="contextNote"></div>
  <div class="write-note" id="writeNote"></div>
  <div class="fix-panel" id="fixPanel">
    <span id="fixingWord"></span><input id="fixInput">
    <button id="saveFix"></button><button id="cancelFix"></button>
  </div>
  <div id="accuracyBanner"></div>`;

/** Answer both functions: the recogniser, then the context step. */
function serve({ transcript, changes, contextStatus = 200, contextBody }) {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('/functions/transcribe')) {
      return new Response(JSON.stringify({ text: transcript }), { status: 200 });
    }
    if (String(url).includes('/functions/contextual-correct')) {
      if (contextStatus !== 200) {
        return new Response(JSON.stringify(contextBody || { error: 'not-configured' }),
          { status: contextStatus });
      }
      return new Response(JSON.stringify({ changes, provider: 'stub', model: 'stub' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

/** Tap, tap — record and stop, as the button now works. */
async function speak() {
  document.getElementById('writeMic').click();
  await settle();
  document.getElementById('writeMic').click();
  await settle();
  await settle();
  await settle();
}

describe('reading a transcript with its own sentence in view', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = DOM;
    // Her bank: "liquor" has been confirmed to mean "little".
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    state.phonicBank = {
      little: { word: 'little', spellings: ['liddle'], keys: ['LTL'], added: '' }
    };
    initFreeWrite();
  });
  afterEach(() => { delete globalThis.fetch; });

  it('corrects a genuine mispronunciation', async () => {
    serve({
      transcript: 'i want the liquor one',
      changes: [{ index: 3, to: 'little', reason: 'She is choosing between sizes.' }]
    });
    await speak();
    expect(shown()).toBe('i want the little one');
    expect(marked()).toEqual(['little']);
  });

  it('leaves a real word alone when the sentence says it is real', async () => {
    // The whole reason for this feature. The bank would rewrite this "liquor"
    // too, because a find-and-replace cannot read the rest of the sentence.
    serve({ transcript: 'dad bought a liquor bottle', changes: [] });
    await speak();
    expect(shown()).toBe('dad bought a liquor bottle');
    expect(marked()).toEqual([]);
    expect(note()).toContain('nothing needed changing');
  });

  it('puts a word back when the marked word is tapped', async () => {
    serve({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();
    expect(shown()).toBe('the little cabinet');

    out().querySelector('.wtok.ctx-fixed').click();
    expect(shown()).toBe('the liquor cabinet');
    expect(marked()).toEqual([]);
  });

  it('falls back to the blind find-and-replace, and says so', async () => {
    serve({ transcript: 'the liquor cabinet', contextStatus: 503 });
    await speak();
    // The old behaviour: every "liquor" becomes "little", context or not.
    expect(shown()).toBe('the little cabinet');
    expect(note()).toContain('Context correction unavailable');
    expect(note()).toContain('not-configured');
    expect(document.getElementById('contextNote').classList.contains('warn')).toBe(true);
  });

  it('never lets Claude teach the bank anything', async () => {
    // Learning stays in Practice, Sentences and Reading, which know the word
    // she was asked for. This step only ever changes what is on screen.
    const before = JSON.stringify(state.wordBank);
    serve({
      transcript: 'the liquor one',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });
    await speak();
    out().querySelector('.wtok.ctx-fixed').click();
    expect(JSON.stringify(state.wordBank)).toBe(before);
  });

  it('sends her patterns, and only the confirmed corrections', async () => {
    state.wordBank.wobble = { correct: 'wonder', count: 1, active: false };
    serve({ transcript: 'hello', changes: [] });
    await speak();
    const call = globalThis.fetch.mock.calls
      .find(([url]) => String(url).includes('contextual-correct'));
    const body = JSON.parse(call[1].body);
    expect(body.tokens).toEqual(['hello']);
    expect(body.corrections).toContainEqual({ heard: 'liquor', means: 'little' });
    expect(body.corrections).not.toContainEqual({ heard: 'wobble', means: 'wonder' });
    expect(body.pronunciations).toContainEqual({ word: 'little', spellings: ['liddle'] });
  });

  it('goes stale rather than lying once the text is edited', async () => {
    serve({
      transcript: 'the liquor one',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });
    await speak();
    expect(marked()).toEqual(['little']);

    const input = document.getElementById('rawInput');
    input.value = 'something else entirely';
    input.dispatchEvent(new Event('input'));
    expect(marked()).toEqual([]);
    expect(note()).toBe('');
  });
});

describe('the log of what Claude changed', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = DOM;
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    state.phonicBank = {};
    initFreeWrite();
  });
  afterEach(() => { delete globalThis.fetch; });

  it('records the word, the replacement and the reason', async () => {
    serve({
      transcript: 'the liquor one',
      changes: [{ index: 1, to: 'little', reason: 'She is talking about a toy.' }]
    });
    await speak();
    const log = readCorrectionLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      from: 'liquor', to: 'little', reason: 'She is talking about a toy.', reverted: false
    });
  });

  it('keeps a change that was undone, marked as undone', async () => {
    // A change the parent keeps putting back is exactly the pattern the log
    // exists to surface, so undoing it must not erase the evidence.
    serve({
      transcript: 'the liquor one',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();
    out().querySelector('.wtok.ctx-fixed').click();
    expect(readCorrectionLog()[0].reverted) .toBe(true);
  });
});

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
// One answer, mounted on the ids this file's fixture already uses. The page
// gives every question its own set; the behaviour under test is the same.
const { createAnswer } = await import('../features/answer.js');
const { initFixPanel } = await import('../features/fix-panel.js');

const LEGACY_IDS = {
  input: 'rawInput', output: 'correctedOutput', contextNote: 'contextNote',
  writeNote: 'writeNote', copyNote: 'copyNote', mic: 'writeMic',
  micLabel: 'writeMicLabel', copy: 'copyBtn', clear: 'clearBtn',
  readBack: 'readBackBtn'
};

let answer = null;
function initFreeWrite() {
  initFixPanel();
  answer = createAnswer({ ids: LEGACY_IDS });
}
const renderCorrectedOutput = () => answer.render();
const correctedPlainText = () => answer.plainText();
const { readCorrectionLog } = await import('../lib/correction-log.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const out = () => document.getElementById('correctedOutput');
const note = () => document.getElementById('contextNote').textContent;
const shown = () => [...out().querySelectorAll('.wtok')].map((el) => el.textContent).join(' ');
const marked = () => [...out().querySelectorAll('.wtok.ctx-fixed')].map((el) => el.textContent);
const putBack = () => [...out().querySelectorAll('.wtok.ctx-original')].map((el) => el.textContent);

const DOM = `
  <nav class="tabs"><div class="tab" data-tab="write"></div></nav>
  <div id="tab-write"></div>
  <textarea id="rawInput"></textarea>
  <button id="writeMic"></button><div id="writeMicLabel"></div>
  <div id="correctedOutput"></div>
  <button id="copyBtn"></button><button id="clearBtn"></button>
  <span class="copy-note" id="copyNote"></span>
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
    state.contextLog = [];
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

  it('fits the replacement to the word it replaces: its case and its punctuation', async () => {
    // The first real test came back "Dad brought a bottle of → Little": the
    // replacement capitalised mid-sentence, and the full stop gone with the
    // word. Whatever case the model answers in, the word on screen takes the
    // case of the one it replaces and keeps its punctuation; and that fitted
    // word is what the log records.
    serve({
      transcript: 'Liquor one, the liquor.',
      changes: [
        { index: 0, to: 'little', reason: 'Choosing a size.' },
        { index: 3, to: 'Little', reason: 'Choosing a size.' }
      ]
    });
    await speak();
    expect(shown()).toBe('Little one, the little.');
    expect(marked()).toEqual(['Little', 'little.']);
    expect(state.contextLog.map((entry) => [entry.from, entry.to])).toEqual([
      ['Liquor', 'Little'], ['liquor.', 'little.']
    ]);
  });

  it('drops a change that only differs from the word in case or punctuation', async () => {
    serve({
      transcript: 'the liquor one.',
      changes: [{ index: 1, to: 'Liquor', reason: 'x' }, { index: 2, to: 'one', reason: 'x' }]
    });
    await speak();
    expect(shown()).toBe('the liquor one.');
    expect(marked()).toEqual([]);
    expect(document.getElementById('contextNote').textContent).toContain('nothing needed changing');
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

  it('puts the change back on when the word is tapped again', async () => {
    // The tap is a toggle, not a one-way door. She will tap a marked word out
    // of curiosity, and a first tap that could not be undone would destroy a
    // correction with no way to ask for it back.
    serve({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();

    out().querySelector('.wtok.ctx-fixed').click();
    expect(shown()).toBe('the liquor cabinet');

    out().querySelector('.wtok.ctx-original').click();
    expect(shown()).toBe('the little cabinet');
    expect(marked()).toEqual(['little']);
  });

  it('keeps toggling however many times it is tapped', async () => {
    serve({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();

    for (let i = 0; i < 6; i++) {
      out().querySelector('.wtok.ctx-fixed').click();
      expect(shown()).toBe('the liquor cabinet');
      out().querySelector('.wtok.ctx-original').click();
      expect(shown()).toBe('the little cabinet');
    }
  });

  it('leaves the word marked once it is put back, so it still reads as tappable', async () => {
    serve({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();
    out().querySelector('.wtok.ctx-fixed').click();

    // Marked, in its own state — not folded back in with the words Claude
    // never touched.
    expect(putBack()).toEqual(['liquor']);
    expect(out().querySelectorAll('.wtok.ctx-fixed, .wtok.ctx-original')).toHaveLength(1);
  });

  it('says both ways round, so the second tap is discoverable', async () => {
    serve({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();
    expect(note()).toContain('Tap a word to change it back');
    expect(out().querySelector('.wtok.ctx-fixed').title).toContain('tap to change it back');

    out().querySelector('.wtok.ctx-fixed').click();
    expect(note()).toContain('Tap it again');
    expect(out().querySelector('.wtok.ctx-original').title).toContain('tap to use “little”');
  });

  it('toggles each changed word on its own', async () => {
    serve({
      transcript: 'the liquor and the liquor',
      changes: [
        { index: 1, to: 'little', reason: 'x' },
        { index: 4, to: 'little', reason: 'x' }
      ]
    });
    await speak();
    expect(shown()).toBe('the little and the little');

    out().querySelectorAll('.wtok.ctx-fixed')[0].click();
    expect(shown()).toBe('the liquor and the little');
    expect(marked()).toEqual(['little']);
    expect(putBack()).toEqual(['liquor']);
  });

  it('never opens the correction panel from a changed word, in either state', async () => {
    // Both states belong to the toggle. Opening the panel here would attach a
    // bank entry to a word Claude decided about, and Claude's decisions are
    // deliberately not evidence the bank ever sees.
    serve({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });
    await speak();
    const panel = document.getElementById('fixPanel');

    out().querySelector('.wtok.ctx-fixed').click();
    expect(panel.classList.contains('show')).toBe(false);
    out().querySelector('.wtok.ctx-original').click();
    expect(panel.classList.contains('show')).toBe(false);
  });

  it('falls back to the blind find-and-replace, and says so', async () => {
    serve({ transcript: 'the liquor cabinet', contextStatus: 503 });
    await speak();
    // The old behaviour: every "liquor" becomes "little", context or not —
    // but now confined to the sentence that could not be read, and said out
    // loud rather than left to look like the new behaviour.
    expect(shown()).toBe('the little cabinet');
    expect(note()).toContain('could not check');
    expect(note()).toContain('not-configured');
    expect(note()).toContain('every match');
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
    state.contextLog = [];
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

  it('stops calling it undone once the change is put back on', async () => {
    // The entry carries how the change stands, not a tally of taps. A curious
    // tap and tap-back must not leave a permanent mark on a change the parent
    // never objected to — that is the signal this log exists to keep clean.
    serve({
      transcript: 'the liquor one',
      changes: [{ index: 1, to: 'little', reason: 'Guessed.' }]
    });
    await speak();
    out().querySelector('.wtok.ctx-fixed').click();
    expect(readCorrectionLog()[0].reverted).toBe(true);

    out().querySelector('.wtok.ctx-original').click();
    expect(readCorrectionLog()[0].reverted).toBe(false);
    // And it is still the same one entry, not a second one appended.
    expect(readCorrectionLog()).toHaveLength(1);
  });
});

// @vitest-environment jsdom
// Getting the finished text out of Speech-To-Text, and building it up a
// sentence at a time. This is the tab's actual job: homework that ends up
// pasted into Seesaw or Word.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
const { initFreeWrite, renderCorrectedOutput, correctedPlainText } =
  await import('../features/freewrite.js');
const { copyViaSelection } = await import('../lib/clipboard.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const out = () => document.getElementById('correctedOutput');
const raw = () => document.getElementById('rawInput');
const note = () => document.getElementById('contextNote').textContent;
const copyNote = () => document.getElementById('copyNote').textContent;

const DOM = `
  <nav class="tabs"><div class="tab" data-tab="write"></div></nav>
  <div id="tab-write"></div>
  <textarea id="rawInput"></textarea>
  <button id="writeMic"></button><div id="writeMicLabel"></div>
  <div id="correctedOutput"></div>
  <div class="context-note" id="contextNote"></div>
  <div class="write-note" id="writeNote"></div>
  <button id="copyBtn"></button><button id="clearBtn"></button>
  <span class="copy-note" id="copyNote"></span>
  <div class="fix-panel" id="fixPanel">
    <span id="fixingWord"></span><input id="fixInput">
    <button id="saveFix"></button><button id="cancelFix"></button>
  </div>
  <div id="accuracyBanner"></div>`;

/** One recording: what she said, and what Claude decided about it. */
let queue = [];
function serve() {
  globalThis.fetch = vi.fn(async (url) => {
    const next = queue[0] || { transcript: '', changes: [] };
    if (String(url).includes('/functions/transcribe')) {
      return new Response(JSON.stringify({ text: next.transcript }), { status: 200 });
    }
    if (String(url).includes('/functions/contextual-correct')) {
      const job = queue.shift() || next;
      if (job.down) return new Response(JSON.stringify({ error: 'not-configured' }), { status: 503 });
      return new Response(JSON.stringify({ changes: job.changes, provider: 's', model: 's' }),
        { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

async function speak(job) {
  queue.push(job);
  document.getElementById('writeMic').click();
  await settle();
  document.getElementById('writeMic').click();
  await settle(); await settle(); await settle();
}

beforeEach(() => {
  queue = [];
  state.contextLog = [];
  document.body.innerHTML = DOM;
  state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
  state.phonicBank = {};
  initFreeWrite();
  serve();
});
afterEach(() => { delete globalThis.fetch; });

describe('building a paragraph across several recordings', () => {
  it('adds each recording to the end rather than starting over', async () => {
    await speak({ transcript: 'the cat sat', changes: [] });
    await speak({ transcript: 'it was warm', changes: [] });
    await speak({ transcript: 'then it slept', changes: [] });
    expect(raw().value).toBe('the cat sat it was warm then it slept');
    expect(out().textContent).toBe('the cat sat it was warm then it slept');
  });

  it('keeps the marks on the sentences already read', async () => {
    await speak({
      transcript: 'i want the liquor one',
      changes: [{ index: 3, to: 'little', reason: 'Choosing a size.' }]
    });
    expect([...out().querySelectorAll('.ctx-fixed')].map((e) => e.textContent))
      .toEqual(['little']);

    await speak({
      transcript: 'the liquor cat sat',
      changes: [{ index: 1, to: 'little', reason: 'Describing the cat.' }]
    });
    // Both marks, in order, and the first one did not move or vanish.
    expect([...out().querySelectorAll('.ctx-fixed')].map((e) => e.textContent))
      .toEqual(['little', 'little']);
    expect(out().textContent).toBe('i want the little one the little cat sat');
  });

  it('sends only the new sentence, not the whole paragraph again', async () => {
    // Re-reading everything would recompute decisions already seen — putting
    // back anything the parent had undone — and make the wait grow with every
    // sentence.
    await speak({ transcript: 'the cat sat', changes: [] });
    await speak({ transcript: 'it was warm', changes: [] });

    const sent = globalThis.fetch.mock.calls
      .filter(([url]) => String(url).includes('contextual-correct'))
      .map(([, init]) => JSON.parse(init.body).tokens);
    expect(sent).toEqual([['the', 'cat', 'sat'], ['it', 'was', 'warm']]);
  });

  it('keeps a word the parent put back put back, when the next sentence arrives', async () => {
    await speak({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });
    out().querySelector('.ctx-fixed').click();
    expect(out().textContent).toBe('the liquor cabinet');

    await speak({ transcript: 'it was full', changes: [] });
    expect(out().textContent).toBe('the liquor cabinet it was full');
  });

  it('reads the lot together when what is there was typed, not spoken', async () => {
    // Typed text carries no decisions to protect, so nothing is lost by
    // sending it — and Claude gets to read the words rather than skip them.
    raw().value = 'i want the liquor';
    raw().dispatchEvent(new Event('input'));
    await speak({ transcript: 'one please', changes: [] });

    const sent = globalThis.fetch.mock.calls
      .filter(([url]) => String(url).includes('contextual-correct'))
      .map(([, init]) => JSON.parse(init.body).tokens);
    expect(sent).toEqual([['i', 'want', 'the', 'liquor', 'one', 'please']]);
  });

  it('counts only the new words in what it says it changed', async () => {
    await speak({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });
    await speak({ transcript: 'it was full', changes: [] });
    expect(note()).toContain('nothing needed changing');
  });

  it('does not add an empty recording, or a stray space', async () => {
    await speak({ transcript: 'the cat sat', changes: [] });
    await speak({ transcript: '   ', changes: [] });
    expect(raw().value).toBe('the cat sat');
  });
});

describe('copying the finished text', () => {
  it('copies the words only — no arrows, no marks', async () => {
    await speak({
      transcript: 'i want the liquor one',
      changes: [{ index: 3, to: 'little', reason: 'Choosing a size.' }]
    });
    // The screen carries a → on the changed word, from CSS. The text must not.
    const text = correctedPlainText();
    expect(text).toBe('i want the little one');
    expect(text).not.toMatch(/[→↩≈✓✗]/);
  });

  it('copies exactly what the panel reads, in every state it has', async () => {
    // The guarantee: what lands in her homework is what is on the screen. Not
    // a second construction of it that can drift.
    const cases = [
      { transcript: 'the liquor cabinet', changes: [{ index: 1, to: 'little', reason: 'x' }] },
      { transcript: 'dad bought a liquor bottle', changes: [] },
      { transcript: 'Liquor one, the liquor.',
        changes: [{ index: 0, to: 'little', reason: 'x' }, { index: 3, to: 'Little', reason: 'x' }] }
    ];
    for (const job of cases) {
      document.body.innerHTML = DOM;
      initFreeWrite();
      await speak(job);
      expect(correctedPlainText()).toBe(out().textContent);
    }
  });

  it('copies the bank-corrected text when Claude could not be reached', async () => {
    await speak({ transcript: 'the liquor cabinet', down: true });
    expect(note()).toContain('unavailable');
    expect(correctedPlainText()).toBe('the little cabinet');
    expect(correctedPlainText()).toBe(out().textContent);
  });

  it('keeps her own spacing and punctuation', async () => {
    raw().value = 'the cat sat.  it was warm!';
    raw().dispatchEvent(new Event('input'));
    expect(correctedPlainText()).toBe('the cat sat.  it was warm!');
  });

  it('puts it on the clipboard and says so', async () => {
    const writeText = vi.fn(async () => {});
    navigator.clipboard = { writeText };
    await speak({ transcript: 'the cat sat', changes: [] });

    document.getElementById('copyBtn').click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('the cat sat');
    expect(copyNote()).toContain('Copied');
    delete navigator.clipboard;
  });

  it('builds the text before anything is awaited, so Safari keeps the gesture', async () => {
    // Safari ties clipboard access to the tap. An await before the write spends
    // it, and the copy is refused on the one device she uses.
    let textAtCall = null;
    navigator.clipboard = { writeText: vi.fn(async (t) => { textAtCall = t; }) };
    await speak({ transcript: 'the cat sat', changes: [] });

    document.getElementById('copyBtn').click();
    // Synchronously after the click, before any microtask has run.
    expect(textAtCall).toBe('the cat sat');
    delete navigator.clipboard;
  });

  it('falls back to the old way when the clipboard API is not there', async () => {
    delete navigator.clipboard;
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await speak({ transcript: 'the cat sat', changes: [] });

    document.getElementById('copyBtn').click();
    await settle();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copyNote()).toContain('Copied');
  });

  it('falls back again when the clipboard API is there and refuses', async () => {
    // iPadOS does this, and reporting the failure instead of trying the old
    // way would mean she cannot get her homework out at all.
    navigator.clipboard = { writeText: vi.fn(async () => { throw new Error('denied'); }) };
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await speak({ transcript: 'the cat sat', changes: [] });

    document.getElementById('copyBtn').click();
    await settle();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copyNote()).toContain('Copied');
    delete navigator.clipboard;
  });

  it('says plainly when it could not copy, rather than looking like it did', async () => {
    delete navigator.clipboard;
    document.execCommand = vi.fn(() => false);
    await speak({ transcript: 'the cat sat', changes: [] });

    document.getElementById('copyBtn').click();
    await settle();
    expect(copyNote()).toContain('Could not copy');
  });

  it('leaves the page selection as it found it', async () => {
    document.execCommand = vi.fn(() => true);
    const holder = document.createElement('p');
    holder.textContent = 'something the parent had selected';
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    copyViaSelection('the cat sat');
    expect(document.getSelection().toString()).toBe('something the parent had selected');
  });

  it('leaves nothing behind in the page', async () => {
    document.execCommand = vi.fn(() => true);
    const before = document.body.children.length;
    copyViaSelection('the cat sat');
    expect(document.body.children.length).toBe(before);
    expect(document.querySelector('[contenteditable="true"]')).toBe(null);
  });

  it('is off until there is something to copy', () => {
    renderCorrectedOutput();
    expect(document.getElementById('copyBtn').disabled).toBe(true);
    raw().value = 'the cat sat';
    raw().dispatchEvent(new Event('input'));
    expect(document.getElementById('copyBtn').disabled).toBe(false);
  });
});

describe('clearing it to start fresh', () => {
  it('asks first when there is text, and does nothing if the answer is no', async () => {
    window.confirm = vi.fn(() => false);
    await speak({ transcript: 'the cat sat', changes: [] });

    document.getElementById('clearBtn').click();
    expect(window.confirm).toHaveBeenCalled();
    expect(raw().value).toBe('the cat sat');
  });

  it('clears the text, the marks and the notes when the answer is yes', async () => {
    window.confirm = vi.fn(() => true);
    await speak({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });

    document.getElementById('clearBtn').click();
    expect(raw().value).toBe('');
    expect(out().textContent).toContain('Nothing here yet');
    expect(note()).toBe('');
    expect(document.getElementById('clearBtn').disabled).toBe(true);
  });

  it('starts the next recording from nothing, with no stale decisions', async () => {
    window.confirm = vi.fn(() => true);
    await speak({
      transcript: 'the liquor cabinet',
      changes: [{ index: 1, to: 'little', reason: 'x' }]
    });
    document.getElementById('clearBtn').click();

    await speak({ transcript: 'a new sentence', changes: [] });
    expect(raw().value).toBe('a new sentence');
    expect(out().querySelectorAll('.ctx-fixed')).toHaveLength(0);
  });

  it('does not ask when there is nothing to lose', () => {
    window.confirm = vi.fn(() => false);
    renderCorrectedOutput();
    document.getElementById('clearBtn').click();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('never touches her bank', async () => {
    window.confirm = vi.fn(() => true);
    await speak({ transcript: 'the liquor cabinet', changes: [] });
    const before = JSON.stringify(state.wordBank);
    document.getElementById('clearBtn').click();
    expect(JSON.stringify(state.wordBank)).toBe(before);
  });
});

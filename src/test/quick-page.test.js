// @vitest-environment jsdom
// The quick page: one box, no sheet, nothing saved. Built from the same answer
// factory the worksheet uses, so the two can never drift — CLAUDE.md §16.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class FakeRecognition { constructor() {} start() {} stop() {} abort() {} }
window.SpeechRecognition = FakeRecognition;
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; }
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
const spoken = [];
window.speechSynthesis = {
  cancel() {}, getVoices: () => [],
  speak(u) { spoken.push(u.text); if (u.onstart) u.onstart(); if (u.onend) u.onend(); }
};
window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

const store = await import('../lib/store.js');
const { state } = store;
const { initQuick } = await import('../features/quick.js');
const { initWorksheet } = await import('../features/worksheet.js');
const { initFixPanel, openFixPanel } = await import('../features/fix-panel.js');
const { initTabs, activateTab } = await import('../features/tabs.js');
const { readSheets } = await import('../lib/sheets.js');

const ROOT = resolve(import.meta.dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const quick = () => document.getElementById('tab-quick');
const box = () => quick().querySelector('.answer-box');
const out = () => quick().querySelector('.answer-out');
const btn = (text) => [...quick().querySelectorAll('button')]
  .find((b) => b.textContent.trim() === text);

let saved;
function mount() {
  document.body.innerHTML = BODY;
  spoken.length = 0;
  saved = [];
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  initTabs();
  initFixPanel();
  initQuick();
  initWorksheet();
}
function type(text) {
  box().value = text;
  box().dispatchEvent(new Event('input'));
}

beforeEach(() => {
  state.sheets = [];
  state.wordBank = {};
  state.phonicBank = {};
  state.contextLog = [];
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 }));
  mount();
});
afterEach(() => { delete globalThis.fetch; });

describe('the two giraffes', () => {
  const giraffes = () => [...document.querySelectorAll('.tab-giraffe')];

  it('are both at the left of the row, and neither has a text label', () => {
    expect(giraffes()).toHaveLength(2);
    giraffes().forEach((g) => {
      expect(g.textContent.trim()).toBe('');
      expect(g.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('open the quick page and the worksheet', () => {
    const [big, small] = giraffes();
    expect(big.dataset.tab).toBe('quick');
    expect(small.dataset.tab).toBe('write');
    expect(small.classList.contains('tab-giraffe-sm')).toBe(true);
    expect(big.classList.contains('tab-giraffe-sm')).toBe(false);
  });

  it('show one page at a time, and mark which', () => {
    const [big, small] = giraffes();
    big.click();
    expect(quick().style.display).toBe('block');
    expect(document.getElementById('tab-write').style.display).toBe('none');
    expect(big.classList.contains('active')).toBe(true);
    expect(small.classList.contains('active')).toBe(false);

    small.click();
    expect(quick().style.display).toBe('none');
    expect(document.getElementById('tab-write').style.display).toBe('block');
    expect(small.classList.contains('active')).toBe(true);
    expect(big.classList.contains('active')).toBe(false);
  });
});

describe('a quick answer', () => {
  it('is one box with no question attached', () => {
    activateTab('quick');
    expect(box()).not.toBe(null);
    expect(quick().querySelector('.question-box')).toBe(null);
    expect(quick().querySelector('.icon-btn')).toBe(null);
    expect(document.getElementById('tab-write').querySelector('.question-box')).not.toBe(null);
  });

  it('corrects, copies and reads back exactly as the worksheet does', async () => {
    navigator.clipboard = { writeText: vi.fn(async () => {}) };
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    activateTab('quick');
    type('i want the liquor one');
    expect(out().textContent).toBe('i want the little one');

    btn('Copy').click();
    await new Promise((r) => setTimeout(r, 5));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('i want the little one');

    btn('Read it to me').click();
    expect(spoken).toEqual(['i', 'want', 'the', 'little', 'one']);
    delete navigator.clipboard;
  });

  it('starts again when asked', () => {
    window.confirm = vi.fn(() => true);
    activateTab('quick');
    type('the cat sat');
    btn('Start again').click();
    expect(box().value).toBe('');
    expect(out().textContent).toContain('Nothing here yet');
  });

  it('saves nothing — it is a scratch surface', () => {
    activateTab('quick');
    type('a quick answer nobody wants kept');
    expect(saved.filter((w) => w.key === 'sheets')).toEqual([]);
    expect(readSheets()).toEqual([]);
  });

  it('never takes a slot in her five saved sheets', () => {
    // The worksheet is what gets kept. A quick answer quietly pushing real
    // schoolwork off the end of the list would be the opposite of the point.
    document.getElementById('sheetTitle').value = 'Real schoolwork';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    activateTab('quick');
    type('scratch');
    expect(readSheets().map((s) => s.title)).toEqual(['Real schoolwork']);
  });

  it('keeps its words separate from the worksheet\'s', () => {
    activateTab('quick');
    type('the quick one');
    const sheetBox = document.getElementById('tab-write').querySelector('.answer-box');
    sheetBox.value = 'the worksheet one';
    sheetBox.dispatchEvent(new Event('input'));

    expect(out().textContent).toBe('the quick one');
    expect(document.getElementById('tab-write').querySelector('.answer-out').textContent)
      .toBe('the worksheet one');
  });
});

describe('the one shared fix panel', () => {
  it('floats over whichever page the word was tapped on', () => {
    // It used to live inside one tab and drag her there. With two pages that
    // have words in them, and Sentences and Reading besides, that is wrong.
    const panel = document.getElementById('fixPanel');
    expect(panel.closest('#tab-write')).toBe(null);
    expect(panel.closest('#tab-quick')).toBe(null);
    expect(panel.classList.contains('fix-panel-float')).toBe(true);
  });

  it('opens without leaving the page she is on', () => {
    activateTab('quick');
    type('wibble');
    out().querySelector('.wtok').click();
    expect(document.getElementById('fixPanel').classList.contains('show')).toBe(true);
    expect(quick().style.display).toBe('block');
  });

  it('stays put when a word is tapped from another tab too', () => {
    activateTab('sentences');
    const span = document.createElement('span');
    span.dataset.rawKey = 'wibble';
    span.textContent = 'wibble';
    openFixPanel(span, false);
    expect(document.getElementById('fixPanel').classList.contains('show')).toBe(true);
    expect(document.getElementById('tab-sentences').style.display).toBe('block');
  });

  it('still teaches the bank the word it was given', () => {
    activateTab('quick');
    type('wibble');
    out().querySelector('.wtok').click();
    document.getElementById('fixInput').value = 'wobble';
    document.getElementById('saveFix').click();
    expect(state.wordBank.wibble).toMatchObject({ correct: 'wobble', count: 1, active: false });
  });
});

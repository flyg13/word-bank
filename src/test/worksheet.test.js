// @vitest-environment jsdom
// Her worksheet: a title, questions she pastes in, answers she says, and a
// rolling five sheets so yesterday's work can be picked up again. See
// CLAUDE.md §14.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class FakeRecognition { start() {} stop() {} }
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
window.speechSynthesis = { cancel() {}, speak: (u) => spoken.push(u.text) };
window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

const { state } = await import('../lib/store.js');
const store = await import('../lib/store.js');
const { initWorksheet, currentSheet } = await import('../features/worksheet.js');
const { initFixPanel } = await import('../features/fix-panel.js');
const { readSheets } = await import('../lib/sheets.js');
const { SHEET_LIMIT } = await import('../config.js');

const ROOT = resolve(import.meta.dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const settle = () => new Promise((r) => setTimeout(r, 5));
const cards = () => [...document.querySelectorAll('#sheetQuestions .qa-card')];
const questionBox = (i) => cards()[i].querySelector('.question-box');
const answerBox = (i) => cards()[i].querySelector('.answer-box');
const answerOut = (i) => cards()[i].querySelector('.answer-out');
const button = (i, text) =>
  [...cards()[i].querySelectorAll('button')].find((b) => b.textContent.trim() === text);

let saved;

function mount() {
  document.body.innerHTML = BODY;
  spoken.length = 0;
  saved = [];
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  initFixPanel();
  initWorksheet();
}

/** Answer a question by typing, which is the same path a transcript takes. */
function type(i, text) {
  answerBox(i).value = text;
  answerBox(i).dispatchEvent(new Event('input'));
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

describe('a sheet of schoolwork', () => {
  it('opens with a name and one question', () => {
    expect(document.getElementById('sheetTitle').value).toBe('');
    expect(cards()).toHaveLength(1);
    expect(questionBox(0)).not.toBe(null);
    expect(answerBox(0)).not.toBe(null);
  });

  it('gives the question a big box of its own to paste into', () => {
    // She pastes it in herself. It has to be an obvious target on an iPad,
    // which means bigger than the answer box, not a one-line input.
    expect(questionBox(0).tagName).toBe('TEXTAREA');
    expect(questionBox(0).placeholder.toLowerCase()).toContain('paste');
  });

  it('keeps what she pastes into the question', () => {
    questionBox(0).value = 'Write a diary entry as a pirate.';
    questionBox(0).dispatchEvent(new Event('input'));
    expect(currentSheet().questions[0].question).toBe('Write a diary entry as a pirate.');
  });

  it('adds another question, and numbers them', () => {
    document.getElementById('addQuestion').click();
    document.getElementById('addQuestion').click();
    expect(cards()).toHaveLength(3);
    expect(cards().map((c) => c.querySelector('.qa-number').textContent))
      .toEqual(['Question 1', 'Question 2', 'Question 3']);
  });

  it('keeps each answer to its own question', () => {
    // The whole reason one box became several: two answers on one sheet must
    // not see each other's words or each other's decisions.
    document.getElementById('addQuestion').click();
    type(0, 'the cat sat');
    type(1, 'it was warm');
    expect(answerOut(0).textContent).toBe('the cat sat');
    expect(answerOut(1).textContent).toBe('it was warm');
  });

  it('re-reads every answer when a correction is confirmed elsewhere', async () => {
    // Confirming in Word Bank changes what every answer should read. Each
    // answer re-renders — and only re-renders: rebuilding the sheet under her
    // would throw away words she is part way through saying.
    const { renderAll } = await import('../lib/store.js');
    document.getElementById('addQuestion').click();
    type(0, 'the liquor one');
    type(1, 'a liquor cat');
    expect(answerOut(0).textContent).toBe('the liquor one');

    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    renderAll();
    expect(answerOut(0).textContent).toBe('the little one');
    expect(answerOut(1).textContent).toBe('a little cat');
    // Still the same boxes: nothing was rebuilt out from under her.
    expect(answerBox(0).value).toBe('the liquor one');
    expect(cards()).toHaveLength(2);
  });

  it('will not remove the last question, because a sheet is at least one', () => {
    expect(button(0, 'Remove')).toBeTruthy();
    expect(button(0, 'Remove').style.display).toBe('none');
  });

  it('removes a question once there is more than one', () => {
    document.getElementById('addQuestion').click();
    type(0, 'first');
    type(1, 'second');
    window.confirm = vi.fn(() => true);
    button(1, 'Remove').click();
    expect(cards()).toHaveLength(1);
    expect(answerOut(0).textContent).toBe('first');
  });

  it('asks before removing a question with work in it', () => {
    document.getElementById('addQuestion').click();
    type(1, 'something she said');
    window.confirm = vi.fn(() => false);
    button(1, 'Remove').click();
    expect(window.confirm).toHaveBeenCalled();
    expect(cards()).toHaveLength(2);
  });
});

describe('hearing the question', () => {
  it('reads it out in her accent, as many times as she wants', () => {
    state.speechLang = 'en-AU';
    questionBox(0).value = 'What did the pirate find?';
    questionBox(0).dispatchEvent(new Event('input'));

    cards()[0].querySelector('.icon-btn').click();
    cards()[0].querySelector('.icon-btn').click();
    cards()[0].querySelector('.icon-btn').click();
    expect(spoken).toEqual([
      'What did the pirate find?', 'What did the pirate find?', 'What did the pirate find?'
    ]);
  });

  it('says so rather than nothing when there is no question yet', () => {
    cards()[0].querySelector('.icon-btn').click();
    expect(spoken[0]).toContain('no question');
  });
});

describe('hearing her answer back', () => {
  it('reads the corrected words — exactly what Copy would give', () => {
    // She cannot proofread by reading, so hearing it is how she checks it.
    // Reading her the raw transcript would check the wrong thing.
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    type(0, 'i want the liquor one');
    button(0, 'Read it to me').click();
    expect(spoken).toEqual(['i want the little one']);
    expect(spoken[0]).toBe(answerOut(0).textContent);
  });

  it('is off until there is something to read', () => {
    expect(button(0, 'Read it to me').disabled).toBe(true);
    type(0, 'the cat sat');
    expect(button(0, 'Read it to me').disabled).toBe(false);
  });
});

describe('copying', () => {
  beforeEach(() => { navigator.clipboard = { writeText: vi.fn(async () => {}) }; });
  afterEach(() => { delete navigator.clipboard; });

  it('copies one answer on its own', async () => {
    document.getElementById('addQuestion').click();
    type(0, 'the cat sat');
    type(1, 'it was warm');
    button(1, 'Copy answer').click();
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('it was warm');
  });

  it('copies the whole sheet, every question with its answer beneath it', async () => {
    questionBox(0).value = 'Question one?';
    questionBox(0).dispatchEvent(new Event('input'));
    type(0, 'answer one');
    document.getElementById('addQuestion').click();
    questionBox(1).value = 'Question two?';
    questionBox(1).dispatchEvent(new Event('input'));
    type(1, 'answer two');

    document.getElementById('copySheet').click();
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Question one?\n\nanswer one\n\nQuestion two?\n\nanswer two');
  });

  it('copies the corrected words, not the raw transcript', async () => {
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    questionBox(0).value = 'Which one?';
    questionBox(0).dispatchEvent(new Event('input'));
    type(0, 'the liquor one');
    document.getElementById('copySheet').click();
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Which one?\n\nthe little one');
  });

  it('says so rather than copying nothing', async () => {
    document.getElementById('copySheet').click();
    await settle();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(document.getElementById('sheetCopyNote').textContent).toContain('Nothing to copy');
  });
});

describe('keeping her work', () => {
  it('is a field the app syncs, and an additive one', async () => {
    // The parent asked for sheets to follow her between devices, the same way
    // the rest of her data does. Additive: the fields that were there before
    // are untouched, which schema-parity.test.js pins in both directions.
    const { SYNCED_FIELDS, foldSnapshot } = await import('../lib/snapshot.js');
    expect(SYNCED_FIELDS).toContain('sheets');

    const fresh = {};
    foldSnapshot(fresh, { sheets: [{ id: 'a', title: 'From another device', questions: [] }] });
    expect(fresh.sheets).toHaveLength(1);
    // A document that predates the field is not a problem.
    foldSnapshot(fresh, {});
    expect(fresh.sheets).toEqual([]);
  });

  it('saves to the synced field, not to this device only', () => {
    document.getElementById('sheetTitle').value = 'Monday diary';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    expect(saved.some((write) => write.key === 'sheets')).toBe(true);
    expect(readSheets()[0].title).toBe('Monday diary');
  });

  it('stores her own words, never what Claude made of them', () => {
    // Claude's changes are a display layer. Freezing them into storage would
    // make a guess indistinguishable from a transcript tomorrow.
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    type(0, 'the liquor one');
    expect(readSheets()[0].questions[0].answer).toBe('the liquor one');
  });

  it('keeps only the five most recent, oldest dropping off', () => {
    for (let i = 1; i <= SHEET_LIMIT + 3; i += 1) {
      document.getElementById('newSheet').click();
      document.getElementById('sheetTitle').value = 'Sheet ' + i;
      document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    }
    const kept = readSheets();
    expect(kept).toHaveLength(SHEET_LIMIT);
    expect(kept[0].title).toBe('Sheet ' + (SHEET_LIMIT + 3));
    expect(kept.map((s) => s.title)).not.toContain('Sheet 1');
  });

  it('does not let a blank sheet push a real one off the end', () => {
    document.getElementById('sheetTitle').value = 'Real work';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    document.getElementById('newSheet').click();
    expect(readSheets().map((s) => s.title)).toEqual(['Real work']);
  });

  it('opens the sheet she was last working on', () => {
    document.getElementById('sheetTitle').value = 'Yesterday';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    type(0, 'what she said yesterday');

    mount();
    expect(document.getElementById('sheetTitle').value).toBe('Yesterday');
    expect(answerBox(0).value).toBe('what she said yesterday');
  });

  it('opens an older sheet from the list, keeping the one it left', () => {
    document.getElementById('sheetTitle').value = 'First';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    type(0, 'first answer');
    document.getElementById('newSheet').click();
    document.getElementById('sheetTitle').value = 'Second';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    type(0, 'second answer');

    const row = [...document.querySelectorAll('#recentSheets .sheet-open')]
      .find((b) => b.textContent.includes('First'));
    row.click();
    expect(document.getElementById('sheetTitle').value).toBe('First');
    expect(answerBox(0).value).toBe('first answer');
    expect(readSheets().map((s) => s.title).sort()).toEqual(['First', 'Second']);
  });

  it('counts the questions in the list, so a sheet is recognisable', () => {
    document.getElementById('sheetTitle').value = 'Two parter';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    document.getElementById('addQuestion').click();
    document.getElementById('newSheet').click();
    expect(document.getElementById('recentSheets').textContent).toContain('2 questions');
  });

  it('deletes a sheet when asked, and only then', () => {
    document.getElementById('sheetTitle').value = 'Delete me';
    document.getElementById('sheetTitle').dispatchEvent(new Event('input'));
    document.getElementById('newSheet').click();

    window.confirm = vi.fn(() => false);
    document.querySelector('#recentSheets .btn-link').click();
    expect(readSheets()).toHaveLength(1);

    window.confirm = vi.fn(() => true);
    document.querySelector('#recentSheets .btn-link').click();
    expect(readSheets()).toHaveLength(0);
  });

  it('survives a document someone hand-edited into nonsense', () => {
    state.sheets = ['not a sheet', null, { id: 'ok', questions: 'nope' }, { noId: true }];
    expect(() => mount()).not.toThrow();
    expect(readSheets()).toHaveLength(1);
    expect(readSheets()[0].questions).toHaveLength(1);
  });
});

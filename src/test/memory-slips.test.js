// @vitest-environment jsdom
// Hearing the sentence, and telling a memory slip from a speech error — in
// Sentences and in Reading, which share one engine. CLAUDE.md §20.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class FakeRecognition { start() {} stop() {} abort() {} }
window.SpeechRecognition = FakeRecognition;

const said = [];
window.speechSynthesis = {
  cancel() { said.push('[cancel]'); },
  getVoices: () => [],
  addEventListener() {},
  speak(u) { said.push(u.text); if (u.onstart) u.onstart(); if (u.onend) u.onend(); }
};
window.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; this.rate = 1; this.lang = ''; this.voice = null; }
};

const store = await import('../lib/store.js');
const { state } = store;
const { SENTENCES } = await import('../data/sentences.js');
const { isKnownWord } = await import('../lib/known-words.js');
const engine = await import('../features/reading-engine.js');
const { initSentences, renderSentence, handleSentenceResult } =
  await import('../features/sentences.js');
const { initReading, renderReading, handleReadingResult } =
  await import('../features/reading.js');

const ROOT = resolve(import.meta.dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

let saved;
beforeEach(() => {
  document.body.innerHTML = BODY;
  said.length = 0;
  saved = [];
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  state.wordBank = {};
  state.phonicBank = {};
  state.verifiedWords = [];
  state.sentenceIndex = 0;
  state.sentenceProgress = {};
  state.readingProgress = {};
  state.readingIndex = 0;
  state.readingPassage = 'The cat sat down.';
  state.readingSentences = ['The cat sat down.'];
});

const marks = (id) => Array.from(document.querySelectorAll('#' + id + ' .wtok'))
  .map((s) => ({ text: s.textContent, kind: s.className.replace('wtok ', '') }));

describe('telling a different word from a mispronunciation', () => {
  it('calls a real word that is not the target a slip', () => {
    expect(engine.classifySubstitution('loves', 'likes')).toBe('slip');
  });

  it('still calls a misheard non-word a mispronunciation', () => {
    // The app's own worked example. A dictionary would have called "liquor"
    // a real word and lost this.
    expect(isKnownWord('liquor')).toBe(false);
    expect(engine.classifySubstitution('little', 'liquor')).toBe('mismatch');
  });

  it('lets a recorded pronunciation win over both', async () => {
    const { addSpelling } = await import('../lib/phonicbank.js');
    // "the" is in her practice list, so it would otherwise read as a slip.
    addSpelling('sat', 'the');
    expect(engine.classifySubstitution('sat', 'the')).toBe('close');
  });

  it('counts a word her bank corrects *to* as real, but not the misheard text', () => {
    state.wordBank = { liquor: { correct: 'little', count: 2, active: true } };
    expect(isKnownWord('little')).toBe(true);
    expect(isKnownWord('liquor')).toBe(false);
  });
});

describe('in Sentences', () => {
  const target = () => SENTENCES[0];
  const sub = () => {
    // Swap one word of the real sentence for another word the app knows.
    const words = target().split(/\s+/);
    const swap = words.map((w) => w).slice();
    swap[swap.length - 1] = 'likes';
    return swap.join(' ');
  };

  it('marks a slip differently from a mispronunciation, and says so', () => {
    initSentences();
    renderSentence();
    engine.renderReadResult('sentenceOutput', 'the cat sat', 'the cat likes');
    const kinds = marks('sentenceOutput').map((m) => m.kind);
    expect(kinds).toContain('slip');
    expect(kinds).not.toContain('mismatch');
  });

  it('does not bank a slip on its own', () => {
    initSentences();
    renderSentence();
    engine.renderReadResult('sentenceOutput', 'the cat sat', 'the cat likes');
    // Nothing reached her corrections without somebody tapping.
    expect(state.wordBank).toEqual({});
    expect(saved.some((w) => w.key === 'word_bank')).toBe(false);
  });

  it('reads the sentence out, one word at a time, lighting each one', () => {
    initSentences();
    renderSentence();
    document.getElementById('speakSentenceBtn').click();

    const spoken = said.filter((t) => t !== '[cancel]');
    // One utterance per word, which is what makes the highlight exact — and
    // the same split the spans use, so index i really is word i.
    expect(spoken).toEqual(target().trim().split(/\s+/));
    expect(document.querySelectorAll('#targetSentence .rtok').length).toBe(spoken.length);
  });

  it('can be asked again, as many times as she needs', () => {
    initSentences();
    renderSentence();
    const btn = document.getElementById('speakSentenceBtn');
    btn.click();
    const first = said.filter((t) => t !== '[cancel]').length;
    said.length = 0;
    btn.click();
    btn.click();
    expect(said.filter((t) => t !== '[cancel]').length).toBeGreaterThanOrEqual(first);
  });

  it('the target still reads as the sentence, punctuation and all', () => {
    // It is the thing she is trying to read. Splitting it into spans must not
    // quietly drop the full stop off the end.
    initSentences();
    renderSentence();
    expect(document.getElementById('targetSentence').textContent.trim())
      .toBe(target().trim());
    expect(target()).toMatch(/[.!?]$/);
  });
});

describe('throwing an attempt away', () => {
  it('undoes a clean read it had just been given credit for', () => {
    initSentences();
    renderSentence();
    const line = SENTENCES[0];

    handleSentenceResult(line);
    expect(state.sentenceProgress[0]).toBe(1);

    document.querySelector('#sentenceOutput .discard-attempt').click();
    // Scores nothing at all — including the credit it had just been given.
    expect(state.sentenceProgress[0]).toBe(0);
    expect(saved.filter((w) => w.key === 'sentence_progress').pop().value[0]).toBe(0);
  });

  it('takes nothing away twice, however many times it is tapped', () => {
    initSentences();
    renderSentence();
    handleSentenceResult(SENTENCES[0]);
    expect(state.sentenceProgress[0]).toBe(1);

    const out = document.getElementById('sentenceOutput');
    out.querySelector('.discard-attempt').click();
    // Re-render the control and tap it again: the attempt is already gone.
    engine.appendDiscard('sentenceOutput', () => {});
    out.querySelector('.discard-attempt').click();
    expect(state.sentenceProgress[0]).toBe(0);
  });

  it('leaves an attempt that scored nothing scoring nothing', () => {
    initSentences();
    renderSentence();
    handleSentenceResult('the cat likes');
    expect(state.sentenceProgress[0] || 0).toBe(0);
    document.querySelector('#sentenceOutput .discard-attempt').click();
    expect(state.sentenceProgress[0] || 0).toBe(0);
  });

  it('a slip stops the read counting, and says why rather than going quiet', () => {
    initSentences();
    renderSentence();
    handleSentenceResult('the cat likes');
    expect(state.sentenceProgress[0] || 0).toBe(0);
    const note = document.querySelector('#sentenceOutput .read-note.slip');
    expect(note).toBeTruthy();
    expect(note.textContent).toContain('not been added to her corrections');
  });

  it('is offered on every attempt and clears the result', () => {
    initSentences();
    renderSentence();
    let undone = 0;
    engine.renderReadResult('sentenceOutput', 'the cat sat', 'the cat likes');
    engine.appendDiscard('sentenceOutput', () => { undone += 1; });

    const button = document.querySelector('#sentenceOutput .discard-attempt');
    expect(button).toBeTruthy();
    button.click();
    expect(undone).toBe(1);
    expect(document.getElementById('sentenceOutput').textContent).toContain('discarded');
  });
});

describe('in Reading, the same three things', () => {
  it('reads the line out word by word and lights each one', () => {
    initReading();
    renderReading();
    document.getElementById('speakReadingBtn').click();
    const spoken = said.filter((t) => t !== '[cancel]');
    expect(spoken).toEqual(['The', 'cat', 'sat', 'down.']);
    expect(document.querySelectorAll('#readingTargetSentence .rtok').length).toBe(4);
  });

  it('marks a slip in a passage line too', () => {
    initReading();
    renderReading();
    engine.renderReadResult('readingOutput', 'the cat sat down', 'the cat likes down');
    expect(marks('readingOutput').map((m) => m.kind)).toContain('slip');
  });

  it('undoes a clean line it had just been given credit for', () => {
    initReading();
    renderReading();
    handleReadingResult('The cat sat down.');
    expect(state.readingProgress[0]).toBe(1);

    document.querySelector('#readingOutput .discard-attempt').click();
    expect(state.readingProgress[0]).toBe(0);
    expect(saved.filter((w) => w.key === 'reading_progress').pop().value[0]).toBe(0);
  });

  it('says why a slipped line did not count', () => {
    initReading();
    renderReading();
    handleReadingResult('The cat likes down.');
    expect(state.readingProgress[0] || 0).toBe(0);
    expect(document.querySelector('#readingOutput .read-note.slip')).toBeTruthy();
  });
});

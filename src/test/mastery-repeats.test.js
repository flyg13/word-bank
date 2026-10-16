// @vitest-environment jsdom
// How many clean goes make a word hers. A setting, not a constant, and
// lowering it must honour repeats she has already earned — CLAUDE.md §20.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class FakeRecognition { start() {} stop() {} abort() {} }
window.SpeechRecognition = FakeRecognition;
window.speechSynthesis = {
  cancel() {}, getVoices: () => [], addEventListener() {},
  speak(u) { if (u.onend) u.onend(); }
};
window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };

const store = await import('../lib/store.js');
const { state } = store;
const { foldSnapshot, SYNCED_FIELDS } = await import('../lib/snapshot.js');
const {
  MASTERY_REPEATS_DEFAULT, MASTERY_REPEAT_CHOICES, MANUAL_BANK_COUNT
} = await import('../config.js');
const { reconcileMastery } = await import('../features/practice.js');
const { initBank } = await import('../features/bank.js');

const ROOT = resolve(import.meta.dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

let saved;
beforeEach(() => {
  document.body.innerHTML = BODY;
  saved = [];
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  state.verifiedWords = [];
  state.confirmCounts = {};
  state.practiceQueue = [];
  state.masteryRepeats = MASTERY_REPEATS_DEFAULT;
});

const choices = () => Array.from(document.querySelectorAll('#masteryRepeats button'));
const chosen = () => choices().filter((b) => b.classList.contains('chosen')).map((b) => b.textContent);

describe('the setting', () => {
  it('defaults to two, and two is the lower of the only two choices', () => {
    expect(MASTERY_REPEATS_DEFAULT).toBe(2);
    expect(MASTERY_REPEAT_CHOICES).toEqual([2, 3]);
  });

  it('is a synced field, read defensively', () => {
    expect(SYNCED_FIELDS).toContain('mastery_repeats');

    const fresh = {};
    foldSnapshot(fresh, {});
    expect(fresh.masteryRepeats).toBe(MASTERY_REPEATS_DEFAULT);

    // A value that is not one of the two is ignored rather than obeyed. Zero
    // would otherwise master every word on sight.
    for (const bad of [0, -1, 7, 2.5, 'two', null]) {
      const out = {};
      foldSnapshot(out, { mastery_repeats: bad });
      expect(out.masteryRepeats).toBe(MASTERY_REPEATS_DEFAULT);
    }
    const good = {};
    foldSnapshot(good, { mastery_repeats: 3 });
    expect(good.masteryRepeats).toBe(3);
  });

  it('offers both choices in Word Bank and marks the live one', () => {
    initBank();
    store.renderAll();
    expect(choices().map((b) => b.textContent)).toEqual(['2 goes', '3 goes']);
    expect(chosen()).toEqual(['2 goes']);

    choices()[1].click();
    expect(state.masteryRepeats).toBe(3);
    expect(saved.some((w) => w.key === 'mastery_repeats' && w.value === 3)).toBe(true);
    expect(chosen()).toEqual(['3 goes']);
  });
});

describe('changing it never invalidates progress', () => {
  it('promotes words that already have enough repeats when it comes down', () => {
    state.masteryRepeats = 3;
    state.confirmCounts = { cat: 2, dog: 1, sun: 3 };
    state.practiceQueue = ['cat', 'dog', 'sun'];
    // 'sun' is already at three but was never promoted; 'cat' has two.
    initBank();
    store.renderAll();
    choices()[0].click();

    expect(state.masteryRepeats).toBe(2);
    expect(state.verifiedWords.sort()).toEqual(['cat', 'sun']);
    // And they leave the queue, rather than sitting there with full dots.
    expect(state.practiceQueue).toEqual(['dog']);
    expect(saved.some((w) => w.key === 'verified_words')).toBe(true);
  });

  it('never un-masters a word when it goes back up', () => {
    state.masteryRepeats = 2;
    state.verifiedWords = ['cat', 'sun'];
    state.confirmCounts = { cat: 2, sun: 2 };
    initBank();
    store.renderAll();
    choices()[1].click();

    expect(state.masteryRepeats).toBe(3);
    // Mastery lives in verified_words and this only ever adds to it.
    expect(state.verifiedWords.sort()).toEqual(['cat', 'sun']);
  });

  it('says so when it promoted something, and stays quiet when it did not', () => {
    state.masteryRepeats = 3;
    state.confirmCounts = { cat: 2 };
    state.practiceQueue = ['cat'];
    initBank();
    store.renderAll();
    choices()[0].click();
    expect(document.getElementById('masteryRepeatsNote').textContent).toContain('1 word');

    state.confirmCounts = {};
    state.practiceQueue = [];
    choices()[1].click();
    choices()[0].click();
    expect(document.getElementById('masteryRepeatsNote').textContent).not.toContain('word she had');
  });

  it('promotes nothing on its own when nothing qualifies', () => {
    state.masteryRepeats = 3;
    state.confirmCounts = { cat: 1 };
    state.practiceQueue = ['cat'];
    expect(reconcileMastery()).toEqual([]);
    expect(state.verifiedWords).toEqual([]);
  });
});

describe('what the setting must not touch', () => {
  it('leaves the count a hand-added correction is written with alone', () => {
    // That three is a stored value in her live documents, pinned by the
    // differential test — not the practice-repeat number wearing a hat.
    expect(MANUAL_BANK_COUNT).toBe(3);
    state.masteryRepeats = 2;
    expect(MANUAL_BANK_COUNT).toBe(3);
  });
});

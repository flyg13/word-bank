// @vitest-environment jsdom
// Practice's rough live preview, and the pause before a recording stops.
// Both came back from real use: she says one word and waits for it a dozen
// times in a row, so the wait is paid over and over. See CLAUDE.md §17.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let live = null;
class FakeRecognition {
  constructor() { this.continuous = false; this.interimResults = false; }
  start() { live = this; }
  stop() { if (live === this) live = null; }
  abort() { if (live === this) live = null; }
  say(text) { if (this.onresult) this.onresult({ results: [[{ transcript: text }]] }); }
}
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
window.speechSynthesis = {
  cancel() {}, getVoices: () => [],
  speak(u) { if (u.onstart) u.onstart(); if (u.onend) u.onend(); }
};
window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };

const store = await import('../lib/store.js');
const { state } = store;
const practice = await import('../features/practice.js');
const { initTabs } = await import('../features/tabs.js');
const { initProgress } = await import('../features/progress.js');
const { initSession } = await import('../features/session.js');
const { CAPTURE_MODES } = await import('../config.js');

const ROOT = resolve(import.meta.dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const settle = () => new Promise((r) => setTimeout(r, 5));
const rough = () => document.getElementById('practiceRough');
const heardBox = () => document.getElementById('heardBox');
const heardText = () => document.getElementById('heardText').textContent;
const mic = () => document.getElementById('practiceMic');

let saved;
/** Hold the transcription open so the wait it covers can be looked at. */
function serviceHangs(text) {
  let release;
  globalThis.fetch = vi.fn(async () => new Promise((resolve2) => {
    release = () => resolve2(new Response(
      JSON.stringify({ text, provider: 'p', model: 'm' }), { status: 200 }));
  }));
  return () => { if (release) release(); };
}

function mount() {
  document.body.innerHTML = BODY;
  live = null;
  saved = [];
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  initTabs();
  initProgress();
  initSession();
  practice.initPractice();
  // The queue is normally built when a Firestore snapshot lands; there is no
  // snapshot here, so it is built directly.
  practice.buildQueue();
  store.renderAll();
}

beforeEach(() => {
  state.wordBank = {};
  state.phonicBank = {};
  state.verifiedWords = [];
  state.confirmCounts = {};
  state.attemptLog = {};
  state.contextLog = [];
  state.sheets = [];
  mount();
});
afterEach(() => { delete globalThis.fetch; });

describe('the pause before one word stops recording', () => {
  it('is short, because a word has nothing to pause inside it', () => {
    expect(CAPTURE_MODES.word.silenceMs).toBeLessThanOrEqual(600);
  });

  it('is the shortest of every mode, and still leaves a hard ceiling', () => {
    const others = ['sentence', 'passage', 'freeform'].map((m) => CAPTURE_MODES[m].silenceMs);
    others.forEach((ms) => expect(CAPTURE_MODES.word.silenceMs).toBeLessThan(ms));
    expect(CAPTURE_MODES.word.maxMs).toBeGreaterThan(CAPTURE_MODES.word.silenceMs);
  });
});

describe('a rough preview while she is still saying the word', () => {
  it('shows the browser recogniser\'s guess as she says it', async () => {
    const release = serviceHangs('yellow');
    mic().click();
    await settle();
    expect(live).not.toBe(null);
    expect(live.interimResults).toBe(true);

    live.say('yell');
    expect(rough().textContent).toBe('yell');
    expect(rough().classList.contains('show')).toBe(true);
    release();
    await settle();
  });

  it('stays up through the wait, then the real transcript replaces it', async () => {
    const release = serviceHangs('yellow');
    mic().click();
    await settle();
    live.say('yeller');
    mic().click();
    await settle();

    // Recording is over; the rough word covers the wait it started.
    expect(rough().textContent).toBe('yeller');
    expect(live).toBe(null);

    release();
    await settle(); await settle();
    expect(rough().textContent).toBe('');
    expect(rough().classList.contains('show')).toBe(false);
    expect(heardBox().classList.contains('show')).toBe(true);
    expect(heardText()).toContain('yellow');
  });

  it('is never matched against the word she was asked for', async () => {
    // Practice *scores* what it hears. A guess reaching the matcher could mark
    // a word mastered on a word she never said.
    const target = state.practiceQueue[0];
    const before = {
      verified: JSON.stringify(state.verifiedWords),
      counts: JSON.stringify(state.confirmCounts),
      bank: JSON.stringify(state.wordBank),
      attempts: JSON.stringify(state.attemptLog)
    };
    const release = serviceHangs('something else');
    mic().click();
    await settle();
    live.say(target);
    live.say(target);

    expect(JSON.stringify(state.verifiedWords)).toBe(before.verified);
    expect(JSON.stringify(state.confirmCounts)).toBe(before.counts);
    expect(JSON.stringify(state.wordBank)).toBe(before.bank);
    expect(JSON.stringify(state.attemptLog)).toBe(before.attempts);
    expect(heardBox().classList.contains('show')).toBe(false);
    expect(saved).toEqual([]);
    release();
    await settle();
  });

  it('never advances the queue on a guess', async () => {
    const queue = state.practiceQueue.slice(0, 3).join('|');
    const release = serviceHangs('yellow');
    mic().click();
    await settle();
    live.say(state.practiceQueue[0]);
    expect(state.practiceQueue.slice(0, 3).join('|')).toBe(queue);
    release();
    await settle();
  });

  it('is cleared when the attempt fails, not left looking like an answer', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 }));
    mic().click();
    await settle();
    live.say('a guess');
    expect(rough().textContent).toBe('a guess');

    mic().click();
    await settle(); await settle();
    expect(rough().textContent).toBe('');
  });

  it('is cleared when the word changes underneath it', async () => {
    const release = serviceHangs('yellow');
    mic().click();
    await settle();
    live.say('a guess');
    release();
    await settle(); await settle();

    practice.clearHeard();
    expect(rough().textContent).toBe('');
  });

  it('carries on silently when the browser gives no second recogniser', async () => {
    const release = serviceHangs('yellow');
    mic().click();
    await settle();
    if (live && live.onerror) live.onerror({ error: 'not-allowed' });
    live.say('should not show');
    expect(rough().textContent).toBe('');

    mic().click();
    await settle();
    release();
    await settle(); await settle();
    expect(heardText()).toContain('yellow');
  });
});

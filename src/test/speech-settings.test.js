// @vitest-environment jsdom
// How fast the app reads, and in whose voice. Set once in Word Bank, synced
// with her accent, and applied everywhere the app speaks — CLAUDE.md §16.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class FakeRecognition { start() {} stop() {} abort() {} }
window.SpeechRecognition = FakeRecognition;

// A voice list the test controls, and a synthesiser that records the whole
// utterance rather than just its text — the rate and voice are the point here.
let voices = [];
const said = [];
window.speechSynthesis = {
  cancel() {},
  getVoices: () => voices,
  addEventListener() {},
  speak(u) { said.push(u); if (u.onstart) u.onstart(); if (u.onend) u.onend(); }
};
window.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; this.rate = 1; this.lang = ''; this.voice = null; }
};
const voice = (name, lang) => ({ name, lang });

const store = await import('../lib/store.js');
const { state } = store;
const { speak, readAloud, voicesForLang, isUpgradedVoice } = await import('../lib/speech.js');
const { foldSnapshot, SYNCED_FIELDS } = await import('../lib/snapshot.js');
const { SPEECH_RATE_DEFAULT, SPEECH_RATE_MIN, SPEECH_RATE_MAX } = await import('../config.js');
const { initBank } = await import('../features/bank.js');
const { initTabs } = await import('../features/tabs.js');

const ROOT = resolve(import.meta.dirname, '../..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const rate = () => document.getElementById('speechRate');
const picker = () => document.getElementById('speechVoice');
const voiceNote = () => document.getElementById('speechVoiceNote').textContent;
let saved;

function mount() {
  document.body.innerHTML = BODY;
  said.length = 0;
  saved = [];
  store.setSaver(async (key, value) => { saved.push({ key, value }); });
  initTabs();
  initBank();
}

beforeEach(() => {
  voices = [];
  state.wordBank = {};
  state.phonicBank = {};
  state.contextLog = [];
  state.sheets = [];
  state.speechLang = 'en-AU';
  state.speechRate = SPEECH_RATE_DEFAULT;
  state.speechVoice = '';
  mount();
});

describe('reading speed', () => {
  it('applies everywhere the app speaks', () => {
    state.speechRate = 0.6;
    speak('hello');
    readAloud(['one', 'two']);
    expect(said.map((u) => u.rate)).toEqual([0.6, 0.6, 0.6]);
  });

  it('is remembered and synced, not kept on this device', () => {
    expect(SYNCED_FIELDS).toContain('speech_rate');
    rate().value = '1.2';
    rate().dispatchEvent(new Event('input'));
    expect(saved.some((w) => w.key === 'speech_rate' && w.value === 1.2)).toBe(true);
    expect(state.speechRate).toBe(1.2);
  });

  it('comes back from a document, and ignores one outside the slider', () => {
    const s = {};
    foldSnapshot(s, { speech_rate: 1.3 });
    expect(s.speechRate).toBe(1.3);
    [0.1, 9, 'quickly', null].forEach((bad) => {
      foldSnapshot(s, { speech_rate: bad });
      expect(s.speechRate).toBe(SPEECH_RATE_DEFAULT);
    });
  });

  it('defaults to the speed the app has always read at', () => {
    const s = {};
    foldSnapshot(s, {});
    expect(s.speechRate).toBe(SPEECH_RATE_DEFAULT);
    expect(rate().min).toBe(String(SPEECH_RATE_MIN));
    expect(rate().max).toBe(String(SPEECH_RATE_MAX));
  });

  it('says what the number means while it is being dragged', () => {
    rate().value = '0.5';
    rate().dispatchEvent(new Event('input'));
    expect(document.getElementById('speechRateNote').textContent).toContain('Slower');
    rate().value = '1.4';
    rate().dispatchEvent(new Event('input'));
    expect(document.getElementById('speechRateNote').textContent).toContain('Faster');
  });
});

describe('her voice', () => {
  it('lists the voices this device has for her accent', () => {
    voices = [
      voice('Karen', 'en-AU'), voice('Daniel', 'en-GB'),
      voice('Amelie', 'fr-FR'), voice('Lee (Enhanced)', 'en-AU')
    ];
    mount();
    const offered = [...picker().options].map((o) => o.value);
    expect(offered).toContain('Karen');
    expect(offered).toContain('Lee (Enhanced)');
    expect(offered).not.toContain('Amelie');
    // A near miss is better than nothing when the exact accent has no voice.
    expect(offered).toContain('Daniel');
    // The exact accent comes first, so the right one is the easy choice.
    expect(offered.indexOf('Karen')).toBeLessThan(offered.indexOf('Daniel'));
  });

  it('applies the chosen voice everywhere the app speaks', () => {
    voices = [voice('Karen', 'en-AU'), voice('Lee (Enhanced)', 'en-AU')];
    mount();
    picker().value = 'Lee (Enhanced)';
    picker().dispatchEvent(new Event('change'));

    speak('hello');
    readAloud(['one']);
    expect(said.map((u) => u.voice && u.voice.name)).toEqual(['Lee (Enhanced)', 'Lee (Enhanced)']);
    expect(saved.some((w) => w.key === 'speech_voice' && w.value === 'Lee (Enhanced)')).toBe(true);
    expect(SYNCED_FIELDS).toContain('speech_voice');
  });

  it('reads in the browser default when the chosen voice is not on this device', () => {
    // Her devices sync; their installed voices do not. A stale name must not
    // silence the app.
    voices = [voice('Karen', 'en-AU')];
    state.speechVoice = 'Lee (Premium)';
    mount();
    speak('hello');
    expect(said[0].voice).toBe(null);
    expect(voiceNote()).toContain('not installed here');
  });

  it('points at the download when only the robotic one is here', () => {
    voices = [voice('Karen', 'en-AU')];
    mount();
    expect(isUpgradedVoice(voices[0])).toBe(false);
    expect(voiceNote()).toContain('Accessibility');
    expect(voiceNote()).toContain('Spoken Content');
    expect(voiceNote()).toContain('Voices');
  });

  it('stops pointing at the download once a better voice is installed', () => {
    voices = [voice('Karen', 'en-AU'), voice('Matilda (Premium)', 'en-AU')];
    mount();
    expect(voiceNote()).not.toContain('Accessibility');
    expect(voiceNote()).toContain('better quality');
  });

  it('recognises the labels iOS gives its downloaded voices', () => {
    expect(isUpgradedVoice(voice('Karen (Enhanced)'))).toBe(true);
    expect(isUpgradedVoice(voice('Serena (Premium)'))).toBe(true);
    expect(isUpgradedVoice(voice('Karen'))).toBe(false);
  });

  it('drops a voice that does not belong to the accent she switched to', () => {
    voices = [voice('Karen', 'en-AU'), voice('Aria', 'en-NZ')];
    state.speechVoice = 'Aria';
    mount();
    const lang = document.getElementById('speechLang');
    lang.value = 'en-IN';
    lang.dispatchEvent(new Event('change'));
    expect(state.speechVoice).toBe('');
    expect(saved.some((w) => w.key === 'speech_voice' && w.value === '')).toBe(true);
  });

  it('survives a browser that reports no voices at all', () => {
    voices = [];
    expect(() => mount()).not.toThrow();
    expect(voicesForLang('en-AU')).toEqual([]);
    expect(() => speak('hello')).not.toThrow();
    expect(said[said.length - 1].voice).toBe(null);
  });
});

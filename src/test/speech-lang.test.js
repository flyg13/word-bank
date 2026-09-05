import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { state } from '../lib/store.js';
import { foldSnapshot, SYNCED_FIELDS } from '../lib/snapshot.js';
import { DEFAULT_SPEECH_LANG, SPEECH_LANGS } from '../config.js';

describe('speech language', () => {
  beforeEach(() => foldSnapshot(state, {}));

  it('defaults to Australian English', () => {
    expect(DEFAULT_SPEECH_LANG).toBe('en-AU');
    expect(state.speechLang).toBe('en-AU');
  });

  it('is per family — it comes from the synced document', () => {
    foldSnapshot(state, { speech_lang: 'en-GB' });
    expect(state.speechLang).toBe('en-GB');
    expect(SYNCED_FIELDS).toContain('speech_lang');
  });

  it('falls back rather than handing the recognizer something it will reject', () => {
    ['kl-KL', '', null, 42, 'en-XX'].forEach((bad) => {
      foldSnapshot(state, { speech_lang: bad });
      expect(state.speechLang).toBe(DEFAULT_SPEECH_LANG);
    });
  });

  it('offers only well-formed BCP 47 tags, with en-AU first', () => {
    expect(SPEECH_LANGS[0].code).toBe('en-AU');
    SPEECH_LANGS.forEach(({ code, label }) => {
      expect(code).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(label.length).toBeGreaterThan(0);
    });
    const codes = SPEECH_LANGS.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('is read at listen time, not frozen at construction', () => {
    // The recognizer is built once at module load. If lang were set there, a
    // change would need a page reload before it took effect.
    const speech = readFileSync(resolve(__dirname, '../lib/speech.js'), 'utf8');
    const construction = speech.slice(0, speech.indexOf('export function'));
    expect(construction).not.toContain('.lang =');
    expect(speech).toContain('recognizer.lang = state.speechLang');
    // And the spoken prompt uses it too, so she copies the right accent.
    expect(speech).toContain('utterance.lang = state.speechLang');
  });
});

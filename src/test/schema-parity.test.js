// @vitest-environment jsdom
//
// Differential schema test: drives the SAME user flows through the original
// single-file app and through the ported modules, with a recording fake in
// place of Firestore, then asserts both wrote byte-identical payloads.
//
// This exists because there is real synced data in production. Field names,
// document structure and value shapes must not drift — an entry written by
// the old app has to keep working in the new one and vice versa.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRACTICE_WORDS } from '../data/practice-words.js';

const ROOT = resolve(__dirname, '../..');

function bodyOf(html) {
  return html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
}

// ---------------------------------------------------------------------------
// Run the ORIGINAL app: its inline script, against a recording fake Firestore.
// ---------------------------------------------------------------------------
function installFakeSpeech() {
  window.__nextTranscript = '';
  class FakeRecognition {
    start() {
      if (this.onresult) {
        this.onresult({ results: [[{ transcript: window.__nextTranscript }]] });
      }
      if (this.onend) this.onend();
    }
    stop() {}
  }
  window.SpeechRecognition = FakeRecognition;
  window.speechSynthesis = { cancel() {}, speak() {} };
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text;
  };
}

async function runLegacy(drive, initial = {}) {
  // Both apps mutate the snapshot they are handed (verifiedWords.push, and so
  // on), so each run gets its own copy — otherwise the second run starts from
  // the first run's leftovers.
  initial = structuredClone(initial);
  const html = readFileSync(resolve(ROOT, 'legacy/index.html'), 'utf8');
  document.body.innerHTML = bodyOf(html);
  installFakeSpeech();

  const writes = [];
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  let snapshotHandler = null;
  window.firebase = {
    initializeApp: () => {},
    auth: () => ({ signInAnonymously: async () => {} }),
    firestore: () => ({
      collection: (name) => ({
        doc: (id) => ({
          path: name + '/' + id,
          onSnapshot: (onNext) => { snapshotHandler = onNext; },
          set: async (payload, options) => { writes.push({ payload, options }); }
        })
      })
    })
  };
  localStorage.setItem('word_bank_family_code', 'parity-test');

  // eslint-disable-next-line no-new-func
  const run = new Function(script);
  run();
  await new Promise((r) => setTimeout(r, 0));
  // Deliver the first snapshot, as Firestore would.
  snapshotHandler({ data: () => initial });

  await drive(document);
  await new Promise((r) => setTimeout(r, 0));
  return writes;
}

// ---------------------------------------------------------------------------
// Run the PORTED app: real feature modules, same recording fake.
// ---------------------------------------------------------------------------
async function runPorted(drive, initial = {}) {
  initial = structuredClone(initial);
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  document.body.innerHTML = bodyOf(html).replace(/<script[\s\S]*?<\/script>/g, '');
  installFakeSpeech();

  vi.resetModules();
  const writes = [];

  const store = await import('../lib/store.js');
  const { initTabs } = await import('../features/tabs.js');
  const { initProgress } = await import('../features/progress.js');
  const { initSession } = await import('../features/session.js');
  const practice = await import('../features/practice.js');
  const { initSentences } = await import('../features/sentences.js');
  const { initReading } = await import('../features/reading.js');
  const { initFreeWrite } = await import('../features/freewrite.js');
  const { initBank } = await import('../features/bank.js');

  initTabs();
  initProgress();
  initSession();
  practice.initPractice();
  initSentences();
  initReading();
  initFreeWrite();
  initBank();

  store.setSaver(async (key, value) => {
    writes.push({ payload: { [key]: value }, options: { merge: true } });
  });

  // The same fold main.js performs on a snapshot.
  const { parsePassage } = await import('../lib/text.js');
  const s = store.state;
  s.wordBank = initial.word_bank || {};
  s.verifiedWords = initial.verified_words || [];
  s.confirmCounts = initial.confirm_counts || {};
  s.sessionLog = initial.session_log || [];
  s.sentenceProgress = initial.sentence_progress || {};
  s.sentenceIndex = initial.sentence_index || 0;
  s.readingPassage = initial.reading_passage || '';
  s.readingSentences = s.readingPassage ? parsePassage(s.readingPassage) : [];
  s.readingProgress = initial.reading_progress || {};
  s.readingIndex = initial.reading_index || 0;
  s.attemptLog = initial.attempt_log || {};

  practice.buildQueue();
  store.renderAll();

  await drive(document);
  await new Promise((r) => setTimeout(r, 0));
  return writes;
}

/** Collapse a write list into { field -> final value } for comparison. */
function finalState(writes) {
  const out = {};
  writes.forEach(({ payload }) => Object.assign(out, payload));
  return out;
}

function fieldsWritten(writes) {
  return [...new Set(writes.flatMap(({ payload }) => Object.keys(payload)))].sort();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('Firestore document path and write options', () => {
  it('the original writes to families/<code> with merge:true', async () => {
    const html = readFileSync(resolve(ROOT, 'legacy/index.html'), 'utf8');
    expect(html).toContain("db.collection('families').doc(code)");
    expect(html).toContain('{ merge: true }');
    expect(html).toContain("localStorage.getItem('word_bank_family_code')");
  });

  it('the port writes to the same path, with the same options and code key', async () => {
    const src = readFileSync(resolve(ROOT, 'src/lib/firestore.js'), 'utf8');
    expect(src).toContain("doc(db, 'families', code)");
    expect(src).toContain('{ merge: true }');
    expect(src).toContain("localStorage.getItem('word_bank_family_code')");
    // Same normalisation of a typed code, so an existing device's code still resolves.
    expect(src).toContain("replace(/[^a-z0-9-]/g, '-')");
  });
});

describe('schema parity: manually adding a correction', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="bank"]').click();
    doc.getElementById('manualRaw').value = 'yoyo';
    doc.getElementById('manualCorrect').value = 'yellow';
    doc.getElementById('manualAddBtn').click();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('writes the same field with the same entry shape', async () => {
    const legacy = finalState(await runLegacy(drive));
    const ported = finalState(await runPorted(drive));
    expect(Object.keys(ported)).toEqual(Object.keys(legacy));
    expect(ported.word_bank).toEqual(legacy.word_bank);
    expect(ported.word_bank).toEqual({ yoyo: { correct: 'yellow', count: 3, active: true } });
  });
});

describe('schema parity: correcting a word in Free Write', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="write"]').click();
    const input = doc.getElementById('rawInput');
    input.value = 'wibble';
    input.dispatchEvent(new window.Event('input'));
    doc.querySelector('#correctedOutput .wtok').click();
    doc.getElementById('fixInput').value = 'wobble';
    doc.getElementById('saveFix').click();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('writes an identical pending entry', async () => {
    const legacy = finalState(await runLegacy(drive));
    const ported = finalState(await runPorted(drive));
    expect(ported.word_bank).toEqual(legacy.word_bank);
    // Pending: seen once, not yet trusted.
    expect(ported.word_bank).toEqual({ wibble: { correct: 'wobble', count: 1, active: false } });
  });
});

describe('schema parity: saving a reading passage', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="reading"]').click();
    doc.getElementById('readingPassageInput').value = 'The dog ran fast. It was warm.';
    doc.getElementById('saveReadingBtn').click();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('writes the same three reading fields with the same values', async () => {
    const legacyWrites = await runLegacy(drive);
    const portedWrites = await runPorted(drive);
    expect(fieldsWritten(portedWrites)).toEqual(fieldsWritten(legacyWrites));
    const legacy = finalState(legacyWrites);
    const ported = finalState(portedWrites);
    expect(ported.reading_passage).toEqual(legacy.reading_passage);
    expect(ported.reading_progress).toEqual(legacy.reading_progress);
    expect(ported.reading_index).toEqual(legacy.reading_index);
    expect(ported.reading_passage).toBe('The dog ran fast. It was warm.');
  });
});

describe('schema parity: ending a practice session', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="practice"]').click();
    doc.getElementById('startSessionBtn').click();
    doc.getElementById('endSessionBtn').click();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('writes an identically shaped session log entry', async () => {
    const legacy = finalState(await runLegacy(drive));
    const ported = finalState(await runPorted(drive));
    expect(Object.keys(ported)).toEqual(Object.keys(legacy));
    expect(Object.keys(ported.session_log[0]).sort()).toEqual(
      Object.keys(legacy.session_log[0]).sort()
    );
    expect(Object.keys(ported.session_log[0]).sort()).toEqual(['attempted', 'date', 'mastered']);
  });
});

describe('reading data written by the original app', () => {
  it('loads every field the original wrote, including bare-string bank entries', async () => {
    document.body.innerHTML = bodyOf(readFileSync(resolve(ROOT, 'index.html'), 'utf8')).replace(
      /<script[\s\S]*?<\/script>/g,
      ''
    );
    vi.resetModules();

    // A document exactly as the ORIGINAL app would have left it, including the
    // oldest bare-string correction format.
    const production = {
      word_bank: {
        yoyo: 'yellow',
        wibble: { correct: 'wobble', count: 2, active: true },
        pending: { correct: 'later', count: 1, active: false }
      },
      verified_words: ['the', 'and'],
      confirm_counts: { the: 3, and: 3, said: 1 },
      session_log: [{ date: '1/1/2026', attempted: 5, mastered: 2 }],
      sentence_progress: { 0: 2, 1: 1 },
      sentence_index: 3,
      reading_passage: 'The dog ran. It was warm.',
      reading_progress: { 0: 1 },
      reading_index: 1,
      attempt_log: {
        'yellow|||yoyo': { target: 'yellow', heard: 'yoyo', count: 2, lastSeen: '2026-01-01T00:00:00.000Z' }
      }
    };

    const store = await import('../lib/store.js');
    const { PRACTICE_WORDS } = await import('../data/practice-words.js');
    const { parsePassage } = await import('../lib/text.js');
    const wordbank = await import('../lib/wordbank.js');
    const practice = await import('../features/practice.js');

    // The same fold main.js performs on every snapshot.
    const s = store.state;
    s.wordBank = production.word_bank;
    s.verifiedWords = production.verified_words;
    s.confirmCounts = production.confirm_counts;
    s.sessionLog = production.session_log;
    s.sentenceProgress = production.sentence_progress;
    s.sentenceIndex = production.sentence_index;
    s.readingPassage = production.reading_passage;
    s.readingSentences = parsePassage(s.readingPassage);
    s.readingProgress = production.reading_progress;
    s.readingIndex = production.reading_index;
    s.attemptLog = production.attempt_log;

    // Nothing is orphaned: every stored form is read back correctly.
    expect(wordbank.getBankEntry('yoyo')).toMatchObject({ correct: 'yellow', active: true });
    expect(wordbank.applyBankToWord('yoyo')).toBe('yellow');
    expect(wordbank.applyBankToWord('wibble')).toBe('wobble');
    expect(wordbank.applyBankToWord('pending')).toBe('pending');
    expect(s.sessionLog[0].mastered).toBe(2);
    expect(s.readingSentences).toEqual(['The dog ran.', 'It was warm.']);

    // Mastered words drop out of the practice queue rather than being re-drilled.
    practice.buildQueue();
    expect(s.practiceQueue).not.toContain('the');
    expect(s.practiceQueue).not.toContain('and');
    expect(s.practiceQueue).toContain('said');
    expect(s.practiceQueue.length).toBe(PRACTICE_WORDS.length - 2);
  });
});

// ---------------------------------------------------------------------------
// The remaining fields, so the parity claim covers all ten rather than a
// sample: confirm_counts, verified_words, attempt_log, sentence_progress.
// ---------------------------------------------------------------------------

/** Say `transcript` into the Practice mic and settle any timers. */
async function speakIntoPractice(doc, transcript) {
  window.__nextTranscript = transcript;
  doc.getElementById('practiceMic').click();
  await new Promise((r) => setTimeout(r, 900)); // the 700ms accept delay
}

describe('schema parity: a correct practice attempt', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="practice"]').click();
    const word = doc.getElementById('targetWord').textContent.trim();
    await speakIntoPractice(doc, word);
  };

  it('writes confirm_counts in the same shape', async () => {
    const legacyWrites = await runLegacy(drive);
    const portedWrites = await runPorted(drive);
    expect(fieldsWritten(portedWrites)).toEqual(fieldsWritten(legacyWrites));
    expect(fieldsWritten(portedWrites)).toEqual(['confirm_counts']);

    const legacy = finalState(legacyWrites);
    const ported = finalState(portedWrites);
    // One word, counted once — a flat { word: count } map in both.
    expect(Object.values(ported.confirm_counts)).toEqual([1]);
    expect(Object.values(legacy.confirm_counts)).toEqual([1]);
    expect(typeof Object.keys(ported.confirm_counts)[0]).toBe('string');
  });
});

describe('schema parity: mastering a word', () => {
  // Seed the document so exactly one word is left unmastered: the queue holds
  // one word, so it repeats immediately and reaches mastery in three attempts.
  const LAST_WORD = 'yesterday';
  const initial = {
    verified_words: PRACTICE_WORDS.filter((w) => w !== LAST_WORD)
  };

  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="practice"]').click();
    for (let i = 0; i < 3; i++) {
      await speakIntoPractice(doc, LAST_WORD);
    }
  };

  it('appends to verified_words as a flat array of words', async () => {
    const legacyWrites = await runLegacy(drive, initial);
    const portedWrites = await runPorted(drive, initial);
    expect(fieldsWritten(portedWrites)).toEqual(fieldsWritten(legacyWrites));
    expect(fieldsWritten(portedWrites)).toEqual(['confirm_counts', 'verified_words']);

    const legacy = finalState(legacyWrites);
    const ported = finalState(portedWrites);
    expect(ported.verified_words).toEqual(legacy.verified_words);
    expect(ported.verified_words.every((w) => typeof w === 'string')).toBe(true);
    expect(ported.verified_words).toContain(LAST_WORD);
    expect(ported.verified_words.length).toBe(PRACTICE_WORDS.length);
    expect(ported.confirm_counts[LAST_WORD]).toBe(3);
    expect(legacy.confirm_counts[LAST_WORD]).toBe(3);
  });
});

describe('schema parity: a misheard practice attempt', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="practice"]').click();
    await speakIntoPractice(doc, 'zzquump');
  };

  it('writes attempt_log with the same key format and entry shape', async () => {
    const legacyWrites = await runLegacy(drive);
    const portedWrites = await runPorted(drive);
    expect(fieldsWritten(portedWrites)).toEqual(fieldsWritten(legacyWrites));

    const legacy = finalState(legacyWrites);
    const ported = finalState(portedWrites);
    const portedKey = Object.keys(ported.attempt_log)[0];
    const legacyKey = Object.keys(legacy.attempt_log)[0];

    // "target|||heard" — the key format existing rows are stored under.
    expect(portedKey).toMatch(/^[a-z']+\|\|\|zzquump$/);
    expect(portedKey.split('|||')[1]).toBe(legacyKey.split('|||')[1]);
    expect(Object.keys(ported.attempt_log[portedKey]).sort()).toEqual(
      Object.keys(legacy.attempt_log[legacyKey]).sort()
    );
    expect(Object.keys(ported.attempt_log[portedKey]).sort()).toEqual([
      'count',
      'heard',
      'lastSeen',
      'target'
    ]);
    expect(ported.attempt_log[portedKey].count).toBe(1);
  });
});

describe('schema parity: a clean sentence read', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="sentences"]').click();
    window.__nextTranscript = doc.getElementById('targetSentence').textContent.trim();
    doc.getElementById('sentenceMic').click();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('writes sentence_progress keyed by index in the same shape', async () => {
    const legacyWrites = await runLegacy(drive);
    const portedWrites = await runPorted(drive);
    expect(fieldsWritten(portedWrites)).toEqual(fieldsWritten(legacyWrites));
    const legacy = finalState(legacyWrites);
    const ported = finalState(portedWrites);
    expect(ported.sentence_progress).toEqual(legacy.sentence_progress);
    expect(ported.sentence_progress).toEqual({ 0: 1 });
  });
});

describe('every synced field is covered by a parity test', () => {
  it('names all ten, so a new field cannot be added without a test', () => {
    const legacy = readFileSync(resolve(ROOT, 'legacy/index.html'), 'utf8');
    const original = [...legacy.matchAll(/saveJSON\('([a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(original)].sort()).toEqual([
      'attempt_log',
      'confirm_counts',
      'reading_index',
      'reading_passage',
      'reading_progress',
      'sentence_index',
      'sentence_progress',
      'session_log',
      'verified_words',
      'word_bank'
    ]);
  });
});

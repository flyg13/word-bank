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
import { readFileSync, readdirSync } from 'node:fs';
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

  // The very fold main.js performs — imported, not reimplemented, so this
  // harness cannot drift from the app.
  const { foldSnapshot } = await import('../lib/snapshot.js');
  foldSnapshot(store.state, initial);

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

describe('schema parity: correcting a word in Speech-To-Text', () => {
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
    const { foldSnapshot } = await import('../lib/snapshot.js');
    const wordbank = await import('../lib/wordbank.js');
    const practice = await import('../features/practice.js');

    const s = store.state;
    foldSnapshot(s, production);

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

// ---------------------------------------------------------------------------
// §3 adds one field, phonic_bank. It has to be additive in both directions:
// the new app must not disturb the ten existing fields, and the original app
// must survive a document containing the new one (a rollback, or a device
// still running a cached copy of the old build).
// ---------------------------------------------------------------------------

describe('phonic_bank is purely additive', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="bank"]').click();
    doc.getElementById('phonicWord').value = 'yellow';
    doc.getElementById('phonicSpelling').value = 'yeyo';
    doc.getElementById('phonicAddBtn').click();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('recording a pronunciation writes phonic_bank and nothing else', async () => {
    const writes = await runPorted(drive);
    expect(fieldsWritten(writes)).toEqual(['phonic_bank']);
    expect(finalState(writes).phonic_bank).toMatchObject({
      yellow: { word: 'yellow', spellings: ['yeyo'], keys: ['A'] }
    });
  });

  it('leaves every pre-existing field byte-identical to what the original wrote', async () => {
    // The same flows as the parity tests above, but run against a document
    // that already carries a phonic_bank.
    const withPhonics = {
      phonic_bank: { yellow: { word: 'yellow', spellings: ['yeyo'], keys: ['A'], added: 'x' } }
    };
    const manualAdd = async (doc) => {
      doc.querySelector('.tab[data-tab="bank"]').click();
      doc.getElementById('manualRaw').value = 'yoyo';
      doc.getElementById('manualCorrect').value = 'yellow';
      doc.getElementById('manualAddBtn').click();
      await new Promise((r) => setTimeout(r, 0));
    };
    const legacy = finalState(await runLegacy(manualAdd));
    const ported = finalState(await runPorted(manualAdd, withPhonics));
    expect(Object.keys(ported)).toEqual(Object.keys(legacy));
    expect(ported.word_bank).toEqual(legacy.word_bank);
  });

  it('the original app tolerates a document containing phonic_bank', async () => {
    // It reads only the fields it knows, and writes one field at a time with
    // merge:true — so an old client can neither choke on nor clobber the new
    // field. That is what makes a rollback safe.
    const drive = async (doc) => {
      doc.querySelector('.tab[data-tab="bank"]').click();
      doc.getElementById('manualRaw').value = 'yoyo';
      doc.getElementById('manualCorrect').value = 'yellow';
      doc.getElementById('manualAddBtn').click();
      await new Promise((r) => setTimeout(r, 0));
    };
    const writes = await runLegacy(drive, {
      word_bank: { wibble: { correct: 'wobble', count: 2, active: true } },
      phonic_bank: { yellow: { word: 'yellow', spellings: ['yeyo'], keys: ['A'], added: 'x' } }
    });

    // It carried on normally...
    expect(finalState(writes).word_bank).toMatchObject({
      wibble: { correct: 'wobble' },
      yoyo: { correct: 'yellow' }
    });
    // ...and never wrote phonic_bank, so merge:true leaves it intact.
    expect(fieldsWritten(writes)).not.toContain('phonic_bank');
    writes.forEach(({ options }) => expect(options).toEqual({ merge: true }));
  });

  it('the port reads a phonic_bank written by an earlier session', async () => {
    const drive = async (doc) => {
      doc.querySelector('.tab[data-tab="bank"]').click();
    };
    await runPorted(drive, {
      phonic_bank: {
        yellow: { word: 'yellow', spellings: ['yeyo', 'ye oh'], keys: ['A'], added: 'x' }
      }
    });
    expect(document.getElementById('phonicList').textContent).toContain('yellow');
    expect(document.getElementById('phonicList').textContent).toContain('yeyo');
  });

  it('survives an export/import round trip', async () => {
    const drive = async (doc) => {
      doc.querySelector('.tab[data-tab="bank"]').click();
      doc.getElementById('phonicWord').value = 'yellow';
      doc.getElementById('phonicSpelling').value = 'yeyo';
      doc.getElementById('phonicAddBtn').click();
      await new Promise((r) => setTimeout(r, 0));
    };
    const exported = finalState(await runPorted(drive));
    // The export payload is assembled from the same state the writes came from.
    expect(exported.phonic_bank.yellow.spellings).toEqual(['yeyo']);

    const reimport = async () => {};
    await runPorted(reimport, { phonic_bank: exported.phonic_bank });
    const { state } = await import('../lib/store.js');
    expect(state.phonicBank.yellow.spellings).toEqual(['yeyo']);
  });
});

describe('the snapshot fold covers every field the app writes', () => {
  it('reads back everything any feature can save', async () => {
    const { SYNCED_FIELDS } = await import('../lib/snapshot.js');
    const sources = ['src/features', 'src/lib']
      .flatMap((dir) =>
        readdirSync(resolve(ROOT, dir)).map((f) => readFileSync(resolve(ROOT, dir, f), 'utf8'))
      )
      .join('\n');
    const written = [...new Set([...sources.matchAll(/save\('([a-z_]+)'/g)].map((m) => m[1]))];
    // Anything the app can persist must also be something it can load back.
    expect(written.filter((f) => !SYNCED_FIELDS.includes(f))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// speech_lang, like phonic_bank, has to be additive in both directions.
// ---------------------------------------------------------------------------

describe('speech_lang is purely additive', () => {
  const drive = async (doc) => {
    doc.querySelector('.tab[data-tab="bank"]').click();
    const select = doc.getElementById('speechLang');
    select.value = 'en-GB';
    select.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 0));
  };

  it('changing the accent writes speech_lang and nothing else', async () => {
    const writes = await runPorted(drive);
    expect(fieldsWritten(writes)).toEqual(['speech_lang']);
    expect(finalState(writes).speech_lang).toBe('en-GB');
  });

  it('defaults to en-AU for a document that predates the field', async () => {
    await runPorted(async (doc) => doc.querySelector('.tab[data-tab="bank"]').click(), {
      word_bank: { yoyo: 'yellow' }
    });
    const { state } = await import('../lib/store.js');
    expect(state.speechLang).toBe('en-AU');
  });

  it('the original app tolerates a document containing speech_lang', async () => {
    const writes = await runLegacy(
      async (doc) => {
        doc.querySelector('.tab[data-tab="bank"]').click();
        doc.getElementById('manualRaw').value = 'yoyo';
        doc.getElementById('manualCorrect').value = 'yellow';
        doc.getElementById('manualAddBtn').click();
        await new Promise((r) => setTimeout(r, 0));
      },
      { speech_lang: 'en-AU', phonic_bank: {} }
    );
    expect(finalState(writes).word_bank).toMatchObject({ yoyo: { correct: 'yellow' } });
    expect(fieldsWritten(writes)).not.toContain('speech_lang');
  });
});

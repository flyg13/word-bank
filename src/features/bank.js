import { MASTERY_THRESHOLD, SPEECH_LANGS } from '../config.js';
import { normalize, parsePassage } from '../lib/text.js';
import { state, save, onRender, renderAll } from '../lib/store.js';
import { getBankEntry } from '../lib/wordbank.js';
import {
  phonicEntries,
  addSpelling,
  removeSpelling,
  removePhonicEntry
} from '../lib/phonicbank.js';
import { isWeakSpelling, phoneticKeys } from '../lib/phonetics.js';
import { buildQueue, attemptKey } from './practice.js';

// ---------- Correction list ----------

function bankEntries() {
  const query = normalize(document.getElementById('bankSearch').value);
  return Object.keys(state.wordBank)
    .map((raw) => [raw, getBankEntry(raw)])
    .filter(([raw, entry]) => {
      if (!entry) return false;
      if (!query) return true;
      return raw.includes(query) || normalize(entry.correct).includes(query);
    })
    .sort((a, b) => a[1].correct.localeCompare(b[1].correct));
}

export function renderBankList() {
  const list = document.getElementById('bankList');
  const entries = bankEntries();

  if (entries.length === 0) {
    list.innerHTML =
      '<div class="empty-note">No corrections saved yet — use Practice or Sentences to start building her bank.</div>';
    return;
  }

  list.innerHTML = '';
  entries.forEach(([raw, entry]) => {
    const row = document.createElement('div');
    row.className = 'bank-row';

    const pair = document.createElement('div');
    pair.className = 'pair';
    pair.append(
      document.createTextNode('heard "'),
      Object.assign(document.createElement('b'), { textContent: raw }),
      document.createTextNode('" → means '),
      Object.assign(document.createElement('b'), { textContent: entry.correct })
    );
    if (!entry.active) {
      const note = document.createElement('span');
      note.style.cssText = 'color:var(--amber);font-size:12px;';
      note.textContent = ' — needs confirming';
      pair.appendChild(note);
    }
    row.appendChild(pair);

    const buttons = document.createElement('div');
    if (!entry.active) {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'del-btn';
      confirmBtn.style.color = 'var(--sage)';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.onclick = () => {
        state.wordBank[raw] = {
          correct: entry.correct,
          count: Math.max(2, entry.count || 1),
          active: true
        };
        save('word_bank', state.wordBank);
        renderAll();
      };
      buttons.appendChild(confirmBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'del-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.style.marginLeft = '10px';
    removeBtn.onclick = () => {
      delete state.wordBank[raw];
      save('word_bank', state.wordBank);
      renderAll();
    };
    buttons.appendChild(removeBtn);

    row.appendChild(buttons);
    list.appendChild(row);
  });
}

// ---------- Recurring mishearings not yet banked ----------

export function renderAttemptLog() {
  const container = document.getElementById('attemptLogList');
  if (!container) return;

  const entries = Object.values(state.attemptLog)
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-note">Nothing recurring yet.</div>';
    return;
  }

  container.innerHTML = '';
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'bank-row';

    const pair = document.createElement('div');
    pair.className = 'pair';
    pair.append(
      document.createTextNode('practicing "'),
      Object.assign(document.createElement('b'), { textContent: entry.target }),
      document.createTextNode('" — heard "'),
      Object.assign(document.createElement('b'), { textContent: entry.heard }),
      document.createTextNode('" (' + entry.count + 'x)')
    );
    row.appendChild(pair);

    const addBtn = document.createElement('button');
    addBtn.className = 'del-btn';
    addBtn.style.color = 'var(--sage)';
    addBtn.textContent = 'Add to bank';
    addBtn.onclick = () => {
      state.wordBank[normalize(entry.heard)] = {
        correct: entry.target,
        count: MASTERY_THRESHOLD,
        active: true
      };
      save('word_bank', state.wordBank);
      delete state.attemptLog[attemptKey(entry.target, entry.heard)];
      save('attempt_log', state.attemptLog);
      renderAll();
    };
    row.appendChild(addBtn);
    container.appendChild(row);
  });
}

// ---------- How she says her words ----------

/**
 * Explain what a typed spelling will actually key to. A one-character key
 * collides with a lot of ordinary speech ("a", "oh", "I"), so the parent
 * should know before relying on it.
 */
function describeSpelling(spelling) {
  const keys = phoneticKeys(spelling);
  if (!keys.length) return { text: '', warn: false };
  if (isWeakSpelling(spelling)) {
    return {
      warn: true,
      text:
        'Heads up: “' +
        spelling +
        '” sounds like a lot of ordinary words (a, oh, I), so it will match loosely. ' +
        'Adding a consonant closer to how she says it makes it sharper.'
    };
  }
  return { warn: false, text: 'Sounds like: ' + keys.join(' or ') };
}

function setNote(id, spelling) {
  const el = document.getElementById(id);
  if (!el) return;
  const { text, warn } = spelling ? describeSpelling(spelling) : { text: '', warn: false };
  el.textContent = text;
  el.className = 'phonic-note' + (warn ? ' warn' : '');
}

export function renderPhonicList() {
  const list = document.getElementById('phonicList');
  if (!list) return;
  const entries = phonicEntries();

  if (entries.length === 0) {
    list.innerHTML =
      '<div class="empty-note">Nothing recorded yet — add a word above, or use “Teach how she says it” during Practice.</div>';
    return;
  }

  list.innerHTML = '';
  entries.forEach(([, entry]) => {
    const row = document.createElement('div');
    row.className = 'phonic-row';

    const head = document.createElement('div');
    head.className = 'head';
    const word = document.createElement('div');
    word.className = 'word';
    word.textContent = entry.word;
    const right = document.createElement('div');
    const keys = document.createElement('span');
    keys.className = 'keys';
    keys.textContent = entry.keys.join(' · ');
    keys.title = 'Double Metaphone keys these spellings produce';
    const remove = document.createElement('button');
    remove.className = 'del-btn';
    remove.style.marginLeft = '10px';
    remove.textContent = 'Remove';
    remove.onclick = () => {
      removePhonicEntry(entry.word);
      save('phonic_bank', state.phonicBank);
      renderAll();
    };
    right.append(keys, remove);
    head.append(word, right);
    row.appendChild(head);

    const spellings = document.createElement('div');
    spellings.className = 'spellings';
    entry.spellings.forEach((spelling) => {
      const chip = document.createElement('span');
      chip.className = 'spelling';
      chip.appendChild(document.createTextNode(spelling));
      if (isWeakSpelling(spelling)) {
        chip.title = 'This spelling matches loosely — it sounds like many common words.';
        chip.style.borderColor = 'var(--amber-dim)';
      }
      const drop = document.createElement('button');
      drop.textContent = '×';
      drop.title = 'Remove this spelling';
      drop.onclick = () => {
        removeSpelling(entry.word, spelling);
        save('phonic_bank', state.phonicBank);
        renderAll();
      };
      chip.appendChild(drop);
      spellings.appendChild(chip);
    });

    const add = document.createElement('button');
    add.className = 'add-spelling';
    add.textContent = '+ another way she says it';
    add.onclick = () => {
      const spelling = window.prompt('Another way she says “' + entry.word + '”:');
      if (!spelling) return;
      if (addSpelling(entry.word, spelling)) {
        save('phonic_bank', state.phonicBank);
        renderAll();
      }
    };
    spellings.appendChild(add);
    row.appendChild(spellings);
    list.appendChild(row);
  });
}

// ---------- Her accent ----------

export function renderSpeechLang() {
  const select = document.getElementById('speechLang');
  if (!select) return;
  if (!select.options.length) {
    SPEECH_LANGS.forEach(({ code, label }) => {
      select.appendChild(new Option(label + '  ·  ' + code, code));
    });
  }
  select.value = state.speechLang;
  document.getElementById('speechLangNote').textContent =
    'Listening for ' + state.speechLang + ', and reading words out in the same accent.';
}

// ---------- Import / export ----------

function exportBank() {
  const payload = {
    word_bank: state.wordBank,
    verified_words: state.verifiedWords,
    confirm_counts: state.confirmCounts,
    sentence_progress: state.sentenceProgress,
    reading_passage: state.readingPassage,
    reading_progress: state.readingProgress,
    phonic_bank: state.phonicBank,
    speech_lang: state.speechLang
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'word-bank-export.json';
  link.click();
  // Revoked on the next tick — Safari can abort the download otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function importBank(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.target.result);
    } catch (e) {
      window.alert('That file could not be read.');
      return;
    }
    if (data.word_bank) {
      state.wordBank = { ...state.wordBank, ...data.word_bank };
      save('word_bank', state.wordBank);
    }
    if (data.verified_words) {
      state.verifiedWords = [...new Set([...state.verifiedWords, ...data.verified_words])];
      save('verified_words', state.verifiedWords);
    }
    if (data.confirm_counts) {
      state.confirmCounts = { ...state.confirmCounts, ...data.confirm_counts };
      save('confirm_counts', state.confirmCounts);
    }
    if (data.sentence_progress) {
      state.sentenceProgress = { ...state.sentenceProgress, ...data.sentence_progress };
      save('sentence_progress', state.sentenceProgress);
    }
    if (data.reading_passage) {
      state.readingPassage = data.reading_passage;
      state.readingSentences = parsePassage(state.readingPassage);
      save('reading_passage', state.readingPassage);
    }
    if (data.reading_progress) {
      state.readingProgress = { ...state.readingProgress, ...data.reading_progress };
      save('reading_progress', state.readingProgress);
    }
    if (data.phonic_bank) {
      state.phonicBank = { ...state.phonicBank, ...data.phonic_bank };
      save('phonic_bank', state.phonicBank);
    }
    if (data.speech_lang && SPEECH_LANGS.some((l) => l.code === data.speech_lang)) {
      state.speechLang = data.speech_lang;
      save('speech_lang', state.speechLang);
    }
    buildQueue();
    renderAll();
    window.alert('Imported successfully.');
  };
  reader.readAsText(file);
}

// ---------- Wiring ----------

export function initBank() {
  document.getElementById('bankSearch').addEventListener('input', renderBankList);

  document.getElementById('manualAddBtn').addEventListener('click', () => {
    const rawEl = document.getElementById('manualRaw');
    const correctEl = document.getElementById('manualCorrect');
    const raw = rawEl.value.trim();
    const correct = correctEl.value.trim();
    if (!raw || !correct) return;
    state.wordBank[normalize(raw)] = {
      correct,
      count: MASTERY_THRESHOLD,
      active: true
    };
    save('word_bank', state.wordBank);
    rawEl.value = '';
    correctEl.value = '';
    renderAll();
  });

  const phonicWordEl = document.getElementById('phonicWord');
  const phonicSpellingEl = document.getElementById('phonicSpelling');

  phonicSpellingEl.addEventListener('input', () =>
    setNote('phonicAddNote', phonicSpellingEl.value.trim())
  );

  document.getElementById('phonicAddBtn').addEventListener('click', () => {
    const word = phonicWordEl.value.trim();
    const spelling = phonicSpellingEl.value.trim();
    if (!word || !spelling) return;
    if (!addSpelling(word, spelling)) {
      setNote('phonicAddNote', spelling);
      return;
    }
    save('phonic_bank', state.phonicBank);
    phonicWordEl.value = '';
    phonicSpellingEl.value = '';
    setNote('phonicAddNote', '');
    renderAll();
  });

  document.getElementById('speechLang').addEventListener('change', (e) => {
    state.speechLang = e.target.value;
    save('speech_lang', state.speechLang);
    renderAll();
  });

  document.getElementById('exportBtn').addEventListener('click', exportBank);

  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importBank(file);
    e.target.value = '';
  });

  onRender(renderBankList);
  onRender(renderAttemptLog);
  onRender(renderPhonicList);
  onRender(renderSpeechLang);
}

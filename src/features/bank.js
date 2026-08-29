import { MASTERY_THRESHOLD } from '../config.js';
import { normalize, parsePassage } from '../lib/text.js';
import { state, save, onRender, renderAll } from '../lib/store.js';
import { getBankEntry } from '../lib/wordbank.js';
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

// ---------- Import / export ----------

function exportBank() {
  const payload = {
    word_bank: state.wordBank,
    verified_words: state.verifiedWords,
    confirm_counts: state.confirmCounts,
    sentence_progress: state.sentenceProgress,
    reading_passage: state.readingPassage,
    reading_progress: state.readingProgress
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

  document.getElementById('exportBtn').addEventListener('click', exportBank);

  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importBank(file);
    e.target.value = '';
  });

  onRender(renderBankList);
  onRender(renderAttemptLog);
}

import {
  MASTERY_THRESHOLD, SPEECH_LANGS,
  SPEECH_RATE_DEFAULT, SPEECH_RATE_MIN, SPEECH_RATE_MAX, SPEECH_RATE_STEP
} from '../config.js';
import { speak, voicesForLang, isUpgradedVoice, onVoicesReady } from '../lib/speech.js';
import { normalize, parsePassage } from '../lib/text.js';
import { state, save, onRender, renderAll } from '../lib/store.js';
import { getBankEntry } from '../lib/wordbank.js';
import {
  phonicEntries,
  addSpelling,
  removeSpelling,
  removePhonicEntry
} from '../lib/phonicbank.js';
import { alreadyRecognised } from '../lib/phonicbank.js';
import { describeWeakSpelling } from '../lib/collisions.js';
import { practiceWord } from './practice.js';
import { activateTab } from './tabs.js';
import { isWeakSpelling, phoneticKeys } from '../lib/phonetics.js';
import { readCorrectionLog, clearCorrectionLog } from '../lib/correction-log.js';
import { getStoredFamilyCode, saveFamilyCode } from '../lib/family-code.js';
import { CORRECTION_LOG_LIMIT } from '../config.js';
import { bindMic } from './mic.js';
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
    row.className = 'bank-row' + (entry.active ? '' : ' pending');

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
      note.className = 'pending-note';
      note.textContent = ' — needs confirming';
      pair.appendChild(note);
    }
    row.appendChild(pair);

    const buttons = document.createElement('div');
    if (!entry.active) {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'del-btn affirm';
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
    row.className = 'bank-row' + (entry.active ? '' : ' pending');

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
    addBtn.className = 'del-btn affirm';
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

/** An amber block, not a tint and not a tooltip. */
function warnBlock({ heading, body }) {
  const block = document.createElement('div');
  block.className = 'warn-block';
  const icon = document.createElement('span');
  icon.className = 'warn-icon';
  icon.textContent = '\u26a0';
  const text = document.createElement('span');
  text.append(
    Object.assign(document.createElement('b'), { textContent: heading + ' ' }),
    document.createTextNode(body)
  );
  block.append(icon, text);
  return block;
}

/** Plain informational note under the add form. */
function showNote(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  el.className = 'phonic-note';
  if (text) el.textContent = text;
}

/** The same area, carrying an amber warning block instead. */
function showWarning(id, description) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  el.className = 'phonic-note';
  el.appendChild(warnBlock(description));
}

/** Describe whatever is currently in the spelling box. */
function describeTypedSpelling() {
  const spelling = document.getElementById('phonicSpelling').value.trim();
  if (!spelling) return showNote('phonicAddNote', '');
  const keys = phoneticKeys(spelling);
  if (!keys.length) return showNote('phonicAddNote', '');
  if (isWeakSpelling(spelling)) return showWarning('phonicAddNote', describeWeakSpelling(spelling));
  showNote('phonicAddNote', 'Sounds like: ' + keys.join(' or '));
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
    const practise = document.createElement('button');
    practise.className = 'practice-this';
    practise.textContent = 'Practice this word';
    practise.onclick = () => {
      practiceWord(entry.word);
      activateTab('practice');
    };

    const remove = document.createElement('button');
    remove.className = 'del-btn';
    remove.style.marginLeft = '10px';
    remove.textContent = 'Remove';
    remove.onclick = () => {
      removePhonicEntry(entry.word);
      save('phonic_bank', state.phonicBank);
      renderAll();
    };
    right.append(keys, practise, remove);
    head.append(word, right);
    row.appendChild(head);

    const spellings = document.createElement('div');
    spellings.className = 'spellings';
    entry.spellings.forEach((spelling) => {
      const chip = document.createElement('span');
      chip.className = 'spelling';
      chip.appendChild(document.createTextNode(spelling));
      if (isWeakSpelling(spelling)) chip.classList.add('loose');
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

    // Shown on the entry, permanently. The previous version put this in a
    // title attribute, which a touchscreen has no way to reach, and cleared
    // the form's warning on save — so the one moment it mattered showed
    // nothing at all.
    entry.spellings.filter(isWeakSpelling).forEach((spelling) => {
      row.appendChild(warnBlock(describeWeakSpelling(spelling)));
    });

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

// ---------- How it reads to her ----------

/** A sentence with some shape to it, so a speed is judged on real speech. */
const RATE_SAMPLE = 'The quick brown fox jumped over the lazy dog.';

export function renderSpeechRate() {
  const slider = document.getElementById('speechRate');
  if (!slider) return;
  slider.min = String(SPEECH_RATE_MIN);
  slider.max = String(SPEECH_RATE_MAX);
  slider.step = String(SPEECH_RATE_STEP);
  slider.value = String(state.speechRate);
  document.getElementById('speechRateNote').textContent = describeRate(state.speechRate);
}

function describeRate(rate) {
  const how = rate < SPEECH_RATE_DEFAULT ? 'Slower than normal'
    : rate > SPEECH_RATE_DEFAULT ? 'Faster than normal'
      : 'Normal speed';
  return how + ' (' + rate.toFixed(1) + '\u00d7). Used everywhere the app reads out loud.';
}

/**
 * The voices this device has for her accent.
 *
 * Only ever what the browser reports: the app cannot install a voice, and
 * pretending otherwise would be a dead end. When none of them is one of the
 * better ones, the note says where to get one — that is the whole reason the
 * picker is worth having, because the built-in iPad voice is what made her ask.
 */
export function renderSpeechVoice() {
  const select = document.getElementById('speechVoice');
  const note = document.getElementById('speechVoiceNote');
  if (!select || !note) return;

  const voices = voicesForLang(state.speechLang);
  select.innerHTML = '';
  select.appendChild(new Option('The one this device picks', ''));
  voices.forEach((voice) => {
    const label = voice.name + (isUpgradedVoice(voice) ? '  \u00b7  better quality' : '');
    select.appendChild(new Option(label, voice.name));
  });

  // A voice chosen on another device that is not installed here: shown, so the
  // setting does not look as though it silently forgot itself.
  const missing = state.speechVoice && !voices.some((v) => v.name === state.speechVoice);
  if (missing) select.appendChild(new Option(state.speechVoice + '  \u00b7  not on this device', state.speechVoice));
  select.value = state.speechVoice;

  if (!voices.length) {
    note.textContent = 'This device has not told the app about any voices yet. ' +
      'If this stays empty, it has none for ' + state.speechLang + '.';
    return;
  }
  if (missing) {
    note.textContent = '\u201c' + state.speechVoice + '\u201d is not installed here, so this ' +
      'device reads in its own voice. Her other devices are unaffected.';
    return;
  }
  note.textContent = voices.some(isUpgradedVoice)
    ? 'The ones marked better quality are the downloaded voices \u2014 they sound far less robotic.'
    : 'Only the built-in voice is here, which is the robotic one. On an iPad, better ones are a ' +
      'free download: Settings \u203a Accessibility \u203a Spoken Content \u203a Voices. ' +
      'Download an Enhanced or Premium voice and it will appear in this list.';
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
    speech_lang: state.speechLang,
    speech_rate: state.speechRate,
    speech_voice: state.speechVoice,
    context_log: state.contextLog
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
    const rate = Number(data.speech_rate);
    if (Number.isFinite(rate) && rate >= SPEECH_RATE_MIN && rate <= SPEECH_RATE_MAX) {
      state.speechRate = rate;
      save('speech_rate', rate);
    }
    if (typeof data.speech_voice === 'string') {
      state.speechVoice = data.speech_voice;
      save('speech_voice', state.speechVoice);
    }
    if (Array.isArray(data.context_log)) {
      // Newest first on both sides; entries already here are not repeated.
      const known = new Set(state.contextLog.map((entry) => entry.id));
      const incoming = data.context_log.filter((entry) => entry && !known.has(entry.id));
      state.contextLog = [...state.contextLog, ...incoming]
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, CORRECTION_LOG_LIMIT);
      save('context_log', state.contextLog);
    }
    buildQueue();
    renderAll();
    window.alert('Imported successfully.');
  };
  reader.readAsText(file);
}

// ---------- Wiring ----------

/**
 * @param {object} [options]
 * @param {() => void} [options.reload] how to restart the app after the family
 *   code changes — firestore.js reads the code once, on connect, so a switch is
 *   a reload. Injectable so a test can see the switch without navigating.
 */
export function initBank({ reload = () => window.location.reload() } = {}) {
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

  phonicSpellingEl.addEventListener('input', describeTypedSpelling);

  document.getElementById('phonicAddBtn').addEventListener('click', () => {
    const word = phonicWordEl.value.trim();
    const spelling = phonicSpellingEl.value.trim();
    if (!word || !spelling) return;
    if (!addSpelling(word, spelling)) {
      describeTypedSpelling();
      return;
    }
    save('phonic_bank', state.phonicBank);
    phonicWordEl.value = '';
    phonicSpellingEl.value = '';
    // Clearing the form note is safe now: the saved entry carries the warning.
    showNote('phonicAddNote', '');
    renderAll();
  });

  // Capture a pronunciation from her voice rather than spelling it out by
  // hand. Same gate as "Teach how she says it" in Practice: only worth saving
  // when the output is not already understood as the word.
  bindMic({
    buttonId: 'phonicMic',
    labelId: 'phonicMicLabel',
    mode: 'word',
    expected: () => phonicWordEl.value.trim(),
    canListen: () => Boolean(phonicWordEl.value.trim()),
    onBlocked: () =>
      showNote('phonicAddNote', 'Type the word first, then tap — it needs to know what she is saying.'),
    onResult: (heard) => {
      const word = phonicWordEl.value.trim();
      if (!word) return;
      if (alreadyRecognised(word, heard)) {
        showNote(
          'phonicAddNote',
          'Heard “' + heard + '”, which already comes through as “' + word + '”. Nothing to record.'
        );
        return;
      }
      phonicSpellingEl.value = heard;
      describeTypedSpelling();
      const el = document.getElementById('phonicAddNote');
      el.prepend(
        Object.assign(document.createElement('div'), {
          textContent: 'Heard “' + heard + '” — tap Add to save it as how she says “' + word + '”.',
          style: 'margin-bottom:6px;'
        })
      );
    }
  });

  document.getElementById('speechLang').addEventListener('change', (e) => {
    state.speechLang = e.target.value;
    save('speech_lang', state.speechLang);
    // The voices on offer are per accent, so the list is now wrong; a voice
    // that does not belong to the new accent is dropped rather than left to
    // read her Australian words in an American one.
    if (state.speechVoice &&
        !voicesForLang(state.speechLang).some((v) => v.name === state.speechVoice)) {
      state.speechVoice = '';
      save('speech_voice', '');
    }
    renderAll();
  });

  const rate = document.getElementById('speechRate');
  // `input`, not `change`: the number under the thumb should mean something
  // while it is being dragged. Each step saves, which is a handful of writes
  // for one drag and the same shape of write the accent already makes.
  rate.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value)) return;
    state.speechRate = value;
    save('speech_rate', value);
    document.getElementById('speechRateNote').textContent = describeRate(value);
  });
  document.getElementById('speechRateTry').addEventListener('click', () => speak(RATE_SAMPLE));

  document.getElementById('speechVoice').addEventListener('change', (e) => {
    state.speechVoice = e.target.value;
    save('speech_voice', state.speechVoice);
    renderSpeechVoice();
  });
  document.getElementById('speechVoiceTry').addEventListener('click', () => speak(RATE_SAMPLE));

  // getVoices() is empty on the first call in most browsers and fills in
  // later, so the picker is built again once the list arrives.
  onVoicesReady(renderSpeechVoice);

  document.getElementById('exportBtn').addEventListener('click', exportBank);

  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importBank(file);
    e.target.value = '';
  });

  document.getElementById('clearContextLog').addEventListener('click', () => {
    clearCorrectionLog();
    renderContextLog();
  });

  bindFamilyCode(reload);

  onRender(renderBankList);
  onRender(renderAttemptLog);
  onRender(renderPhonicList);
  onRender(renderSpeechLang);
  onRender(renderSpeechRate);
  onRender(renderSpeechVoice);
  onRender(renderContextLog);
}

// ---------- Family code ----------

/**
 * Show the code this device is using, and let it be changed in place.
 *
 * The parent's decision. Until now, moving a device to another code meant
 * clearing Safari's website data, which is how a teacher would have had to set
 * up a school iPad and how the parent would have had to leave a short code
 * behind. Storage is exactly the entry screen's — same key, same
 * normalisation, same refusal of a code with nothing in it — so the device
 * ends up in the state it would be in had that code been typed on first open.
 */
function bindFamilyCode(reload) {
  const input = document.getElementById('familyCodeInput');
  const note = document.getElementById('familyCodeNote');
  const button = document.getElementById('familyCodeBtn');
  if (!input || !note || !button) return;

  renderFamilyCode();

  const attempt = () => {
    const before = getStoredFamilyCode();
    const typed = input.value;
    if (!typed.trim()) {
      note.textContent = 'Type the code to switch to.';
      input.focus();
      return;
    }
    const code = saveFamilyCode(typed);
    if (!code) {
      // saveFamilyCode stores nothing in this case, so the device keeps the
      // code it had.
      note.textContent = 'Use letters and numbers — for example, harlie-home.';
      input.focus();
      return;
    }
    if (code === before) {
      note.textContent = 'This device is already using “' + code + '”.';
      return;
    }
    // Stored. Firestore reads the code once when it connects, so the switch
    // itself is a restart — say so, because the screen is about to go blank.
    note.textContent = 'Switching to “' + code + '”…';
    button.disabled = true;
    reload();
  };

  button.addEventListener('click', attempt);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      attempt();
    }
  });
}

export function renderFamilyCode() {
  const el = document.getElementById('familyCodeCurrent');
  if (!el) return;
  const code = getStoredFamilyCode();
  el.textContent = code ? '“' + code + '”' : '(none)';
}

/**
 * What Claude changed in Speech-To-Text, newest first.
 *
 * Built with DOM nodes rather than markup, like the bank list: every value here
 * is text a recogniser produced or a model returned, and none of it is ever
 * treated as HTML.
 */
export function renderContextLog() {
  const view = document.getElementById('contextLogView');
  if (!view) return;
  const entries = readCorrectionLog();

  view.innerHTML = '';
  if (!entries.length) {
    view.append(
      Object.assign(document.createElement('span'), {
        className: 'empty-note',
        textContent: 'Nothing changed yet.'
      })
    );
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'ctx-row';

    const heading = document.createElement('div');
    heading.append(
      Object.assign(document.createElement('b'), { textContent: '“' + entry.from + '”' }),
      document.createTextNode(' → '),
      Object.assign(document.createElement('b'), { textContent: '“' + entry.to + '”' })
    );
    if (entry.reverted) {
      heading.append(
        document.createTextNode(' '),
        Object.assign(document.createElement('span'), {
          className: 'ctx-undone',
          textContent: '— you put it back'
        })
      );
    }
    row.append(heading);

    if (entry.reason) {
      row.append(
        Object.assign(document.createElement('span'), {
          className: 'ctx-reason',
          textContent: entry.reason
        })
      );
    }
    view.append(row);
  });
}

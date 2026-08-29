import { MASTERY_THRESHOLD, REQUEUE_GAP, ATTEMPT_LOG_LIMIT } from '../config.js';
import { PRACTICE_WORDS } from '../data/practice-words.js';
import { normalize, shuffle } from '../lib/text.js';
import { state, save, onRender, renderAll } from '../lib/store.js';
import { getBankEntry, recordBankObservation } from '../lib/wordbank.js';
import { soundsLikeHerWord, addSpelling } from '../lib/phonicbank.js';
import { isWeakSpelling, phoneticKeys } from '../lib/phonetics.js';
import { speak } from '../lib/speech.js';
import { bindMic, MIC_IDLE } from './mic.js';
import { renderProgress } from './progress.js';
import { countAttempt, renderSession } from './session.js';

// ---------- Queue ----------

export function buildQueue() {
  const mastered = new Set(state.verifiedWords.map(normalize));
  state.practiceQueue = shuffle(PRACTICE_WORDS.filter((w) => !mastered.has(normalize(w))));
}

/**
 * Live sync means a Firestore update fires after every attempt (including our
 * own). Rebuilding the queue from scratch each time would discard the
 * spaced-repeat positions set in registerConfirm — this just drops
 * newly-mastered words without disturbing the order, so a word requeued a few
 * turns out actually stays a few turns out.
 */
export function reconcileQueue() {
  const mastered = new Set(state.verifiedWords.map(normalize));
  state.practiceQueue = state.practiceQueue.filter((w) => !mastered.has(normalize(w)));
  const queued = new Set(state.practiceQueue.map(normalize));
  PRACTICE_WORDS.forEach((w) => {
    const key = normalize(w);
    if (!mastered.has(key) && !queued.has(key)) state.practiceQueue.push(w);
  });
}

// ---------- Attempt log ----------

export function attemptKey(target, heard) {
  return normalize(target) + '|||' + normalize(heard);
}

function logAttempt(target, heard) {
  const key = attemptKey(target, heard);
  const existing = state.attemptLog[key];
  state.attemptLog[key] = {
    target,
    heard,
    count: (existing ? existing.count : 0) + 1,
    lastSeen: new Date().toISOString()
  };
  const keys = Object.keys(state.attemptLog);
  if (keys.length > ATTEMPT_LOG_LIMIT) {
    keys.sort((a, b) => new Date(state.attemptLog[a].lastSeen) - new Date(state.attemptLog[b].lastSeen));
    delete state.attemptLog[keys[0]];
  }
  return save('attempt_log', state.attemptLog);
}

// ---------- Rendering ----------

function renderRepeatDots(word) {
  const count = state.confirmCounts[normalize(word)] || 0;
  const el = document.getElementById('repeatDots');
  el.innerHTML = '';
  for (let i = 0; i < MASTERY_THRESHOLD; i++) {
    const dot = document.createElement('div');
    dot.className = 'repeat-dot' + (i < count ? ' filled' : '');
    el.appendChild(dot);
  }
}

/**
 * Hide the "Heard" box. Kept separate from renderPracticeWord so a background
 * Firestore snapshot can refresh the screen without yanking the confirmation
 * buttons out from under whoever is mid-decision.
 */
export function clearHeard() {
  document.getElementById('heardBox').classList.remove('show');
}

export function renderPracticeWord() {
  if (state.practiceQueue.length === 0) {
    document.getElementById('targetWord').textContent = '🎉 All done!';
    document.getElementById('practiceMic').style.display = 'none';
    document.getElementById('speakWordBtn').style.display = 'none';
    document.getElementById('practiceMicLabel').textContent = 'Every word has been mastered.';
    document.getElementById('repeatDots').innerHTML = '';
    return;
  }

  document.getElementById('practiceMic').style.display = 'block';
  document.getElementById('speakWordBtn').style.display = 'flex';
  document.getElementById('practiceMicLabel').textContent = MIC_IDLE;
  const word = state.practiceQueue[0];
  document.getElementById('targetWord').textContent = word;
  renderRepeatDots(word);
}

// ---------- Attempt handling ----------

function registerConfirm(word) {
  const key = normalize(word);
  state.confirmCounts[key] = (state.confirmCounts[key] || 0) + 1;
  countAttempt();

  let justMastered = false;
  if (state.confirmCounts[key] >= MASTERY_THRESHOLD) {
    if (!state.verifiedWords.map(normalize).includes(key)) {
      state.verifiedWords.push(word);
      justMastered = true;
    }
    state.practiceQueue.shift();
  } else {
    const word_ = state.practiceQueue.shift();
    const insertAt = Math.min(REQUEUE_GAP, state.practiceQueue.length);
    state.practiceQueue.splice(insertAt, 0, word_);
  }

  // Update the screen immediately — don't make her wait on a network
  // round-trip before she can see (or hear) the next word.
  clearHeard();
  closePhonicQuick();
  renderProgress();
  renderSession();
  renderPracticeWord();

  // Persist in the background.
  save('confirm_counts', state.confirmCounts);
  if (justMastered) save('verified_words', state.verifiedWords);
}

function handlePracticeResult(heard) {
  const target = state.practiceQueue[0];
  if (!target) return;

  const heardKey = normalize(heard);
  const targetKey = normalize(target);
  const entry = getBankEntry(heardKey);
  const isDirectMatch = heardKey === targetKey;
  const isKnownPronunciation = Boolean(
    entry && entry.active && normalize(entry.correct) === targetKey
  );

  document.getElementById('heardBox').classList.add('show');
  const heardTextEl = document.getElementById('heardText');
  heardTextEl.textContent = '"' + heard + '"';
  heardTextEl.className =
    'heard-text ' + (isDirectMatch || isKnownPronunciation ? 'match-yes' : 'match-no');

  const actions = document.getElementById('matchActions');
  actions.innerHTML = '';

  if (isDirectMatch || isKnownPronunciation) {
    heardTextEl.textContent += isDirectMatch
      ? '  ✓ matched'
      : '  ✓ matches her known pronunciation';
    setTimeout(() => registerConfirm(target), 700);
    return;
  }

  // A phonetic hit is a strong suggestion, never a silent pass. Double
  // Metaphone over-matches (see src/lib/phonetics.js), so this stops at
  // telling the parent what it thinks and letting them say yes — which also
  // banks the exact text, so the precise correction accumulates towards
  // going active on its own.
  const soundsRight = soundsLikeHerWord(target, heard);
  if (soundsRight) {
    heardTextEl.className = 'heard-text match-close';
    heardTextEl.textContent += '  ≈ sounds like how she says it';
  }

  logAttempt(target, heard);
  renderAll();

  const bankBtn = document.createElement('button');
  bankBtn.className = 'btn btn-primary';
  if (soundsRight) {
    bankBtn.textContent = "Yes — that's her saying it";
  } else {
    bankBtn.textContent =
      entry && !entry.active ? "Yes, that's her word again — confirm it" : "That's her word — bank it";
  }
  bankBtn.onclick = () => {
    recordBankObservation(heardKey, target);
    save('word_bank', state.wordBank);
    delete state.attemptLog[attemptKey(target, heard)];
    save('attempt_log', state.attemptLog);
    registerConfirm(target);
    renderAll();
  };

  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn btn-ghost';
  retryBtn.textContent = 'Try again';
  retryBtn.onclick = () => {
    clearHeard();
    closePhonicQuick();
  };

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn btn-outline';
  skipBtn.textContent = 'Skip';
  skipBtn.onclick = () => {
    state.practiceQueue.push(state.practiceQueue.shift());
    clearHeard();
    closePhonicQuick();
    renderPracticeWord();
  };

  actions.append(bankBtn, retryBtn, skipBtn);

  // The moment the parent is best placed to record a pronunciation is right
  // after hearing her say it, so offer it here rather than only in Word Bank.
  if (!soundsRight) {
    const teachBtn = document.createElement('button');
    teachBtn.className = 'btn btn-outline';
    teachBtn.textContent = 'Teach how she says it';
    teachBtn.onclick = () => openPhonicQuick(target, heard);
    actions.appendChild(teachBtn);
  }
}

// ---------- "Teach how she says it" ----------

function openPhonicQuick(word, prefill) {
  const panel = document.getElementById('phonicQuick');
  panel.dataset.word = word;
  document.getElementById('phonicQuickWord').textContent = word;
  const input = document.getElementById('phonicQuickInput');
  input.value = prefill || '';
  panel.classList.add('show');
  updatePhonicQuickNote();
  input.focus();
  input.select();
}

function closePhonicQuick() {
  const panel = document.getElementById('phonicQuick');
  panel.classList.remove('show');
  panel.dataset.word = '';
  document.getElementById('phonicQuickNote').textContent = '';
}

function updatePhonicQuickNote() {
  const spelling = document.getElementById('phonicQuickInput').value.trim();
  const note = document.getElementById('phonicQuickNote');
  if (!spelling) {
    note.textContent = '';
    note.className = 'phonic-note';
    return;
  }
  const weak = isWeakSpelling(spelling);
  note.className = 'phonic-note' + (weak ? ' warn' : '');
  note.textContent = weak
    ? 'Heads up: “' +
      spelling +
      '” sounds like a lot of ordinary words (a, oh, I), so it will match loosely.'
    : 'Sounds like: ' + phoneticKeys(spelling).join(' or ');
}

// ---------- Wiring ----------

export function initPractice() {
  document.getElementById('speakWordBtn').addEventListener('click', () => {
    const word = state.practiceQueue[0];
    if (word) speak(word);
  });

  bindMic({
    buttonId: 'practiceMic',
    labelId: 'practiceMicLabel',
    canListen: () => state.practiceQueue.length > 0,
    onResult: handlePracticeResult
  });

  document.getElementById('skipWord').addEventListener('click', () => {
    if (state.practiceQueue.length) {
      state.practiceQueue.push(state.practiceQueue.shift());
      clearHeard();
      renderPracticeWord();
    }
  });

  document.getElementById('resetProgress').addEventListener('click', () => {
    if (!window.confirm("Reset practice queue order? This won't remove mastered words or her bank.")) {
      return;
    }
    buildQueue();
    clearHeard();
    renderPracticeWord();
  });

  const quickInput = document.getElementById('phonicQuickInput');
  quickInput.addEventListener('input', updatePhonicQuickNote);
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('phonicQuickSave').click();
    if (e.key === 'Escape') closePhonicQuick();
  });

  document.getElementById('phonicQuickSave').addEventListener('click', () => {
    const panel = document.getElementById('phonicQuick');
    const word = panel.dataset.word;
    const spelling = quickInput.value.trim();
    if (!word || !spelling) return;
    if (addSpelling(word, spelling)) {
      save('phonic_bank', state.phonicBank);
    }
    closePhonicQuick();
    renderAll();
  });

  document.getElementById('phonicQuickCancel').addEventListener('click', closePhonicQuick);

  onRender(renderPracticeWord);
}

import { state, save, onRender, renderAll } from '../lib/store.js';
import { applyBankToText, recordBankObservation, getBankEntry } from '../lib/wordbank.js';
import { suggestFromSound } from '../lib/phonicbank.js';
import { normalize } from '../lib/text.js';
import { bindMic } from './mic.js';
import { activateTab } from './tabs.js';

function showWriteNote(text) {
  const note = document.getElementById('writeNote');
  if (note) note.textContent = text || '';
}

/**
 * Accept a suggestion. This is the same evidence a confirmation in Practice
 * gives — one sighting of "this text means that word" — so it goes through the
 * same pending-then-active path rather than applying outright.
 */
function acceptSuggestion(rawKey, word) {
  recordBankObservation(rawKey, word);
  save('word_bank', state.wordBank);
  const entry = getBankEntry(rawKey);
  showWriteNote(
    entry && entry.active
      ? 'Confirmed — “' + rawKey + '” now reads as “' + word + '” on its own.'
      : 'Noted — “' + rawKey + '” means “' + word + '”. One more sighting and it will apply on its own.'
  );
  renderAll();
}

export function renderCorrectedOutput() {
  const input = document.getElementById('rawInput');
  const out = document.getElementById('correctedOutput');
  const text = input ? input.value : '';

  if (!text.trim()) {
    out.innerHTML = '<span class="empty-note">Nothing here yet.</span>';
    return;
  }

  out.innerHTML = '';
  applyBankToText(text).forEach((part) => {
    if (part.raw === '' || /^\s+$/.test(part.raw)) {
      out.appendChild(document.createTextNode(part.raw));
      return;
    }
    const span = document.createElement('span');
    span.textContent = part.display;
    span.dataset.rawKey = part.key;
    span.dataset.original = part.raw;

    // A recorded pronunciation can suggest what a loose word probably was, but
    // never rewrites it. One tap accepts, and that counts as a sighting.
    const suggestion = part.fixed ? null : suggestFromSound(part.raw);
    if (suggestion) {
      span.className = 'wtok suggest';
      span.title = 'Sounds like “' + suggestion + '” — tap to accept';
      span.addEventListener('click', () => acceptSuggestion(normalize(part.raw), suggestion));
    } else {
      span.className = 'wtok' + (part.fixed ? ' fixed' : '');
      span.addEventListener('click', () => openFixPanel(span, false));
    }
    out.appendChild(span);
  });
}

/**
 * Open the correction panel for a word token. Called from Speech-To-Text and, for
 * a mis-read word, from Sentences and Reading — which is why it jumps to the
 * Speech-To-Text tab where the panel lives.
 *
 * @param {HTMLElement} span   the clicked token
 * @param {boolean} fromSentence  prefill with the expected word rather than the
 *                                displayed one
 */
export function openFixPanel(span, fromSentence) {
  const panel = document.getElementById('fixPanel');
  const key = span.dataset.rawKey;
  if (!key) return; // nothing heard here — no correction to attach

  panel.classList.add('show');
  panel.dataset.rawKey = key;
  document.getElementById('fixingWord').textContent =
    '"' + (span.dataset.original || span.textContent) + '"';

  const input = document.getElementById('fixInput');
  input.value = fromSentence ? span.dataset.expected || '' : span.textContent;

  activateTab('write');
  input.focus();
}

export function initFreeWrite() {
  const rawInput = document.getElementById('rawInput');
  rawInput.addEventListener('input', () => {
    showWriteNote('');
    renderCorrectedOutput();
  });

  document.getElementById('cancelFix').addEventListener('click', () => {
    document.getElementById('fixPanel').classList.remove('show');
  });

  document.getElementById('saveFix').addEventListener('click', () => {
    const panel = document.getElementById('fixPanel');
    const key = panel.dataset.rawKey;
    const value = document.getElementById('fixInput').value.trim();
    if (!key || !value) return;
    recordBankObservation(key, value);
    save('word_bank', state.wordBank);
    panel.classList.remove('show');
    renderAll();
  });

  bindMic({
    buttonId: 'writeMic',
    labelId: 'writeMicLabel',
    // Nothing is expected here, so there is no target to hint with and no
    // reason to be impatient about a pause.
    mode: 'freeform',
    onResult: (heard) => {
      rawInput.value = (rawInput.value ? rawInput.value + ' ' : '') + heard;
      renderCorrectedOutput();
    }
  });

  onRender(renderCorrectedOutput);
}

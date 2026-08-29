import { state, save, onRender, renderAll } from '../lib/store.js';
import { applyBankToText, recordBankObservation } from '../lib/wordbank.js';
import { bindMic } from './mic.js';
import { activateTab } from './tabs.js';

export function renderCorrectedOutput() {
  const input = document.getElementById('rawInput');
  const out = document.getElementById('correctedOutput');
  const text = input ? input.value : '';

  if (!text.trim()) {
    out.innerHTML = '<span style="color:var(--ink-dim);">Nothing here yet.</span>';
    return;
  }

  out.innerHTML = '';
  applyBankToText(text).forEach((part) => {
    if (part.raw === '' || /^\s+$/.test(part.raw)) {
      out.appendChild(document.createTextNode(part.raw));
      return;
    }
    const span = document.createElement('span');
    span.className = 'wtok' + (part.fixed ? ' fixed' : '');
    span.textContent = part.display;
    span.dataset.rawKey = part.key;
    span.dataset.original = part.raw;
    span.addEventListener('click', () => openFixPanel(span, false));
    out.appendChild(span);
  });
}

/**
 * Open the correction panel for a word token. Called from Free Write and, for
 * a mis-read word, from Sentences and Reading — which is why it jumps to the
 * Free Write tab where the panel lives.
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
  rawInput.addEventListener('input', renderCorrectedOutput);

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
    onResult: (heard) => {
      rawInput.value = (rawInput.value ? rawInput.value + ' ' : '') + heard;
      renderCorrectedOutput();
    }
  });

  onRender(renderCorrectedOutput);
}

// Teaching the bank a word, from wherever the word was tapped.
//
// One panel for the whole app. Practice, Sentences and Reading all send a
// mis-read word here, and so does every answer on her worksheet — a worksheet
// has several answers, so this could not stay inside one of them.

import { state, save, renderAll } from '../lib/store.js';
import { recordBankObservation } from '../lib/wordbank.js';
import { activateTab } from './tabs.js';

/**
 * Open the correction panel for a word token.
 *
 * Called from her worksheet and, for a mis-read word, from Sentences and
 * Reading — which is why it jumps to the worksheet tab, where the panel lives.
 *
 * @param {HTMLElement} span   the clicked token
 * @param {boolean} fromSentence  prefill with the expected word rather than the
 *                                displayed one
 */
export function openFixPanel(span, fromSentence) {
  const panel = document.getElementById('fixPanel');
  const key = span.dataset.rawKey;
  if (!key || !panel) return; // nothing heard here — no correction to attach

  panel.classList.add('show');
  panel.dataset.rawKey = key;
  document.getElementById('fixingWord').textContent =
    '“' + (span.dataset.original || span.textContent) + '”';

  const input = document.getElementById('fixInput');
  input.value = fromSentence ? span.dataset.expected || '' : span.textContent;

  activateTab('write');
  input.focus();
}

export function initFixPanel() {
  const panel = document.getElementById('fixPanel');
  if (!panel) return;

  document.getElementById('cancelFix').addEventListener('click', () => {
    panel.classList.remove('show');
  });

  document.getElementById('saveFix').addEventListener('click', () => {
    const key = panel.dataset.rawKey;
    const value = document.getElementById('fixInput').value.trim();
    if (!key || !value) return;
    recordBankObservation(key, value);
    save('word_bank', state.wordBank);
    panel.classList.remove('show');
    renderAll();
  });
}

import { SENTENCES } from '../data/sentences.js';
import { state, save, onRender } from '../lib/store.js';
import { bindMic } from './mic.js';
import {
  renderCleanDots,
  renderTargetWords,
  bindSpeaker,
  clearReadOutput,
  renderReadResult,
  appendCleanNote,
  appendSlipNote,
  appendDiscard
} from './reading-engine.js';

function currentSentence() {
  return SENTENCES[state.sentenceIndex] || '';
}

// What the last attempt changed, so "Didn't mean that" can put it back.
let lastAttempt = null;

export function renderSentence() {
  renderTargetWords('targetSentence', currentSentence());
  document.getElementById('sentenceCounter').textContent =
    state.sentenceIndex + 1 + ' / ' + SENTENCES.length;
  renderCleanDots('cleanDots', state.sentenceProgress[state.sentenceIndex] || 0);
}

function goTo(index) {
  state.sentenceIndex = (index + SENTENCES.length) % SENTENCES.length;
  save('sentence_index', state.sentenceIndex);
  lastAttempt = null;
  clearReadOutput('sentenceOutput');
  renderSentence();
}

/** Undo whatever the last attempt scored. Safe to call twice. */
function discardLastAttempt() {
  if (!lastAttempt) return;
  const { index, counted } = lastAttempt;
  lastAttempt = null;
  if (!counted) return;
  state.sentenceProgress[index] = Math.max(0, (state.sentenceProgress[index] || 1) - 1);
  save('sentence_progress', state.sentenceProgress);
  renderCleanDots('cleanDots', state.sentenceProgress[index] || 0);
}

export function handleSentenceResult(heard) {
  const index = state.sentenceIndex;
  const { clean, slips } = renderReadResult('sentenceOutput', currentSentence(), heard);
  lastAttempt = { index, counted: clean };

  if (clean) {
    state.sentenceProgress[index] = (state.sentenceProgress[index] || 0) + 1;
    save('sentence_progress', state.sentenceProgress);
    appendCleanNote('sentenceOutput', state.sentenceProgress[index]);
    renderCleanDots('cleanDots', state.sentenceProgress[index]);
  } else if (slips) {
    appendSlipNote('sentenceOutput', slips);
  }

  // Offered on every attempt, clean or not: the parent heard what happened
  // and the app did not.
  appendDiscard('sentenceOutput', discardLastAttempt);
}

export function initSentences() {
  bindSpeaker({
    buttonId: 'speakSentenceBtn',
    targetId: 'targetSentence',
    getText: currentSentence
  });
  document
    .getElementById('prevSentence')
    .addEventListener('click', () => goTo(state.sentenceIndex - 1));
  document
    .getElementById('nextSentence')
    .addEventListener('click', () => goTo(state.sentenceIndex + 1));

  bindMic({
    buttonId: 'sentenceMic',
    labelId: 'sentenceMicLabel',
    mode: 'sentence',
    expected: currentSentence,
    onResult: handleSentenceResult
  });

  onRender(renderSentence);
}

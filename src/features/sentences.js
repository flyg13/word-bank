import { SENTENCES } from '../data/sentences.js';
import { state, save, onRender } from '../lib/store.js';
import { speak } from '../lib/speech.js';
import { bindMic } from './mic.js';
import {
  renderCleanDots,
  clearReadOutput,
  renderReadResult,
  appendCleanNote
} from './reading-engine.js';

function currentSentence() {
  return SENTENCES[state.sentenceIndex] || '';
}

export function renderSentence() {
  document.getElementById('targetSentence').textContent = currentSentence();
  document.getElementById('sentenceCounter').textContent =
    state.sentenceIndex + 1 + ' / ' + SENTENCES.length;
  renderCleanDots('cleanDots', state.sentenceProgress[state.sentenceIndex] || 0);
}

function goTo(index) {
  state.sentenceIndex = (index + SENTENCES.length) % SENTENCES.length;
  save('sentence_index', state.sentenceIndex);
  clearReadOutput('sentenceOutput');
  renderSentence();
}

function handleSentenceResult(heard) {
  const clean = renderReadResult('sentenceOutput', currentSentence(), heard);
  if (!clean) return;

  const index = state.sentenceIndex;
  state.sentenceProgress[index] = (state.sentenceProgress[index] || 0) + 1;
  save('sentence_progress', state.sentenceProgress);
  appendCleanNote('sentenceOutput', state.sentenceProgress[index]);
  renderCleanDots('cleanDots', state.sentenceProgress[index]);
}

export function initSentences() {
  document.getElementById('speakSentenceBtn').addEventListener('click', () =>
    speak(currentSentence())
  );
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

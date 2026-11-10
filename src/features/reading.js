import { state, save, onRender } from '../lib/store.js';
import { parsePassage } from '../lib/text.js';
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

// Set while the parent is pasting a replacement passage, so a background
// Firestore snapshot doesn't close the editor mid-paste.
let editingPassage = false;

// What the last attempt changed, so "Didn't mean that" can put it back.
let lastAttempt = null;

function currentLine() {
  return state.readingSentences[state.readingIndex] || '';
}

function hasPassage() {
  return Boolean(state.readingPassage) && state.readingSentences.length > 0;
}

export function renderReading() {
  const showSetup = editingPassage || !hasPassage();
  document.getElementById('readingSetupCard').style.display = showSetup ? 'block' : 'none';
  document.getElementById('readingPracticeCard').style.display = showSetup ? 'none' : 'block';
  if (!hasPassage()) return;

  renderTargetWords('readingTargetSentence', currentLine());
  document.getElementById('readingCounter').textContent =
    state.readingIndex + 1 + ' / ' + state.readingSentences.length;
  renderCleanDots('readingCleanDots', state.readingProgress[state.readingIndex] || 0);
}

function goTo(index) {
  const total = state.readingSentences.length;
  if (!total) return;
  state.readingIndex = (index + total) % total;
  save('reading_index', state.readingIndex);
  lastAttempt = null;
  clearReadOutput('readingOutput');
  renderReading();
}

/** Undo whatever the last attempt scored. Safe to call twice. */
function discardLastAttempt() {
  if (!lastAttempt) return;
  const { index, counted } = lastAttempt;
  lastAttempt = null;
  if (!counted) return;
  state.readingProgress[index] = Math.max(0, (state.readingProgress[index] || 1) - 1);
  save('reading_progress', state.readingProgress);
  renderCleanDots('readingCleanDots', state.readingProgress[index] || 0);
}

export function handleReadingResult(heard) {
  const index = state.readingIndex;
  const { clean, slips } = renderReadResult('readingOutput', currentLine(), heard);
  lastAttempt = { index, counted: clean };

  if (clean) {
    state.readingProgress[index] = (state.readingProgress[index] || 0) + 1;
    save('reading_progress', state.readingProgress);
    appendCleanNote('readingOutput', state.readingProgress[index]);
    renderCleanDots('readingCleanDots', state.readingProgress[index]);
  } else if (slips) {
    appendSlipNote('readingOutput', slips);
  }

  // A passage has the same problem as a sentence: she is holding a line in
  // her head, and the parent is the one who heard what she meant.
  appendDiscard('readingOutput', discardLastAttempt);
}

export function initReading() {
  document.getElementById('saveReadingBtn').addEventListener('click', () => {
    const text = document.getElementById('readingPassageInput').value.trim();
    if (!text) return;
    state.readingPassage = text;
    state.readingSentences = parsePassage(text);
    state.readingProgress = {};
    state.readingIndex = 0;
    save('reading_passage', state.readingPassage);
    save('reading_progress', state.readingProgress);
    save('reading_index', state.readingIndex);
    editingPassage = false;
    clearReadOutput('readingOutput');
    renderReading();
  });

  document.getElementById('editReadingBtn').addEventListener('click', () => {
    document.getElementById('readingPassageInput').value = state.readingPassage;
    editingPassage = true;
    renderReading();
  });

  bindSpeaker({
    buttonId: 'speakReadingBtn',
    targetId: 'readingTargetSentence',
    getText: currentLine
  });
  document
    .getElementById('prevReading')
    .addEventListener('click', () => goTo(state.readingIndex - 1));
  document
    .getElementById('nextReading')
    .addEventListener('click', () => goTo(state.readingIndex + 1));

  bindMic({
    buttonId: 'readingMic',
    labelId: 'readingMicLabel',
    // A line of a passage can be long and can have real pauses inside it, so
    // this is the most patient of the timed modes.
    mode: 'passage',
    expected: currentLine,
    onResult: handleReadingResult
  });

  onRender(renderReading);
}

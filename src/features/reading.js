import { state, save, onRender } from '../lib/store.js';
import { parsePassage } from '../lib/text.js';
import { speak } from '../lib/speech.js';
import { bindMic } from './mic.js';
import {
  renderCleanDots,
  clearReadOutput,
  renderReadResult,
  appendCleanNote
} from './reading-engine.js';

// Set while the parent is pasting a replacement passage, so a background
// Firestore snapshot doesn't close the editor mid-paste.
let editingPassage = false;

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

  document.getElementById('readingTargetSentence').textContent = currentLine();
  document.getElementById('readingCounter').textContent =
    state.readingIndex + 1 + ' / ' + state.readingSentences.length;
  renderCleanDots('readingCleanDots', state.readingProgress[state.readingIndex] || 0);
}

function goTo(index) {
  const total = state.readingSentences.length;
  if (!total) return;
  state.readingIndex = (index + total) % total;
  save('reading_index', state.readingIndex);
  clearReadOutput('readingOutput');
  renderReading();
}

function handleReadingResult(heard) {
  const clean = renderReadResult('readingOutput', currentLine(), heard);
  if (!clean) return;

  const index = state.readingIndex;
  state.readingProgress[index] = (state.readingProgress[index] || 0) + 1;
  save('reading_progress', state.readingProgress);
  appendCleanNote('readingOutput', state.readingProgress[index]);
  renderCleanDots('readingCleanDots', state.readingProgress[index]);
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

  document.getElementById('speakReadingBtn').addEventListener('click', () => {
    const line = currentLine();
    if (line) speak(line);
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

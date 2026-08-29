import './style.css';

import { state, setSaveErrorHandler, setSaver, renderAll } from './lib/store.js';
import { parsePassage } from './lib/text.js';
import { SENTENCES } from './data/sentences.js';
import { speechRecognitionSupported } from './lib/speech.js';

import { initTabs } from './features/tabs.js';
import { initProgress, setSyncStatus } from './features/progress.js';
import { initSession } from './features/session.js';
import { initPractice, buildQueue, reconcileQueue } from './features/practice.js';
import { initSentences } from './features/sentences.js';
import { initReading } from './features/reading.js';
import { initFreeWrite } from './features/freewrite.js';
import { initBank } from './features/bank.js';

let firstSnapshotReceived = false;

/** A stored position can outlive the list it points into. */
function clampIndex(value, length) {
  const index = Number(value) || 0;
  if (!length) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/** Fold a Firestore snapshot into local state. */
function applySnapshot(data) {
  state.wordBank = data.word_bank || {};
  state.verifiedWords = data.verified_words || [];
  state.confirmCounts = data.confirm_counts || {};
  state.sessionLog = data.session_log || [];
  state.sentenceProgress = data.sentence_progress || {};
  state.sentenceIndex = clampIndex(data.sentence_index, SENTENCES.length);
  state.readingPassage = data.reading_passage || '';
  state.readingSentences = state.readingPassage ? parsePassage(state.readingPassage) : [];
  state.readingProgress = data.reading_progress || {};
  state.readingIndex = clampIndex(data.reading_index, state.readingSentences.length);
  state.attemptLog = data.attempt_log || {};

  if (!firstSnapshotReceived) {
    buildQueue();
    firstSnapshotReceived = true;
  } else {
    reconcileQueue();
  }

  renderAll();
}

async function main() {
  if (!speechRecognitionSupported) {
    document.getElementById('unsupportedBanner').classList.add('show');
  }

  initTabs();
  initProgress();
  initSession();
  initPractice();
  initSentences();
  initReading();
  initFreeWrite();
  initBank();

  setSaveErrorHandler(() => setSyncStatus('error', 'Save failed — check connection'));

  // Render an empty shell immediately; real data populates once Firestore's
  // first snapshot arrives.
  buildQueue();
  renderAll();

  // The Firebase SDK is the bulk of the bundle and nothing on screen needs it,
  // so it loads in its own chunk after the shell is up.
  setSyncStatus('', 'Connecting…');
  const { initFirebase, isFirebaseConfigured, saveJSON } = await import('./lib/firestore.js');
  setSaver(saveJSON);

  // Only the "no Firebase project wired up yet" case is a setup problem —
  // a connection failure is a different message, handled by setSyncStatus.
  if (!isFirebaseConfigured()) {
    document.getElementById('setupBanner').classList.add('show');
  }

  await initFirebase(applySnapshot, setSyncStatus);
}

main();

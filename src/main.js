import './style.css';

import { state, setSaveErrorHandler, setSaver, renderAll } from './lib/store.js';
import { foldSnapshot } from './lib/snapshot.js';
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

/** Fold a Firestore snapshot into local state, then redraw. */
function applySnapshot(data) {
  foldSnapshot(state, data);

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

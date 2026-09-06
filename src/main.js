// Self-hosted: a missing font on her reading surface is worse than a slow one.
// Latin subset only — the app is English-only, and the full set drags in
// Cyrillic and Vietnamese faces nothing here will ever render.
import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import '@fontsource/andika/latin-400.css';
import '@fontsource/andika/latin-400-italic.css';
import '@fontsource/andika/latin-700.css';

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
import { requireFamilyCode } from './features/entry.js';

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

  // Ask for the family code before connecting — without one there is no
  // document to sync with, and the shell behind is already usable.
  await requireFamilyCode();

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

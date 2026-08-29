import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { FIREBASE_CONFIG } from '../config.js';

let familyDocRef = null;

/** Whether a real Firebase project has been wired up in src/config.js. */
export function isFirebaseConfigured() {
  return Boolean(FIREBASE_CONFIG.apiKey) && FIREBASE_CONFIG.apiKey !== 'PASTE_YOUR_API_KEY';
}

/**
 * The shared "family code" is the whole multi-device story: every device that
 * types the same code reads and writes the same Firestore document.
 */
export function getFamilyCode() {
  let code = localStorage.getItem('word_bank_family_code');
  if (!code) {
    code = window.prompt(
      'Set up her shared code (make one up, then type this exact same code on ' +
        'every device — Mac, iPad, etc). Letters and numbers only:'
    );
    if (code) {
      code = code.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      localStorage.setItem('word_bank_family_code', code);
    }
  }
  return code;
}

/**
 * Connect to Firestore and start streaming the family document.
 *
 * @param {(data: object) => void} onData    called with every snapshot
 * @param {(state: ''|'connected'|'error', label: string) => void} onStatus
 * @returns {Promise<boolean>} whether sync came up
 */
export async function initFirebase(onData, onStatus) {
  if (!isFirebaseConfigured()) {
    onStatus('error', 'Not connected — setup needed');
    return false;
  }
  try {
    const app = initializeApp(FIREBASE_CONFIG);
    await signInAnonymously(getAuth(app));
    const db = getFirestore(app);

    const code = getFamilyCode();
    if (!code) {
      onStatus('error', 'No family code set');
      return false;
    }

    familyDocRef = doc(db, 'families', code);
    onSnapshot(
      familyDocRef,
      (snap) => {
        onData(snap.data() || {});
        onStatus('connected', 'Synced — code "' + code + '"');
      },
      (err) => {
        console.error(err);
        onStatus('error', 'Sync error — check Firestore rules');
      }
    );
    return true;
  } catch (e) {
    console.error(e);
    onStatus('error', 'Could not connect to Firebase');
    return false;
  }
}

/** Merge a single top-level field into the family document. */
export async function saveJSON(key, value) {
  if (!familyDocRef) return;
  try {
    await setDoc(familyDocRef, { [key]: value }, { merge: true });
  } catch (e) {
    console.error(key, 'save failed', e);
    throw e;
  }
}

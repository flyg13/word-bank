// ---------- Firebase ----------
// From Firebase console > Project settings > Your apps > Web app.
// These values are public by design (they identify the project, they don't
// authorise anything) — access is controlled by Firestore security rules.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA03iZfP-uupMcnO7ZgGwu5qTqXvHDk26E",
  authDomain: "wordbank-fg13.firebaseapp.com",
  projectId: "wordbank-fg13",
  storageBucket: "wordbank-fg13.firebasestorage.app",
  messagingSenderId: "67559322147",
  appId: "1:67559322147:web:1fc04bcb87488e931b3796"
};

// ---------- Tuning ----------

// Clean repetitions of a word before it counts as mastered.
export const MASTERY_THRESHOLD = 3;
// How many words later an unmastered word gets requeued (spaced repetition).
export const REQUEUE_GAP = 4;
// Clean reads of a sentence/passage line before it counts as mastered.
export const SENTENCE_MASTERY = 2;
// Most recent sessions kept in the log.
export const SESSION_LOG_LIMIT = 8;
// Cap on stored practice attempts before the oldest is evicted.
export const ATTEMPT_LOG_LIMIT = 150;

// ---------- Speech ----------

// Drives both the recognizer and the voice that reads words aloud. Getting this
// wrong costs accuracy in both directions: an en-US recognizer scores an
// Australian child's vowels against the wrong model, and an American voice
// gives her the wrong pronunciation to copy in the first place.
export const DEFAULT_SPEECH_LANG = 'en-AU';

// Offered in Word Bank. Recogniser support varies by browser and platform; an
// unsupported choice surfaces as a `language-not-supported` error on the mic
// button rather than failing silently.
export const SPEECH_LANGS = [
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-NZ', label: 'English (New Zealand)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-IE', label: 'English (Ireland)' },
  { code: 'en-ZA', label: 'English (South Africa)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-CA', label: 'English (Canada)' },
  { code: 'en-US', label: 'English (US)' }
];

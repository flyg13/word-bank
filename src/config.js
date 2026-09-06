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

// ---------- Transcription ----------

// Where the browser sends captured audio. A Netlify Function in this repo
// holds the provider's API key; the key is never in the bundle, and the
// browser never talks to the provider directly.
export const TRANSCRIBE_ENDPOINT = '/.netlify/functions/transcribe';

// How long to wait on the function before giving up and falling back to the
// browser's own recogniser. Long enough for a cold start plus a short clip;
// short enough that a child is not left staring at a spinner.
export const TRANSCRIBE_TIMEOUT_MS = 15000;

// Recording limits, tuned per mode. Two separate jobs:
//
//   silenceMs  how long a pause has to run before the recorder decides she is
//              finished. One word is over in a moment, so Practice can be
//              impatient; reading a passage has real pauses inside it, so it
//              must not be.
//   maxMs      a hard ceiling, so a recording can never be left running — the
//              fallback for a tap-to-stop that never comes.
//
// Auto-stop is a safety net, not the mechanism: tapping again is the intended
// way to finish, and always ends the recording immediately.
export const CAPTURE_MODES = {
  word: { silenceMs: 1200, maxMs: 8000 },
  sentence: { silenceMs: 2000, maxMs: 20000 },
  passage: { silenceMs: 2500, maxMs: 45000 },
  freeform: { silenceMs: 3500, maxMs: 60000 }
};

// Below this RMS (0–1, over a 2048-sample window) counts as silence. Set by
// ear against room noise on an iPad rather than derived: too low and a quiet
// room never triggers the auto-stop, too high and it cuts her off mid-word.
export const SILENCE_RMS = 0.012;

// How long to wait for her to start at all. Distinct from silenceMs, which is
// the pause *after* speech: if she taps and then says nothing, the recording
// should end in a few seconds rather than running to the mode's ceiling.
export const NO_SPEECH_MS = 6000;

// Vocabulary hints are capped before they are sent. The provider's prompt
// field is bounded (whisper-1 truncates past 224 tokens), and a hint list long
// enough to describe the whole bank would start biasing every transcript.
export const VOCAB_HINT_LIMIT = 90;

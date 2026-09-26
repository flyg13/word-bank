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

// How fast the app reads anything out, and the range the slider offers. The
// default is the rate the app has always used. Slow matters here: she is
// following the words as she hears them, and a voice that outruns her eye is
// worse than no voice. Fast matters too — re-reading a question she nearly has
// should not be a chore.
export const SPEECH_RATE_DEFAULT = 0.9;
export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 1.4;
export const SPEECH_RATE_STEP = 0.1;

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
//
// The numbers below are defaults. Each mode's pause can be overridden from
// Netlify without a code change — see `envMs` and the README — because the
// right value is a thing only the iPad, mid-session, can settle.
const DEFAULT_SILENCE_MS = {
  // One word, with nothing inside it to pause for. 1200ms was still long
  // enough to read as the app having frozen — the same complaint §13 answered
  // for Speech-To-Text, reported again from Practice, where she is saying one
  // word and waiting for it a dozen times in a row. Tapping again always ends
  // a recording immediately, so the cost of cutting short is one tap.
  word: 600,
  // A 3–5 word target sentence. She is articulating carefully and may pause
  // between words; cutting her off costs a whole retry of the sentence, so
  // this stays where it is.
  sentence: 2000,
  // Reading a passage has real pauses in it. Lowering this would cut her off
  // mid-read, which is the failure that matters here.
  passage: 2500,
  // Speech-To-Text. Was 3500, which read as the app having frozen — the
  // parent's report from real use. What makes 1500 safe is that recordings
  // now add to the end rather than replacing (CLAUDE.md §12): a pause cut
  // short ends that sentence, and the next tap carries straight on, so the
  // cost of being impatient here is one extra tap rather than lost work.
  freeform: 1500
};

/**
 * Read a millisecond setting from the build environment.
 *
 * Vite substitutes `import.meta.env` at build time, so these come from
 * Netlify's environment variables and changing one needs a redeploy — not a
 * code change, but not as live as the function-side variables either. A value
 * that is not a number in a sane range is ignored rather than used: a typo
 * must not be what leaves a recording running for a minute, or stops it
 * before she has drawn breath.
 *
 * Exported so a test can drive the real rule rather than a copy of it; `env`
 * is only for that, since `import.meta.env` is frozen at build time.
 */
export function envMs(name, fallback, { min = 300, max = 120000, env } = {}) {
  const source = env || (typeof import.meta !== 'undefined' && import.meta.env);
  const asked = Number(source && source[name]);
  return Number.isFinite(asked) && asked >= min && asked <= max ? asked : fallback;
}

export const CAPTURE_MODES = {
  word: {
    silenceMs: envMs('VITE_SILENCE_MS_WORD', DEFAULT_SILENCE_MS.word),
    maxMs: 8000
  },
  sentence: {
    silenceMs: envMs('VITE_SILENCE_MS_SENTENCE', DEFAULT_SILENCE_MS.sentence),
    maxMs: 20000
  },
  passage: {
    silenceMs: envMs('VITE_SILENCE_MS_PASSAGE', DEFAULT_SILENCE_MS.passage),
    maxMs: 45000
  },
  freeform: {
    silenceMs: envMs('VITE_SILENCE_MS_FREEFORM', DEFAULT_SILENCE_MS.freeform),
    maxMs: 60000
  }
};

// Below this RMS (0–1, over a 2048-sample window) counts as silence. Set by
// ear against room noise on an iPad rather than derived: too low and a quiet
// room never triggers the auto-stop, too high and it cuts her off mid-word.
export const SILENCE_RMS = 0.012;

// How long to wait for her to start at all. Distinct from silenceMs, which is
// the pause *after* speech: if she taps and then says nothing, the recording
// should end in a few seconds rather than running to the mode's ceiling.
export const NO_SPEECH_MS = envMs('VITE_NO_SPEECH_MS', 6000);

// Vocabulary hints are capped before they are sent. The provider's prompt
// field is bounded (whisper-1 truncates past 224 tokens), and a hint list long
// enough to describe the whole bank would start biasing every transcript.
export const VOCAB_HINT_LIMIT = 90;

// ---------- Her worksheets ----------

// How many sheets of schoolwork are kept. The parent's number: enough to pick
// yesterday's work back up, and deliberately not a history to manage. The
// whole list is written to the family document on every change, so this also
// bounds how large that field can get.
export const SHEET_LIMIT = 5;

// ---------- Context-aware correction ----------

// Where Speech-To-Text sends a transcript to be read with its own sentence in
// view. A second Netlify Function; the model's credentials never reach the
// browser, same as the recogniser's.
export const CONTEXT_ENDPOINT = '/.netlify/functions/contextual-correct';

// Longer than the transcription timeout: this call reads and reasons, and it
// happens after she has finished speaking rather than while she waits to be
// heard. Still short enough that the corrected text is not a mystery.
export const CONTEXT_TIMEOUT_MS = 25000;

// How many of Claude's changes the rolling log keeps — the parent's number.
// The log is a Firestore field the family document carries whole, so this is
// also a bound on how much of the document one Speech-To-Text session can
// rewrite: 50 entries is a few sessions' worth and still reads in one go.
export const CORRECTION_LOG_LIMIT = 50;

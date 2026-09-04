import { listen } from '../lib/speech.js';
import { state } from '../lib/store.js';

export const MIC_IDLE = 'Tap to listen';
const MIC_LISTENING = 'Listening…';

// What the recognizer's error codes actually mean, in words the person holding
// the iPad can act on. The raw code is always shown alongside: these are the
// only diagnostic there is when something goes wrong on a device that is not
// in front of you.
const ERROR_HINTS = {
  'no-speech': "Didn't hear anything",
  'audio-capture': 'No microphone found',
  'not-allowed': 'Microphone permission is blocked',
  'service-not-allowed': 'The speech service is blocked',
  network: 'Network problem',
  'bad-grammar': 'Recogniser configuration problem',
  'language-not-supported': 'This browser has no recogniser for'
};

/** Build the failure label, always naming the raw code. */
export function micErrorLabel(code, lang = state.speechLang) {
  if (code === 'language-not-supported') {
    return ERROR_HINTS[code] + ' ' + lang + ' (' + code + ') — try another language in Word Bank';
  }
  const hint = ERROR_HINTS[code] || "Didn't catch that";
  const suffix = code === 'not-allowed' || code === 'audio-capture' ? '' : ' — tap to try again';
  return hint + ' (' + code + ')' + suffix;
}

/**
 * Wire a mic button to the recognizer. Practice, Sentences, Reading and Free
 * Write all want the same thing — press, show that it's listening, hand back a
 * transcript — so the button state lives here once.
 *
 * The original left the label reading "Listening…" forever after the first
 * successful attempt, since only the error path ever reset it.
 */
export function bindMic({ buttonId, labelId, canListen = () => true, onResult }) {
  const button = document.getElementById(buttonId);
  const label = labelId ? document.getElementById(labelId) : null;

  const setLabel = (text) => {
    if (label) label.textContent = text;
  };

  button.addEventListener('click', () => {
    if (!canListen()) return;

    let failed = false;
    button.classList.add('listening');
    setLabel(MIC_LISTENING);

    listen({
      onResult,
      onError: (code) => {
        button.classList.remove('listening');
        // `aborted` fires when a listen is cancelled — tapping away, or a new
        // listen starting. That is not a failure worth reporting.
        if (code === 'aborted') {
          setLabel(MIC_IDLE);
          return;
        }
        failed = true;
        setLabel(micErrorLabel(code));
      },
      onEnd: () => {
        button.classList.remove('listening');
        if (!failed) setLabel(MIC_IDLE);
      }
    });
  });
}

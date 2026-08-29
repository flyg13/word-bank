import { listen } from '../lib/speech.js';

export const MIC_IDLE = 'Tap to listen';
const MIC_LISTENING = 'Listening…';
const MIC_FAILED = "Didn't catch that — tap to try again";

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
      onError: () => {
        failed = true;
        button.classList.remove('listening');
        setLabel(MIC_FAILED);
      },
      onEnd: () => {
        button.classList.remove('listening');
        if (!failed) setLabel(MIC_IDLE);
      }
    });
  });
}

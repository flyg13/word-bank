// Web Speech API wrapper. Both halves are optional in any given browser, so
// every entry point here degrades to a no-op rather than throwing.

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognizer = null;
if (SpeechRecognitionCtor) {
  recognizer = new SpeechRecognitionCtor();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.lang = 'en-US';
}

export const speechRecognitionSupported = Boolean(recognizer);

/** Read text aloud so she can hear the target before attempting it. */
export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    /* speech synthesis is a nicety, never a blocker */
  }
}

/**
 * Listen for a single utterance.
 *
 * There is one shared recognizer instance, so handlers are reassigned on each
 * call — same as the original, and the reason a listen already in flight is
 * simply restarted rather than queued.
 *
 * @param {{onResult:(heard:string)=>void, onError?:()=>void, onEnd?:()=>void}} handlers
 */
export function listen({ onResult, onError, onEnd }) {
  if (!recognizer) return;
  recognizer.onresult = (e) => {
    const heard = e.results[0][0].transcript.trim();
    onResult(heard);
  };
  recognizer.onerror = () => {
    if (onError) onError();
  };
  recognizer.onend = () => {
    if (onEnd) onEnd();
  };
  try {
    recognizer.start();
  } catch (e) {
    /* start() throws if already listening — harmless */
  }
}

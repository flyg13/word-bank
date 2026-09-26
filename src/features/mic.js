import { listen, listenInterim, speechRecognitionSupported } from '../lib/speech.js';
import { startCapture, CaptureError, mediaRecordingSupported } from '../lib/capture.js';
import { state } from '../lib/store.js';

export const MIC_IDLE = 'Tap to record';
export const MIC_RECORDING = 'Recording — tap when done';
export const MIC_WORKING = 'Working it out\u2026';
const MIC_FALLBACK = 'Reduced accuracy — say it again';
const MIC_FALLBACK_TAP = 'Reduced accuracy — tap and say it again';

// What each failure actually means, in words the person holding the iPad can
// act on. The raw code is always shown alongside: it is the only diagnostic
// there is when something goes wrong on a device that is not in front of you.
//
// Two vocabularies land here. The browser recogniser's own codes (no-speech,
// not-allowed, …) were the original set; the transcription service adds its
// own, and capture.js deliberately maps getUserMedia's errors onto the browser
// names so there is one list rather than two.
const ERROR_HINTS = {
  'no-speech': "Didn't hear anything",
  'audio-capture': 'No microphone found',
  'not-allowed': 'Microphone permission is blocked',
  'service-not-allowed': 'The speech service is blocked',
  network: 'Network problem',
  'bad-grammar': 'Recogniser configuration problem',
  'language-not-supported': 'This browser has no recogniser for',
  // Transcription service.
  offline: 'No connection to the speech service',
  timeout: 'The speech service took too long',
  'not-configured': 'The speech service has no API key set',
  'not-authorised': 'The speech service rejected the key',
  'rate-limited': 'The speech service is busy',
  'provider-error': 'The speech service had a problem',
  'transcribe-failed': 'Could not turn that into text',
  'bad-response': 'The speech service sent something unreadable',
  'too-large': 'That recording was too long to send',
  'empty-audio': 'Nothing was recorded',
  'no-recorder': 'This browser cannot record audio',
  'mic-failed': 'The microphone could not start'
};

// Failures of the online service, as opposed to failures of the microphone or
// of her actually saying something. Only these are worth falling back for:
// re-recording will not fix a blocked microphone, and it should not quietly
// paper over a gate refusing the clip.
const FALLBACK_CODES = new Set([
  'offline', 'timeout', 'not-configured', 'not-authorised', 'rate-limited',
  'provider-error', 'transcribe-failed', 'bad-response', 'http-500', 'http-502',
  'http-503', 'http-504', 'no-provider', 'bad-request'
]);

/** Build the failure label, always naming the raw code. */
export function micErrorLabel(code, lang = state.speechLang) {
  if (code === 'language-not-supported') {
    return ERROR_HINTS[code] + ' ' + lang + ' (' + code + ') — try another language in Word Bank';
  }
  const hint = ERROR_HINTS[code] || "Didn't catch that";
  const noRetry = code === 'not-allowed' || code === 'audio-capture' || code === 'no-recorder';
  return hint + ' (' + code + ')' + (noRetry ? '' : ' — tap to try again');
}

export function shouldFallBack(code) {
  return FALLBACK_CODES.has(code) || /^http-5/.test(code || '');
}

// ---------- The reduced-accuracy notice ----------
// Deliberately a banner and not just the mic label: the label is gone the
// moment the next attempt starts, and "it quietly got worse" is exactly the
// thing that must not be possible to miss.

function setAccuracyNotice(code) {
  const banner = document.getElementById('accuracyBanner');
  if (!banner) return;
  if (!code) {
    banner.classList.remove('show');
    return;
  }
  const where = speechRecognitionSupported
    ? 'Using this browser’s own recogniser instead, which is what she was being misheard by before.'
    : 'This browser has no recogniser of its own, so nothing was transcribed.';
  banner.innerHTML = '';
  banner.append(
    Object.assign(document.createElement('b'), { textContent: 'Reduced accuracy: ' }),
    document.createTextNode(
      'the speech service could not be reached (' + code + '). ' + where +
      ' Corrections recorded now may be less reliable.'
    )
  );
  banner.classList.add('show');
}

/**
 * Wire a mic button.
 *
 * Practice, Sentences, Reading, Speech-To-Text and the pronunciation capture
 * all want the same thing — tap, show that it is recording, tap again, hand
 * back a transcript — so the button's whole state machine lives here once.
 *
 * @param {{
 *   buttonId: string,
 *   labelId?: string,
 *   mode?: 'word'|'sentence'|'passage'|'freeform',
 *   expected?: () => string,
 *   canListen?: () => boolean,
 *   onBlocked?: () => void,
 *   onWorking?: () => void,
 *   onInterim?: (text: string|null) => void,
 *   onResult: (text: string) => void
 * }} options
 *
 * `onWorking` fires when the recording ends and the clip starts being turned
 * into text, for a screen that wants to say so somewhere other than the mic.
 *
 * `onInterim` receives a rough preview of what she is saying, while she says
 * it, from the browser's own recogniser running alongside the recording; it is
 * called with null when there is no longer a preview to show. A device with no
 * second recogniser simply never calls it, and behaves exactly as before.
 */
export function bindMic({
  buttonId, labelId, mode = 'word', expected = () => '',
  canListen = () => true, onBlocked, onWorking, onInterim, onResult
}) {
  const button = document.getElementById(buttonId);
  const label = labelId ? document.getElementById(labelId) : null;

  const setLabel = (text) => {
    if (label) {
      label.textContent = text;
      label.classList.remove('working');
    }
  };

  /**
   * Recording is over and the clip is on its way.
   *
   * This is its own visible state, not a relabelling. While it was missing,
   * the button kept the gold "listening" fill through the entire upload, so
   * the one thing on screen said "still recording" when nothing was being
   * recorded — and an auto-stop never even changed the label. On the iPad that
   * reads as the app having frozen, which is what the parent reported.
   */
  const enterWorking = () => {
    // Both ways a recording ends lead here — the tap, and capture's own
    // `onSending` — and a tap-to-stop travels both. Entering the state twice
    // is harmless on the button, but `onWorking` is somebody else's callback
    // and it is told once.
    if (workingShown) return;
    workingShown = true;
    // Nothing more is being said, so there is nothing left to listen for —
    // but the rough words stay up, because the wait they cover starts now.
    stopPreview();
    button.classList.remove('listening');
    button.classList.add('working');
    if (label) {
      label.textContent = MIC_WORKING;
      label.classList.add('working');
    }
    if (onWorking) onWorking();
  };

  // One capture at a time per button. `active` holds the live capture so the
  // second tap can stop it; `fallbackArmed` survives between taps so a failed
  // attempt's retry goes straight to the browser recogniser instead of
  // spending another recording and timeout on a service that is down.
  //
  // `starting` covers the gap between the first tap and the microphone being
  // live — getUserMedia is asynchronous, so without it a second tap in that
  // window finds no active capture and starts a second one, opening two
  // streams and producing two transcripts for one attempt. A child tapping
  // twice because nothing happened yet is the likeliest way to hit it.
  // `stopRequested` is why the tap is remembered rather than dropped: it still
  // means "finish", it just arrived before there was anything to finish.
  let active = null;
  let starting = false;
  let stopRequested = false;
  let fallbackArmed = false;
  let workingShown = false;
  let preview = null;

  /**
   * Stop listening for the preview, but leave what it produced on screen.
   *
   * This is the whole point of it: the rough words stay up through the wait
   * for the real transcript, which is the part that felt too long. They are
   * cleared by `clearPreview` when the accurate text arrives to replace them,
   * or when the attempt fails and there is nothing to replace them with.
   */
  const stopPreview = () => {
    if (preview) {
      preview.stop();
      preview = null;
    }
  };

  const clearPreview = () => {
    stopPreview();
    if (onInterim) onInterim(null);
  };

  const finishIdle = () => {
    button.classList.remove('listening');
    button.classList.remove('working');
    active = null;
    starting = false;
    stopRequested = false;
    workingShown = false;
  };

  /** The browser's own recogniser — the fallback, and never the first choice. */
  const useBrowserRecogniser = (startLabel) => {
    if (!speechRecognitionSupported) {
      setLabel('No offline recogniser here (no-recogniser)');
      finishIdle();
      return;
    }
    let failed = false;
    button.classList.add('listening');
    setLabel(startLabel);
    listen({
      onResult: (heard) => {
        fallbackArmed = false;
        onResult(heard);
      },
      onError: (code) => {
        button.classList.remove('listening');
        button.classList.remove('working');
        if (code === 'aborted') {
          setLabel(MIC_FALLBACK_TAP);
          return;
        }
        failed = true;
        // Still armed: the service is the thing that failed, and this tap did
        // not reach it. The next tap should not pay for it again.
        setLabel(micErrorLabel(code));
      },
      onEnd: () => {
        button.classList.remove('listening');
        button.classList.remove('working');
        active = null;
        if (!failed) setLabel(fallbackArmed ? MIC_FALLBACK_TAP : MIC_IDLE);
      }
    });
  };

  const fallBack = (code) => {
    fallbackArmed = true;
    setAccuracyNotice(code);
    if (!speechRecognitionSupported) {
      setLabel(micErrorLabel(code));
      finishIdle();
      return;
    }
    // Safari only lets the recogniser start from a user gesture, and awaiting
    // the upload has already spent this tap's. So this auto-start is best
    // effort: when it is refused, the armed state makes the next tap — a fresh
    // gesture — go straight to the browser recogniser.
    useBrowserRecogniser(MIC_FALLBACK);
  };

  const runCapture = async () => {
    starting = true;
    stopRequested = false;
    workingShown = false;
    button.classList.add('listening');
    setLabel(MIC_RECORDING);

    let capture;
    try {
      capture = await startCapture({ mode, expected: expected(), onSending: enterWorking });
    } catch (e) {
      finishIdle();
      clearPreview();
      const code = e instanceof CaptureError ? e.code : 'mic-failed';
      if (shouldFallBack(code)) fallBack(code);
      else setLabel(micErrorLabel(code));
      return;
    }

    active = capture;
    starting = false;

    // The preview starts only once the microphone is actually live, and only
    // where there is a second recogniser to run. It is a preview: every way it
    // can fail is silent, and the recording never waits on it or hears about
    // it.
    if (onInterim && speechRecognitionSupported) {
      try {
        preview = listenInterim({ onText: (text) => { if (preview) onInterim(text); } });
      } catch (e) {
        preview = null;
      }
    }

    // A tap that arrived while the microphone was coming up still meant
    // "finish" — honour it now rather than leaving the recording running.
    if (stopRequested) capture.stop('tap');

    try {
      const { text } = await capture.result;
      finishIdle();
      // The accurate transcript is here, so the rough words have done their
      // job. Cleared before onResult, so the two are never on screen together.
      clearPreview();
      setLabel(MIC_IDLE);
      // A transcript came back from the service, so whatever was wrong before
      // is over. The notice clears itself rather than needing dismissing.
      setAccuracyNotice('');
      fallbackArmed = false;
      onResult(text);
    } catch (e) {
      finishIdle();
      clearPreview();
      const code = e instanceof CaptureError ? e.code : 'transcribe-failed';
      if (shouldFallBack(code)) fallBack(code);
      else setLabel(micErrorLabel(code));
    }
  };

  button.addEventListener('click', () => {
    // Second tap: stop. This is the intended way to finish; the silence and
    // length limits in CAPTURE_MODES only exist so a recording can never be
    // left running.
    if (active) {
      enterWorking();
      active.stop('tap');
      return;
    }

    // Tapped again before the microphone was live. Remembered, not dropped.
    if (starting) {
      stopRequested = true;
      enterWorking();
      return;
    }

    if (!canListen()) {
      if (onBlocked) onBlocked();
      return;
    }

    if (fallbackArmed || !mediaRecordingSupported()) {
      useBrowserRecogniser(fallbackArmed ? MIC_FALLBACK : 'Listening…');
      return;
    }

    runCapture();
  });
}

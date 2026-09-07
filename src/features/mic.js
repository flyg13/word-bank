import { listen, speechRecognitionSupported } from '../lib/speech.js';
import { startCapture, CaptureError, mediaRecordingSupported } from '../lib/capture.js';
import { state } from '../lib/store.js';

export const MIC_IDLE = 'Tap to record';
export const MIC_RECORDING = 'Recording — tap when done';
const MIC_WORKING = 'Working it out…';
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
 *   onResult: (text: string) => void
 * }} options
 */
export function bindMic({
  buttonId, labelId, mode = 'word', expected = () => '',
  canListen = () => true, onBlocked, onResult
}) {
  const button = document.getElementById(buttonId);
  const label = labelId ? document.getElementById(labelId) : null;

  const setLabel = (text) => {
    if (label) label.textContent = text;
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

  const finishIdle = () => {
    button.classList.remove('listening');
    active = null;
    starting = false;
    stopRequested = false;
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
    button.classList.add('listening');
    setLabel(MIC_RECORDING);

    let capture;
    try {
      capture = await startCapture({ mode, expected: expected() });
    } catch (e) {
      finishIdle();
      const code = e instanceof CaptureError ? e.code : 'mic-failed';
      if (shouldFallBack(code)) fallBack(code);
      else setLabel(micErrorLabel(code));
      return;
    }

    active = capture;
    starting = false;
    // A tap that arrived while the microphone was coming up still meant
    // "finish" — honour it now rather than leaving the recording running.
    if (stopRequested) capture.stop('tap');

    try {
      const { text } = await capture.result;
      finishIdle();
      setLabel(MIC_IDLE);
      // A transcript came back from the service, so whatever was wrong before
      // is over. The notice clears itself rather than needing dismissing.
      setAccuracyNotice('');
      fallbackArmed = false;
      onResult(text);
    } catch (e) {
      finishIdle();
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
      setLabel(MIC_WORKING);
      active.stop('tap');
      return;
    }

    // Tapped again before the microphone was live. Remembered, not dropped.
    if (starting) {
      stopRequested = true;
      setLabel(MIC_WORKING);
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

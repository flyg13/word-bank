// Voice Lock: the classroom gate.
//
// The problem it answers is the teacher's, not the parent's: a room full of
// children, and speech-to-text that picks up all of them. So a clip is checked
// against Harlie's own voiceprint before it is sent, and one that is somebody
// else — or several people at once — is refused on the device.
//
// Three things about the shape of this are deliberate and load-bearing:
//
// 1. **It runs on the finished clip, not the microphone.** `addClipGate` hands
//    it a Blob after recording ends and before anything is uploaded. So it is
//    not a third consumer of live audio alongside the recorder and the interim
//    recogniser — nothing new is contending for the microphone.
// 2. **Off unless switched on.** At home it can only cause problems, and the
//    only place it earns its keep is a classroom.
// 3. **Always escapable.** Being locked out of her own tool in front of a class
//    is worse than a classmate getting through, so a refusal puts an off
//    switch on the screen next to the apology. See CLAUDE.md §18.

import { state, save, onRender, renderAll } from '../lib/store.js';
import { addClipGate } from '../lib/capture.js';
import { embedClip, cosine, bestScore, forgetVoiceEngine } from '../lib/voiceprint.js';
import {
  voiceLock, updateVoiceLock, saveEnrolment, clearEnrolment,
  logScore, suggestThreshold,
  startCalibration, finishCalibration, cancelCalibration
} from '../lib/voicelock-state.js';
import {
  VOICE_THRESHOLD_MIN, VOICE_THRESHOLD_MAX, VOICE_THRESHOLD_STEP,
  VOICE_ENROL_MIN_SECONDS, VOICE_ENROL_TARGET_SECONDS, VOICE_ENROL_CLIPS,
  VOICE_LOG_LIMIT
} from '../config.js';
import { bindMic } from './mic.js';

// The code a refused clip is reported with, so the mic label and the page can
// tell "that was not her" apart from every other reason a capture can fail.
export const NOT_HER = 'not-her';

// Enrolment recordings collected but not yet saved.
let enrolling = [];

/** What the last gated attempt scored, for the page to show. */
let lastScore = null;

// ---------- the gate ----------

/**
 * Decide whether a clip is hers.
 *
 * Returns a verdict rather than throwing, so `passesGates` owns the failure.
 * Every uncertainty resolves to *allow*: no enrolment, no model, a decode that
 * failed, an engine that would not load. A gate that cannot see has no
 * business refusing a nine-year-old's homework, and §18 says silence is never
 * an option — the page says what happened either way.
 */
export async function judgeClip(clip) {
  const setting = voiceLock();
  if (!setting.enabled && !setting.calibrating) {
    hideRefusal();
    return { ok: true };
  }
  if (!setting.print) {
    return { ok: true, why: 'no-enrolment' };
  }

  let print;
  try {
    print = await embedClip(clip.blob);
  } catch (e) {
    // The model is missing, the runtime would not start, or the clip would not
    // decode. Let it through and say so; refusing here would make a broken
    // download look like a child with the wrong voice.
    return { ok: true, why: 'unavailable', error: (e && e.message) || 'failed' };
  }

  if (print.values.length !== setting.print.dim) {
    return { ok: true, why: 'model-changed' };
  }

  const score = bestScore(print.values, setting.print.embeddings);
  lastScore = score;

  // A calibration session is open, so the gate stands down — but it does not
  // quietly add a row either. Calibration is now a set of recordings the
  // parent made on purpose and said who each one was; an untagged score from
  // her ordinary Practice would land in neither group and only muddy the two
  // ranges the session exists to produce.
  if (setting.calibrating) {
    return { ok: true, why: 'calibrating', score };
  }

  if (score >= setting.threshold) {
    hideRefusal();
    return { ok: true, score };
  }
  logScore({ score, where: 'refused' });
  // Said here, by the gate that refused, rather than left to whichever screen
  // she happens to be on. A refusal she cannot see is a broken app.
  showRefusal();
  return { ok: false, code: NOT_HER, score };
}

// ---------- enrolment ----------

function showEnrolNote(text, kind) {
  const note = document.getElementById('voiceEnrolNote');
  if (!note) return;
  note.textContent = text || '';
  note.className = 'phonic-note' + (kind ? ' ' + kind : '');
}

/**
 * Count the seconds out loud while she talks.
 *
 * The parent timed the first enrolment on their phone, because the card asked
 * for "about ten seconds" and then showed nothing at all: no elapsed time, no
 * target, and no stop. All three are here now, and the recording ends itself
 * at the target (CAPTURE_MODES.enrol), so the number is a reassurance rather
 * than something to act on.
 */
export function showEnrolTimer(elapsedMs) {
  const box = document.getElementById('voiceEnrolTimer');
  if (!box) return;
  const seconds = Math.floor(elapsedMs / 1000);
  const left = Math.max(0, VOICE_ENROL_TARGET_SECONDS - seconds);
  box.hidden = false;
  box.className = 'enrol-timer' + (seconds >= VOICE_ENROL_MIN_SECONDS ? ' enough' : '');
  box.textContent = seconds + 's \u00b7 ' +
    (left > 0 ? left + ' to go' : 'that is plenty') +
    (seconds >= VOICE_ENROL_MIN_SECONDS ? '  \u2713 long enough to use' : '');
}

function hideEnrolTimer() {
  const box = document.getElementById('voiceEnrolTimer');
  if (!box) return;
  box.hidden = true;
  box.textContent = '';
}

export async function collectEnrolment(clip) {
  hideEnrolTimer();
  showEnrolNote('Listening to that\u2026');
  let print;
  try {
    print = await embedClip(clip.blob);
  } catch (e) {
    showEnrolNote(
      (e && e.message) === 'model-missing'
        ? 'The voice model is not installed on this site, so Voice Lock cannot be set up yet.'
        : 'That recording could not be used (' + ((e && e.message) || 'failed') + ').',
      'warn'
    );
    return;
  }

  // Every recording is now kept or refused on its own, and a refusal says
  // which recording and why. The old rule needed three clips *and* nine
  // seconds between them, so a short clip was half-counted: the card could
  // sit on "3 of 3" and still ask for more, with nothing saying that the
  // recording just made was the problem.
  if (print.seconds < VOICE_ENROL_MIN_SECONDS) {
    showEnrolNote(
      'That one was only ' + print.seconds.toFixed(1) + ' seconds, and I need at ' +
      'least ' + VOICE_ENROL_MIN_SECONDS + '. It has not been counted \u2014 tap again and ' +
      'let her talk for longer.', 'warn');
    renderAll();
    return;
  }

  enrolling.push(print);
  if (enrolling.length >= VOICE_ENROL_CLIPS) {
    saveEnrolment({
      embeddings: enrolling.map((p) => Array.from(p.values)),
      model: modelName(),
      seconds: enrolledSeconds()
    });
    enrolling = [];
    showEnrolNote('Her voice is saved. Calibrate next \u2014 step 2.', 'good');
  } else {
    showEnrolNote('Recording ' + enrolling.length + ' of ' + VOICE_ENROL_CLIPS +
      ' saved (' + print.seconds.toFixed(0) + 's). Tap again for the next one.');
  }
  renderAll();
}

/** Drop any enrolment recordings collected but not yet saved. */
export function resetEnrolment() {
  enrolling = [];
}

function enrolledSeconds() {
  return enrolling.reduce((total, print) => total + print.seconds, 0);
}

/** Which model made a print, so a swapped model is visible rather than silent. */
function modelName() {
  return (state.voiceModelName || 'speaker.onnx');
}

// ---------- the page ----------

/**
 * Score one deliberately-recorded clip and file it under whoever it was.
 *
 * Who is decided *before* recording, by which button was tapped, rather than
 * tagged afterwards. Tagging a list of bare numbers after the fact was the
 * part nobody could follow: by the third row there was no way to remember
 * which was which, and the note confirming each score was overwritten by the
 * standing advice the moment the card re-rendered — so recording again looked
 * like it did nothing, which read as a cap of three.
 *
 * Scores the clip exactly the way the gate does — same embedding, same
 * `bestScore` against the same enrolment — so a threshold tuned here is the
 * threshold the gate will apply.
 */
export async function scoreForCalibration(clip, who) {
  const setting = voiceLock();
  if (!setting.print) {
    showCalNote('Save her voice first, in step 1 \u2014 there is nothing to compare against yet.', 'warn');
    return null;
  }

  let print;
  try {
    print = await embedClip(clip.blob);
  } catch (e) {
    showCalNote('Could not read that recording (' + ((e && e.message) || 'failed') + '). Try again.', 'warn');
    return null;
  }

  if (print.values.length !== setting.print.dim) {
    showCalNote('That was measured with a different model to her saved voice. Record her voice again in step 1.', 'warn');
    return null;
  }

  const score = bestScore(print.values, setting.print.embeddings);
  logScore({ score, where: 'calibrate', who });
  // Its own line, not the one the verdict uses. The two used to share an
  // element, and the verdict always won.
  showCalNote((who === 'her' ? 'Harlie' : 'Someone else') + ': ' + score.toFixed(2) +
    '. Recorded \u2014 keep going for as long as you like.', 'good');
  renderAll();
  return score;
}

/** The per-recording line. Deliberately separate from the verdict. */
function showCalNote(text, kind) {
  const note = document.getElementById('voiceCalNote');
  if (!note) return;
  note.textContent = text || '';
  note.className = 'phonic-note' + (kind ? ' ' + kind : '');
}

export function renderVoiceLock() {
  const card = document.getElementById('voiceLockCard');
  if (!card) return;
  const setting = voiceLock();

  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  };

  // ---- step 1
  const state1 = document.getElementById('voiceEnrolState');
  if (state1) {
    state1.textContent = setting.print
      ? 'Her voice was saved ' + (setting.print.enrolledAt || '').slice(0, 10) +
        ' from ' + Math.round(setting.print.seconds) + ' seconds. ' +
        'Record it again whenever it stops recognising her \u2014 voices change.'
      : 'Nothing saved yet. ' + VOICE_ENROL_CLIPS + ' recordings of her talking, about ' +
        VOICE_ENROL_TARGET_SECONDS + ' seconds each, saying anything at all. Each one ' +
        'stops itself when it has enough.';
  }

  // ---- step 2: idle, running, or done
  show('voiceCalIdle', !setting.calibrating && !setting.calibratedAt);
  show('voiceCalRunning', setting.calibrating);
  show('voiceCalDone', !setting.calibrating && !!setting.calibratedAt);

  const start = document.getElementById('voiceCalStart');
  if (start) start.disabled = !setting.print;

  const doneNote = document.getElementById('voiceCalDoneNote');
  if (doneNote && setting.calibratedAt) {
    doneNote.textContent = 'Calibrated ' + setting.calibratedAt.slice(0, 10) +
      '. The gate is set to ' + setting.threshold.toFixed(2) + '.';
  }

  if (setting.calibrating) renderCalibration(setting);

  // ---- step 3
  const on = document.getElementById('voiceLockOn');
  if (on) {
    on.checked = setting.enabled;
    // Not before there is a voice to compare against, and not before a
    // session has measured where the line goes. A threshold nobody checked is
    // a threshold that locks her out in front of a class.
    on.disabled = !setting.print || !setting.calibratedAt;
  }
  const slider = document.getElementById('voiceThreshold');
  if (slider) {
    slider.min = String(VOICE_THRESHOLD_MIN);
    slider.max = String(VOICE_THRESHOLD_MAX);
    slider.step = String(VOICE_THRESHOLD_STEP);
    slider.value = String(setting.threshold);
    slider.disabled = !setting.calibratedAt;
  }
  const tnote = document.getElementById('voiceThresholdNote');
  if (tnote) {
    tnote.textContent = !setting.print
      ? 'Save her voice in step 1 first.'
      : !setting.calibratedAt
        ? 'Finish calibrating in step 2 and the gate turns on here, with the threshold it worked out.'
        : 'Accepting anything scoring ' + setting.threshold.toFixed(2) + ' or higher. ' +
          'Lower lets more through; higher is stricter.';
  }
}

/** One group of scores, newest first, under its own heading. */
function renderGroup(id, title, entries) {
  const holder = document.getElementById(id);
  if (!holder) return;
  holder.innerHTML = '';
  const head = document.createElement('h4');
  head.className = 'score-group-title';
  head.textContent = title + ' \u00b7 ' + entries.length;
  holder.appendChild(head);

  if (!entries.length) {
    holder.append(Object.assign(document.createElement('span'), {
      className: 'empty-note', textContent: 'None yet.'
    }));
    return;
  }
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'score-row tagged-' + entry.who;
    const value = document.createElement('b');
    value.className = 'score-value';
    value.textContent = entry.score.toFixed(2);
    const when = document.createElement('span');
    when.className = 'score-when';
    when.textContent = (entry.at || '').slice(11, 16);
    row.append(value, when);
    holder.appendChild(row);
  });
}

function renderCalibration(setting) {
  const hers = setting.log.filter((e) => e.who === 'her');
  const others = setting.log.filter((e) => e.who === 'other');
  renderGroup('voiceCalHerGroup', 'Harlie', hers);
  renderGroup('voiceCalOtherGroup', 'Someone else', others);

  // One sentence saying what to do next, rather than two tickboxes to work
  // out. It is recomputed on every change, so the card always names the thing
  // standing between here and a threshold.
  const step = document.getElementById('voiceCalStep');
  if (step) {
    step.textContent = hers.length < 2
      ? 'Record Harlie talking, two or three times. Anything she likes saying.'
      : others.length < 1
        ? 'Now record somebody else \u2014 you will do, and another child is better. ' +
          'As many different people as you like.'
        : 'Enough to work with. Add more of either to sharpen it, or finish below.';
  }

  const suggestion = suggestThreshold(setting.log);
  const verdict = document.getElementById('voiceCalVerdict');
  if (!verdict) return;
  verdict.innerHTML = '';
  verdict.className = 'cal-verdict';

  const range = (label, r) => label + ' ' + (r ? r.low.toFixed(2) + '\u2013' + r.high.toFixed(2) : '\u2014');
  if (suggestion.herRange || suggestion.otherRange) {
    verdict.append(Object.assign(document.createElement('div'), {
      className: 'cal-ranges',
      textContent: range('Harlie', suggestion.herRange) + '   ' +
        range('Others', suggestion.otherRange)
    }));
  }

  const say = (text, cls) => verdict.append(Object.assign(document.createElement('div'), {
    className: cls, textContent: text
  }));

  if (suggestion.ok) {
    say('They do not overlap. Her lowest sits ' + suggestion.margin.toFixed(2) +
      ' above the highest anyone else scored, so ' + suggestion.value +
      ' separates them. Finish, and the gate will use that.', 'cal-ok');
  } else if (suggestion.reason === 'overlap') {
    say('They overlap by ' + suggestion.overlap.toFixed(2) + '. No threshold tells ' +
      'them apart cleanly. That is a real finding about this model and these ' +
      'voices, not a setup mistake \u2014 more recordings may separate them, and if ' +
      'they do not, the honest answer is to leave the gate off.', 'cal-warn');
  } else {
    say('Two recordings of Harlie and one of somebody else is the minimum. ' +
      'More of both makes the line more trustworthy.', 'cal-wait');
  }

  if (setting.log.length >= VOICE_LOG_LIMIT) {
    say('That is ' + VOICE_LOG_LIMIT + ' recordings, which is the most kept \u2014 ' +
      'the oldest now drop off as you add more.', 'cal-warn');
  }

  const finish = document.getElementById('voiceCalFinish');
  // Finishing is allowed on an overlap too: the parent may want the number
  // recorded and the gate left off. It is only blocked while there is
  // genuinely nothing to finish with.
  if (finish) finish.disabled = !(suggestion.ok || suggestion.reason === 'overlap');
}

/**
 * Say, on the page she is looking at, that the gate refused her — and offer
 * the way out in the same breath.
 *
 * She is nine and cannot read an error code. The sentence is hers; the off
 * switch is for whoever is helping, and it is right there because being locked
 * out mid-lesson is the failure that matters most.
 */
/**
 * Say, wherever she is, that the gate refused her — and give her the way out.
 *
 * It floats rather than taking a container, for the same reason §16's fix
 * panel does: a refusal can happen in Practice, Sentences, Reading or an
 * answer, and a screen that forgot to pass a container would refuse her in
 * silence. That is the one failure this feature must never have.
 *
 * The escape hatch is on the refusal itself, not buried in Word Bank. Being
 * locked out of her own tool in front of a class is worse than the gate
 * picking up a classmate, so the way out is always one tap from the refusal.
 */
export function showRefusal() {
  const box = document.getElementById('voiceRefusal');
  if (!box) return;
  box.textContent = '';

  box.append(Object.assign(document.createElement('b'), {
    textContent: 'I didn\u2019t hear your voice that time. Have another go.'
  }));

  // The score, small and grey, for the parent reading over her shoulder: a
  // gate refusing at 0.71 when she enrolled at 0.74 is a threshold problem,
  // and that is only diagnosable if the number is on screen.
  if (lastScore !== null) {
    const hint = document.createElement('span');
    hint.className = 'code-hint';
    hint.textContent = ' (voice match ' + lastScore.toFixed(2) + ')';
    box.appendChild(hint);
  }

  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'btn btn-outline voice-off';
  off.textContent = 'Turn Voice Lock off';
  off.addEventListener('click', () => {
    updateVoiceLock({ enabled: false });
    hideRefusal();
    renderAll();
  });
  box.appendChild(off);
  box.classList.add('show');
}

/** Clear it. Called on every pass, so a stale refusal never sits over a
 *  recording that worked. */
export function hideRefusal() {
  const box = document.getElementById('voiceRefusal');
  if (!box) return;
  box.classList.remove('show');
  box.textContent = '';
}

export function initVoiceLock() {
  const card = document.getElementById('voiceLockCard');
  if (!card) return;

  addClipGate(judgeClip);

  const on = (id, event, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  };

  // ---- step 1: her voice
  bindMic({
    buttonId: 'voiceEnrolMic',
    labelId: 'voiceEnrolMicLabel',
    // The ceiling of this mode is the target, so the recording ends itself
    // once it has enough and nobody has to time it.
    mode: 'enrol',
    // Without this, bindMic takes the transcript branch: onClip is never
    // called, so nothing is ever enrolled however many times she records —
    // and the clip is uploaded, which is exactly what this feature promises
    // never happens to her enrolment audio.
    localOnly: true,
    onTick: showEnrolTimer,
    onWorking: hideEnrolTimer,
    onClip: collectEnrolment
  });

  on('voiceForget', 'click', () => {
    if (!window.confirm('Forget her saved voice? Voice Lock switches off, and the calibration goes with it — every score was measured against the voice being thrown away.')) return;
    resetEnrolment();
    clearEnrolment();
    forgetVoiceEngine();
    hideEnrolTimer();
    showEnrolNote('Her voice was forgotten. Record it again whenever you are ready.');
    renderAll();
  });

  // ---- step 2: the calibration session
  on('voiceCalStart', 'click', () => {
    startCalibration();
    showCalNote('');
    renderAll();
  });
  on('voiceCalAgain', 'click', () => {
    startCalibration();
    showCalNote('');
    renderAll();
  });
  on('voiceCalCancel', 'click', () => {
    cancelCalibration();
    showCalNote('');
    renderAll();
  });
  on('voiceCalFinish', 'click', () => {
    const suggestion = suggestThreshold(voiceLock().log);
    // An overlap finishes too, keeping the threshold as it stands — the
    // session still measured something, and the verdict said plainly that
    // the gate is not trustworthy on these voices.
    finishCalibration(suggestion.ok ? suggestion.value : voiceLock().threshold);
    renderAll();
  });

  // Who is chosen by which button is tapped, before anything is recorded.
  bindMic({
    buttonId: 'voiceCalHerMic',
    labelId: 'voiceCalHerLabel',
    mode: 'sentence',
    localOnly: true,
    onClip: (clip) => scoreForCalibration(clip, 'her')
  });
  bindMic({
    buttonId: 'voiceCalOtherMic',
    labelId: 'voiceCalOtherLabel',
    mode: 'sentence',
    localOnly: true,
    onClip: (clip) => scoreForCalibration(clip, 'other')
  });

  // ---- step 3: the gate
  on('voiceLockOn', 'change', (e) => {
    updateVoiceLock({ enabled: e.target.checked });
    renderAll();
  });
  on('voiceThreshold', 'input', (e) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value)) return;
    updateVoiceLock({ threshold: value });
    renderAll();
  });

  onRender(renderVoiceLock);
}

/** The last score the gate saw. Exported for the page and for tests. */
export function lastGateScore() {
  return lastScore;
}

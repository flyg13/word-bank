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
  logScore, tagScore, clearLog, suggestThreshold
} from '../lib/voicelock-state.js';
import {
  VOICE_THRESHOLD_MIN, VOICE_THRESHOLD_MAX, VOICE_THRESHOLD_STEP,
  VOICE_ENROL_MIN_SECONDS, VOICE_ENROL_TARGET_SECONDS, VOICE_ENROL_CLIPS
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

  // Calibration shows the number and gates nothing — that is the whole point
  // of it, and it comes before the gate so the threshold is set from her real
  // voice rather than guessed.
  if (setting.calibrating) {
    logScore({ score, where: 'attempt' });
    renderAll();
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

function enrolledSeconds() {
  return enrolling.reduce((total, clip) => total + clip.seconds, 0);
}

function showEnrolNote(text, kind) {
  const note = document.getElementById('voiceEnrolNote');
  if (!note) return;
  note.textContent = text || '';
  note.className = 'phonic-note' + (kind ? ' ' + kind : '');
}

async function collectEnrolment(clip) {
  showEnrolNote('Listening to that…');
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
  enrolling.push(print);
  const done = enrolling.length >= VOICE_ENROL_CLIPS &&
    enrolledSeconds() >= VOICE_ENROL_MIN_SECONDS * VOICE_ENROL_CLIPS;
  if (done) {
    saveEnrolment({
      embeddings: enrolling.map((p) => Array.from(p.values)),
      model: modelName(),
      seconds: enrolledSeconds()
    });
    enrolling = [];
    showEnrolNote('Done — her voice is saved. Turn Calibration on next, and see what the scores look like.');
  } else {
    showEnrolNote('Recording ' + enrolling.length + ' of ' + VOICE_ENROL_CLIPS +
      ' saved. Tap again and keep talking for about ' + VOICE_ENROL_TARGET_SECONDS + ' seconds.');
  }
  renderAll();
}

/** Which model made a print, so a swapped model is visible rather than silent. */
function modelName() {
  return (state.voiceModelName || 'speaker.onnx');
}

// ---------- the page ----------

export function renderVoiceLock() {
  const card = document.getElementById('voiceLockCard');
  if (!card) return;
  const setting = voiceLock();

  const on = document.getElementById('voiceLockOn');
  const cal = document.getElementById('voiceLockCalibrate');
  const slider = document.getElementById('voiceThreshold');
  if (on) {
    on.checked = setting.enabled;
    // Nothing to gate against: offering the switch would only promise a
    // refusal.
    on.disabled = !setting.print;
  }
  if (cal) cal.checked = setting.calibrating;
  if (slider) {
    slider.min = String(VOICE_THRESHOLD_MIN);
    slider.max = String(VOICE_THRESHOLD_MAX);
    slider.step = String(VOICE_THRESHOLD_STEP);
    slider.value = String(setting.threshold);
  }

  const state1 = document.getElementById('voiceEnrolState');
  if (state1) {
    state1.textContent = setting.print
      ? 'Her voice was saved ' + (setting.print.enrolledAt || '').slice(0, 10) +
        ' from ' + Math.round(setting.print.seconds) + ' seconds. ' +
        'Record it again whenever it stops recognising her — voices change.'
      : 'No voice saved yet. Record her talking ' + VOICE_ENROL_CLIPS + ' times, ' +
        'about ' + VOICE_ENROL_TARGET_SECONDS + ' seconds each, saying anything at all.';
  }

  renderCalibration(setting);
}

function renderCalibration(setting) {
  const holder = document.getElementById('voiceScores');
  if (!holder) return;
  holder.innerHTML = '';

  if (!setting.log.length) {
    holder.innerHTML = '<span class="empty-note">No scores yet. ' +
      'With Calibration on, every recording adds one.</span>';
  } else {
    setting.log.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'score-row' + (entry.who ? ' tagged-' + entry.who : '');
      const value = document.createElement('b');
      value.className = 'score-value';
      value.textContent = entry.score.toFixed(3);
      const when = document.createElement('span');
      when.className = 'score-when';
      when.textContent = (entry.at || '').slice(11, 16) +
        (entry.where === 'refused' ? '  ·  refused' : '');
      row.append(value, when);

      // Tagging is what turns a list of numbers into a threshold: without
      // knowing which were her, the scores say nothing.
      [['her', 'Her'], ['other', 'Someone else']].forEach(([who, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-link score-tag' + (entry.who === who ? ' chosen' : '');
        button.textContent = label;
        button.addEventListener('click', () => { tagScore(entry.at, who); renderAll(); });
        row.appendChild(button);
      });
      holder.appendChild(row);
    });
  }

  const note = document.getElementById('voiceSuggestNote');
  if (!note) return;
  const suggestion = suggestThreshold(setting.log);
  if (suggestion.ok) {
    note.textContent = 'Her lowest score sits ' + suggestion.margin +
      ' above the highest anyone else scored. ' + suggestion.value +
      ' would separate them — but leave room, and prefer letting someone ' +
      'else through over locking her out.';
  } else if (suggestion.reason === 'overlap') {
    note.textContent = 'Her scores and other people’s overlap by ' + suggestion.overlap +
      ', so no threshold separates them cleanly. That is a real finding, not a ' +
      'setup problem: more enrolment may help, and if it does not, the honest ' +
      'answer is a loose gate that only catches the obvious cases.';
  } else {
    note.textContent = 'Tag some scores as hers and some as someone else — ' +
      'at least two of hers and one other — and a threshold can be suggested.';
  }
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

  document.getElementById('voiceLockOn').addEventListener('change', (e) => {
    updateVoiceLock({ enabled: e.target.checked });
    renderAll();
  });
  document.getElementById('voiceLockCalibrate').addEventListener('change', (e) => {
    updateVoiceLock({ calibrating: e.target.checked });
    renderAll();
  });
  document.getElementById('voiceThreshold').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value)) return;
    updateVoiceLock({ threshold: value });
    document.getElementById('voiceThresholdNote').textContent =
      'Accepting anything scoring ' + value.toFixed(2) + ' or higher.';
  });
  document.getElementById('voiceForget').addEventListener('click', () => {
    if (!window.confirm('Forget her saved voice? Voice Lock will switch off until she records it again.')) return;
    enrolling = [];
    clearEnrolment();
    forgetVoiceEngine();
    showEnrolNote('Her voice was forgotten. Record it again whenever you are ready.');
    renderAll();
  });
  document.getElementById('voiceClearScores').addEventListener('click', () => {
    clearLog();
    renderAll();
  });

  bindMic({
    buttonId: 'voiceEnrolMic',
    labelId: 'voiceEnrolMicLabel',
    // The longest mode there is: enrolment wants ten unhurried seconds, and
    // being cut off after a sentence is exactly what makes a print too thin.
    mode: 'passage',
    onResult: () => {},
    onClip: collectEnrolment
  });

  onRender(renderVoiceLock);
}

/** The last score the gate saw. Exported for the page and for tests. */
export function lastGateScore() {
  return lastScore;
}

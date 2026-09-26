// A quick answer: one box, no sheet.
//
// The worksheet is right for schoolwork, and wrong for a maths question with a
// short written part — a name to give the sheet and a box to paste a question
// into are both in the way when the whole job is one sentence. This is the
// page that was here before the worksheet, back as its own tab.
//
// **The same answer as the worksheet's, deliberately.** It is one
// `createAnswer` with no question attached, not a second copy of that code.
// Two implementations of the same box would drift the first time either was
// touched, and the one that drifted would be this one — the page nobody
// notices until she is using it. See CLAUDE.md §16.

import { onRender } from '../lib/store.js';
import { createAnswer } from './answer.js';

const IDS = {
  input: 'quickSaid',
  interim: 'quickRough',
  output: 'quickOut',
  contextNote: 'quickCtx',
  writeNote: 'quickNote',
  copyNote: 'quickCopied',
  mic: 'quickMic',
  micLabel: 'quickMicLabel',
  copy: 'quickCopy',
  readBack: 'quickHear',
  clear: 'quickClear'
};

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

export function initQuick() {
  const mount = document.getElementById('quickAnswer');
  if (!mount) return;

  mount.innerHTML = `
    <textarea class="answer-box" id="${IDS.input}"
      placeholder="Tap the mic and talk. You can type here too."></textarea>
    <div class="centre-row centre-col">
      <button class="mic-btn mic-btn-sm" id="${IDS.mic}" aria-label="Tap to record your answer">${MIC}</button>
      <div class="mic-label" id="${IDS.micLabel}">Tap to record</div>
    </div>

    <div class="interim" id="${IDS.interim}" aria-hidden="true"></div>

    <div class="eyebrow">Your answer</div>
    <div class="read-out answer-out" id="${IDS.output}"><span class="empty-note">Nothing here yet.</span></div>
    <div class="context-note" id="${IDS.contextNote}" role="status"></div>
    <div class="write-note" id="${IDS.writeNote}"></div>

    <div class="out-actions">
      <button class="btn btn-primary ans-copy" id="${IDS.copy}">Copy</button>
      <button class="btn btn-outline ans-read" id="${IDS.readBack}">Read it to me</button>
      <button class="btn btn-ghost ans-clear" id="${IDS.clear}">Start again</button>
      <span class="copy-note" id="${IDS.copyNote}" role="status"></span>
    </div>`;

  // No `onChange`: nothing here is kept. A scratch surface is the whole point,
  // and a quick answer quietly taking a slot in her five saved sheets would be
  // the opposite of what it is for.
  const answer = createAnswer({ ids: IDS });
  answer.render();

  // Confirming a correction in Word Bank changes what this box should read,
  // the same as on the worksheet.
  onRender(() => answer.render());
}

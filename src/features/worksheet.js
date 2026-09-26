// Her worksheet: one piece of schoolwork, with the questions she pasted in and
// the answers she said.
//
// The page used to be a single scratch box, which is not the shape of the work
// she actually does — weekly creative writing in paragraphs, and short reading
// and writing questions, both of which come as a question she has to answer and
// then paste back into Seesaw. See CLAUDE.md §14.
//
// The question box is hers to fill: she pastes it in herself, because she is
// nine and this is about doing her own schoolwork. The speaker beside it reads
// it out as many times as she wants, so a question she cannot read is not a
// question she cannot answer.

import { state, onRender, renderAll } from '../lib/store.js';
import { readAloud } from '../lib/speech.js';
import { copyText } from '../lib/clipboard.js';
import { MIC_IDLE } from './mic.js';
import { createAnswer } from './answer.js';
import {
  readSheets, saveSheet, deleteSheet, newSheet, newQuestion, sheetAsText, sheetHasContent
} from '../lib/sheets.js';


// The sheet on screen, and one live answer per question on it. `answers` is
// keyed by question id: rebuilding the page throws the old instances away with
// their DOM, and a stale one left behind would keep writing into nothing.
let sheet = null;
let answers = new Map();
let built = false;

const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a6.8 6.8 0 0 1 0 13.4v2.1a8.9 8.9 0 0 0 0-17.6z"/></svg>';

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

/** Element ids for one question block. Unique per question, so nothing collides. */
function idsFor(questionId) {
  const base = 'q_' + questionId.replace(/[^A-Za-z0-9_-]/g, '');
  return {
    question: base + '_ask',
    speak: base + '_speak',
    readAlong: base + '_along',
    remove: base + '_remove',
    input: base + '_said',
    interim: base + '_rough',
    output: base + '_out',
    contextNote: base + '_ctx',
    writeNote: base + '_note',
    copyNote: base + '_copied',
    mic: base + '_mic',
    micLabel: base + '_miclabel',
    copy: base + '_copy',
    readBack: base + '_hear',
    clear: base + '_clear'
  };
}

function store() {
  if (sheetHasContent(sheet)) saveSheet(sheet);
}

/** Pull every live answer's words back into the sheet before it is stored. */
function collect() {
  sheet.questions.forEach((question) => {
    const box = document.getElementById(idsFor(question.id).input);
    if (box) question.answer = box.value;
  });
}

function questionBlock(question, index) {
  const ids = idsFor(question.id);
  const card = document.createElement('div');
  card.className = 'card qa-card';
  card.dataset.questionId = question.id;
  card.innerHTML = `
    <div class="qa-head">
      <h2 class="qa-number">Question ${index + 1}</h2>
      <button type="button" class="icon-btn" id="${ids.speak}" title="Read the question out loud"
              aria-label="Read question ${index + 1} out loud">${SPEAKER}</button>
      <button type="button" class="btn btn-link qa-remove" id="${ids.remove}">Remove</button>
    </div>
    <label class="eyebrow" for="${ids.question}">Paste the question here</label>
    <textarea class="question-box" id="${ids.question}"
      placeholder="Copy the question from Seesaw and paste it here"></textarea>
    <!-- The question again, word by word, only while it is being read out:
         a textarea cannot light up one word inside it. -->
    <div class="read-along" id="${ids.readAlong}" aria-hidden="true"></div>

    <div class="eyebrow">Say your answer</div>
    <textarea class="answer-box" id="${ids.input}" placeholder="Tap the mic and talk. You can type here too."></textarea>
    <div class="centre-row centre-col">
      <button class="mic-btn mic-btn-sm" id="${ids.mic}" aria-label="Tap to record your answer">${MIC}</button>
      <div class="mic-label" id="${ids.micLabel}">${MIC_IDLE}</div>
    </div>

    <!-- A rough preview of what she is saying, while she says it. Never her
         answer: it is not in the box anything reads from. -->
    <div class="interim" id="${ids.interim}" aria-hidden="true"></div>

    <div class="eyebrow">Your answer</div>
    <div class="read-out answer-out" id="${ids.output}"><span class="empty-note">Nothing here yet.</span></div>
    <div class="context-note" id="${ids.contextNote}" role="status"></div>
    <div class="write-note" id="${ids.writeNote}"></div>

    <div class="out-actions">
      <button class="btn btn-primary ans-copy" id="${ids.copy}">Copy answer</button>
      <button class="btn btn-outline ans-read" id="${ids.readBack}">Read it to me</button>
      <button class="btn btn-ghost ans-clear" id="${ids.clear}">Start again</button>
      <span class="copy-note" id="${ids.copyNote}" role="status"></span>
    </div>`;
  return { card, ids };
}

function build() {
  const tab = document.getElementById('tab-write');
  if (!tab) return;
  const list = document.getElementById('sheetQuestions');
  if (!list) return;

  answers = new Map();
  list.innerHTML = '';

  sheet.questions.forEach((question, index) => {
    const { card, ids } = questionBlock(question, index);
    list.appendChild(card);

    document.getElementById(ids.question).value = question.question || '';
    document.getElementById(ids.question).addEventListener('input', (e) => {
      question.question = e.target.value;
      store();
    });

    // As many times as she needs, with each word lit as it is said. A second
    // tap while it is reading stops it rather than starting a second one.
    const speaker = document.getElementById(ids.speak);
    const along = document.getElementById(ids.readAlong);
    let reading = null;

    speaker.addEventListener('click', () => {
      if (reading) {
        reading.stop();
        return;
      }
      const asked = (question.question || '').trim();
      if (!asked) {
        readAloud(['There is no question here yet.']);
        return;
      }

      // The words again, as spans, because a textarea cannot light up one word
      // inside it. It is shown only while it is being read.
      const words = asked.split(/\s+/);
      along.innerHTML = '';
      words.forEach((word, index) => {
        const span = document.createElement('span');
        span.className = 'along-word';
        span.dataset.index = String(index);
        span.textContent = word;
        along.append(span, document.createTextNode(' '));
      });
      along.classList.add('show');
      speaker.classList.add('reading');

      // See answer.js: a run that finishes inside readAloud calls onDone before
      // the handle exists, and assigning it afterwards would resurrect it.
      let finished = false;
      const handle = readAloud(words, {
        onWord: (index) => {
          along.querySelectorAll('.along-word.saying')
            .forEach((span) => span.classList.remove('saying'));
          const span = along.querySelector('.along-word[data-index="' + index + '"]');
          if (span) {
            span.classList.add('saying');
            if (span.scrollIntoView) span.scrollIntoView({ block: 'nearest' });
          }
        },
        onDone: () => {
          finished = true;
          reading = null;
          along.classList.remove('show');
          along.innerHTML = '';
          speaker.classList.remove('reading');
        }
      });
      reading = finished ? null : handle;
    });

    document.getElementById(ids.remove).addEventListener('click', () => {
      if (sheet.questions.length === 1) return; // a sheet is at least one question
      if ((question.question || '').trim() || (question.answer || '').trim()) {
        if (!window.confirm('Remove this question and its answer?')) return;
      }
      collect();
      sheet.questions = sheet.questions.filter((item) => item !== question);
      store();
      build();
    });

    const answer = createAnswer({
      ids,
      onChange: (text) => { question.answer = text; store(); }
    });
    answer.setText(question.answer || '');
    answers.set(question.id, answer);
  });

  // Removing is only offered where there is something to remove down to.
  list.querySelectorAll('.qa-remove').forEach((button) => {
    button.style.display = sheet.questions.length > 1 ? '' : 'none';
  });

  renderRecent();
}

/** What Copy would give for this question, live where it is on screen. */
function answerTextFor(question) {
  const live = answers.get(question.id);
  return live ? live.plainText() : question.answer || '';
}

function renderRecent() {
  const holder = document.getElementById('recentSheets');
  if (!holder) return;
  const others = readSheets().filter((item) => item.id !== sheet.id);
  holder.innerHTML = '';

  if (!others.length) {
    holder.innerHTML = '<span class="empty-note">Nothing saved yet.</span>';
    return;
  }

  others.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'sheet-row';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-ghost sheet-open';
    const count = item.questions.length;
    open.textContent = (item.title.trim() || 'Untitled sheet') +
      ' — ' + count + (count === 1 ? ' question' : ' questions');
    open.addEventListener('click', () => openSheet(item));

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'btn btn-link';
    drop.textContent = 'Delete';
    drop.addEventListener('click', () => {
      if (!window.confirm('Delete this sheet? It will be gone.')) return;
      deleteSheet(item.id);
      renderRecent();
    });

    row.append(open, drop);
    holder.appendChild(row);
  });
}

function openSheet(item) {
  collect();
  store();
  // A copy, so editing the open sheet does not reach into the stored list
  // before it is saved.
  sheet = JSON.parse(JSON.stringify(item));
  const title = document.getElementById('sheetTitle');
  if (title) title.value = sheet.title || '';
  build();
}

function startSheet() {
  collect();
  store();
  sheet = newSheet();
  const title = document.getElementById('sheetTitle');
  if (title) title.value = '';
  build();
}

export function initWorksheet() {
  const title = document.getElementById('sheetTitle');
  if (!title) return;

  // The most recent sheet is the one she was working on, so that is the one
  // that opens. A first visit gets a blank one.
  const recent = readSheets();
  sheet = recent.length ? JSON.parse(JSON.stringify(recent[0])) : newSheet();
  title.value = sheet.title || '';

  title.addEventListener('input', () => {
    sheet.title = title.value;
    store();
  });

  document.getElementById('addQuestion').addEventListener('click', () => {
    collect();
    sheet.questions.push(newQuestion());
    store();
    build();
    // The new question is the point of the tap, so it is what she should see.
    const last = document.querySelector('#sheetQuestions .qa-card:last-child');
    if (last && last.scrollIntoView) last.scrollIntoView({ block: 'start' });
  });

  // No confirmation here on purpose: nothing is lost. The sheet on screen is
  // saved on the way out and is the first row of the list underneath.
  document.getElementById('newSheet').addEventListener('click', startSheet);

  document.getElementById('copySheet').addEventListener('click', () => {
    // Synchronously, before anything is awaited: Safari ties the clipboard to
    // the tap that asked for it.
    const text = sheetAsText(sheet, answerTextFor);
    const note = document.getElementById('sheetCopyNote');
    const say = (message, kind) => {
      if (!note) return;
      note.textContent = message;
      note.className = 'copy-note' + (kind ? ' ' + kind : '');
      setTimeout(() => { note.textContent = ''; }, 4000);
    };
    if (!text) {
      say('Nothing to copy yet.', 'warn');
      return;
    }
    copyText(text).then((ok) => {
      say(ok ? 'Copied the whole sheet! Now paste it into Seesaw.'
             : 'It would not copy. Select the words and copy them yourself.',
        ok ? '' : 'warn');
    });
  });

  build();
  built = true;

  // Confirming a correction in Word Bank changes what every answer on the
  // sheet should read, so each one re-renders — but only re-renders. The sheet
  // itself is not rebuilt: a snapshot from another device arriving mid-sentence
  // must not throw away words she is part way through saying, so a new sheet
  // from elsewhere shows up in the list rather than replacing what is open.
  onRender(() => {
    if (!built) return;
    answers.forEach((answer) => answer.render());
    renderRecent();
  });
}

/** The sheet on screen. Exported for tests and for the e2e smoke run. */
export function currentSheet() {
  collect();
  return sheet;
}

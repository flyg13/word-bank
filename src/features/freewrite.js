import { state, save, onRender, renderAll } from '../lib/store.js';
import { applyBankToText, recordBankObservation, getBankEntry } from '../lib/wordbank.js';
import { suggestFromSound } from '../lib/phonicbank.js';
import { normalize } from '../lib/text.js';
import { correctWithContext, splitForCorrection, ContextError } from '../lib/context-correct.js';
import { recordContextChanges, markReverted, markReapplied } from '../lib/correction-log.js';
import { bindMic } from './mic.js';
import { activateTab } from './tabs.js';

// What Claude decided about the transcript currently in the box.
//
// Held against the exact text it read: the moment that text is edited or added
// to, the decisions no longer describe it and the view falls back to the bank's
// own find-and-replace. Nothing here is ever saved — see CLAUDE.md §10, the
// bank learns in Practice, Sentences and Reading, and never from this.
let context = null;

function contextFor(text) {
  return context && context.text === text ? context : null;
}

function showContextNote(text, kind) {
  const note = document.getElementById('contextNote');
  if (!note) return;
  note.textContent = text || '';
  note.className = 'context-note' + (kind ? ' ' + kind : '');
  note.classList.toggle('show', Boolean(text));
}

function showWriteNote(text) {
  const note = document.getElementById('writeNote');
  if (note) note.textContent = text || '';
}

/**
 * Accept a suggestion. This is the same evidence a confirmation in Practice
 * gives — one sighting of "this text means that word" — so it goes through the
 * same pending-then-active path rather than applying outright.
 */
function acceptSuggestion(rawKey, word) {
  recordBankObservation(rawKey, word);
  save('word_bank', state.wordBank);
  const entry = getBankEntry(rawKey);
  showWriteNote(
    entry && entry.active
      ? 'Confirmed — “' + rawKey + '” now reads as “' + word + '” on its own.'
      : 'Noted — “' + rawKey + '” means “' + word + '”. One more sighting and it will apply on its own.'
  );
  renderAll();
}

export function renderCorrectedOutput() {
  const input = document.getElementById('rawInput');
  const out = document.getElementById('correctedOutput');
  const text = input ? input.value : '';

  if (!text.trim()) {
    out.innerHTML = '<span class="empty-note">Nothing here yet.</span>';
    return;
  }

  const decided = contextFor(text);
  if (decided) {
    renderWithContext(out, text, decided);
    return;
  }

  out.innerHTML = '';
  applyBankToText(text).forEach((part) => {
    if (part.raw === '' || /^\s+$/.test(part.raw)) {
      out.appendChild(document.createTextNode(part.raw));
      return;
    }
    const span = document.createElement('span');
    span.textContent = part.display;
    span.dataset.rawKey = part.key;
    span.dataset.original = part.raw;

    // A recorded pronunciation can suggest what a loose word probably was, but
    // never rewrites it. One tap accepts, and that counts as a sighting.
    const suggestion = part.fixed ? null : suggestFromSound(part.raw);
    if (suggestion) {
      span.className = 'wtok suggest';
      span.title = 'Sounds like “' + suggestion + '” — tap to accept';
      span.addEventListener('click', () => acceptSuggestion(normalize(part.raw), suggestion));
    } else {
      span.className = 'wtok' + (part.fixed ? ' fixed' : '');
      span.addEventListener('click', () => openFixPanel(span, false));
    }
    out.appendChild(span);
  });
}

/**
 * Turn one of Claude's changes off, or back on.
 *
 * A tap is a toggle, never a one-way door. A marked word invites a tap, and a
 * nine-year-old will take that invitation out of curiosity — if the first tap
 * were final she would have destroyed a correction with no way to ask for it
 * back, and the parent would not even know which word it had been.
 */
function toggleChange(change, raw) {
  change.reverted = !change.reverted;
  if (change.logId) (change.reverted ? markReverted : markReapplied)(change.logId);
  showContextNote(
    change.reverted
      ? 'Put “' + raw + '” back — tap it again for Claude’s “' + change.to + '”. ' +
        'The log keeps this, so a change you keep undoing is easy to spot.'
      : 'Using Claude’s “' + change.to + '” again — tap it again for “' + raw + '”.',
    ''
  );
  renderCorrectedOutput();
}

/**
 * Render the transcript with Claude's decisions applied.
 *
 * Every word Claude changed is marked, and one tap puts it back — which is the
 * whole safety story for a step that rewrites without being asked. It stays
 * marked once it is back, in its own state, because a change that could not be
 * reapplied would be a worse trap than the silent rewrite. Words Claude left
 * alone behave exactly as they always have.
 */
function renderWithContext(out, text, decided) {
  const { parts, wordIndexOfPart } = splitForCorrection(text);
  const changeAt = new Map(decided.changes.map((change) => [change.index, change]));

  out.innerHTML = '';
  parts.forEach((raw, partIndex) => {
    const wordIndex = wordIndexOfPart[partIndex];
    if (wordIndex < 0) {
      out.appendChild(document.createTextNode(raw));
      return;
    }

    const change = changeAt.get(wordIndex);
    const span = document.createElement('span');
    span.dataset.rawKey = normalize(raw);
    span.dataset.original = raw;

    if (change) {
      const applied = !change.reverted;
      span.className = 'wtok ' + (applied ? 'ctx-fixed' : 'ctx-original');
      span.textContent = applied ? change.to : raw;
      span.title = applied
        ? 'Claude read this as “' + change.to + '”' +
          (change.reason ? ': ' + change.reason : '') + ' — tap to put “' + raw + '” back'
        : '“' + raw + '” as the recogniser heard it — tap for Claude’s “' + change.to + '”' +
          (change.reason ? ': ' + change.reason : '');
      span.addEventListener('click', () => toggleChange(change, raw));
    } else {
      span.className = 'wtok';
      span.textContent = raw;
      span.addEventListener('click', () => openFixPanel(span, false));
    }
    out.appendChild(span);
  });
}

/**
 * Open the correction panel for a word token. Called from Speech-To-Text and, for
 * a mis-read word, from Sentences and Reading — which is why it jumps to the
 * Speech-To-Text tab where the panel lives.
 *
 * @param {HTMLElement} span   the clicked token
 * @param {boolean} fromSentence  prefill with the expected word rather than the
 *                                displayed one
 */
export function openFixPanel(span, fromSentence) {
  const panel = document.getElementById('fixPanel');
  const key = span.dataset.rawKey;
  if (!key) return; // nothing heard here — no correction to attach

  panel.classList.add('show');
  panel.dataset.rawKey = key;
  document.getElementById('fixingWord').textContent =
    '"' + (span.dataset.original || span.textContent) + '"';

  const input = document.getElementById('fixInput');
  input.value = fromSentence ? span.dataset.expected || '' : span.textContent;

  activateTab('write');
  input.focus();
}

export function initFreeWrite() {
  const rawInput = document.getElementById('rawInput');
  rawInput.addEventListener('input', () => {
    showWriteNote('');
    // Editing the text makes any decision about it stale, and a note still
    // claiming "3 words changed" would be describing something else.
    showContextNote('');
    renderCorrectedOutput();
  });

  document.getElementById('cancelFix').addEventListener('click', () => {
    document.getElementById('fixPanel').classList.remove('show');
  });

  document.getElementById('saveFix').addEventListener('click', () => {
    const panel = document.getElementById('fixPanel');
    const key = panel.dataset.rawKey;
    const value = document.getElementById('fixInput').value.trim();
    if (!key || !value) return;
    recordBankObservation(key, value);
    save('word_bank', state.wordBank);
    panel.classList.remove('show');
    renderAll();
  });

  bindMic({
    buttonId: 'writeMic',
    labelId: 'writeMicLabel',
    // Nothing is expected here, so there is no target to hint with and no
    // reason to be impatient about a pause.
    mode: 'freeform',
    onResult: (heard) => {
      rawInput.value = (rawInput.value ? rawInput.value + ' ' : '') + heard;
      renderCorrectedOutput();
      readInContext(rawInput.value);
    }
  });

  onRender(renderCorrectedOutput);
}

/**
 * Read the transcript back with its own sentence in view.
 *
 * Runs only on speech, never on typing: typed text is the parent testing the
 * bank, and the blind find-and-replace is exactly what they are testing.
 */
async function readInContext(text) {
  context = null;
  showContextNote('Reading it back in context…', '');

  let decided;
  try {
    decided = await correctWithContext(text);
  } catch (e) {
    const code = e instanceof ContextError ? e.code : 'context-failed';
    // Fall back to what the app did before: apply confirmed corrections
    // blindly. That is the behaviour this feature exists to replace, so it is
    // said out loud rather than left to look like the new one.
    showContextNote(
      'Context correction unavailable (' + code + '). Showing her confirmed ' +
      'corrections applied to every match, which is what this replaces — a word ' +
      'that only looks like one of hers will have been changed too.',
      'warn'
    );
    renderCorrectedOutput();
    return;
  }

  const ids = recordContextChanges(decided.changes);
  decided.changes.forEach((change, i) => { change.logId = ids[i]; });
  context = { text, changes: decided.changes };

  showContextNote(
    decided.changes.length
      ? 'Read in context: ' + decided.changes.length +
        (decided.changes.length === 1 ? ' word' : ' words') +
        ' changed, marked above. Tap one to put it back, tap it again to use ' +
        'Claude’s word.'
      : 'Read in context: nothing needed changing.',
    ''
  );
  renderCorrectedOutput();
  renderAll();
}

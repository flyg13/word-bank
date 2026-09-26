import { state, save, onRender, renderAll } from '../lib/store.js';
import { applyBankToText, blindToken, recordBankObservation, getBankEntry } from '../lib/wordbank.js';
import { suggestFromSound } from '../lib/phonicbank.js';
import { normalize } from '../lib/text.js';
import { correctWithContext, splitForCorrection, ContextError } from '../lib/context-correct.js';
import { recordContextChanges, markReverted, markReapplied } from '../lib/correction-log.js';
import { copyText } from '../lib/clipboard.js';
import { bindMic } from './mic.js';
import { activateTab } from './tabs.js';

// What Claude decided about the transcript currently in the box:
//
//   text     the exact text these decisions describe. The moment it is edited
//            the decisions no longer describe it and the view falls back to
//            the bank's own find-and-replace.
//   changes  one per word Claude changed, at its position in `text`.
//   unread   stretches of `text` the context step could not read at all, as
//            half-open word ranges. Her confirmed corrections are applied
//            blindly inside them — the old whole-box behaviour, now confined
//            to the sentence it actually happened to — and each carries what
//            it would take to ask again.
//
// Nothing here is ever saved: see CLAUDE.md §10, the bank learns in Practice,
// Sentences and Reading, and never from this.
let context = null;

function contextWith(text, changes, unread) {
  return { text, changes, unread: unread || [] };
}

/** The unread stretch this word index falls in, if any. */
function unreadAt(decided, wordIndex) {
  return (decided.unread || [])
    .find((run) => wordIndex >= run.from && wordIndex < run.to) || null;
}

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

// The copy confirmation. Brief on purpose: it answers "did that work?" and then
// gets out of the way, because it sits directly under the text she is about to
// paste.
let copyNoteTimer = null;

function showCopyNote(text, kind) {
  const note = document.getElementById('copyNote');
  if (!note) return;
  clearTimeout(copyNoteTimer);
  note.textContent = text || '';
  note.className = 'copy-note' + (kind ? ' ' + kind : '');
  if (text) copyNoteTimer = setTimeout(() => { note.textContent = ''; }, 4000);
}

/** Copy and Clear mean nothing with an empty box, and say so by being off. */
function updateOutActions(hasText) {
  ['copyBtn', 'clearBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = !hasText;
  });
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

/**
 * The corrected panel's contents, as data: one entry per part of the text,
 * whitespace included, carrying what to show and why.
 *
 * Both the view and the Copy button read this, and that is the point. What
 * lands in her homework has to be the same words that are on the screen —
 * built from the same decisions, not scraped off the DOM, where a mark that is
 * a CSS pseudo-element today could be a real character tomorrow and put an
 * arrow in a Seesaw post.
 */
function correctedParts(text, decided) {
  if (decided) {
    const { parts, wordIndexOfPart } = splitForCorrection(text);
    const changeAt = new Map(decided.changes.map((change) => [change.index, change]));

    // A gap belongs to an unread run only when the words on both sides of it
    // do — otherwise the wash would bleed past the last word of the run.
    const gapRun = (partIndex) => {
      let before = null;
      for (let i = partIndex - 1; i >= 0; i -= 1) {
        if (wordIndexOfPart[i] >= 0) { before = unreadAt(decided, wordIndexOfPart[i]); break; }
      }
      if (!before) return null;
      for (let i = partIndex + 1; i < parts.length; i += 1) {
        if (wordIndexOfPart[i] >= 0) {
          return unreadAt(decided, wordIndexOfPart[i]) === before ? before : null;
        }
      }
      return null;
    };

    return parts.map((raw, partIndex) => {
      const wordIndex = wordIndexOfPart[partIndex];
      if (wordIndex < 0) return { raw, display: raw, space: true, run: gapRun(partIndex) };
      // Inside a stretch that was never read, there is no decision to respect,
      // so the bank fires the way it always used to — but only here, and the
      // run is marked as not having been checked.
      const run = unreadAt(decided, wordIndex);
      if (run) {
        const blind = blindToken(raw);
        return { raw, key: blind.key, display: blind.display, fixed: blind.fixed, run };
      }

      const change = changeAt.get(wordIndex);
      // A word Claude left alone is shown as she said it. The bank's blind
      // replacement is deliberately not applied on top: Claude read this
      // sentence and decided, and that decision stands.
      return {
        raw, key: normalize(raw), change,
        display: change && !change.reverted ? change.to : raw
      };
    });
  }

  return applyBankToText(text).map((part) => {
    if (part.raw === '' || /^\s+$/.test(part.raw)) {
      return { raw: part.raw, display: part.raw, space: true };
    }
    // A recorded pronunciation can suggest what a loose word probably was, but
    // never rewrites it. One tap accepts, and that counts as a sighting.
    return {
      raw: part.raw, display: part.display, key: part.key, fixed: part.fixed,
      suggestion: part.fixed ? null : suggestFromSound(part.raw)
    };
  });
}

/**
 * The finished text: her words with the corrections that are showing, and
 * nothing else — no arrows, no marks, no highlighting.
 *
 * This is what goes on the clipboard and from there into Seesaw or Word, which
 * is what the tab is for.
 */
export function correctedPlainText() {
  const input = document.getElementById('rawInput');
  const text = input ? input.value : '';
  if (!text.trim()) return '';
  return correctedParts(text, contextFor(text)).map((part) => part.display).join('');
}

export function renderCorrectedOutput() {
  const input = document.getElementById('rawInput');
  const out = document.getElementById('correctedOutput');
  const text = input ? input.value : '';

  updateOutActions(Boolean(text.trim()));

  if (!text.trim()) {
    out.innerHTML = '<span class="empty-note">Nothing here yet.</span>';
    return;
  }

  out.innerHTML = '';
  // A stretch that was never read is wrapped as one run, not marked word by
  // word: what went wrong happened to the whole sentence. `wrap` is the run
  // currently open, so consecutive parts of the same one land inside it.
  let wrap = null;
  let wrapFor = null;
  const into = (run) => {
    if (run !== wrapFor) {
      wrapFor = run;
      wrap = null;
      if (run) {
        wrap = document.createElement('span');
        wrap.className = 'unread-run';
        wrap.title = 'This part could not be read in context (' + run.code + '). ' +
          'Her confirmed corrections were applied to every match here.';
        out.appendChild(wrap);
      }
    }
    return wrap || out;
  };

  correctedParts(text, contextFor(text)).forEach((part) => {
    if (part.space) {
      into(part.run || null).appendChild(document.createTextNode(part.raw));
      return;
    }
    const span = document.createElement('span');
    span.textContent = part.display;
    span.dataset.rawKey = part.key;
    span.dataset.original = part.raw;

    if (part.change) {
      addContextMark(span, part);
    } else if (part.suggestion) {
      span.className = 'wtok suggest';
      span.title = 'Sounds like \u201c' + part.suggestion + '\u201d \u2014 tap to accept';
      span.addEventListener('click', () => acceptSuggestion(normalize(part.raw), part.suggestion));
    } else {
      span.className = 'wtok' + (part.fixed ? ' fixed' : '');
      span.addEventListener('click', () => openFixPanel(span, false));
    }
    into(part.run || null).appendChild(span);
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
 * Mark a word Claude changed after reading the sentence, and wire the tap that
 * toggles it.
 *
 * The word is marked in both states — whichever word is showing, the mark says
 * it can be tapped again — which is the whole safety story for a step that
 * rewrites without being asked. The text itself is already set from the part's
 * `display`, so this only decides how it reads and what the tap does. Words
 * Claude left alone behave exactly as they always have.
 */
function addContextMark(span, part) {
  const { change, raw } = part;
  const applied = !change.reverted;
  span.className = 'wtok ' + (applied ? 'ctx-fixed' : 'ctx-original');
  span.title = applied
    ? 'Claude read this as “' + change.to + '”' +
      (change.reason ? ': ' + change.reason : '') +
      ' — tap to put “' + raw + '” back'
    : '“' + raw + '” as the recogniser heard it — tap for Claude’s “' + change.to + '”' +
      (change.reason ? ': ' + change.reason : '');
  span.addEventListener('click', () => toggleChange(change, raw));
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
    // The gap between the recording ending and the words arriving is several
    // seconds, and this is where the parent is looking — not at the mic.
    onWorking: () => showContextNote('Writing down what she said\u2026', ''),
    onResult: (heard) => appendHeard(rawInput, heard)
  });

  document.getElementById('copyBtn').addEventListener('click', () => {
    // Built before anything asynchronous happens. Safari ties the clipboard to
    // the tap that asked for it, and an await here would spend that gesture and
    // be refused — on the one device she actually uses.
    const text = correctedPlainText();
    if (!text) {
      showCopyNote('Nothing to copy yet.', 'warn');
      return;
    }
    copyText(text).then((ok) => {
      showCopyNote(
        ok ? 'Copied \u2014 paste it into her homework.'
           : 'Could not copy \u2014 select the text above and copy it by hand.',
        ok ? '' : 'warn'
      );
    });
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    // Asked for, because a paragraph built across several recordings is not
    // something to lose to a stray tap — and the tap that clears it sits next
    // to the one that copies it.
    if (rawInput.value.trim() &&
        !window.confirm('Clear this and start fresh? The text here will be gone.')) {
      return;
    }
    rawInput.value = '';
    context = null;
    showContextNote('');
    showWriteNote('');
    showCopyNote('');
    renderCorrectedOutput();
  });

  onRender(renderCorrectedOutput);
}

/**
 * Add what she just said to the end of what is already there.
 *
 * A paragraph gets built a sentence at a time, so each recording adds on
 * rather than starting over — and the sentences already read keep their marks
 * while the new one is still being looked at.
 *
 * Only the new words are sent. Re-reading the whole paragraph would recompute
 * decisions the parent has already seen — silently putting back any they had
 * undone — and would make the wait grow with every sentence, which is the
 * thing CLAUDE.md §10's effort dial exists to keep short.
 */
async function appendHeard(rawInput, heard) {
  const addition = String(heard || '').trim();
  if (!addition) return;

  const before = rawInput.value;
  // Decisions that still describe what is in the box. Typing invalidates them,
  // in which case there is nothing to protect and the lot is read together —
  // which also gives Claude the typed words rather than skipping over them.
  const settled = contextFor(before);
  const joined = before.replace(/\s+$/, '');
  const next = joined ? joined + ' ' + addition : addition;
  const offset = settled ? splitForCorrection(joined).words.length : 0;

  rawInput.value = next;
  if (settled) {
    // Hold the earlier marks on screen through the wait. Appending does not
    // move any earlier word, so their indices still point where they did, and
    // any stretch that already failed to be read stays failed.
    context = contextWith(next, settled.changes.slice(), settled.unread.slice());
  }
  renderCorrectedOutput();

  await readInContext({
    send: settled ? addition : next,
    full: next,
    offset,
    keep: settled ? settled.changes.slice() : [],
    keepUnread: settled ? settled.unread.slice() : []
  });
}

/**
 * Read a piece of the transcript back with its own sentence in view.
 *
 * Runs only on speech, never on typing: typed text is the parent testing the
 * bank, and the blind find-and-replace is exactly what they are testing.
 *
 * @param {{send:string, full:string, offset:number, keep:Array, keepUnread:Array}} job
 *   `send` is the text Claude reads; `full` is everything in the box, which is
 *   what the decisions end up describing; `offset` shifts the word positions
 *   that come back so they point into `full`; `keep` and `keepUnread` are what
 *   is already known about the earlier sentences, which a failure here must
 *   not disturb.
 */
async function readInContext(job) {
  const { send, full, offset, keep, keepUnread } = job;
  showContextNote('Reading it back in context\u2026', '');

  let decided;
  try {
    decided = await correctWithContext(send);
  } catch (e) {
    failedToRead(job, e instanceof ContextError ? e.code : 'context-failed');
    return;
  }

  // Positions come back against `send`; they have to point into the whole box.
  const fresh = decided.changes.map((change) => ({ ...change, index: change.index + offset }));
  const ids = recordContextChanges(fresh);
  fresh.forEach((change, i) => { change.logId = ids[i]; });
  context = contextWith(full, keep.concat(fresh), keepUnread);

  showContextNote(
    fresh.length
      ? 'Read in context: ' + fresh.length +
        (fresh.length === 1 ? ' word' : ' words') +
        ' changed, marked above. Tap one to put it back, tap it again to use ' +
        'Claude\u2019s word.'
      : 'Read in context: nothing needed changing.',
    ''
  );
  if (keepUnread.length) showUnreadNote();
  renderCorrectedOutput();
  renderAll();
}

/**
 * One sentence could not be read in context.
 *
 * What this deliberately does *not* do is throw away the rest. Until the
 * parent hit it on the iPad with a dropped connection, a failure here reset
 * the whole box to the blind find-and-replace: sentences that had been read
 * correctly were silently recomputed, and words they had tapped to put back
 * came back changed. One lost connection undid a paragraph of review.
 *
 * So the fallback is now confined to the words that were actually being read.
 * Her confirmed corrections still fire inside that stretch — that is the
 * documented behaviour and a known mispronunciation should not be left wrong —
 * but the stretch is marked as unchecked, and it can be asked about again.
 */
function failedToRead(job, code) {
  const { full, offset, keep, keepUnread } = job;
  const total = splitForCorrection(full).words.length;
  const run = { from: offset, to: total, code, job };
  context = contextWith(full, keep, keepUnread.concat(run));
  showUnreadNote();
  renderCorrectedOutput();
}

/**
 * Say what was not read, and offer to ask again.
 *
 * Never silent, and never quietly folded into the ordinary note: the marked
 * stretch is running on the blind find-and-replace, which is the behaviour
 * this whole feature exists to replace, so a word that only looks like one of
 * hers will have been changed in there.
 */
function showUnreadNote() {
  const runs = (context && context.unread) || [];
  if (!runs.length) return;
  const note = document.getElementById('contextNote');
  if (!note) return;

  const codes = [...new Set(runs.map((run) => run.code))].join(', ');
  note.className = 'context-note warn show';
  note.textContent =
    (runs.length === 1 ? 'That sentence could not be read in context (' : runs.length +
      ' sentences could not be read in context (') + codes + '). ' +
    'It is marked above, with her confirmed corrections applied to every match ' +
    'inside it \u2014 a word that only looks like one of hers will have been changed ' +
    'too. Everything before it is untouched.';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry-read';
  retry.textContent = runs.length === 1 ? 'Read it again' : 'Read them again';
  retry.addEventListener('click', () => { retry.disabled = true; retryUnread(); });
  note.append(' ', retry);
}

/**
 * Ask again about every stretch that was not read.
 *
 * Each run kept the job that produced it, so this is the same request as
 * before rather than a reconstruction of it. A run whose text has since been
 * edited is dropped instead of retried: its word positions would no longer
 * mean anything, and a retry that lands on the wrong words is worse than no
 * retry at all.
 */
async function retryUnread() {
  const current = context;
  if (!current || !current.unread.length) return;

  const input = document.getElementById('rawInput');
  if (!input || input.value !== current.text) {
    showContextNote('The text changed, so there is nothing to read again \u2014 record ' +
      'the sentence once more instead.', 'warn');
    return;
  }

  const runs = current.unread.slice();
  // The mark stays up while the asking happens. Clearing it first would show
  // the words with no correction at all for as long as the request takes, and
  // would say the stretch had been read before anyone knew whether it had.
  showContextNote('Reading it back in context\u2026', '');

  for (const run of runs) {
    // Sequential, so each one's decisions land on a context that already
    // carries the one before it. A run only leaves `unread` by being read;
    // if this fails again, failedToRead puts it straight back.
    const others = (context.unread || []).filter((other) => other !== run);
    await readInContext({
      ...run.job,
      full: current.text,
      keep: context.changes.slice(),
      keepUnread: others
    });
  }
}

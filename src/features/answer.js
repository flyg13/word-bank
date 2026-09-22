// One answer on her worksheet: say it, see it, hear it back, copy it.
//
// This is the Speech-To-Text box that used to be the whole tab, turned into
// something a sheet can have several of. Everything it does is unchanged —
// the mic, recordings adding to the end, context correction, tap-to-toggle,
// Copy — but every piece of state that used to sit at module level now belongs
// to one instance, because a sheet has one of these per question and they must
// not see each other's decisions.

import { state, save, renderAll } from '../lib/store.js';
import { applyBankToText, blindToken, recordBankObservation, getBankEntry } from '../lib/wordbank.js';
import { suggestFromSound } from '../lib/phonicbank.js';
import { normalize } from '../lib/text.js';
import { readAloud } from '../lib/speech.js';
import { correctWithContext, splitForCorrection, ContextError } from '../lib/context-correct.js';
import { recordContextChanges, markReverted, markReapplied } from '../lib/correction-log.js';
import { copyText } from '../lib/clipboard.js';
import { bindMic } from './mic.js';
import { openFixPanel } from './fix-panel.js';

/**
 * Wire up one answer.
 *
 * @param {{
 *   ids: {
 *     input: string, output: string, contextNote: string, writeNote: string,
 *     copyNote: string, mic: string, micLabel: string,
 *     copy?: string, clear?: string, readBack?: string
 *   },
 *   onChange?: (text: string) => void
 * }} options
 *   `ids` names the elements this instance owns — one set per answer, so a
 *   worksheet with four questions has four of these and nothing is shared.
 *   `onChange` fires whenever her words change, so the sheet can save itself.
 * @returns {{render: () => void, plainText: () => string, setText: (t: string) => void}}
 */
export function createAnswer({ ids, onChange }) {
  const el = (name) => (ids[name] ? document.getElementById(ids[name]) : null);
  const tell = () => { if (onChange) onChange(rawText()); };

  // What Claude decided about the words in this box:
  //
  //   text     the exact text these decisions describe. The moment it is
  //            edited the decisions no longer describe it and the view falls
  //            back to the bank's own find-and-replace.
  //   changes  one per word Claude changed, at its position in `text`.
  //   unread   stretches of `text` the context step could not read at all, as
  //            half-open word ranges. Her confirmed corrections are applied
  //            blindly inside them — the old whole-box behaviour, confined to
  //            the sentence it actually happened to — and each carries what it
  //            would take to ask again.
  //
  // Nothing here is ever saved: see CLAUDE.md §10, the bank learns in
  // Practice, Sentences and Reading, and never from this.
  let context = null;
  let copyNoteTimer = null;

  function rawText() {
    const input = el('input');
    return input ? input.value : '';
  }

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
    const note = el('contextNote');
    if (!note) return;
    note.textContent = text || '';
    note.className = 'context-note' + (kind ? ' ' + kind : '');
    note.classList.toggle('show', Boolean(text));
  }

  function showWriteNote(text) {
    const note = el('writeNote');
    if (note) note.textContent = text || '';
  }

  // The copy confirmation. Brief on purpose: it answers "did that work?" and
  // then gets out of the way, because it sits directly under the words she is
  // about to paste.
  function showCopyNote(text, kind) {
    const note = el('copyNote');
    if (!note) return;
    clearTimeout(copyNoteTimer);
    note.textContent = text || '';
    note.className = 'copy-note' + (kind ? ' ' + kind : '');
    if (text) copyNoteTimer = setTimeout(() => { note.textContent = ''; }, 4000);
  }

  /** The buttons mean nothing with an empty box, and say so by being off. */
  function updateOutActions(hasText) {
    ['copy', 'clear', 'readBack'].forEach((name) => {
      const button = el(name);
      if (button) button.disabled = !hasText;
    });
  }

  /**
   * Accept a suggestion. This is the same evidence a confirmation in Practice
   * gives — one sighting of "this text means that word" — so it goes through
   * the same pending-then-active path rather than applying outright.
   */
  function acceptSuggestion(rawKey, word) {
    recordBankObservation(rawKey, word);
    save('word_bank', state.wordBank);
    const entry = getBankEntry(rawKey);
    showWriteNote(
      entry && entry.active
        ? 'Got it — “' + rawKey + '” now means “' + word + '”.'
        : 'Thanks — one more time and “' + rawKey + '” will mean “' + word + '” on its own.'
    );
    renderAll();
  }

  /**
   * The panel's contents, as data: one entry per part of the text, whitespace
   * included, carrying what to show and why.
   *
   * Both the view and the Copy button read this, and that is the point. What
   * lands in her homework has to be the same words that are on the screen —
   * built from the same decisions, not scraped off the DOM, where a mark that
   * is a CSS pseudo-element today could be a real character tomorrow and put
   * an arrow in a Seesaw post. Reading it aloud uses it too, for the same
   * reason: she checks her work by ear, so what she hears has to be what she
   * would hand in.
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

        // Inside a stretch that was never read, there is no decision to
        // respect, so the bank fires the way it always used to — but only
        // here, and the run is marked as not having been checked.
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
      // A recorded pronunciation can suggest what a loose word probably was,
      // but never rewrites it. One tap accepts, and that counts as a sighting.
      return {
        raw: part.raw, display: part.display, key: part.key, fixed: part.fixed,
        suggestion: part.fixed ? null : suggestFromSound(part.raw)
      };
    });
  }

  /**
   * The words of the finished answer, in order — one entry per token on
   * screen, so the nth word here is the nth `.wtok` in the panel.
   *
   * Built from the same parts as the view and as Copy rather than by splitting
   * the finished string, because a bank replacement can itself be two words
   * ("yo yo" for one token) and splitting would put the highlight one word out
   * from there on.
   */
  function spokenWords() {
    const text = rawText();
    if (!text.trim()) return [];
    return correctedParts(text, contextFor(text))
      .filter((part) => !part.space)
      .map((part) => part.display);
  }

  /**
   * The finished answer: her words with the corrections that are showing, and
   * nothing else — no arrows, no marks, no highlighting.
   */
  function plainText() {
    const text = rawText();
    if (!text.trim()) return '';
    return correctedParts(text, contextFor(text)).map((part) => part.display).join('');
  }

  function render() {
    const out = el('output');
    if (!out) return;
    const text = rawText();

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
          wrap.title = 'I could not check this bit (' + run.code + '), ' +
            'so your usual word swaps were used on every match in it.';
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
        span.title = 'Sounds like “' + part.suggestion + '” — tap if that is right';
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
   * A tap is a toggle, never a one-way door. A marked word invites a tap, and
   * a nine-year-old will take that invitation out of curiosity — if the first
   * tap were final she would have destroyed a correction with no way to ask
   * for it back, and nobody would know which word it had been.
   */
  function toggleChange(change, raw) {
    change.reverted = !change.reverted;
    if (change.logId) (change.reverted ? markReverted : markReapplied)(change.logId);
    showContextNote(
      change.reverted
        ? 'Put “' + raw + '” back. Tap it again for “' + change.to + '”.'
        : 'Using “' + change.to + '” again. Tap it again for “' + raw + '”.',
      ''
    );
    render();
  }

  /**
   * Mark a word Claude changed after reading the sentence, and wire the tap
   * that toggles it.
   *
   * The word is marked in both states — whichever word is showing, the mark
   * says it can be tapped again — which is the whole safety story for a step
   * that rewrites without being asked. The text itself is already set from the
   * part's `display`, so this only decides how it reads and what the tap does.
   */
  function addContextMark(span, part) {
    const { change, raw } = part;
    const applied = !change.reverted;
    span.className = 'wtok ' + (applied ? 'ctx-fixed' : 'ctx-original');
    span.title = applied
      ? 'You said “' + raw + '”. I think you meant “' + change.to + '”' +
        (change.reason ? ': ' + change.reason : '') + ' — tap to change it back'
      : '“' + raw + '” is what I heard — tap to use “' + change.to + '”' +
        (change.reason ? ': ' + change.reason : '');
    span.addEventListener('click', () => toggleChange(change, raw));
  }

  /**
   * Add what she just said to the end of what is already there.
   *
   * A paragraph gets built a sentence at a time, so each recording adds on
   * rather than starting over — and the sentences already checked keep their
   * marks while the new one is still being looked at.
   *
   * Only the new words are sent. Re-reading the whole answer would recompute
   * decisions she has already seen — silently putting back any she had undone
   * — and would make the wait grow with every sentence.
   */
  async function appendHeard(heard) {
    const addition = String(heard || '').trim();
    if (!addition) return;

    const input = el('input');
    if (!input) return;
    const before = input.value;
    // Decisions that still describe what is in the box. Typing invalidates
    // them, in which case there is nothing to protect and the lot is read
    // together — which also gets the typed words read rather than skipped.
    const settled = contextFor(before);
    const joined = before.replace(/\s+$/, '');
    const next = joined ? joined + ' ' + addition : addition;
    const offset = settled ? splitForCorrection(joined).words.length : 0;

    input.value = next;
    if (settled) {
      // Hold the earlier marks on screen through the wait. Appending does not
      // move any earlier word, so their indices still point where they did,
      // and any stretch that already failed to be read stays failed.
      context = contextWith(next, settled.changes.slice(), settled.unread.slice());
    }
    render();
    tell();

    await readInContext({
      send: settled ? addition : next,
      full: next,
      offset,
      keep: settled ? settled.changes.slice() : [],
      keepUnread: settled ? settled.unread.slice() : []
    });
  }

  /**
   * Read a piece of her answer back with its own sentence in view.
   *
   * @param {{send:string, full:string, offset:number, keep:Array, keepUnread:Array}} job
   *   `send` is the text Claude reads; `full` is everything in the box, which
   *   is what the decisions end up describing; `offset` shifts the word
   *   positions that come back so they point into `full`; `keep` and
   *   `keepUnread` are what is already known about the earlier sentences,
   *   which a failure here must not disturb.
   */
  async function readInContext(job) {
    const { send, full, offset, keep, keepUnread } = job;
    showContextNote('Checking your words…', '');

    let decided;
    try {
      decided = await correctWithContext(send);
    } catch (e) {
      failedToRead(job, e instanceof ContextError ? e.code : 'context-failed');
      return;
    }

    // Positions come back against `send`; they have to point into the whole box.
    const fresh = decided.changes.map((change) => ({ ...change, index: change.index + offset }));
    const ids2 = recordContextChanges(fresh);
    fresh.forEach((change, i) => { change.logId = ids2[i]; });
    context = contextWith(full, keep.concat(fresh), keepUnread);

    showContextNote(
      fresh.length
        ? 'I changed ' + fresh.length + (fresh.length === 1 ? ' word' : ' words') +
          '. Tap a word to change it back.'
        : 'All good — nothing needed changing.',
      ''
    );
    if (keepUnread.length) showUnreadNote();
    render();
    tell();
    renderAll();
  }

  /**
   * One sentence could not be checked.
   *
   * What this deliberately does not do is throw away the rest. The fallback is
   * confined to the words that were actually being read: her confirmed
   * corrections still fire inside that stretch, but the stretch is marked as
   * unchecked and it can be asked about again.
   */
  function failedToRead(job, code) {
    const { full, offset, keep, keepUnread } = job;
    const total = splitForCorrection(full).words.length;
    const run = { from: offset, to: total, code, job };
    context = contextWith(full, keep, keepUnread.concat(run));
    showUnreadNote();
    render();
    tell();
  }

  /**
   * Say what was not checked, and offer to try again.
   *
   * Never silent: the marked stretch is running on the blind find-and-replace,
   * which is the behaviour the context step exists to replace, so a word that
   * only looks like one of hers will have been changed in there.
   */
  function showUnreadNote() {
    const runs = (context && context.unread) || [];
    if (!runs.length) return;
    const note = el('contextNote');
    if (!note) return;

    note.className = 'context-note warn show';
    note.textContent = runs.length === 1
      ? 'I could not check the marked bit. Your usual word swaps were used on ' +
        'every match in it. Everything before it is fine.'
      : 'I could not check the marked bits. Your usual word swaps were used on ' +
        'every match in them. Everything before them is fine.';

    // The sentence is hers; the code is for whoever has to work out why, on a
    // device that is not in front of them. CLAUDE.md §10 asks for the code by
    // name, so plainer wording is not allowed to quietly drop it — it is set
    // small and grey rather than removed.
    const codes = [...new Set(runs.map((run) => run.code))].join(', ');
    const hint = document.createElement('small');
    hint.className = 'code-hint';
    hint.textContent = '(' + codes + ')';
    note.append(' ', hint);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-read';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => { retry.disabled = true; retryUnread(); });
    note.append(' ', retry);
  }

  /**
   * Ask again about every stretch that was not checked.
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

    const input = el('input');
    if (!input || input.value !== current.text) {
      showContextNote('Your words changed, so there is nothing to check again.', 'warn');
      return;
    }

    const runs = current.unread.slice();
    // The mark stays up while the asking happens. Clearing it first would show
    // the words with no correction at all for as long as the request takes,
    // and would say the stretch had been checked before anyone knew.
    showContextNote('Checking your words…', '');

    for (const run of runs) {
      const others = (context.unread || []).filter((other) => other !== run);
      await readInContext({
        ...run.job,
        full: current.text,
        keep: context.changes.slice(),
        keepUnread: others
      });
    }
  }

  // ---------- wiring ----------

  const input = el('input');
  if (input) {
    input.addEventListener('input', () => {
      showWriteNote('');
      // Editing the text makes any decision about it stale, and a note still
      // claiming "3 words changed" would be describing something else.
      showContextNote('');
      render();
      tell();
    });
  }

  /**
   * Show, or clear, the rough preview of what she is saying.
   *
   * It lives in its own element and goes nowhere else. It is never in the box
   * her words are read from, so it cannot be saved, copied, read aloud or sent
   * to be checked — those all read `rawText()`, which this never touches.
   */
  function showInterim(text) {
    const box = el('interim');
    if (!box) return;
    box.textContent = text || '';
    box.classList.toggle('show', Boolean(text));
  }

  bindMic({
    buttonId: ids.mic,
    labelId: ids.micLabel,
    // Nothing is expected here, so there is no target to hint with and no
    // reason to be impatient about a pause.
    mode: 'freeform',
    // The gap between the recording ending and the words arriving is several
    // seconds, and this is where she is looking — not at the mic.
    onWorking: () => showContextNote('Writing down what you said…', ''),
    onInterim: showInterim,
    onResult: (heard) => appendHeard(heard)
  });

  const copyButton = el('copy');
  if (copyButton) {
    copyButton.addEventListener('click', () => {
      // Built before anything asynchronous happens. Safari ties the clipboard
      // to the tap that asked for it, and an await here would spend that
      // gesture and be refused — on the one device she actually uses.
      const text = plainText();
      if (!text) {
        showCopyNote('Nothing to copy yet.', 'warn');
        return;
      }
      copyText(text).then((ok) => {
        showCopyNote(
          ok ? 'Copied! Now paste it into Seesaw.'
             : 'It would not copy. Select the words above and copy them yourself.',
          ok ? '' : 'warn'
        );
      });
    });
  }

  // The read-aloud currently running on this answer, so a second tap stops it
  // rather than starting a second one underneath the first.
  let reading = null;

  function clearHighlight() {
    const out = el('output');
    if (!out) return;
    out.querySelectorAll('.wtok.saying').forEach((span) => span.classList.remove('saying'));
  }

  const readBack = el('readBack');
  if (readBack) {
    readBack.addEventListener('click', () => {
      if (reading) {
        reading.stop();
        return;
      }
      // The corrected words, not what she said into the mic: she checks her
      // work by ear, so what she hears has to be what she would hand in.
      const words = spokenWords();
      if (!words.length) {
        showCopyNote('Nothing to read yet.', 'warn');
        return;
      }
      readBack.textContent = 'Stop reading';
      // `finished` rather than clearing `reading` from onDone: a run that ends
      // inside readAloud — every word already spoken, or synthesis refusing —
      // calls onDone *before* the handle exists, and the assignment below
      // would then put a finished run back. It would never stop again.
      let finished = false;
      const handle = readAloud(words, {
        // Each word lights up as it is said. Seeing the word at the moment she
        // hears it is the point — it is what ties the sound to the shape of it.
        onWord: (index) => {
          const out = el('output');
          if (!out) return;
          clearHighlight();
          const spans = out.querySelectorAll('.wtok');
          const span = spans[index];
          if (span) {
            span.classList.add('saying');
            if (span.scrollIntoView) span.scrollIntoView({ block: 'nearest' });
          }
        },
        onDone: () => {
          finished = true;
          reading = null;
          readBack.textContent = 'Read it to me';
          clearHighlight();
        }
      });
      reading = finished ? null : handle;
    });
  }

  const clearButton = el('clear');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      const box = el('input');
      if (!box) return;
      if (box.value.trim() &&
          !window.confirm('Start this answer again? What you said will be gone.')) {
        return;
      }
      box.value = '';
      context = null;
      showContextNote('');
      showWriteNote('');
      showCopyNote('');
      render();
      tell();
    });
  }

  return {
    render,
    plainText,
    /** Put stored words back in the box, with no decisions attached to them. */
    setText(text) {
      const box = el('input');
      if (!box) return;
      if (reading) reading.stop();
      box.value = text || '';
      context = null;
      showContextNote('');
      showWriteNote('');
      showCopyNote('');
      render();
    }
  };
}

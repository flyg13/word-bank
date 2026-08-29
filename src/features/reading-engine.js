import { SENTENCE_MASTERY } from '../config.js';
import { alignWords, isCleanRead } from '../lib/align.js';
import { toWords, normalize } from '../lib/text.js';
import { wordsMatch } from '../lib/wordbank.js';
import { soundsLikeHerWord } from '../lib/phonicbank.js';
import { openFixPanel } from './freewrite.js';

// Sentences and Reading Passage differ only in where their text and progress
// live, so the read-and-score mechanics live here once.

/** Draw the "clean read" progress dots for a sentence. */
export function renderCleanDots(containerId, cleanCount) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  for (let i = 0; i < SENTENCE_MASTERY; i++) {
    const dot = document.createElement('div');
    dot.className = 'repeat-dot' + (i < cleanCount ? ' filled' : '');
    el.appendChild(dot);
  }
}

export function clearReadOutput(outputId) {
  document.getElementById(outputId).innerHTML =
    '<span style="color:var(--ink-dim);">Nothing yet.</span>';
}

function makeToken(className, text) {
  const span = document.createElement('span');
  span.className = 'wtok ' + className;
  span.textContent = text;
  return span;
}

/**
 * Score a heard utterance against the expected sentence and render the result.
 *
 * Words are aligned rather than compared position-by-position, so a dropped or
 * inserted word costs exactly one word instead of throwing off everything that
 * follows it. The comparison is bank-aware: a confirmed mispronunciation counts
 * as the word it stands for.
 *
 * A wrong word that sounds like a way she says the expected word is shown in
 * amber rather than red. That is a display annotation only — the alignment
 * itself and `isCleanRead` stay strict, so an approximate match never scores a
 * read as clean. Tapping the word banks the exact text, which is how the
 * precise correction accumulates towards going active.
 *
 * @returns {boolean} whether this was a clean read.
 */
export function renderReadResult(outputId, expectedSentence, heard) {
  const expectedWords = toWords(expectedSentence);
  const heardWords = toWords(heard);
  const ops = alignWords(expectedWords, heardWords, wordsMatch);

  const out = document.getElementById(outputId);
  out.innerHTML = '';

  ops.forEach((op) => {
    let span;
    if (op.type === 'match') {
      span = makeToken('match', op.heard);
      span.dataset.rawKey = normalize(op.heard);
      span.dataset.expected = op.expected;
      span.addEventListener('click', () => openFixPanel(span, true));
    } else if (op.type === 'substitute') {
      const soundsRight = soundsLikeHerWord(op.expected, op.heard);
      span = makeToken(soundsRight ? 'close' : 'mismatch', op.heard);
      if (soundsRight) {
        span.title =
          'Sounds like how she says “' + op.expected + '” — tap to confirm the correction';
      }
      span.dataset.rawKey = normalize(op.heard);
      span.dataset.expected = op.expected;
      span.addEventListener('click', () => openFixPanel(span, true));
    } else if (op.type === 'extra') {
      // A word with no counterpart in the sentence — often the recognizer
      // splitting one spoken word into two. Still worth being able to bank.
      span = makeToken('extra', op.heard);
      span.dataset.rawKey = normalize(op.heard);
      span.dataset.expected = '';
      span.title = 'Extra word — not in the sentence';
      span.addEventListener('click', () => openFixPanel(span, true));
    } else {
      // Missing: there is no heard text to attach a correction to, so this one
      // is informational only.
      span = makeToken('missing', op.expected);
      span.title = "Not heard — she may have skipped it";
    }
    out.appendChild(span);
    out.appendChild(document.createTextNode(' '));
  });

  return isCleanRead(ops) && heardWords.length > 0;
}

/** Append the "✓ Clean read (n/N)" note under a result. */
export function appendCleanNote(outputId, cleanCount) {
  const note = document.createElement('div');
  note.className = 'read-note clean';
  note.textContent =
    '✓ Clean read (' + Math.min(cleanCount, SENTENCE_MASTERY) + '/' + SENTENCE_MASTERY + ')';
  document.getElementById(outputId).appendChild(note);
}

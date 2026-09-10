// Small text helpers shared across features.

/**
 * Reduce a word to the form used as a bank key and for comparisons:
 * lowercase, letters and apostrophes only.
 */
export function normalize(word) {
  return (word || '').toLowerCase().replace(/[^a-z']/g, '');
}

/** Split a sentence into comparable words, dropping sentence punctuation. */
export function toWords(text) {
  return (text || '')
    .replace(/[.,!?;:"“”]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Fit a replacement word into the place of the word it replaces: keep the
 * original's surrounding punctuation ("liquor." stays a sentence end) and
 * match its case ("Liquor" at a sentence start becomes "Little", a lower-case
 * "liquor" becomes "little" even if the replacement arrived capitalised).
 *
 * Case follows the original in three shapes — all lower, all upper, or an
 * initial capital. Anything else (a mixed-case original) leaves the
 * replacement's own case alone, because there is no rule to copy.
 */
export function fitReplacement(original, replacement) {
  const shell = /^([^A-Za-z0-9']*)([\s\S]*?)([^A-Za-z0-9']*)$/.exec(String(original || ''));
  const word = shell[2];
  const core = String(replacement || '').replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '') ||
    String(replacement || '');
  return shell[1] + matchCase(word, core) + shell[3];
}

function matchCase(model, word) {
  const letters = model.replace(/[^A-Za-z]/g, '');
  if (!letters) return word;
  if (letters === letters.toLowerCase()) return word.toLowerCase();
  if (letters.length > 1 && letters === letters.toUpperCase()) return word.toUpperCase();
  if (/^[A-Z]/.test(letters) && letters.slice(1) === letters.slice(1).toLowerCase()) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return word;
}

/** Fisher-Yates, non-mutating. */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Split a passage into individual sentences on terminal punctuation. */
export function parsePassage(text) {
  return (text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

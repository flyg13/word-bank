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

// How much two words resemble each other, 0 (nothing in common) to 1 (identical).
//
// Used by the aligner to decide whether pairing two words as a substitution is
// a plausible reading. When §3 adds Double Metaphone, this is the seam to
// replace: swap in a phonetic-key comparison and the aligner improves with it.

import { normalize } from './text.js';

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current.slice();
  }
  return previous[b.length];
}

/** Character-level similarity of two words, ignoring case and punctuation. */
export function characterSimilarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x.length && !y.length) return 1;
  const longest = Math.max(x.length, y.length);
  if (!longest) return 1;
  return 1 - editDistance(x, y) / longest;
}

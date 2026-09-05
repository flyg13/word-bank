// The shared "family code" is the whole multi-device story: every device that
// types the same code reads and writes the same Firestore document.
//
// This lives apart from firestore.js on purpose. The entry screen needs to read
// and write the code before the Firebase SDK is loaded, and importing it from
// firestore.js would pull the whole 527 kB SDK into the main chunk and undo the
// lazy load.
//
// Storage is unchanged from the original app — same key, same normalisation —
// so a device that already has a code carries straight on.

const FAMILY_CODE_KEY = 'word_bank_family_code';

/** @returns {string|null} the stored code, without asking for one. */
export function getStoredFamilyCode() {
  return localStorage.getItem(FAMILY_CODE_KEY);
}

/**
 * Normalise a typed code and store it.
 *
 * Normalisation is the original's, unchanged: trim, lowercase, then anything
 * outside [a-z0-9-] becomes a hyphen. What is new is refusing a code with no
 * letter or digit left in it — "!!!" normalises to "---", which the original
 * prompt accepted and would have stored as the document id `families/---`.
 * A code already on a device is never re-validated, so nothing existing moves.
 *
 * @returns {string} the stored form, or '' if there was nothing usable
 */
export function saveFamilyCode(raw) {
  const code = (raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/[a-z0-9]/.test(code)) return '';
  localStorage.setItem(FAMILY_CODE_KEY, code);
  return code;
}

import { getStoredFamilyCode, saveFamilyCode } from '../lib/family-code.js';

// The family code gate. It replaces a browser prompt(), which on an iPad is a
// system dialog with no explanation of what is being asked for or why it
// matters — and which, if dismissed, left the app running with no sync and no
// way back short of a reload.
//
// Storage is untouched: same key, same normalisation, now in family-code.js so
// this screen does not have to load the Firebase SDK to read it. Only the
// asking moved.

/**
 * Resolve once a family code exists, showing the entry screen if it does not.
 *
 * @returns {Promise<string>} the stored code
 */
export function requireFamilyCode() {
  const existing = getStoredFamilyCode();
  if (existing) return Promise.resolve(existing);

  const screen = document.getElementById('entryScreen');
  const form = document.getElementById('entryForm');
  const input = document.getElementById('entryCode');
  const error = document.getElementById('entryError');

  screen.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = saveFamilyCode(input.value);
      if (!code) {
        // Normalisation strips everything but letters, digits and hyphens, so
        // an entry of only punctuation leaves nothing to store.
        error.textContent = 'Use letters and numbers — for example, harlie-home.';
        input.focus();
        return;
      }
      error.textContent = '';
      screen.hidden = true;
      resolve(code);
    });
  });
}

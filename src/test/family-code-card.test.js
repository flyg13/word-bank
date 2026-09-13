// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The "Change family code" card in Word Bank — the parent's decision, so a
// teacher can set up a school iPad, and the parent can leave a short code
// behind, without clearing Safari's website data.
//
// It must use exactly the storage the entry screen uses: the same key and the
// same normalisation, so the device ends up as if that code had been typed on
// first open.

const ROOT = resolve(import.meta.dirname, '../..');
const KEY = 'word_bank_family_code';

function bodyOf(html) {
  return html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

async function mount(storedCode) {
  document.body.innerHTML = bodyOf(readFileSync(resolve(ROOT, 'index.html'), 'utf8'));
  localStorage.clear();
  if (storedCode) localStorage.setItem(KEY, storedCode);
  vi.resetModules();
  const reload = vi.fn();
  const { initBank } = await import('../features/bank.js');
  initBank({ reload });
  return {
    reload,
    current: () => document.getElementById('familyCodeCurrent').textContent,
    note: () => document.getElementById('familyCodeNote').textContent,
    type: (value) => { document.getElementById('familyCodeInput').value = value; },
    go: () => document.getElementById('familyCodeBtn').click()
  };
}

describe('changing the family code from Word Bank', () => {
  beforeEach(() => { localStorage.clear(); });

  it('shows the code this device is using', async () => {
    const card = await mount('harlie-home');
    expect(card.current()).toBe('“harlie-home”');
  });

  it('stores a new code exactly as the entry screen would, then restarts', async () => {
    const card = await mount('harlie-home');
    card.type('  Room 12 Grade 4!  ');
    card.go();
    // The entry screen's normalisation: trim, lowercase, [^a-z0-9-] -> '-'.
    expect(localStorage.getItem(KEY)).toBe('room-12-grade-4-');
    expect(card.note()).toContain('room-12-grade-4-');
    expect(card.reload).toHaveBeenCalledTimes(1);
  });

  it('Enter in the field does the same as the button', async () => {
    const card = await mount('harlie-home');
    card.type('school-ipad');
    document.getElementById('familyCodeInput').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    expect(localStorage.getItem(KEY)).toBe('school-ipad');
    expect(card.reload).toHaveBeenCalledTimes(1);
  });

  it('refuses a code that normalises to nothing, and keeps the old one', async () => {
    const card = await mount('harlie-home');
    card.type('!!!');
    card.go();
    expect(localStorage.getItem(KEY)).toBe('harlie-home');
    expect(card.note()).toContain('letters and numbers');
    expect(card.reload).not.toHaveBeenCalled();
  });

  it('asks for something when the field is empty', async () => {
    const card = await mount('harlie-home');
    card.type('   ');
    card.go();
    expect(localStorage.getItem(KEY)).toBe('harlie-home');
    expect(card.note()).toContain('Type the code');
    expect(card.reload).not.toHaveBeenCalled();
  });

  it('does not restart for the code the device already has', async () => {
    const card = await mount('harlie-home');
    card.type('Harlie-Home');
    card.go();
    expect(localStorage.getItem(KEY)).toBe('harlie-home');
    expect(card.note()).toContain('already using');
    expect(card.reload).not.toHaveBeenCalled();
  });

  it('catches up once the entry screen has taken a code', async () => {
    // Word Bank is wired up before the entry screen resolves, so on a device
    // with no code the card first draws with nothing to show. main.js redraws
    // it after the entry screen; this is that redraw.
    const card = await mount(null);
    expect(card.current()).toBe('(none)');
    localStorage.setItem(KEY, 'harlie-home');
    const { renderFamilyCode } = await import('../features/bank.js');
    renderFamilyCode();
    expect(card.current()).toBe('“harlie-home”');
    const main = readFileSync(resolve(ROOT, 'src/main.js'), 'utf8');
    expect(main.indexOf('await requireFamilyCode()')).toBeLessThan(main.indexOf('renderFamilyCode()'));
  });

  it('the entry screen and the card agree on what a code is', () => {
    // Pinned by reading the source: the card must not grow its own rules.
    const bank = readFileSync(resolve(ROOT, 'src/features/bank.js'), 'utf8');
    const entry = readFileSync(resolve(ROOT, 'src/features/entry.js'), 'utf8');
    expect(bank).toContain("from '../lib/family-code.js'");
    expect(entry).toContain("from '../lib/family-code.js'");
    expect(bank).not.toContain('word_bank_family_code');
    expect(bank).not.toContain('localStorage');
  });
});

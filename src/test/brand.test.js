import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../style.css'), 'utf8');

/** The value of a :root custom property. */
function token(name) {
  const m = css.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})'));
  return m ? m[1].toUpperCase() : null;
}

function contrast(a, b) {
  const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const luminance = (hex) => {
    const s = channels(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('brand palette', () => {
  it('carries the tokens the mockups actually use', () => {
    expect(token('ink')).toBe('#241F1B');
    expect(token('muted')).toBe('#6B6259');
    expect(token('gold')).toBe('#C9A659');
    expect(token('gold-text')).toBe('#8A6A1F');
    expect(token('gold-wash')).toBe('#F4EFE2');
    expect(token('shell')).toBe('#FBF8F4');
    expect(token('checked')).toBe('#3D6B4A');
  });

  // DESIGN.md §6. Every pairing the app actually renders text in.
  it.each([
    ['ink on shell', 'ink', 'shell'],
    ['ink on white', 'ink', 'white'],
    ['ink on paper', 'ink', 'paper'],
    ['ink on gold wash', 'ink', 'gold-wash'],
    ['muted on shell', 'muted', 'shell'],
    ['muted on white', 'muted', 'white'],
    ['muted on paper', 'muted', 'paper'],
    ['muted on gold wash', 'muted', 'gold-wash'],
    ['gold text on white', 'gold-text', 'white'],
    ['checked on white', 'checked', 'white']
  ])('%s clears 4.5:1', (_name, fg, bg) => {
    const bgHex = bg === 'white' ? '#FFFFFF' : token(bg);
    expect(contrast(token(fg), bgHex)).toBeGreaterThanOrEqual(4.5);
  });

  it('never puts gold text on gold wash — it only reaches 4.39:1', () => {
    // Documented here because the brand sheet implies this pairing is fine.
    // It is not, for the sizes this app uses, so gold on a wash is carried by
    // the border and the icon while the text itself is ink.
    expect(contrast(token('gold-text'), token('gold-wash'))).toBeLessThan(4.5);
    expect(css).not.toMatch(/background:var\(--gold-wash\)[^}]*color:var\(--gold-text\)/);
  });

  it('uses --quiet for marks only, never for text', () => {
    // 2.93:1 on shell — below AA at any size the app renders.
    expect(contrast(token('quiet'), token('shell'))).toBeLessThan(4.5);
    const textUses = [...css.matchAll(/color:var\(--quiet\)/g)];
    expect(textUses).toHaveLength(0);
  });
});

describe('brand typography', () => {
  it('sets Andika for what she reads and Atkinson for the chrome', () => {
    expect(css).toMatch(/--font-read:'Andika'/);
    expect(css).toMatch(/--font-ui:'Atkinson Hyperlegible'/);
    ['.word{', '.sentence-text{', '.heard-text{', '.read-out{', '.reading-input{'].forEach((sel) => {
      const block = css.slice(css.indexOf(sel));
      expect(block.slice(0, block.indexOf('}'))).toContain('var(--font-read)');
    });
  });

  it('uses only the two weights the brand allows', () => {
    const weights = [...css.matchAll(/font-weight:(\d+)/g)].map((m) => m[1]);
    expect([...new Set(weights)].sort()).toEqual(['400', '700']);
  });
});

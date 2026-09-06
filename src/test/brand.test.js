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
    ['ink on the Word Bank tab', 'ink', 'wash-orange'],
    ['ink on the End session button', 'ink', 'session-end'],
    ['ink on shell', 'ink', 'shell'],
    ['ink on white', 'ink', 'white'],
    ['ink on paper', 'ink', 'paper'],
    ['ink on gold wash', 'ink', 'gold-wash'],
    ['muted on shell', 'muted', 'shell'],
    ['muted on white', 'muted', 'white'],
    ['muted on paper', 'muted', 'paper'],
    ['muted on gold wash', 'muted', 'gold-wash'],
    ['gold text on white', 'gold-text', 'white'],
    ['checked on white', 'checked', 'white'],
    ['tab label on the orange stop', 'muted', 'wash-orange']
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

describe('the giraffe', () => {
  it('flaps at the brand beat, on the brand pivot, with the brand keyframe', () => {
    // Lifted from docs/worksheet-mockups/ rather than invented.
    expect(css).toContain('animation:fg-flap .95s ease-in-out infinite');
    expect(css).toContain('transform-origin:52.4% 38.3%');
    expect(css).toContain('35%{ transform:rotate(-34deg) scaleY(.9); }');
    expect(css).toContain('70%{ transform:rotate(16deg) scaleY(1.04); }');
  });

  it('turns into a still ink silhouette once Speech-To-Text is the tab she is on', () => {
    // The five text tabs fill with ink when selected; she gets the same
    // treatment in her own shape. Parent's decision — see DESIGN.md.
    expect(css).toContain('.tab-giraffe.active .fg-body, .tab-giraffe.active .fg-wing{ display:none; }');
    expect(css).toContain('.tab-giraffe.active .fg-body-ink, .tab-giraffe.active .fg-wing-ink{ display:block; }');
    const ink = css.slice(css.indexOf('.fg-body-ink, .fg-wing-ink{'));
    expect(ink.slice(0, ink.indexOf('}'))).toContain('background:var(--ink)');
    // The silhouette is her outline, painted through the artwork's own alpha.
    expect(css).toContain('mask-image:url(/giraffe-body.png)');
    expect(css).toContain('mask-image:url(/giraffe-wing.png)');
    // Nothing animates on the silhouette layers.
    expect(ink).not.toMatch(/\.fg-(body|wing)-ink\{[^}]*animation:/);
  });

  it('has nothing drawn around her in either state', () => {
    // Parent's decision: no ring, no fill, no box — the shape carries the
    // selected state on its own.
    expect(css).not.toContain('.tab-giraffe::before');
    const giraffe = css.slice(css.indexOf('.tab-giraffe{'));
    const block = giraffe.slice(0, giraffe.indexOf('}'));
    expect(block).toContain('background:none');
    expect(block).toContain('border:none');
    expect(block).not.toContain('border-radius');
    expect(css).toContain(`.tab.tab-giraffe.active[data-tab='write']{ background:none; box-shadow:none; }`);
  });

  it('does not flap when reduced motion is asked for', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce){'));
    expect(block.slice(0, block.indexOf('}'))).toContain('animation:none');
  });

  it('is twice the height of a tab', () => {
    const tab = css.slice(css.indexOf('.tab{'));
    expect(tab.slice(0, tab.indexOf('}'))).toContain('min-height:44px');
    const giraffe = css.slice(css.indexOf('.tab-giraffe{'));
    expect(giraffe.slice(0, giraffe.indexOf('}'))).toContain('height:88px');
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

describe('the filled buttons the parent chose', () => {
  it.each([
    ['mic waiting', 'mic-idle'],
    ['mic recording', 'mic-recording'],
    ['start session', 'session-start']
  ])('%s carries white at 4.5:1 or better', (_name, name) => {
    expect(contrast('#FFFFFF', token(name))).toBeGreaterThanOrEqual(4.5);
  });

  it('End session is a mid orange that takes ink, because white fails on it', () => {
    // Lighter than the brick it replaced, darker than the Word Bank pastel.
    // White reaches only 2.65:1 there, so the label is ink — the same move the
    // brand makes on gold wash.
    expect(contrast('#FFFFFF', token('session-end'))).toBeLessThan(4.5);
    expect(contrast(token('ink'), token('session-end'))).toBeGreaterThanOrEqual(4.5);
    const block = css.slice(css.indexOf('#endSessionBtn{'));
    expect(block.slice(0, block.indexOf('}'))).toContain('color:var(--ink)');
  });

  it('changes colour between waiting and recording', () => {
    expect(token('mic-idle')).not.toBe(token('mic-recording'));
  });

  it('changes colour between starting and ending a session', () => {
    expect(token('session-start')).not.toBe(token('session-end'));
  });
});

describe('the 16px readable floor', () => {
  // The parent raised the minimum from the brand sheet's 13px to 16px for this
  // product. Three labels are exempt at 15px: the section label, the entry
  // screen's field label, and the brand wordmark.
  const sizes = [...css.matchAll(/font-size:([0-9.]+)px/g)].map((m) => parseFloat(m[1]));

  it('has no rule below 15px except the tick glyph inside a progress dot', () => {
    const belowFifteen = sizes.filter((s) => s < 15);
    // 12px, and it is an icon inside a 19px circle rather than text.
    expect(belowFifteen).toEqual([12]);
  });

  it('allows exactly four 15px rules: three labels and the tab', () => {
    // The tab is the fourth exception, added so the six sit on one line at
    // iPad width. Parent's decision.
    expect(sizes.filter((s) => s === 15)).toHaveLength(4);
    ['.eyebrow{', '.wordmark{', '.entry-label{', '.tab{'].forEach((sel) => {
      const block = css.slice(css.indexOf(sel));
      expect(block.slice(0, block.indexOf('}'))).toContain('font-size:15px');
    });
  });

  it('sets section labels in sentence case, not the brand sheet\'s all-caps', () => {
    const block = css.slice(css.indexOf('.eyebrow{'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).not.toContain('text-transform:uppercase');
    expect(rule).not.toContain('letter-spacing');
    expect(rule).toContain('font-weight:700');
  });

  it('keeps inputs at 16px, which also stops iOS zooming on focus', () => {
    const block = css.slice(css.indexOf('input[type=text], textarea, select{'));
    expect(block.slice(0, block.indexOf('}'))).toContain('font-size:16px');
  });
});

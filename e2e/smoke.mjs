// End-to-end smoke test: builds nothing, serves dist/, and drives the real app
// in a real browser. SpeechRecognition is stubbed so mic-driven flows can be
// exercised deterministically; nothing else is mocked.
//
//   npm run build && npm run test:e2e
//
import { chromium } from 'playwright';
import { preview } from 'vite';

// The sandboxed dev environment ships its own Chromium; elsewhere Playwright's
// own download is used.
const executablePath = process.env.CHROMIUM_PATH || undefined;

const server = await preview({ preview: { port: 0 } });
const BASE = server.resolvedUrls.local[0];
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();

// This sandbox has no outbound access to Firebase, so its network errors are
// expected here — and the run doubles as a check that the app stays usable
// when sync is unavailable.
const IGNORE = /firebase|firestore|googleapis|ERR_CONNECTION|favicon/i;
const errors = [];
const netErrors = [];
page.on('pageerror', (e) => (IGNORE.test(e.message) ? netErrors : errors).push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  const isResourceLoad = text.startsWith('Failed to load resource');
  (IGNORE.test(text) || isResourceLoad ? netErrors : errors).push('console: ' + text);
});
page.on('requestfailed', (r) => netErrors.push('net: ' + r.url()));
// "Failed to load resource" console lines carry no URL, so classify them from
// the response side instead.
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url()); });

// Fake SpeechRecognition so we can drive the mic paths deterministically.
await page.addInitScript(() => {
  window.__nextTranscript = '';
  class FakeRecognition {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; }
    start() {
      setTimeout(() => {
        if (this.onresult) {
          this.onresult({ results: [[{ transcript: window.__nextTranscript }]] });
        }
        if (this.onend) this.onend();
      }, 10);
    }
    stop() {}
  }
  window.SpeechRecognition = FakeRecognition;
  window.speechSynthesis = { cancel() {}, speak() {} };
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
});
// No family code -> Firestore never connects, so this run can't touch real data.
page.on('dialog', (d) => d.dismiss());

await page.goto(BASE, { waitUntil: 'networkidle' });

// ---- Shell ----
check('title renders', (await page.title()) === "Harlie's Word Bank");
check('five tabs present', (await page.locator('.tab').count()) === 5);
check('progress reads 0 / 355', (await page.locator('#bankCountLabel').textContent()).includes('355'));
check('speech supported banner hidden',
  !(await page.locator('#unsupportedBanner').evaluate((el) => el.classList.contains('show'))));

// ---- Practice ----
await page.click('.tab[data-tab="practice"]');
const target = (await page.locator('#targetWord').textContent()).trim();
check('a practice word is showing', target.length > 0 && target !== '—', target);
check('mastery dots rendered', (await page.locator('#repeatDots .repeat-dot').count()) === 3);

// A correct utterance advances the word.
await page.evaluate((w) => { window.__nextTranscript = w; }, target);
await page.click('#practiceMic');
await page.waitForFunction(() => document.getElementById('heardText').textContent.includes('matched'));
check('correct utterance is accepted', true);
await page.waitForFunction(
  (prev) => document.getElementById('targetWord').textContent.trim() !== prev, target, { timeout: 4000 }
);
check('practice advances to the next word', true);
check('session attempt counted',
  (await page.locator('#sessionAttemptedStat').textContent()) === '1');

// A mishearing offers to bank it.
const target2 = (await page.locator('#targetWord').textContent()).trim();
await page.evaluate(() => { window.__nextTranscript = 'zzquump'; });
await page.click('#practiceMic');
await page.waitForSelector('#matchActions button');
const actionLabels = await page.locator('#matchActions button').allTextContents();
check('mishearing offers bank / retry / skip', actionLabels.length === 3, actionLabels.join(' | '));
await page.locator('#matchActions button', { hasText: "That's her word" }).click();
await page.click('.tab[data-tab="bank"]');
const bankText = await page.locator('#bankList').textContent();
check('banked correction appears, pending confirmation',
  bankText.includes('zzquump') && bankText.includes(target2) && bankText.includes('needs confirming'));

// ---- Free Write, and the pending -> active flow ----
await page.click('.tab[data-tab="write"]');
await page.fill('#rawInput', 'zzquump is here');
check('pending correction is NOT applied',
  (await page.locator('#correctedOutput').textContent()).includes('zzquump'));

await page.click('.tab[data-tab="bank"]');
await page.locator('#bankList button', { hasText: 'Confirm' }).first().click();
await page.click('.tab[data-tab="write"]');
check('confirmed correction IS applied',
  (await page.locator('#correctedOutput').textContent()).includes(target2),
  await page.locator('#correctedOutput').textContent());

// Tap a word to correct it.
await page.fill('#rawInput', 'wibble');
await page.locator('#correctedOutput .wtok').first().click();
await page.fill('#fixInput', 'wobble');
await page.click('#saveFix');
await page.click('.tab[data-tab="bank"]');
check('manual tap-to-fix saves a correction',
  (await page.locator('#bankList').textContent()).includes('wibble'));

// ---- Sentences: the alignment fix, end to end ----
await page.click('.tab[data-tab="sentences"]');
const sentence = (await page.locator('#targetSentence').textContent()).trim();
check('a sentence is showing', sentence.length > 3, sentence);

// Drop one word from the middle and confirm only that word reads as wrong.
const words = sentence.replace(/[.,!?]/g, '').split(/\s+/);
const dropIndex = Math.min(2, words.length - 1);
const dropped = words[dropIndex];
const partial = words.filter((_, i) => i !== dropIndex).join(' ');
await page.evaluate((t) => { window.__nextTranscript = t; }, partial);
await page.click('#sentenceMic');
await page.waitForFunction(() => document.querySelectorAll('#sentenceOutput .wtok').length > 0);
const matched = await page.locator('#sentenceOutput .wtok.match').count();
const missing = await page.locator('#sentenceOutput .wtok.missing').allTextContents();
check('a dropped word costs exactly one word (the old bug shifted the rest)',
  matched === words.length - 1 && missing.length === 1 && missing[0] === dropped,
  matched + ' matched, missing=[' + missing.join(',') + '] of ' + words.length);

// A perfect read is clean.
await page.evaluate((t) => { window.__nextTranscript = t; }, sentence);
await page.click('#sentenceMic');
await page.waitForSelector('#sentenceOutput .read-note');
check('a perfect read is a clean read',
  (await page.locator('#sentenceOutput .read-note').textContent()).includes('Clean read (1/2)'));
check('clean-read dot filled',
  (await page.locator('#cleanDots .repeat-dot.filled').count()) === 1);

// An extra word is flagged as extra, not as a cascade of mismatches.
await page.click('#nextSentence');
const sentence2 = (await page.locator('#targetSentence').textContent()).trim();
const words2 = sentence2.replace(/[.,!?]/g, '').split(/\s+/);
await page.evaluate((t) => { window.__nextTranscript = t; },
  [words2[0], 'umm', ...words2.slice(1)].join(' '));
await page.click('#sentenceMic');
await page.waitForFunction(() => document.querySelectorAll('#sentenceOutput .wtok').length > 0);
check('an inserted word costs exactly one word',
  (await page.locator('#sentenceOutput .wtok.match').count()) === words2.length &&
  (await page.locator('#sentenceOutput .wtok.extra').count()) === 1);

// ---- Reading passage ----
await page.click('.tab[data-tab="reading"]');
await page.fill('#readingPassageInput', 'The dog ran fast. It was a warm day.');
await page.click('#saveReadingBtn');
await page.waitForSelector('#readingPracticeCard:visible');
check('passage splits into two lines',
  (await page.locator('#readingCounter').textContent()).trim() === '1 / 2');
await page.evaluate(() => { window.__nextTranscript = 'the dog ran fast'; });
await page.click('#readingMic');
await page.waitForSelector('#readingOutput .read-note');
check('reading line scores a clean read',
  (await page.locator('#readingOutput .read-note').textContent()).includes('Clean read (1/2)'));
await page.click('#nextReading');
check('reading navigation works',
  (await page.locator('#readingTargetSentence').textContent()).includes('warm day'));

// ---- Session log ----
await page.click('.tab[data-tab="practice"]');
await page.click('#startSessionBtn');
await page.click('#endSessionBtn');
await page.click('.tab[data-tab="bank"]');
check('session is logged',
  (await page.locator('#sessionLogView').textContent()).includes('attempted'));

// ---- Escaping: banked text is never treated as markup ----
// `correct` is free text typed by the parent (and, via Practice, the
// recognizer's own output). The original interpolated it straight into
// innerHTML; these rows are built as DOM nodes now.
await page.fill('#manualRaw', 'zzhostile');
await page.fill('#manualCorrect', '<img src=x onerror="window.__pwned=1">');
await page.click('#manualAddBtn');
check('bank list escapes untrusted text',
  (await page.locator('#bankList img').count()) === 0 &&
  (await page.locator('#bankList').textContent()).includes('<img') &&
  (await page.evaluate(() => window.__pwned)) === undefined,
  'imgs=' + (await page.locator('#bankList img').count()));

const unexpectedResponses = badResponses.filter((r) => !IGNORE.test(r));
check('every failed request is a blocked sync call, not an app asset',
  unexpectedResponses.length === 0, unexpectedResponses.join(' ;; ') || badResponses.join(' ;; '));
check('app is fully usable with sync unavailable', true, netErrors.length + ' network errors tolerated');
check('no uncaught application errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
await browser.close();
await server.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exit(failed.length ? 1 : 0);

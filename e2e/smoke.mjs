// End-to-end smoke test: builds nothing, serves dist/, and drives the real app
// in a real browser. SpeechRecognition is stubbed so mic-driven flows can be
// exercised deterministically; nothing else is mocked.
//
//   npm run build && npm run test:e2e
//
import { readFileSync } from 'node:fs';
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

// CI runners are far slower than a dev machine, and a race that never shows
// locally fails there every time. E2E_CPU_THROTTLE=10 reproduces that without
// needing a second machine.
if (process.env.E2E_CPU_THROTTLE) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_THROTTLE) });
}

// Sync is blocked outright, for two reasons.
//
// The first is safety. The family code this run types is a real one, and on a
// machine with working internet the app connects to the real Firestore project
// and both reads and writes `families/smoke-test-`. A browser test must never
// write to the production sync backend.
//
// The second is that it made the suite unrepeatable. State written by one run
// came back in the next: a pronunciation recorded here is loaded at startup
// there, so a check that records one and expects it to be new finds it already
// present and stalls. That is invisible in a sandbox with no outbound access
// and deterministic on a runner with it — exactly the shape of a failure that
// passes locally and fails on CI every single time.
//
// Blocking it also makes every run double as a check that the app stays usable
// when sync is unavailable, which this suite already claimed to be doing.
await page.route(
  (url) => /(^|\.)googleapis\.com$|(^|\.)firebaseio\.com$|(^|\.)firebaseinstallations\.com$/
    .test(url.hostname),
  (route) => route.abort()
);

// An aborted request surfaces as net::ERR_FAILED rather than ERR_CONNECTION.
const IGNORE = /firebase|firestore|googleapis|net::ERR_|ERR_CONNECTION|favicon/i;
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

async function finish(code) {
  const failed = results.filter((r) => !r.ok);
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(code || (failed.length ? 1 : 0));
}

/**
 * A wait that times out here says only which line gave up. That is not enough
 * to diagnose a failure that only happens on a CI runner, so dump what the app
 * was actually showing — the mic labels are where every speech failure
 * surfaces, and the banner is where an outage does.
 */
process.on('uncaughtException', async (e) => {
  console.log('\nFAIL  ' + (e && e.message));
  results.push({ name: 'the run completed', ok: false, detail: e && e.message });
  try {
    const state = await page.evaluate(() => {
      const text = (id) => {
        const el = document.getElementById(id);
        return el ? (el.value !== undefined && el.tagName === 'INPUT' ? el.value : el.textContent).trim() : null;
      };
      return {
        tab: (document.querySelector('.tab.active') || {}).textContent,
        micLabels: ['practiceMicLabel', 'sentenceMicLabel', 'readingMicLabel', 'writeMicLabel', 'phonicMicLabel']
          .reduce((acc, id) => { acc[id] = text(id); return acc; }, {}),
        listening: [...document.querySelectorAll('.listening')].map((el) => el.id),
        phonicWord: text('phonicWord'),
        phonicSpelling: text('phonicSpelling'),
        phonicNote: (text('phonicAddNote') || '').slice(0, 240),
        heard: (text('heardText') || '').slice(0, 160),
        banner: document.getElementById('accuracyBanner').className + ' | ' +
          document.getElementById('accuracyBanner').textContent.slice(0, 200),
        // What alreadyRecognised() reads, via the UI that renders it — no
        // debug hook in the app itself.
        phonicList: (text('phonicList') || '').replace(/\s+/g, ' ').slice(0, 400),
        bankList: (text('bankList') || '').replace(/\s+/g, ' ').slice(0, 400),
        serviceCalls: window.__serviceCalls,
        lastHints: (window.__lastHints || []).slice(0, 5)
      };
    });
    console.log('      app state at failure: ' + JSON.stringify(state, null, 2));
  } catch (e2) {
    console.log('      (could not read app state: ' + e2.message + ')');
  }
  if (errors.length) console.log('      page errors: ' + errors.slice(0, 5).join(' ;; '));
  await finish(1);
});

// Fake the whole speech stack so the mic paths run deterministically:
//   - MediaRecorder / getUserMedia / AudioContext, so a clip is captured
//   - fetch to the transcription function, so a transcript comes back
//   - SpeechRecognition, which is now only the fallback
// Nothing else is mocked, and the real capture.js / mic.js run throughout.
// The practice queue is shuffled, so each run exercises a different arrangement
// of words — which is good coverage and terrible for reproducing a failure.
// E2E_SEED pins it.
if (process.env.E2E_SEED) {
  await page.addInitScript((seed) => {
    let state = Number(seed) || 1;
    Math.random = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }, process.env.E2E_SEED);
}

await page.addInitScript(() => {
  window.__nextTranscript = '';
  window.__nextError = null;      // makes the service reply with this code
  window.__serviceDown = false;   // makes the service fail the way an outage does
  window.__serviceCalls = 0;
  window.__lastLang = null;
  window.__lastHints = [];

  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() {
      this.state = 'recording';
      this.ondataavailable({ data: new Blob(['fake audio']) });
    }
    stop() { this.state = 'inactive'; this.onstop(); }
  }
  window.MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
  });
  // Always "speaking", so only a tap or the ceiling ends a recording. The
  // silence path has its own coverage in the unit tests, where the clock can
  // be moved rather than waited out.
  window.AudioContext = class {
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(1); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() {}
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    if (!String(url).includes('/functions/transcribe')) return realFetch(url, init);
    window.__serviceCalls += 1;
    window.__lastLang = init.body.get('language');
    window.__lastHints = JSON.parse(init.body.get('hints') || '[]');
    if (window.__serviceDown) return new Response('gateway', { status: 503 });
    if (window.__nextError) {
      return new Response(JSON.stringify({ error: window.__nextError }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ text: window.__nextTranscript, provider: 'stub', model: 'stub' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  class FakeRecognition {
    constructor() { this.continuous = false; this.interimResults = false; }
    start() {
      window.__lastLang = this.lang;
      setTimeout(() => {
        if (window.__nextError) {
          if (this.onerror) this.onerror({ error: window.__nextError, message: '' });
        } else if (this.onresult) {
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

// ---- Entry screen ----
// It replaces a browser prompt(), so the app is gated behind it on a device
// with no code stored — which is every preview URL, since each is its own origin.
check('a device with no family code is met by the entry screen, not a prompt',
  (await page.locator('#entryScreen').isVisible()) &&
  (await page.locator('#entryScreen .wordmark').textContent()).trim() === 'Flying Giraffe');
check('the entry screen carries the coin and the product title',
  (await page.locator('.entry-coin').isVisible()) &&
  (await page.locator('.entry-title').textContent()).trim() === 'Word Bank');
check('and says what the code is for',
  (await page.locator('.entry-meta').textContent()).includes('only key to her data'));

// A code of pure punctuation normalises to nothing, so it is refused rather
// than stored empty.
await page.fill('#entryCode', '!!!');
await page.click('#entryContinue');
check('a code that normalises to nothing is refused',
  (await page.locator('#entryError').textContent()).includes('letters and numbers') &&
  (await page.locator('#entryScreen').isVisible()));

await page.fill('#entryCode', 'Smoke Test!');
await page.click('#entryContinue');
await page.waitForFunction(() => document.getElementById('entryScreen').hidden);
check('a valid code dismisses it and is normalised the way the prompt did',
  (await page.evaluate(() => localStorage.getItem('word_bank_family_code'))) === 'smoke-test-');
check('the app behind it is now usable',
  await page.locator('.tabs').isVisible());

/**
 * Tap the mic, then tap it again to finish — which is how it now works.
 *
 * The wait between is for the button to actually be recording, not a fixed
 * pause: getUserMedia is asynchronous, and on a loaded CI runner a fixed pause
 * is a race. The catch covers the case where the mic refuses to start at all
 * (nothing to say yet, permission denied), where the second tap is the point.
 */
async function tapMic(micId) {
  const selector = micId.startsWith('#') ? micId : '#' + micId;
  await page.click(selector);
  await page.waitForSelector(selector + '.listening', { timeout: 2000 }).catch(() => {});
  // Only tap again if it is still recording. Two cases must not get a second
  // tap: a mic that refused to start (nothing typed yet), and the browser
  // recogniser, which finishes by itself. Tapping either again starts a fresh
  // capture that nothing stops, which then resolves seconds later in the
  // middle of a later check.
  if (await page.locator(selector + '.listening').count()) await page.click(selector);
}

/**
 * Say something into a sentence/reading mic and wait for THIS result.
 * Clearing first matters: without it, waiting for "some tokens exist" passes
 * instantly against the previous read's tokens.
 */
async function readInto(outputId, micId, transcript) {
  await page.evaluate((id) => { document.getElementById(id).innerHTML = ''; }, outputId);
  await page.evaluate((t) => { window.__nextTranscript = t; }, transcript);
  await tapMic(micId);
  await page.waitForFunction(
    (id) => document.querySelectorAll('#' + id + ' .wtok').length > 0,
    outputId
  );
}

// ---- Shell ----
check('title renders', (await page.title()) === "Harlie's Word Bank");
check('six tabs, in three groups', (await page.locator('.tab').count()) === 6 &&
  (await page.locator('.tab-group').count()) === 3,
  (await page.locator('.tab').allTextContents()).join(' | '));
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
await tapMic('practiceMic');
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
await tapMic('practiceMic');
await page.waitForSelector('#matchActions button');
const actionLabels = await page.locator('#matchActions button').allTextContents();
check('mishearing offers bank / retry / skip / teach',
  actionLabels.length === 4 &&
  actionLabels.some((l) => l.includes('Teach how she says it')),
  actionLabels.join(' | '));
await page.locator('#matchActions button', { hasText: "That's her word" }).click();
await page.click('.tab[data-tab="bank"]');
const bankText = await page.locator('#bankList').textContent();
check('banked correction appears, pending confirmation',
  bankText.includes('zzquump') && bankText.includes(target2) && bankText.includes('needs confirming'));

// ---- Speech-To-Text, and the pending -> active flow ----
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
await readInto('sentenceOutput', 'sentenceMic', partial);
const matched = await page.locator('#sentenceOutput .wtok.match').count();
const missing = await page.locator('#sentenceOutput .wtok.missing').allTextContents();
check('a dropped word costs exactly one word (the old bug shifted the rest)',
  matched === words.length - 1 && missing.length === 1 && missing[0] === dropped,
  matched + ' matched, missing=[' + missing.join(',') + '] of ' + words.length);

// A perfect read is clean.
await readInto('sentenceOutput', 'sentenceMic', sentence);
await page.waitForSelector('#sentenceOutput .read-note');
check('a perfect read is a clean read',
  (await page.locator('#sentenceOutput .read-note').textContent()).includes('Clean read (1/2)'));
check('clean-read dot filled',
  (await page.locator('#cleanDots .repeat-dot.filled').count()) === 1);

// An extra word is flagged as extra, not as a cascade of mismatches.
await page.click('#nextSentence');
const sentence2 = (await page.locator('#targetSentence').textContent()).trim();
const words2 = sentence2.replace(/[.,!?]/g, '').split(/\s+/);
await readInto('sentenceOutput', 'sentenceMic', [words2[0], 'umm', ...words2.slice(1)].join(' '));
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
await readInto('readingOutput', 'readingMic', 'the dog ran fast');
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

// ---- §3 Phonetic matching ----

// Record how she says the word Practice is currently showing.
await page.click('.tab[data-tab="practice"]');
const phonicTarget = (await page.locator('#targetWord').textContent()).trim();
await page.click('.tab[data-tab="corrections"]');
await page.fill('#phonicWord', phonicTarget);
await page.fill('#phonicSpelling', 'yeyo');
check('a collision-prone spelling is flagged before saving',
  (await page.locator('#phonicAddNote .warn-block').count()) === 1);
await page.click('#phonicAddBtn');

// The bug this replaces: the warning fired while typing and was wiped on save,
// so the moment it actually mattered showed nothing. And in the list its only
// signal was a title attribute, which a touchscreen cannot reach.
const savedWarnings = await page.locator('#phonicList .warn-block').count();
const savedWarningText = savedWarnings
  ? await page.locator('#phonicList .warn-block').first().innerText()
  : 'no warning on the saved entry';
check('the warning survives saving, on the entry itself', savedWarnings >= 1, savedWarningText);
check('it names this spelling and its own colliding words',
  savedWarningText.includes('“yeyo” matches loosely') && savedWarningText.includes(' a,'),
  savedWarningText);
check('and it does not prescribe an invented better spelling',
  !/yeyoh/i.test(savedWarningText) &&
  savedWarningText.includes('will need confirming each time it fires'));
check('and it is a visible block, not a tooltip',
  savedWarnings >= 1 &&
  (await page.locator('#phonicList .warn-block').first().isVisible()) &&
  (await page.locator('#phonicList [title*="loosely"]').count()) === 0);
const phonicList = await page.locator('#phonicList').textContent();
check('pronunciation is recorded, with its derived key shown',
  phonicList.includes(phonicTarget) && phonicList.includes('yeyo') && phonicList.includes('A'));

// A different transcription of the same sound is recognised...
await page.click('.tab[data-tab="practice"]');
await page.evaluate(() => { window.__nextTranscript = 'yo yo'; });
await tapMic('practiceMic');
await page.waitForFunction(() => document.getElementById('heardBox').classList.contains('show'));
check('a transcription variant is recognised as how she says it',
  (await page.locator('#heardText').textContent()).includes('sounds like how she says it'));
check('and is shown as approximate, not as a match',
  await page.locator('#heardText').evaluate((el) => el.classList.contains('match-close')));

// ...but must NOT advance the word on its own. This is the confidence buffer:
// Double Metaphone over-matches, so a phonetic hit is a suggestion to confirm.
await page.waitForTimeout(1200);
check('a phonetic hit does NOT auto-advance the word',
  (await page.locator('#targetWord').textContent()).trim() === phonicTarget);

// Confirming it advances, and banks the exact text as a pending correction.
await page.locator('#matchActions button', { hasText: "that's her saying it" }).click();
await page.waitForFunction(
  (prev) => document.getElementById('targetWord').textContent.trim() !== prev,
  phonicTarget, { timeout: 4000 });
check('confirming a phonetic hit advances the word', true);
await page.click('.tab[data-tab="bank"]');
const afterConfirm = await page.locator('#bankList').textContent();
check('and banks the exact text as pending, not active',
  afterConfirm.includes('yoyo') && afterConfirm.includes('needs confirming'));

// "Teach how she says it" — capture a pronunciation at the moment it happens.
await page.click('.tab[data-tab="practice"]');
const teachTarget = (await page.locator('#targetWord').textContent()).trim();
await page.evaluate(() => { window.__nextTranscript = 'blorptastic'; });
await tapMic('practiceMic');
await page.waitForSelector('#matchActions button');
await page.locator('#matchActions button', { hasText: 'Teach how she says it' }).click();
check('the teach panel opens prefilled with what was heard',
  (await page.inputValue('#phonicQuickInput')) === 'blorptastic' &&
  (await page.locator('#phonicQuickNote').textContent()).includes('Sounds like'));
await page.click('#phonicQuickSave');
await page.click('.tab[data-tab="corrections"]');
check('teaching from Practice records the pronunciation',
  (await page.locator('#phonicList').textContent()).includes(teachTarget));

// Sentences: a phonetically-close word reads amber, and the read is not clean.
await page.click('.tab[data-tab="corrections"]');
await page.fill('#phonicWord', 'cat');
await page.fill('#phonicSpelling', 'kat');
await page.click('#phonicAddBtn');
await page.click('.tab[data-tab="sentences"]');
while ((await page.locator('#targetSentence').textContent()).trim() !== 'The cat sat on the mat.') {
  await page.click('#nextSentence');
}
await readInto('sentenceOutput', 'sentenceMic', 'the cot sat on the mat');
check('a phonetically-close word is amber, not red',
  (await page.locator('#sentenceOutput .wtok.close').count()) === 1 &&
  (await page.locator('#sentenceOutput .wtok.close').textContent()) === 'cot' &&
  (await page.locator('#sentenceOutput .wtok.mismatch').count()) === 0);
check('but the read is still NOT scored clean',
  (await page.locator('#sentenceOutput .read-note').count()) === 0);

// Removing it puts the word back to a plain mismatch.
await page.click('.tab[data-tab="corrections"]');
await page.locator('.phonic-row').filter({ has: page.locator('.word', { hasText: /^cat$/ }) })
  .locator('button', { hasText: 'Remove' }).click();
await page.click('.tab[data-tab="sentences"]');
await readInto('sentenceOutput', 'sentenceMic', 'the cot sat on the mat');
check('removing the pronunciation restores the plain mismatch',
  (await page.locator('#sentenceOutput .wtok.close').count()) === 0 &&
  (await page.locator('#sentenceOutput .wtok.mismatch').count()) === 1,
  'close=' + (await page.locator('#sentenceOutput .wtok.close').count()) +
  ' mismatch=' + (await page.locator('#sentenceOutput .wtok.mismatch').count()));

await page.click('.tab[data-tab="corrections"]');

// A different spelling must describe itself, not the first one's example.
await page.fill('#phonicWord', 'blue');
await page.fill('#phonicSpelling', 'boo');
await page.click('#phonicAddBtn');
await page.waitForFunction(() =>
  [...document.querySelectorAll('.phonic-row')].some((r) => r.textContent.includes('boo')));
const booWarning = await page.locator('.phonic-row', { hasText: 'blue' }).locator('.warn-block').innerText();
check('a second entry names its own colliding words, not the first entry\'s',
  booWarning.includes('“boo” matches loosely') && !/yeyo/i.test(booWarning), booWarning);
check('and the two warnings genuinely differ',
  booWarning !== savedWarningText);

check('the mic explains what it records and that a typed spelling also helps',
  (await page.locator('.capture-hint').textContent()).includes('records what the app hears') &&
  (await page.locator('.capture-hint').textContent()).includes('add that spelling too'));

// ---- Recording a pronunciation from her voice ----

await page.click('.tab[data-tab="corrections"]');
await page.fill('#phonicWord', '');
await page.fill('#phonicSpelling', '');
await page.evaluate(() => { window.__nextError = null; });

// Nothing to listen for until it knows which word she is saying.
await tapMic('phonicMic');
check('the mic asks for the word before listening',
  (await page.locator('#phonicAddNote').textContent()).includes('Type the word first'));

// A sound nothing recognises yet: offer to save it.
await page.fill('#phonicWord', 'butterfly');
await page.evaluate(() => { window.__nextTranscript = 'butta fly'; });
await tapMic('phonicMic');
await page.waitForFunction(() => document.getElementById('phonicSpelling').value !== '');
check('an unrecognised sound is captured into the spelling box',
  (await page.inputValue('#phonicSpelling')) === 'butta fly');
check('and it says what it heard and what saving would mean',
  (await page.locator('#phonicAddNote').textContent()).includes('tap Add to save it as how she says'));
await page.click('#phonicAddBtn');
check('saving it records the pronunciation',
  (await page.locator('#phonicList').textContent()).includes('butta fly'));

// Output that is already understood: same gate as Practice, so no offer.
await page.fill('#phonicWord', 'butterfly');
await page.fill('#phonicSpelling', '');
await page.evaluate(() => { window.__nextTranscript = 'butterfly'; });
await tapMic('phonicMic');
await page.waitForFunction(() =>
  document.getElementById('phonicAddNote').textContent.includes('Nothing to record'));
check('output that already matches the word is not offered for saving',
  (await page.inputValue('#phonicSpelling')) === '');

// A pronunciation already recorded also counts as recognised.
await page.evaluate(() => { window.__nextTranscript = 'butta fly'; });
await tapMic('phonicMic');
await page.waitForTimeout(200);
check('a sound an existing pronunciation already covers is not offered again',
  (await page.locator('#phonicAddNote').textContent()).includes('Nothing to record') &&
  (await page.inputValue('#phonicSpelling')) === '');

// Shared mic wiring means the error codes land here too.
await page.evaluate(() => { window.__nextError = 'audio-capture'; });
await tapMic('phonicMic');
await page.waitForFunction(() => {
  const t = document.getElementById('phonicMicLabel').textContent;
  return !t.includes('Recording') && !t.includes('Working it out');
});
const phonicMicErr = (await page.locator('#phonicMicLabel').textContent()).trim();
check('recognizer error codes show on this mic too',
  phonicMicErr.includes('(audio-capture)') && phonicMicErr.includes('No microphone found'),
  phonicMicErr);
await page.evaluate(() => { window.__nextError = null; });

// ---- What actually goes to the speech service ----

await page.click('.tab[data-tab="practice"]');
const hintTarget = (await page.locator('#targetWord').textContent()).trim();
await page.evaluate(() => { window.__nextTranscript = 'anything'; window.__serviceCalls = 0; });
await page.click('#practiceMic');
await page.waitForTimeout(250);
check('one tap starts recording and says how to finish',
  (await page.locator('#practiceMicLabel').textContent()).trim() === 'Recording — tap when done',
  await page.locator('#practiceMicLabel').textContent());
check('and nothing has been sent yet — it is still recording',
  (await page.evaluate(() => window.__serviceCalls)) === 0);
await page.click('#practiceMic');
await page.waitForFunction(() => window.__serviceCalls === 1);
check('the second tap is what sends it', true);
check('the word she was asked for leads the vocabulary hints',
  (await page.evaluate(() => window.__lastHints))[0] === hintTarget,
  JSON.stringify(await page.evaluate(() => window.__lastHints)));

// ---- Accent, and recognizer error codes ----

await page.click('.tab[data-tab="practice"]');
await page.evaluate(() => { window.__nextTranscript = 'anything'; });
await tapMic('practiceMic');
await page.waitForFunction(() => window.__lastLang !== null);
check('the speech service is asked for Australian English by default',
  (await page.evaluate(() => window.__lastLang)) === 'en-AU',
  await page.evaluate(() => window.__lastLang));

// Changing it in Word Bank takes effect on the next tap, without a reload.
await page.click('.tab[data-tab="bank"]');
await page.selectOption('#speechLang', 'en-GB');
check('the accent note reflects the change',
  (await page.locator('#speechLangNote').textContent()).includes('en-GB'));
await page.click('.tab[data-tab="practice"]');
await page.evaluate(() => { window.__lastLang = null; window.__nextTranscript = 'anything'; });
await tapMic('practiceMic');
await page.waitForFunction(() => window.__lastLang !== null);
check('a changed accent applies to the next listen, with no reload',
  (await page.evaluate(() => window.__lastLang)) === 'en-GB',
  await page.evaluate(() => window.__lastLang));
await page.click('.tab[data-tab="bank"]');
await page.selectOption('#speechLang', 'en-AU');

// Error codes reach the mic label.
await page.click('.tab[data-tab="practice"]');
async function micError(code) {
  await page.evaluate((c) => { window.__nextError = c; }, code);
  await tapMic('practiceMic');
  await page.waitForFunction(() => {
    const t = document.getElementById('practiceMicLabel').textContent;
    return !t.includes('Recording') && !t.includes('Working it out');
  });
  return (await page.locator('#practiceMicLabel').textContent()).trim();
}
const noSpeech = await micError('no-speech');
check('a recognizer error names its code on the mic label',
  noSpeech.includes('(no-speech)') && noSpeech.includes("Didn't hear anything"), noSpeech);

const blocked = await micError('not-allowed');
check('a permission failure says so, and does not suggest retrying',
  blocked.includes('(not-allowed)') && blocked.includes('permission is blocked') &&
  !blocked.includes('tap to try again'), blocked);

const unsupported = await micError('language-not-supported');
check('an unsupported language names the language and where to change it',
  unsupported.includes('en-AU') && unsupported.includes('(language-not-supported)') &&
  unsupported.includes('Word Bank'), unsupported);

await page.evaluate(() => { window.__nextError = null; });

// ---- When the speech service cannot be reached ----
// The fallback is the browser's own recogniser: the engine that was mishearing
// her in the first place. It must work, and it must never be mistaken for the
// real thing.
await page.evaluate(() => {
  window.__serviceDown = true;
  window.__nextTranscript = 'from the browser engine';
});
await tapMic('practiceMic');
await page.waitForFunction(() =>
  document.getElementById('accuracyBanner').classList.contains('show'));
const notice = (await page.locator('#accuracyBanner').textContent()).trim();
check('an outage is announced, not swallowed',
  notice.includes('Reduced accuracy') && notice.includes('less reliable'), notice);
check('and it names the code, so a failure on a device across the room is diagnosable',
  notice.includes('http-503') || notice.includes('503'), notice);

// The fallback recogniser still produces a transcript for this attempt.
// Wait for THIS transcript, not for "some text exists" — heardText is still
// showing the previous attempt's, so the loose wait passes instantly.
await page.waitForFunction(() =>
  document.getElementById('heardText').textContent.includes('from the browser engine'),
  null, { timeout: 5000 });
check('the attempt is not lost — the browser recogniser stands in', true);

// And it clears itself the moment the service answers again.
await page.evaluate(() => { window.__serviceDown = false; window.__nextTranscript = 'anything'; });
await tapMic('practiceMic');   // consumes the armed fallback
await page.waitForTimeout(300);
await tapMic('practiceMic');   // back on the service
await page.waitForFunction(() =>
  !document.getElementById('accuracyBanner').classList.contains('show'), null, { timeout: 5000 });
check('and the notice clears itself once a real transcript comes back', true);

await page.click('.tab[data-tab="bank"]');

// ---- Reaching a specific word, and focusing the queue ----

await page.click('.tab[data-tab="corrections"]');
await page.fill('#phonicWord', 'flobber');
await page.fill('#phonicSpelling', 'flibber');
await page.click('#phonicAddBtn');
await page.waitForFunction(() =>
  [...document.querySelectorAll('.phonic-row')].some((r) => r.textContent.includes('flobber')));

await page.locator('.phonic-row', { hasText: 'flobber' })
  .locator('button', { hasText: 'Practice this word' }).click();
check('"Practice this word" jumps straight to that word',
  (await page.locator('#targetWord').textContent()).trim() === 'flobber' &&
  (await page.locator('#tab-practice').isVisible()),
  (await page.locator('#targetWord').textContent()).trim());

check('the focus toggle says how many words it would cover',
  /\(\d+ words?\)/.test(await page.locator('#focusCount').textContent()),
  await page.locator('#focusCount').textContent());

await page.check('#focusToggle');
await page.waitForTimeout(100);
const focusSeen = new Set();
for (let i = 0; i < 8; i++) {
  focusSeen.add((await page.locator('#targetWord').textContent()).trim());
  await page.click('#skipWord');
}
const focusCount = Number((await page.locator('#focusCount').textContent()).match(/\d+/)[0]);
check('focus mode limits the queue to her own words',
  focusSeen.size <= focusCount && focusSeen.has('flobber'),
  [...focusSeen].join(', '));

await page.uncheck('#focusToggle');
await page.waitForTimeout(100);
check('turning it off restores the full queue',
  (await page.locator('#practiceMic').isVisible()));

// ---- Speech-To-Text: pronunciations as suggestions, never applied ----

await page.click('.tab[data-tab="write"]');
await page.fill('#rawInput', 'the flibber and the yo yo');
await page.dispatchEvent('#rawInput', 'input');
await page.waitForFunction(() => document.querySelectorAll('#correctedOutput .wtok').length > 0);

const suggested = await page.locator('#correctedOutput .wtok.suggest').allTextContents();
check('a strong pronunciation suggests what a loose word probably was',
  suggested.length === 1 && suggested[0] === 'flibber', JSON.stringify(suggested));
check('and it is offered, not applied',
  (await page.locator('#correctedOutput').textContent()).includes('flibber') &&
  !(await page.locator('#correctedOutput').textContent()).includes('flobber'));
check('a loose pronunciation stays out of Speech-To-Text entirely',
  !suggested.includes('yo') && !suggested.includes('yeyo'));

// Accepting is one sighting, not an instant correction.
await page.locator('#correctedOutput .wtok.suggest').first().click();
await page.waitForFunction(() => document.getElementById('writeNote').textContent.trim() !== '');
check('accepting once records a sighting without applying it',
  (await page.locator('#writeNote').textContent()).includes('One more sighting') &&
  (await page.locator('#correctedOutput .wtok.suggest').count()) === 1,
  await page.locator('#writeNote').textContent());

await page.locator('#correctedOutput .wtok.suggest').first().click();
await page.waitForFunction(() =>
  document.getElementById('writeNote').textContent.includes('Confirmed'));
check('the second sighting confirms it, and then it applies',
  (await page.locator('#correctedOutput .wtok.fixed').allTextContents()).includes('flobber') &&
  (await page.locator('#correctedOutput .wtok.suggest').count()) === 0);

await page.click('.tab[data-tab="bank"]');
// Scoped to this row: other entries in the list are legitimately still pending.
const flibberRow = page.locator('#bankList .bank-row', { hasText: 'flibber' });
const flibberText = (await flibberRow.count()) ? await flibberRow.first().innerText() : '(no row)';
check('and it reached the word bank as a confirmed correction',
  flibberText.includes('flobber') && !flibberText.includes('needs confirming'),
  flibberText.replace(/\s+/g, ' '));

// ---- Export / import round trip, through the real file ----
// Not a state round trip: the actual Blob the Export button produces, fed back
// through the actual file input. A restore that silently dropped a field would
// lose every recorded pronunciation.
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#exportBtn')
]);
const exportPath = await download.path();
const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
check('export carries every synced field',
  ['word_bank', 'verified_words', 'confirm_counts', 'sentence_progress',
   'reading_passage', 'reading_progress', 'phonic_bank', 'speech_lang']
    .every((f) => f in exported),
  Object.keys(exported).join(', '));
check('export carries the recorded pronunciations',
  Object.keys(exported.phonic_bank || {}).length > 0,
  JSON.stringify(exported.phonic_bank));

// Wipe the pronunciations, then restore from that file. The pronunciations
// live on Corrections; Export/Import stayed on Word Bank.
const beforeWipe = Object.keys(exported.phonic_bank);
await page.click('.tab[data-tab="corrections"]');
let guard = 0;
while ((await page.locator('.phonic-row').count()) > 0 && guard++ < 20) {
  await page.locator('.phonic-row button', { hasText: 'Remove' }).first().click();
}
check('pronunciations can be cleared', (await page.locator('.phonic-row').count()) === 0);

await page.click('.tab[data-tab="bank"]');
await page.setInputFiles('#importFile', exportPath);
await page.click('.tab[data-tab="corrections"]');
await page.waitForFunction(() => document.querySelectorAll('.phonic-row').length > 0);
const restored = await page.evaluate(() =>
  [...document.querySelectorAll('.phonic-row .word')].map((el) => el.textContent)
);
check('importing the export file restores every pronunciation',
  beforeWipe.length === restored.length,
  'had ' + beforeWipe.length + ', restored ' + restored.length + ' (' + restored.join(', ') + ')');

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
// ---- Brand rules from DESIGN.md §6, so a later change cannot quietly break them ----

await page.click('.tab[data-tab="practice"]');
const faces = await page.evaluate(() => {
  const face = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontFamily.split(',')[0].replace(/['"]/g, '') : null;
  };
  return { word: face('#targetWord'), sentence: face('.sentence-text'), tab: face('.tab'), body: face('body') };
});
check('what she reads is set in Andika, the chrome in Atkinson',
  faces.word === 'Andika' && faces.sentence === 'Andika' &&
  faces.tab === 'Atkinson Hyperlegible' && faces.body === 'Atkinson Hyperlegible',
  JSON.stringify(faces));

const tooSmall = await page.evaluate(() => {
  const bad = [];
  document.querySelectorAll('button, .btn, .tab, input, select, textarea').forEach((el) => {
    if (!el.offsetParent && el.id !== 'importFile') return; // not on screen
    // A control wrapped in a label is tapped via the label, so that is the
    // hit target that has to clear 44px — not the 19px checkbox inside it.
    const target = el.closest('label') || el;
    const r = target.getBoundingClientRect();
    if (r.height > 0 && r.height < 44) bad.push((el.id || el.className) + ' ' + Math.round(r.height) + 'px');
  });
  return bad;
});
check('every visible control clears the 44px minimum hit height',
  tooSmall.length === 0, tooSmall.slice(0, 5).join(', '));

const tinyText = await page.evaluate(() => {
  const bad = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!el.offsetParent || !el.textContent.trim()) return;
    if (el.children.length) return; // leaf nodes only
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    // Four documented exceptions, all at 15px: the section label, the entry
    // screen's field label, the brand wordmark, and the tabs.
    const exempt = el.classList.contains('eyebrow') || el.classList.contains('tab') ||
      el.classList.contains('entry-label') || el.classList.contains('wordmark');
    if (size < 16 && !exempt) bad.push((el.className || el.tagName) + ' ' + size + 'px');
    if (exempt && size < 15) bad.push((el.className || el.tagName) + ' ' + size + 'px (exempt, still too small)');
  });
  return bad;
});
check('nothing renders below 16px, bar the four 15px exceptions', tinyText.length === 0,
  tinyText.slice(0, 6).join(', '));

check('section labels are sentence case, not all-caps',
  await page.evaluate(() => [...document.querySelectorAll('.eyebrow')].every((el) => {
    const cs = getComputedStyle(el);
    return cs.textTransform === 'none' && cs.fontWeight === '700' &&
           parseFloat(cs.fontSize) === 15;
  })));

await page.click('.tab[data-tab="bank"]');
check('the fullness bar is always paired with words and numerals',
  /\d+\s*\/\s*\d+ words mastered/.test(await page.locator('#bankCount').textContent()),
  (await page.locator('#bankCount').textContent()).trim());

// Pending must carry background, border AND the words — never colour alone.
const pendingRow = page.locator('#bankList .bank-row.pending').first();
if (await pendingRow.count()) {
  const marks = await pendingRow.evaluate((el) => ({
    text: el.textContent.includes('needs confirming'),
    bg: getComputedStyle(el).backgroundColor,
    border: getComputedStyle(el).borderLeftWidth
  }));
  check('a pending correction is marked by background, border and words together',
    marks.text && marks.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(marks.border) >= 3,
    JSON.stringify(marks));
} else {
  check('a pending correction is marked by background, border and words together',
    false, 'no pending row present to check');
}

// Colour reinforces the tab grouping; it must not be the only signal.
// Tabs and the mic both transition over ~150ms, so let them settle first —
// otherwise these read an intermediate blend rather than the real colour.
await page.waitForTimeout(300);
const tabColours = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('.tab')].map((t) => [
    t.dataset.tab,
    t.classList.contains('active') ? 'active' : getComputedStyle(t).backgroundImage !== 'none'
      ? 'gradient' : getComputedStyle(t).backgroundColor
  ])));
check('the build-the-bank group shares one wash stop',
  tabColours.sentences === tabColours.reading, JSON.stringify(tabColours));
check('Corrections and Word Bank each get their own, all three different',
  new Set([tabColours.sentences, tabColours.corrections, tabColours.bank]).size === 3,
  JSON.stringify(tabColours));
check('the six tabs sit on one row at iPad width',
  (await page.evaluate(() => new Set([...document.querySelectorAll('.tab')]
    .map((t) => { const r = t.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size)) === 1);
// Speech-To-Text is the giraffe now, not a labelled tab.
const giraffe = page.locator('.tab-giraffe');
check('Speech-To-Text is the giraffe, with no visible label',
  (await giraffe.count()) === 1 &&
  (await giraffe.textContent()).trim() === '' &&
  (await page.locator('.tab[data-tab="write"]').count()) === 1);
check('but it still has an accessible name',
  (await giraffe.getAttribute('aria-label')) === 'Speech-To-Text');

const geometry = await page.evaluate(() => {
  const bar = document.querySelector('.tabs').getBoundingClientRect();
  const g = document.querySelector('.tab-giraffe').getBoundingClientRect();
  const labelled = [...document.querySelectorAll('.tab:not(.tab-giraffe)')].map((t) => t.getBoundingClientRect());
  const t = labelled[0];
  return {
    ratio: g.height / t.height,
    centred: Math.abs((g.top + g.height / 2) - (t.top + t.height / 2)) < 1,
    circle: Math.round(g.width) === Math.round(g.height),
    width: g.width,
    atFarLeft: Math.round(g.left - bar.left) === 0,
    tabsRightJustified: Math.round(bar.right - labelled[labelled.length - 1].right) <= 1,
    // The group gap between Reading and Corrections survives the reflow.
    groupGap: Math.round(labelled[3].left - labelled[2].right)
  };
});
check('the tap target stays 88px square, twice the tab height and centred',
  geometry.ratio === 2 && geometry.centred && geometry.circle &&
  Math.round(geometry.width) === 88, JSON.stringify(geometry));
check('it leads the row, with the five tabs right-justified beside it',
  geometry.atFarLeft && geometry.tabsRightJustified, JSON.stringify(geometry));
check('and the group gap between Reading and Corrections is kept',
  geometry.groupGap === 26, String(geometry.groupGap));

// Nothing is drawn around her in either state: no ring, no fill, no border.
const bare = await page.evaluate(() => {
  const el = document.querySelector('.tab-giraffe');
  const cs = getComputedStyle(el);
  const ring = getComputedStyle(el, '::before');
  return {
    noFill: cs.backgroundImage === 'none' && cs.backgroundColor === 'rgba(0, 0, 0, 0)',
    noBorder: cs.borderTopWidth === '0px',
    noRing: ring.content === 'none',
    colourShowing: getComputedStyle(document.querySelector('.fg-body')).display !== 'none',
    silhouetteHidden: getComputedStyle(document.querySelector('.fg-body-ink')).display === 'none'
  };
});
check('unselected, she flies on the shell with no ring and nothing behind her',
  bare.noFill && bare.noBorder && bare.noRing &&
  bare.colourShowing && bare.silhouetteHidden, JSON.stringify(bare));

check('the wing flaps at the brand beat while she is elsewhere',
  await page.locator('.fg-wing').evaluate((el) => {
    const cs = getComputedStyle(el);
    return cs.animationName === 'fg-flap' && cs.animationDuration === '0.95s';
  }));

await giraffe.click();
await page.waitForTimeout(300);
check('tapping the giraffe opens Speech-To-Text', await page.locator('#tab-write').isVisible());
const selected = await page.evaluate(() => {
  const el = document.querySelector('.tab-giraffe');
  const cs = getComputedStyle(el);
  const body = getComputedStyle(document.querySelector('.fg-body-ink'));
  const wing = getComputedStyle(document.querySelector('.fg-wing-ink'));
  return {
    // Still no box: the shape carries the state, not a fill behind it.
    noFill: cs.backgroundImage === 'none' && cs.backgroundColor === 'rgba(0, 0, 0, 0)',
    colourHidden: getComputedStyle(document.querySelector('.fg-body')).display === 'none' &&
                  getComputedStyle(document.querySelector('.fg-wing')).display === 'none',
    silhouette: body.display !== 'none' && wing.display !== 'none',
    inkBody: body.backgroundColor,
    inkWing: wing.backgroundColor,
    masked: body.maskImage.includes('giraffe-body') && wing.maskImage.includes('giraffe-wing'),
    // Nothing animates: both silhouette layers are static.
    still: body.animationName === 'none' && wing.animationName === 'none'
  };
});
check('selected, the whole giraffe becomes a still ink silhouette, with no box',
  selected.noFill && selected.colourHidden && selected.silhouette && selected.masked &&
  selected.still && selected.inkBody === 'rgb(36, 31, 27)' &&
  selected.inkWing === 'rgb(36, 31, 27)', JSON.stringify(selected));

check('while the other five still fill with ink when selected',
  await page.evaluate(async () => {
    document.querySelector('.tab[data-tab="bank"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector('.tab[data-tab="bank"]');
    return getComputedStyle(el).backgroundColor === 'rgb(36, 31, 27)';
  }));
check('no tab is clipped off the edge of the bar',
  await page.evaluate(() => {
    const bar = document.querySelector('.tabs').getBoundingClientRect();
    return [...document.querySelectorAll('.tab')].every((t) => {
      const b = t.getBoundingClientRect();
      return b.right <= bar.right + 1 && b.left >= bar.left - 1;
    });
  }));
check('and the page itself never scrolls sideways',
  await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth));
check('but the grouping still reads without colour, from the spacing',
  (await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.tab-group')];
    const gap = parseFloat(getComputedStyle(groups[0].parentElement).columnGap);
    const inner = parseFloat(getComputedStyle(groups[0]).gap);
    return gap > inner * 2;
  })));

await page.click('.tab[data-tab="practice"]');
await page.waitForTimeout(300);
const micIdle = await page.locator('#practiceMic').evaluate((el) => getComputedStyle(el).backgroundColor);
await page.evaluate(() => document.getElementById('practiceMic').classList.add('listening'));
await page.waitForTimeout(300);
const micRecording = await page.locator('#practiceMic').evaluate((el) => getComputedStyle(el).backgroundColor);
await page.evaluate(() => document.getElementById('practiceMic').classList.remove('listening'));
check('the mic changes colour between waiting and recording',
  micIdle === 'rgb(181, 83, 60)' && micRecording === 'rgb(61, 107, 74)',
  micIdle + ' -> ' + micRecording);

const sessionColours = await page.evaluate(() => ({
  start: getComputedStyle(document.getElementById('startSessionBtn')).backgroundColor,
  end: getComputedStyle(document.getElementById('endSessionBtn')).backgroundColor
}));
check('start and end session are different brand fills, neither ink nor white',
  sessionColours.start === 'rgb(61, 107, 74)' && sessionColours.end === 'rgb(222, 140, 66)',
  JSON.stringify(sessionColours));
check('End session takes ink text, because white fails on a mid orange',
  (await page.locator('#endSessionBtn').evaluate((el) => getComputedStyle(el).color)) === 'rgb(36, 31, 27)');

check('the coin is present and not stretched', await page.evaluate(() => {
  const img = document.querySelector('.coin');
  return Boolean(img && img.complete && img.naturalWidth === img.naturalHeight);
}));

check('no uncaught application errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
await finish(0);

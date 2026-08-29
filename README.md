# Harlie's Word Bank

A personal speech-to-text trainer that learns her voice, one correction at a time.

Five modes — Practice, Sentences, Reading, Free Write, Word Bank — synced across
devices through Firebase Firestore using a shared family code.

See [CLAUDE.md](CLAUDE.md) for the architecture and build plan.

## Running it

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # static build into dist/
npm run preview    # serve the build locally
```

## Tests

```bash
npm test           # unit tests (alignment, bank model, text helpers)
npm run test:e2e   # drives the built app in a real browser
```

The e2e suite needs a browser: `npx playwright install chromium` once, or set
`CHROMIUM_PATH` to an existing Chromium binary. It builds nothing itself, so run
`npm run build` first.

## Layout

```
index.html              markup only — no logic
src/
  main.js               wiring: init features, fold Firestore snapshots into state
  config.js             Firebase config and tuning constants
  style.css
  data/                 the built-in practice word list and sentences
  lib/
    align.js            word-sequence alignment (see below)
    similarity.js       how much two words resemble each other
    text.js             normalize / tokenize / passage splitting
    wordbank.js         bank entry model: pending -> active corrections
    store.js            shared state, persistence, render registry
    firestore.js        sync layer
    speech.js           Web Speech API wrapper
  features/             one module per tab, plus shared session/mic/progress
  test/                 unit tests
e2e/smoke.mjs           browser smoke test
legacy/index.html       the original single-file app, kept for reference
```

Feature modules never import each other's renderers. Each registers a render
function with `onRender()`; anything that changes shared state calls
`renderAll()`.

### Word alignment

Sentences and Reading used to compare `heardWords[i]` against
`expectedWords[i]`. One dropped word shifted everything after it, so an almost
perfect read scored as almost entirely wrong.

`src/lib/align.js` replaces that with a Levenshtein alignment over words, so a
dropped or inserted word costs exactly one word. Each expected word comes back
as `match`, `substitute`, `missing` or `extra`.

Two details worth knowing:

- **The comparison is bank-aware.** A confirmed mispronunciation counts as the
  word it stands for, so a known pronunciation doesn't drag the alignment out
  of step.
- **Dissimilar substitutions cost slightly more than a gap.** Without that,
  "the cat sat on the mat" read as "the cot on a the mat" scores identically
  whether you call it three wrong words or one wrong word plus a dropped one
  plus an inserted one. The second reading is the truthful one.
  `src/lib/similarity.js` is the seam to replace when Double Metaphone lands.

## Deployment

`npm run build` produces a static `dist/`, published to GitHub Pages by
`.github/workflows/deploy.yml` on every push to `main`.

**One-time setup:** in the repository's *Settings → Pages*, set **Source** to
**GitHub Actions**. The site previously served `index.html` straight from the
branch root; that file is now a build input rather than the built app, so Pages
has to run the build.

`vite.config.js` sets `base: './'`, so the build works from a repo subpath
(`https://<user>.github.io/word-bank/`) as well as a domain root.

## Firebase

`FIREBASE_CONFIG` lives in `src/config.js`. Those values are public by design —
they identify the project, they don't authorise anything. Access is controlled
by Firestore security rules.

Each device prompts once for a shared family code and stores it in
`localStorage`; every device using the same code reads and writes the same
document under `families/<code>`.

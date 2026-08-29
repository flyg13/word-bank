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

## Testing it by hand

```bash
git clone -b claude/vite-scaffold-index-port-vf8y3x https://github.com/flyg13/word-bank.git
cd word-bank
npm install
npm run dev
```

Open the printed `http://localhost:5173/` **in Chrome, Edge or Safari**. The mic
needs a secure context, and `localhost` counts as one — a `file://` copy does
not, so open the URL rather than the built HTML.

**Use a throwaway family code.** The first prompt asks for one. `localhost` is a
different origin from the live site, so it will ask fresh and store its own
answer — type something like `parity-test`, not the real code. That gives a
clean empty document to click through without touching production data.

To test against realistic data, open the live site, *Word Bank → Export bank
(.json)*, then import that file on localhost under the throwaway code. Same
data, separate document.

## Tests

```bash
npm test           # unit tests
npm run test:e2e   # drives the built app in a real browser
```

`src/test/schema-parity.test.js` is the one to know about. It drives the same
user flows through `legacy/index.html` and through the ported modules, with a
recording fake in place of Firestore, and asserts both wrote identical
payloads — field names, document path, `merge: true`, and value shapes across
all ten synced fields. There is real synced data in production; this is what
stops the schema drifting out from under it.

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
    phonetics.js        Double Metaphone keys and sound-alike comparison
    phonicbank.js       how she says her words (word -> spellings)
    snapshot.js         the one place stored and in-memory shapes meet
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

### Phonetic matching

`src/lib/phonetics.js` (Double Metaphone) and `src/lib/phonicbank.js`.

The parent records how a word sounds coming out of her mouth — "yellow" is
said "yeyo" — proactively, rather than waiting for the recognizer to happen to
emit something correctable. Three things are worth knowing:

**What it fixes.** The recognizer is inconsistent: the same sound comes back as
"yo yo", then "ye oh", then "yeyo". Under exact-text matching those are three
unrelated corrections, none of which ever reaches the two sightings needed to
activate. All three key to `A`, so a recorded spelling recognises all of them.

**What it does not do.** Double Metaphone maps English spelling to sound. It has
no model of her articulation — it does not know she says "wed" for "red"
(`RT` vs `AT`) or "fink" for "think" (`0NK` vs `FNK`). The parent supplies the
sound; Double Metaphone absorbs however the recognizer spells it.

**Why nothing is matched globally.** Across the 355-word practice list there are
70 colliding key groups: `AT` covers it/at/what/out/eat/eight/idea/wait/white,
and the single-character `A` covers you/we/way/who as well as the bare words a,
i, oh and e. A "which of her words does this sound like" search would be
unusable. So every phonetic comparison is scoped to one expected word — "does
this sound like how she says the word I already asked her for" — and the answer
is never applied silently:

| | Practice | Sentences / Reading | Free Write |
|---|---|---|---|
| Exact text, active correction | advances automatically | counts as a match | applied |
| Sounds like how she says it | amber, one tap to confirm | amber, not a clean read | not applied |

Confirming a phonetic hit banks the exact text as a *pending* correction, so the
precise text still needs two sightings before it is trusted on its own. The
phonetic layer accelerates that accumulation; it never replaces it.

Free Write is deliberately unchanged: with no expected word there is nothing to
scope against, and an unscoped rewrite is exactly the collision hazard above.

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

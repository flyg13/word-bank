# Harlie's Word Bank

A personal speech-to-text trainer that learns her voice, one correction at a time.

Five modes — Practice, Sentences, Reading, Speech-To-Text, Word Bank — synced across
devices through Firebase Firestore using a shared family code.

See [CLAUDE.md](CLAUDE.md) for the architecture and build plan.

## Running it

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # static build into dist/
npm run preview    # serve the build locally
```

## The speech service (one-time setup)

Speech goes to a Netlify Function in this repo, which calls OpenAI and returns
text. The function needs an API key, and the key must never be in the repo.

**1. Get the key.** Sign in at <https://platform.openai.com>, open **API keys**
(<https://platform.openai.com/api-keys>), and click **Create new secret key**.
Name it something like `word-bank`. Copy it when it is shown — it is shown
once. It starts with `sk-`. The account needs credit on it: **Settings →
Billing**. Transcription is charged per minute of audio, and a child's practice
session is a few minutes, so this runs at cents per week, not dollars.

**2. Put it in Netlify.** In the Netlify dashboard, open the Word Bank site,
then:

> **Site configuration → Environment variables → Add a variable → Add a single
> variable**

| Field | Value |
|---|---|
| Key | `OPENAI_API_KEY` |
| Value | the `sk-…` key you copied |
| Scopes | leave as **All scopes** (it must include Functions) |
| Deploy contexts | **All deploy contexts** — so branch previews work too |

Save it. **Then redeploy** (Deploys → Trigger deploy → Deploy site); functions
only pick up a new variable on a new deploy.

**3. Check it.** Open the site, tap a mic, say a word. If the key is missing or
wrong, the app says so specifically rather than failing silently: a banner
reading *Reduced accuracy … (not-configured)* or *(not-authorised)*.

Two optional variables, neither of which is needed to start:

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Set to `whisper-1` to try the older model without a code change |
| `TRANSCRIBE_PROVIDER` | `openai` | Selects the provider module in `netlify/functions/providers/` |

The key is read only inside the function, in `netlify/functions/providers/`.
It is never in the repo, never in the built bundle, and never sent to the
browser — there is a test asserting each of those. See [CLAUDE.md](CLAUDE.md)
§9 for why this provider and this model, and what to watch for.

### Running the function locally

`npm run dev` serves the app but not the function, so speech falls back to the
browser recogniser (with the banner saying so — that is the fallback working,
not a bug). To run both:

```bash
npm install -g netlify-cli
netlify dev                    # app + functions, on one port
```

`netlify dev` reads the key from your linked site, or from a local `.env`
holding `OPENAI_API_KEY=sk-…`. **`.env` is gitignored; keep it that way.**

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

To test against realistic data, open the live site
(https://wordbank.flyinggiraffe.ai), *Word Bank → Export bank (.json)*, then
import that file on localhost under the throwaway code. Same
data, separate document.

## Testing on an iPad, or any other device

Every branch and pull request gets its own public HTTPS URL automatically, from
Netlify. Open it on the iPad — no terminal, no certificate, no being on the same
network. Because it is real HTTPS on a public host, the microphone works.

- **A pull request** gets a comment from Netlify carrying the preview link.
- **Any branch** is also reachable at a stable address,
  `https://<branch-name>--<site>.netlify.app` — branch names are lowercased and
  anything unusual becomes a hyphen.

Two things to expect:

- Each preview is a different origin, so it asks for the family code the first
  time you open a given branch. Nothing is lost — the data lives in Firestore
  keyed by the code, not by the URL. Use the throwaway code unless you
  deliberately want to work against real data.
- Open it in a Safari tab, not from the home screen. The Web Speech API is
  unavailable in home-screen mode, which is what the app's own banner is about.

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

## Design

The Flying Giraffe brand, applied per `DESIGN.md`. Tokens come from
`docs/worksheet-mockups/`; `src/test/brand.test.js` pins the palette, the
contrast ratios and the two-weight type rule, and the browser suite checks the
44px hit minimum, the 13px text minimum and that colour never carries meaning
alone.

Two faces, self-hosted from npm so nothing depends on a CDN: **Andika** for what
she reads (the practice word, sentences, the heard-back text) and **Atkinson
Hyperlegible** for the parent's interface. Latin subset only.

Six tabs in three groups, separated by spacing rather than colour: build the
bank (Practice, Sentences, Reading), use it (Speech-To-Text), teach it
(Corrections), and the brain (Word Bank).

## Layout

```
index.html              markup only — no logic
src/
  main.js               wiring: init features, fold Firestore snapshots into state
  config.js             Firebase config and tuning constants
  style.css
  data/                 the built-in practice word list and sentences
  lib/
    recorder.js         MediaRecorder plus Web Audio silence detection
    capture.js          record -> gate -> send, and the Voice Lock seam
    transcribe.js       client for the transcription function
    vocab.js            her bank, as vocabulary hints for the recogniser
    align.js            word-sequence alignment (see below)
    similarity.js       how much two words resemble each other
    phonetics.js        Double Metaphone keys and sound-alike comparison
    speech.js           recognizer and voice, both tagged with her accent
    collisions.js       which real words a phonic spelling cannot be told from
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
netlify/functions/
  transcribe.mjs        audio in, text out — holds nothing, delegates
  providers/openai.mjs  the only file that knows a provider exists
netlify.toml            hosting: build, previews, functions, cache headers
redirect/index.html     what the old GitHub Pages URL now serves
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

### Her accent

The recogniser and the voice that reads words aloud both run on one setting,
`speech_lang`, defaulting to **en-AU** and changeable per family in the Word
Bank tab. It is synced, so her devices agree.

Getting this wrong costs accuracy twice over: an en-US recogniser scores an
Australian child's vowels against the wrong model, and an American voice hands
her the wrong pronunciation to copy in the first place.

Recogniser coverage of these tags varies by browser and platform. An
unsupported choice surfaces on the mic button as
`language-not-supported`, naming the tag and pointing at the setting, rather
than failing silently — every recognizer error code reaches that label, since on
a device that isn't in front of you it is the only diagnostic there is.

### Reaching a particular word

The practice queue is shuffled and Skip is the only way through it, so without
help, reaching one word means tapping past everything in front of it. Two ways
round that:

- **"Practice this word"** on any entry in "How she says her words" sends the
  queue straight there. The word is pinned, so a background sync cannot pull it
  away — `reconcileQueue` drops mastered words, and a word worth revisiting is
  often already mastered.
- **"Focus on her words"** in Practice limits the queue to words she has a
  pronunciation or a correction for, pending corrections included, since those
  are precisely the ones still needing work. Words outside the built-in list
  count — a correction from her homework is exactly what is worth drilling.

The toggle is local, not synced: it is "what am I working on right now", and one
device forcing it on another would be surprising.

### Recording how she says a word

Two ways in, both gated identically by `alreadyRecognised(word, heard)` — the
word itself, a confirmed correction, or an existing pronunciation all count as
already understood, so neither offers to record something already covered:

- **Practice** — "Teach how she says it", prefilled with what was just heard.
- **Word Bank** — type the word, tap the mic, she says it. Both mics share the
  same wiring, so recognizer error codes appear on either.

A spelling that is mostly vowels produces a Double Metaphone key barely a
character long ("yeyo" → `A`, "boo" → `P`), and a key that short cannot be told
apart from a lot of ordinary speech. `src/lib/collisions.js` works out which
real words those actually are — the practice list plus the bare vowel sounds and
homophones it deliberately omits, which are exactly what a recognizer emits for
an unclear attempt — so each entry names its own: "boo" is warned about `be, by,
bee and buy`, "yeyo" about `a, I, ah and aw`.

The warning states the limit rather than prescribing a fix. Adding a consonant
helps only if she actually makes one; otherwise that spelling will need
confirming every time it fires, and saying so is more honest than inventing a
better spelling.

It shows before saving **and permanently on the saved entry**. An earlier
version put it in a `title` attribute and cleared the form warning on save,
which meant a touchscreen could never see it at the one moment it mattered.

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

| | Practice | Sentences / Reading | Speech-To-Text |
|---|---|---|---|
| Exact text, active correction | advances automatically | counts as a match | applied |
| Sounds like how she says it | amber, one tap to confirm | amber, not a clean read | amber, one tap to accept |

Confirming a phonetic hit banks the exact text as a *pending* correction, so the
precise text still needs two sightings before it is trusted on its own. The
phonetic layer accelerates that accumulation; it never replaces it.

Speech-To-Text is the one place with no expected word to scope against, so it gets
the narrowest version: a suggestion, never a rewrite. Two guards make that safe,
both in `suggestFromSound`. Spellings flagged as loose are excluded entirely —
unscoped, a key like `A` would underline half a sentence. And if two different
words would both fit, nothing is suggested, because picking one silently is a
guess presented as knowledge. Accepting is one sighting, so the same
pending-then-active path applies: tap once and it is noted, tap again and it
starts applying on its own.

## Deployment

`npm run build` produces a static `dist/`. Hosting is Netlify, configured by
`netlify.toml`: it builds every push, publishes `main` as production, and gives
every other branch and pull request its own preview URL.

Production runs `npm test && npm run build`; previews run the build only. Harlie
uses production daily, so it does not ship unless the suite passes. Previews
exist to be looked at quickly, and GitHub Actions already runs the full suite on
every pull request.

`vite.config.js` sets `base: './'`, so the build works from a domain root or a
subpath either way.

Production is `https://wordbank.flyinggiraffe.ai`.

### DNS

The domain is registered at GoDaddy and its nameservers stay there, so other
subdomains can point elsewhere later. Netlify serves this one subdomain through
a single record:

| Type | Name | Value | TTL |
|---|---|---|---|
| CNAME | `wordbank` | `<site-name>.netlify.app` | 600 |

`<site-name>` is the Netlify site's own subdomain, from *Site configuration →
Site details*. GoDaddy appends the domain to whatever goes in **Name**, so the
name is `wordbank`, never `wordbank.flyinggiraffe.ai`.

A subdomain only needs a CNAME. The A-record-to-`75.2.60.5` approach in
Netlify's docs is for apex domains (`flyinggiraffe.ai` itself) and does not
apply here.

Netlify issues the Let's Encrypt certificate automatically once that record
resolves, which is what makes the microphone work on a phone or iPad.

### The old GitHub Pages URL

`https://flyg13.github.io/word-bank/` now redirects here.
`.github/workflows/deploy.yml` no longer builds the app; it publishes
`redirect/index.html` as both `index.html` and `404.html`, so deeper paths
redirect too.

Pages serves static files and cannot issue a 301, so the page redirects three
ways — a script (which also carries the query string and fragment across), a
meta refresh behind it, and a plain link if both are blocked. It uses
`location.replace`, so the back button does not bounce into it again.

`flyg13.github.io/word-bank` is a GitHub-owned address that no other host can
serve, which is why the URL changed at all — and why a domain you own is the
last hosting move you should have to make.

## Firebase

`FIREBASE_CONFIG` lives in `src/config.js`. `authDomain` stays
`wordbank-fg13.firebaseapp.com` regardless of where the app is served from — it
is the Firebase project's own handler domain, not the site's.

`wordbank.flyinggiraffe.ai` is listed under *Authentication → Settings →
Authorized domains*. Strictly it does not need to be: that list gates OAuth
popup and redirect sign-in, and this app only ever calls `signInAnonymously()`,
which talks to the Identity Toolkit API directly. It is there so that adding a
real sign-in method later does not fail mysteriously. Netlify preview
subdomains are not listed and cannot be — the list takes no wildcards — which
is another reason the anonymous-only design is worth keeping.
 Those values are public by design —
they identify the project, they don't authorise anything. Access is controlled
by Firestore security rules.

Each device prompts once for a shared family code and stores it in
`localStorage`; every device using the same code reads and writes the same
document under `families/<code>`.

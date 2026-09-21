# Harlie's Word Bank

A personal speech-to-text trainer that learns her voice, one correction at a time.

Five modes — Practice, Sentences, Reading, Speech-To-Text (her worksheet: a
question she pastes in from Seesaw and an answer she says), Word Bank — synced across
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

**If recording stops too soon, or hangs on too long.** Tapping the mic again
always ends a recording immediately; the settings below only decide when it
gives up waiting on its own. Unlike the function-side variables on this page,
these are read when the site is *built*, so changing one needs a redeploy —
Netlify's **Trigger deploy** is enough, there is no code change. A value that
is not a number between 300 and 120000 is ignored and the default is used.

| Variable | Default | The pause it controls |
|---|---|---|
| `VITE_SILENCE_MS_FREEFORM` | `1500` | Speech-To-Text. Short, because recordings add to the end: cut off early, the next tap carries on |
| `VITE_SILENCE_MS_WORD` | `1200` | Practice. One word, with nothing to pause inside |
| `VITE_SILENCE_MS_SENTENCE` | `2000` | Sentences. Longer, because being cut off costs her the whole sentence again |
| `VITE_SILENCE_MS_PASSAGE` | `2500` | Reading Passage. Longest: a passage has real pauses in it |
| `VITE_NO_SPEECH_MS` | `6000` | How long it waits if she taps and then says nothing at all |

Raise one if she is being cut off mid-sentence; lower it if the app feels like
it has frozen after she stops talking.

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

## The context-correction service (one-time setup)

Speech-To-Text sends each transcript to a second Netlify Function, which asks
Claude to apply her corrections *with the sentence in view* rather than blindly.
That function asks **Claude Opus 5 on the direct Anthropic API** and needs an
Anthropic API key. (It first ran on Amazon Bedrock; that provider is kept and
is one variable away — see *Returning to Bedrock* below for why it is not the
default any more.)

**1. Get the key.** In the [Anthropic Console](https://console.anthropic.com/)
→ **API keys** → **Create key**. Copy it once; it is not shown again.

**2. Put it in Netlify.** Same place as the speech key:

> **Site configuration → Environment variables → Add a variable → Add a single
> variable**

| Field | Value |
|---|---|
| Key | `ANTHROPIC_API_KEY` |
| Value | the key you created |
| Scopes | leave as **All scopes** (it must include Functions) |
| Deploy contexts | **All deploy contexts** |

Nothing else is required. `CONTEXT_PROVIDER` may stay unset, and the Bedrock
variables may stay as they are or be removed; they are read only when Bedrock
is selected.

**3. Redeploy** (Deploys → Trigger deploy → Deploy site). Functions only pick up
a new variable on a new deploy.

**4. Check it.** Open Speech-To-Text, tap the mic under a question, say a
sentence with a word she has a confirmed correction for. If the key is missing
or wrong, the app says so under her answer — *I could not check the marked bit*
with the code beside it, *(not-configured)*, *(not-authorised)* or
*(model-not-found)* — and falls back to the old blind find-and-replace for that
sentence only. Then the two sentences the switch was made for, with
"liquor → little" confirmed: *"Dad brought a bottle of liquor"* must come back
unchanged, and *"I want the liquor one"* must change.

**5. Ask the provider what this key can see.** The function has a read-only
diagnostic that goes through **whichever provider `CONTEXT_PROVIDER` selects**
— the same path her sentences take — using the same key. Open it in a browser
on the deployed site (or a preview):

| URL | What it reports |
|---|---|
| `/.netlify/functions/context-diagnose` | Which provider is in use and which model is configured, then what that provider can see (below) |
| `/.netlify/functions/context-diagnose?probe` | The same, then one one-token request to the configured model through the same endpoint correction uses, reporting exactly what came back |
| `/.netlify/functions/context-diagnose?probe=<model-id>` | The same probe against an ID of your choosing |

Through the direct API (`provider: "anthropic-claude"`), the report carries
`models` — every model ID the key can see — and `configuredModelResolves`,
which says whether the configured ID (an alias such as `claude-opus-5`
included) is one the API knows, with the ID it resolves to under
`configuredModelInfo`. How to read it:

- `calls.listModels.status: 401` — the key is wrong or revoked. Step 1.
- `configuredModelResolves: false` with a 404 — `ANTHROPIC_MODEL` names an ID
  the API does not know. Pick one from `models`.
- `probe.status: 429` or `529` — busy, not broken; the app's banner says
  *rate-limited* for both, and it is worth a moment and another go.

The report never contains the key, and nothing in it is cached or written.

The variables, all optional:

| Variable | Default | What it does |
|---|---|---|
| `CONTEXT_PROVIDER` | `anthropic-claude` | Selects the provider module in `netlify/functions/providers/`: `anthropic-claude` (the direct API) or `bedrock-claude` |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Swap models on the direct API without a code change. The request carries no thinking parameter, so Opus 5 thinks adaptively (its default) and an older model simply answers |
| `ANTHROPIC_EFFORT` | `medium` | How hard it thinks before answering, and therefore how long she waits: `low`, `medium`, `high`, `xhigh`, `max`. See *If the wait is too long* below. A value that is not one of those five is ignored, and the default is used |
| `BEDROCK_REGION` | `ap-southeast-2` | Bedrock only: the AWS region, and therefore where her speech is processed |
| `BEDROCK_MODEL` | `au.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock only: an inference-profile ID (`au.` or `global.` prefix); a bare `anthropic.` ID is refused on the classic endpoint with *needs-inference-profile* |

Cost: one short request per spoken transcript, on Opus 5 at `medium` effort.
Still smaller than the transcription bill.

**If the wait is too long — or a correction goes wrong.** The pause before the
corrected text settles is the model thinking, and `ANTHROPIC_EFFORT` is the
dial. It ships at `medium`, one notch below the API's own default, because the
first real session on Opus 5 was slower than a nine-year-old will sit through.
Move it, redeploy, and re-run the two sentences below:

| If | Set it to |
|---|---|
| Still too slow | `low` |
| A word of hers gets changed that should not have been, or missed | `high` |
| Still wrong at `high` | `xhigh`, then `max` |

The two sentences are the test, with `liquor → little` confirmed in her bank.
*"Dad brought a bottle of liquor"* must come back untouched — a real word left
alone. *"I want the liquor one"* must change. Both have to pass at whatever
level you settle on; one without the other is not a pass. `?probe` on the
diagnostic reports `configuredEffort`, so you can check what the deploy
actually picked up.

See [CLAUDE.md](CLAUDE.md) §10 for why this exists, why it moved off Bedrock,
and what is load-bearing about how it works.

### Returning to Bedrock

**Why it is not the default.** The Bedrock account has a model agreement for
Claude Sonnet 4.5 only — Opus 4.8 answers 403 *"not available for this
account"* — and Sonnet 4.5 failed the context test twice, changing *"a bottle
of liquor"* to *"a bottle of little"* even after the prompt was made to read
the original first. That is a judgement failure, and the fix is a stronger
model, which the direct API has today. The Bedrock provider file is intact
and sends exactly the same prompt; when the account's Sonnet 5 access on
Bedrock comes through, the switch back is:

| Variable | Value |
|---|---|
| `CONTEXT_PROVIDER` | `bedrock-claude` |
| `BEDROCK_API_KEY` | the Bedrock API key (below) |
| `BEDROCK_MODEL` | the Sonnet 5 inference-profile ID the diagnostic lists |

then redeploy, and run step 5: the diagnostic follows the switch.

**The Bedrock key.** In the AWS console, switch to **Asia Pacific (Sydney)
`ap-southeast-2`** — see *Which endpoint, region and model* below — then:

> **Amazon Bedrock → Model access** (left menu, under *Configure and learn*) →
> **Modify model access** → tick **Anthropic → Claude Sonnet 5** → **Next**.
> The first time an account enables any Anthropic model, the console asks for
> **use case details** (company, website, industry, who the users are, what it
> is for) — one form, once per account. Fill it in, **Submit**, then **Review →
> Submit** on the access page. The row reads *In progress* and then *Access
> granted*, usually within minutes. Model access is per region: do this with
> the region set to the one `BEDROCK_REGION` names.
>
> If the console has a **Model catalog** instead, open **Claude Sonnet 5** there
> and use its **Request access** / **Available to request** button — same form.
>
> **Amazon Bedrock → API keys** — create a key. Long-term keys expire; a
> short-term one lasts 12 hours, so use a long-term key here and note its expiry.
> The key belongs to an IAM user Bedrock creates for it; that user carries
> `AmazonBedrockLimitedAccess`, which is enough for both the requests and
> the diagnostic.

**The name matters.** Netlify reserves every `AWS_`-prefixed variable name for
its own build environment, so the usual `AWS_BEARER_TOKEN_BEDROCK` cannot be
used here — hence `BEDROCK_API_KEY`.

**What the app says when Bedrock fails.** Two codes are Bedrock's own:
*model-not-found* means Bedrock has no route for the model ID in that region;
*needs-inference-profile* means it wants a `global.`/`au.` profile ID rather
than a bare `anthropic.` one. Run the diagnostic rather than guessing another
ID.

**Reading the diagnostic through Bedrock** (`provider: "bedrock-claude"`). The
report carries the Anthropic models offered in the region, every
system-defined inference profile with *anthropic* in it (and which regions each
routes to), and for the configured model ID — plus its bare, `global.` and
`au.` forms — whether the account is **authorised** for it:

- `availability[...].authorizationStatus: "NOT_AUTHORIZED"` — the account has
  not been granted access to that model in that region. Model access is the
  fix, not a different ID.
- `AUTHORIZED` but the probe answers 404 — the ID is not one this endpoint
  routes in this region. Use one from `anthropicInferenceProfiles`, or a
  region that lists the model in-region.
- `anthropicInferenceProfiles: []` with a healthy `inferenceProfileCount` —
  there really are no Anthropic profiles in the region for this account, which
  again points at access, not the ID.
- A `403` under `calls` — the key's IAM user cannot list models. The key still
  works for correction; only the diagnosis is blind. The same three questions
  can be asked with the AWS CLI as an admin:
  `aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED`
  and `aws bedrock get-foundation-model-availability --model-id anthropic.claude-sonnet-4-5-20250929-v1:0`.

**Which endpoint, region and model.** Bedrock has two endpoints for Claude.
The newer Messages-API one (`bedrock-mantle`) serves Claude Sonnet 5 and later,
but this account is not enabled for it: every model there answers 403 *"not
available for this account, contact AWS Sales"*, and the older models 404. The
classic InvokeModel endpoint (`bedrock-runtime`) is proven on the same
account — it is what the parent's worksheet generator uses, in Sydney, with
Claude Sonnet 4.5 — so that is what the provider uses, through the official
Bedrock SDK's classic client with the same API key as a bearer token. On the
classic endpoint the newer Claude models are served only through cross-region
inference, so the model ID is an inference-profile ID (`au.` keeps routing
inside the Australian regions; `global.` routes anywhere), never a bare
`anthropic.` one. The defaults are Sydney and the AU profile of the versioned
Sonnet 4.5 ID.

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
bank (Practice, Sentences, Reading), use it (Speech-To-Text — her worksheet),
teach it (Corrections), and the brain (Word Bank).

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
    context-correct.js  client for the context-correction function
    correction-log.js   a rolling record of what Claude changed (synced, most recent 50)
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
  transcribe.mjs           audio in, text out — holds nothing, delegates
  contextual-correct.mjs   transcript + her patterns in, decisions out
  context-diagnose.mjs    read-only: which model IDs this account can see (README step 5)
  providers/openai.mjs         the only file that knows the recogniser's provider
  providers/claude-prompt.mjs  the one prompt every Claude provider sends
  providers/anthropic-claude.mjs Claude Opus 5 on the direct API — the default
  providers/bedrock-claude.mjs   Claude on Bedrock — kept, CONTEXT_PROVIDER away
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

To move a device to a different code — a school iPad joining the family, or a
new code replacing a short one — use *Word Bank → Family code*. It shows the
code the device is using, takes a new one, and restarts the app on it. It goes
through the same storage as the entry screen, so nothing else needs clearing,
and nothing is deleted: the data stays under the old code.

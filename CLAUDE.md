# Harlie's Word Bank — Architecture & Build Plan (v2)

**Purpose of this document:** a spec to hand to Claude Code to properly rebuild what's currently a single 1,100-line HTML file into a real, maintainable project — while adding phonetic matching, staleness re-testing, and (later) on-device voice lock. Written by Claude (chat) as the architecture partner; built by Claude Code as the implementation partner.

**Current state:** a Vite project deployed to Netlify at
`wordbank.flyinggiraffe.ai`, synced via Firebase Firestore using a shared
"family code." Five tabs — Practice, Sentences, Reading Passage, Speech-To-Text,
Word Bank — a correction system that requires a mishearing to be confirmed twice
before it auto-applies, and phonetic matching on top of it. Harlie is using it
daily. Every branch gets its own preview URL, so changes are testable on an iPad
before they reach her.

The original single-file app is kept at `legacy/index.html`, and a differential
test drives both it and the port to prove the Firestore schema never diverged.

---

## 1. Why restructure before adding features

The single-file approach was right for getting something working fast. It's now the wrong shape for what's next:
- Voice Lock's WASM compile step needs a real build pipeline (Emscripten → bundled asset), which doesn't fit cleanly into a hand-copied HTML file.
- Phonetic matching adds a second data dimension to every bank entry — cleaner as its own module than more inline logic in an already-dense script block.
- Everything currently gets verified by static analysis (div balance, `node --check`) because there's no way to run it in a real browser from chat. Claude Code can actually launch it and click through it. That closes a real gap.

**Recommendation:** scaffold a proper Vite project (`npm create vite@latest`, vanilla JS or React — vanilla is fine, this app doesn't need a framework's complexity). Keep deploying to GitHub Pages as a static build (`vite build` outputs static files, same hosting model as now, same zero cost). Firebase Firestore stays exactly as-is as the sync layer.

Suggested structure:
```
/src
  /features
    practice.js
    sentences.js
    reading.js
    freewrite.js
    bank.js
    voicelock.js       (added later)
  /lib
    phonetics.js        (new — see §3)
    firestore.js         (existing sync logic, extracted)
    speech.js             (Web Speech API wrapper)
  main.js
  style.css
/public
  eagle_params.pv → removed; sherpa-onnx model assets go here instead when built
```

This is a refactor of working code, not a rewrite — the logic in the current HTML file is sound and should move over close to as-is, just split into modules.

**One fix to make during this port, not after:** the Sentences and Reading Passage matching logic currently compares recognized words to expected words *by position* (`heardWords[i]` against `expectedWords[i]`). If she drops a word, or the recognizer splits/merges a word, every word after that point misaligns and shows as wrong even when it isn't. This matters more now that sentence-based practice is becoming the primary way the bank gets built (see §2) rather than a supplement — worth replacing with a proper sequence-alignment approach (e.g., a Levenshtein-based word alignment) instead of blind positional indexing.

---

## 2. Content strategy: sentence-first, not word-first

Decision, made in conversation with the parent: **short sentences should become the primary mechanism for building the word bank, not isolated word drilling.** Reasoning:

1. **Context resolves what isolation can't.** Homophones ("to/too/two," "off/of," "see/sea") and context-dependent pronunciation ("a" the article vs. "a" the letter) are structurally unsolvable in isolated-word practice — there is no correct answer without surrounding context, for a human or a recognizer. This is *why* those word pairs were pulled from the isolated Practice list earlier; sentence practice is where they actually belong.
2. **Ecological validity.** Harlie's actual use case — homework, classroom work — is connected speech. Training and banking corrections in that same format transfers better than isolated drilling.
3. **Cognitive load stays manageable if sentences stay short** (3–5 words: "the cat sat," "there are two ducks"). Long sentences add working-memory burden on top of articulation planning; short ones don't. This matches standard decodable-reader convention, not a novel idea — early literacy instruction has used this pattern for decades.

**Practical plan (parent's, worth following as-is):**
- Use a separate chat for content generation — research and draft a large set of short, original sentences designed to collectively cover every word in the practice list (and eventually, target specific phonics patterns). Keep this work separate from app-engineering conversations; it's a content task, not a code task.
- Guidance worth giving that content-generation chat: track coverage explicitly against the practice word list (which words are and aren't hit yet), keep every sentence short (3–5 words) and grammatically simple, and write fully original sentences rather than adapting any existing published reading program — decodable readers like PLD, Bob Books, etc. are copyrighted, and their *scope-and-sequence structure* (which phonics pattern gets introduced in what order) is the reusable, non-copyrightable part, not their actual text.
- Long-term: compile these sentences into short illustrated "stories" — see §6. This turns bank-building into "read some short stories" rather than "drill a list," which matters a lot for a 9-year-old's engagement over time.

This doesn't require new app architecture — the Sentences/Reading Passage matching logic already works at the sentence level. It's a content strategy shift (write for coverage, prioritize sentences over isolated words) more than a code change, aside from the alignment fix noted above.

**The practice word list needs to become extensible, not fixed.** Currently `PRACTICE_WORDS` is a static built-in array (355 words after removing homophones/context-dependent words). Real classroom and homework use will surface specific words worth tracking that aren't in that list — add a simple **"Add a custom word"** input (Word Bank tab) that inserts any typed word directly into the practice queue alongside the built-in list. This is deliberately *not* a browsable full-dictionary UI — at 100,000+ entries, that's not a useful way to find anything, and the actual need ("this word came up for her specifically") is better served by just typing it the moment it's relevant.

Separately, worth adding a **curated "suggested words" list** — not the full dictionary, but a well-established extended grade-level vocabulary (e.g., a standard 3rd/4th-grade word list) — browsable/searchable, each with an "Add to her practice list" button, for the times the parent wants to scan for candidates rather than already knowing the specific word needed.

**Important consequence for the sentence-drafting workflow:** because the word list can grow over time (new custom words added as they come up), sentence coverage isn't a one-time task with a finish line — it's an ongoing pipeline. Whoever does the sentence-drafting work (the separate research chat) should expect to be asked back periodically to cover newly-added words, not just once at the start.

---

## 3. Phonetic-key matching (highest priority — build this first)

### The problem it solves
Today, a correction only applies if the recognizer's output *exactly* matches previously-banked text. Two issues follow from that:
1. You can't proactively tell the system "she says it like *this*" — you can only wait for the recognizer to happen to produce some real-word text and correct it after the fact.
2. If the recognizer is inconsistent — the same mispronunciation gets transcribed as different real words on different attempts — the correction never accumulates enough confirmations to activate, even though the underlying speech pattern is completely consistent.

### The fix
Add a **phonetic key** to the matching system, computed with the **Double Metaphone** algorithm (the standard, well-documented approach for "do these two strings sound alike in English" — deterministic, no ML, plenty of solid reference implementations to port to JS). Double Metaphone was chosen over plain Soundex because it handles vowel and consonant-cluster ambiguity (which is exactly the territory Harlie's mispronunciations live in) far better.

**Data model change** — each bank entry becomes:
```js
{
  correct: "yellow",
  heardExamples: ["yo yo", "ye oh"],   // exact ASR outputs seen so far (existing behavior)
  phonicSpelling: "yeyo",               // NEW — manually entered by parent
  phonicKey: "Y",                        // NEW — Double Metaphone key of phonicSpelling
  count: 2,
  active: true
}
```

**Matching logic** (runs in this order):
1. Exact text match against `heardExamples` (current system — keep it, it's the most precise signal when it fires).
2. If no exact match: compute the Double Metaphone key of whatever the recognizer just output, and compare against every banked `phonicKey`. A match here counts as a hit on that entry.

**New UI in the Word Bank tab:** a "phonic spelling" field next to each entry (or in the manual-add form) where you can type "yeyo" directly — sound it out however makes sense to you, doesn't need to be a real word. This is entered *once, proactively*, rather than only being extractable after the recognizer happens to mishear something.

### As built — two deviations, for review

**1. Stored as a second field, not merged into the bank entry.** The sketch above
puts `heardExamples` and `phonicSpelling` on one object, which means re-keying
`word_bank` from heard-text to correct-word — a migration on live data. Instead
there is a new `phonic_bank` field keyed by word, and `word_bank` is untouched.
Logically it is the same model (an entry's heard examples are exactly the
`word_bank` keys pointing at it); it is denormalised so nothing needs migrating.
A phonic entry has no `count`/`active`: the parent typed it deliberately, so
there is nothing for the app to confirm about it.

**2. Matching is scoped to one expected word, never a global scan.** The sketch
says to compare the recognizer's key "against every banked phonicKey". Measured
against the real 355-word list, that is not safe: 70 key groups collide, `AT`
covers nine practice words, and the one-character `A` — which is what "yeyo"
keys to — also covers you/we/way/who and the bare words a, i, oh, e. So the
question asked is always "does this sound like how she says the word I already
asked her for", which keeps the collision surface to a single entry.

Speech-To-Text, having no expected word, was initially left with no phonetic
behaviour at all. It now has the narrowest possible version, added after iPad
testing: a suggestion underlined in amber that one tap accepts, never a rewrite.
Loose spellings are excluded, and an ambiguous match suggests nothing. Accepting
counts as one sighting, so it feeds the same pending-then-active path rather
than bypassing it.

**The confidence buffer is stronger than requested.** A phonetic hit never
auto-advances and never auto-activates: it shows amber with a one-tap confirm,
and confirming banks the exact text as *pending*, still needing two sightings.
Phonetics accelerates accumulation rather than substituting for it.

**One limitation worth knowing:** Double Metaphone models English spelling, not
her articulation. It will not connect "red" to "wed" or "think" to "fink" on its
own — the parent supplies the sound, and it absorbs the recognizer's spelling
variance. That is the actual complaint it answers (§3's problem 2).

**This also directly addresses the homophone/collision risk you raised** — because phonetic matching is *approximate*, it's actually more prone to over-matching than the exact-text system, not less. Claude Code should build a confidence buffer here: a phonetic match should require a slightly higher bar (e.g., exact Double Metaphone key match, not just "close") and should still route through the existing pending→confirm flow before going active, never auto-activate on a single phonetic hit.

---

## 4. Staleness / re-test reminders

### The idea, as you described it
Not a forced re-test — a gentle, dismissible nudge. Speech therapy progress means an old correction might no longer be needed; the app should notice and ask, not assume permanence.

### Spec
- Add `lastConfirmedDate` (ISO timestamp) to every active bank entry — set whenever an entry is confirmed or re-confirmed.
- On app load, check for active entries where `lastConfirmedDate` is older than a threshold (suggest 60 days as a default, easy to make configurable later).
- If any exist, show a small dismissible banner: *"It's been a while since some of her corrections were checked — her pronunciation may have improved. Review them?"*
- "Review" opens a filtered Practice-style flow that cycles **only** through stale entries. Same familiar mechanic — she says the word, you confirm it's still needed or mark it resolved (removing the correction entirely, since if she now says it correctly, we don't want a stale rule silently "fixing" something that isn't broken anymore).
- Dismissing the banner should snooze it for a set period (e.g., 14 days), not just for the session — otherwise it becomes noise she or you tune out.

This is a small, self-contained feature — good second build after phonetic matching, before touching Voice Lock.

---

## 5. Voice Lock (sherpa-onnx) — build this last

Already scoped in earlier conversation; summarizing for this document so Claude Code has the full picture without needing the chat history:

- **Why not Picovoice Eagle:** trial access was declined ("reserved for opportunities with a defined commercial use case"); paid tier is the only path, and licensing risk grows if this ever serves other families.
- **Path forward: sherpa-onnx** (Apache 2.0, open source, no per-user licensing). It has a working speaker-embedding model (`embedding.onnx`, confirmed to exist in their repo) used inside their speaker-diarization WASM demo — but there's no pre-built browser package the way Eagle had. **This requires compiling their C++ source to WebAssembly using Emscripten.** That compilation step needs to happen in a real dev environment with the ability to test the output in an actual browser — this is squarely a Claude Code task, not something to attempt blind.
- Once compiled, the integration pattern is conceptually the same as the Eagle build that already exists in this codebase's history: enroll (record her voice, extract an embedding, store it), then gate every recognizer call behind a live similarity check against that stored embedding.
- **Sequencing reason for building this last:** it's the highest-uncertainty, highest-effort piece, and the other two features are lower-risk wins that directly help Harlie sooner. Get the foundation (Vite restructure) and the two quick wins shipped and tested first, then tackle the harder infrastructure with that momentum.

---

## 6. Illustrated reading passages (extends §2's story plan)

Once the sentence corpus from §2 gets compiled into short "stories," each story needs a place to carry an illustration — generated externally (Canva, Adobe Firefly) and attached to the passage, not generated by the app itself.

**Spec:** extend Reading Passage's data model — a saved passage becomes `{ text, imageUrl (optional) }` instead of just raw text. If `imageUrl` is set, display it alongside the passage text in Reading Passage mode. Simple addition: no new matching logic, no new correction logic — purely a display layer on top of what already exists. Multiple stories should be selectable (currently Reading Passage holds one passage at a time; this should become a small library of saved stories to choose from, each with its own text, image, and independent progress tracking).

**Bulk import:** at the scale of "enough sentences/stories to cover the full word list," pasting each one in individually isn't practical. Support importing a batch (CSV or JSON — whatever the content-drafting chat naturally outputs) in one action, rather than one story at a time.

**Review before use — a real gate, not just a habit:** every imported story starts in a `draft` state, invisible to Harlie. It only becomes available for her to actually practice with once the parent has read it and explicitly marked it `approved` (in a dedicated review queue). This matters because AI-drafted content can drift in reading level or contain an awkward sentence — the parent is the actual judge of what's right for her, and nothing should reach her unreviewed.

This is a lower-priority, purely additive feature — sequence it after the accuracy-focused work (§3, §4), since it's about engagement and delivery, not correctness.

## 7. Roadmap (re-scoped, September 2026)

**Everything below the line waits on evidence from the line above it.** The
foundation and phonetic matching are built; whether phonetic matching actually
works is not yet known, and nothing else should be built on top of an unproven
assumption.

### Done

1. ~~**Scaffold the Vite project structure**~~ — ported module-by-module,
   including the sentence-alignment fix. Schema parity with the original single-
   file app is pinned by a differential test, so live data was never at risk.
2. ~~**Phonetic matching** (§3)~~ — built, with two deliberate deviations
   documented in §3. Hosting moved to Netlify at `wordbank.flyinggiraffe.ai`
   with per-branch preview URLs, which is what makes real iPad testing possible
   at all; speech defaults to en-AU.

3. ~~**API-based speech recognition** (§9)~~ — the browser's recogniser is now
   the fallback, not the primary path. This lands *before* the evaluation
   below rather than after it, because the two questions there are about how
   well corrections accumulate, and they were being asked of a recogniser that
   was itself the largest source of error.

### Now: prove it works — 2–3 weeks of real use

The immediate goal is **not** more features. It is finding out whether phonetic
matching earns its place, through Harlie actually using Practice and Sentences.
Two questions:

- **Does the bank fill faster?** The complaint phonetic matching answers is that
  inconsistent transcription stops corrections ever reaching the two sightings
  they need to activate. So: how many pronunciations get recorded, and how many
  corrections go from pending to active, compared with the flat line before?
- **Does Sentences catch homophones?** §2 argues context resolves what isolation
  structurally cannot — to/too/two, off/of, see/sea. Sentences practice is where
  that claim gets tested. Does it actually surface and correct them?

A third question, from §9: **does it transcribe what she said, or what she
meant?** The new recogniser is an LLM and LLMs tidy. Say a word wrong on
purpose; if the transcript reads it as correct, the accuracy gain has come at
the cost of the thing the app exists to notice, and the model needs changing
(one environment variable) rather than the app.

What to watch for, and bring back:

- Pronunciations that never fire, or fire on everything — the collision risk in
  §3 is real, and a one-character key like `A` is the likeliest offender.
- Phonetic hits confirmed that turn out to be wrong. A false accept is worse
  than a miss here: it silently teaches the bank something untrue.
- Whether the amber "sounds like how she says it" state reads clearly in the
  moment, mid-session, with a 9-year-old waiting.
- Whether recording a pronunciation actually happens in practice, or whether it
  is one step too many when she is right there waiting.

If it does not earn its place, the honest options are to tune it or to remove
it — not to build more on top of it.

### After that, pending results

3. **Staleness reminders** (§4) — small, valuable, low risk. The natural next
   build once matching is trusted.
4. **Illustrated reading passages / story library** (§6) — needs the content
   corpus from §2 to exist first.
5. **Voice Lock via sherpa-onnx** (§5) — biggest lift and highest uncertainty.
   Deliberately last: it is infrastructure, not accuracy, and none of the above
   depends on it.

Reading and stories, staleness, and Voice Lock all sit below the line. None of
them should start before the two questions above have answers.

## 8. How to use this document

Point Claude Code at the current GitHub repo, hand it this file, and start with step 1. When Claude Code finishes a milestone, bring the result back here — I'll review the approach, sanity-check the phonetic-matching logic and data model, and help think through anything that doesn't feel right before you build further on it. That loop — Claude Code builds and tests, you bring it back for review — is where this partnership actually works best.

## 9. Speech recognition: API-based, not the browser's (parent's decision)

**The decision.** The browser's built-in recogniser is gone from the primary
path. The browser captures audio and sends it to a Netlify Function in this
repo; the function holds the API key and calls a transcription provider;
what comes back is text. Everything downstream — corrections, pronunciations,
phonetic matching, the bank — operates on text and is unchanged.

**Why.** The Web Speech API is the same engine Seesaw uses, and it is what has
been mishearing her. Every accuracy feature built so far (§3, §4) sits on top
of its output; improving the input is the largest single accuracy gain
available, and it is the one that makes the rest of the work worth more rather
than less.

**Provider: OpenAI now, for accuracy. Self-hosted Whisper on AWS Sydney later
if a school requires Australian data residency.** Parent's decision. The
function is written behind a provider interface — audio in, language hint in,
vocabulary hints in, text out — so that swap is one file
(`netlify/functions/providers/`), not a rewrite. Nothing above the interface
knows which provider answered.

**Model: `gpt-4o-transcribe`, not `whisper-1`.** Three reasons, in order of how
much they matter here:

1. **Short clips.** whisper-1's best-documented failure mode is inventing text
   on near-silent or very short audio — it was trained on 30-second windows and
   pads shorter ones. Practice sends single words of about a second. That is
   precisely the input that triggers it, and a confidently hallucinated word is
   worse for this app than no answer, because the bank would learn from it.
2. **Accent.** gpt-4o-transcribe reports materially lower error rates on
   non-US English than whisper-1, which matters for an Australian child.
3. **Nothing is given up.** The only whisper-1 features this app would lose are
   word timestamps and verbose JSON, neither of which it uses. Both models take
   the same prompt-based vocabulary hint.

`OPENAI_TRANSCRIBE_MODEL` overrides the model without a code change, so testing
whisper-1 against her actual voice costs one environment variable.

**The risk to watch, and it is a real one.** gpt-4o-transcribe is an LLM, and
LLMs tidy. It may transcribe what she *meant* rather than what she *said* —
turning "yeyo" into "yellow" on its own. For an app whose entire purpose is
noticing the difference, that is a false accept, and §7 already names false
accepts as worse than misses. Two things are done about it in the code:
`temperature: 0`, and a prompt that states her vocabulary without ever asking
the model to correct anything. Neither is a guarantee. **This is the first
thing to check on the iPad:** say a word wrong on purpose and see whether the
transcript says so.

**What the vocabulary hints contain.** The correct words of active corrections,
and the words she has pronunciations for, capped and with the word she was just
asked for first. Deliberately *not* the heard text or the sounded-out
spellings: priming the decoder with "yeyo" invites it to emit "yeyo", and the
bank cannot map back from a non-word.

**Recording control (parent's decision).** Tap to start, tap to stop. Auto-stop
exists only so a recording can never be left running: a trailing-silence
threshold tuned per mode (short for Practice's single word, longer for
Sentences, Reading and Speech-To-Text) plus a hard ceiling. Silence is detected
in the browser with Web Audio, and a clip in which nothing was ever heard is
refused locally rather than sent — see the hallucination risk above.

**Fallback (parent's decision).** If the function cannot be reached, the
browser's own recogniser stands in for that attempt, and a banner says so,
naming the error code, and says plainly that it is the engine that was
mishearing her before. It clears itself when a real transcript comes back.
One constraint worth recording: Safari only starts its recogniser from a user
gesture, and awaiting the upload spends the tap's. So the fallback auto-starts
where the browser allows it, and where it does not, the next tap goes straight
to the browser recogniser instead of paying for another timeout.

**Voice Lock (§5) has its seam.** The recorded clip is a value in the app
before anything is sent: `addClipGate()` registers a check that runs on the
clip, and a refusal means nothing leaves the device. Enrolment plus one gate is
the whole integration.

## 10. Context-aware correction in Speech-To-Text (parent's decision)

**The problem.** The correction bank has no context. Once "liquor → little" is
confirmed, it rewrites *every* "liquor" — including a real one, in a sentence
where she plainly meant it. The same is true of every entry: a find-and-replace
cannot read the rest of the sentence, and the more the bank fills, the more
often it will be wrong about a word it has no business touching.

This is the mirror of §3's collision risk. Phonetic matching was scoped to a
single expected word precisely because a global scan over-matches. Speech-To-Text
has no expected word, so the bank fires there with nothing to check it against.

**The decision.** Use Claude to apply corrections with the sentence in view, so
the bank becomes knowledge Claude weighs rather than rules that fire blindly.

**The flow.** After the recogniser returns a Speech-To-Text transcript, the
browser sends it to a second Netlify Function along with her pronunciations and
her *confirmed* corrections. Claude gets the transcript and the patterns with a
plain instruction: using the sentence, decide which words are her known
mispronunciations and which are the real word. Each changed word is marked, and
one tap puts it back.

**Claude's changes never feed the bank.** Learning stays in Practice, Sentences
and Reading, which know the word she was asked for and can therefore tell a
correction from a guess. This step only ever changes what is on screen. Nothing
it does is saved to Firestore, and the schema is unchanged by this feature.

**Provider, as first built: Claude on Amazon Bedrock, ap-southeast-2 (Sydney),
through the classic InvokeModel endpoint.** *Superseded in September 2026 by the
direct Anthropic API — see the end of this section; the Bedrock provider is
kept, one variable away.* Parent's decision, and the same residency
reasoning as §9's future move: a school asking where a child's speech is
processed gets "Sydney" as the answer for this half already. Behind the same
provider-interface pattern as the recogniser — one file in
`netlify/functions/providers/` — so model or platform is a swap, not a rewrite.
Authentication is a Bedrock API key (bearer token); the official Bedrock SDK's
classic client takes it as `apiKey` and sends it as `Authorization: Bearer`,
so this is the official SDK, not a hand-rolled HTTP call. Netlify reserves
`AWS_`-prefixed variable names, so the key is `BEDROCK_API_KEY`.

**How the endpoint, region and model were settled (September 2026).** The
first build used the newer Messages-API endpoint (`bedrock-mantle`) with Claude
Sonnet 5 in Sydney. On the first real device the bare model ID was answered
with a 404; so was the `au.` inference profile; the account showed no Anthropic
profiles in Sydney; and Melbourne, the one Australian region with an in-region
endpoint, was tried next. The finding that settled it: **this account is not
enabled for the newer endpoint at all** — every model there answers 403 *"not
available for this account, contact AWS Sales"*, and the older models 404. The
classic InvokeModel endpoint (`bedrock-runtime`) is proven on the same account:
the parent's worksheet generator runs Claude Sonnet 4.5 through it in Sydney.
**So the provider now uses the classic endpoint, in Sydney, with the versioned
Sonnet 4.5 ID as an inference profile** (`au.anthropic.claude-sonnet-4-5-20250929-v1:0`
by default — the classic endpoint serves newer Claude models only through
cross-region inference, and `au.` keeps routing inside Australia). `BEDROCK_REGION`
and `BEDROCK_MODEL` override the defaults and must change together. The request
carries no thinking parameter, because Sonnet 4.5 and the 4.6+ models take
different forms and the model is configurable; the judgement is small enough
not to need it. When the account is enabled for the newer endpoint, Sonnet 5
is a change to this one provider file.

Three things the detour left behind. A 404 from the provider is reported as
`model-not-found`, and the classic endpoint's "retry with an inference
profile" 400 as `needs-inference-profile`, rather than the generic
`provider-error`, so the banner says which. And there is a read-only
diagnostic, `context-diagnose`, behind the same provider interface: it lists
the Anthropic models offered in the region, the system-defined inference
profiles, and Bedrock's own authorisation status for each candidate ID, and
on request sends one one-token probe through the same endpoint correction
uses and reports exactly what came back — so the next region or model
question is answered by asking, not guessing. The README's step 5 says how to
read it.

### Three things that were not obvious, and are load-bearing

**1. Claude reports decisions against word positions, never a rewritten string.**
The transcript goes over numbered, and what comes back is `{index, to, reason}`.
A rewritten sentence would have to be re-aligned against the original — the
exact class of bug §1's alignment fix existed to remove — and a model that
quietly reordered, dropped or added a word would not be noticed. Positions
cannot do either. Both the function and the browser then check every change
against their own copy of the words; neither takes the other on trust.

**2. The prompt says the bank is evidence, not an instruction.** Without that,
this becomes a general autocorrect, and an app whose entire job is noticing how
she actually speaks would start hiding it. Claude is told explicitly: only
change a word one of the lists covers, never fix spelling or grammar it was not
given a pattern for, and when the sentence does not settle it, leave the word
alone. A missed correction is recoverable; a wrong one may never be noticed.

**3. Only confirmed corrections are sent.** A pending one has been seen once and
is not yet trusted to fire on its own in the bank — it is not trusted here
either.

**Fallback.** If the function cannot be reached, the app applies confirmed
corrections the old way and says so, naming the code and saying plainly that
this is the behaviour the feature replaces: *a word that only looks like one of
hers will have been changed too.* Never silent.

**The log.** A rolling record of every change — word, replacement, reason — in
Word Bank, so a change that keeps happening, or one the parent keeps undoing, is
easy to spot. Undoing marks an entry rather than deleting it, because a change
that is always reverted is exactly the pattern the log exists to surface.

It was first kept in `localStorage`, as a record of what one device showed.
**Parent's decision, September 2026: it is now a synced field, `context_log`,
on the family document,** so it can be reviewed from any device — the iPad is
where changes happen and the parent's own device is where they get read. It is
a rolling log of the most recent 50 entries, newest first, and the whole list is
written on each change, so the document can never grow past that. It is purely
additive: the ten original fields are untouched and the differential test pins
that, in both directions — the port writes only `context_log` when it logs, and
the original single-file app reads and writes around a document that carries
it. Nothing reads the log to decide a correction, so it still cannot feed the
bank. The old device-local log is not migrated; there was never more than a few
sessions of it.

**What to watch on the iPad.** Whether Claude leaves real words alone — say
"dad bought a liquor bottle" once the bank has that entry and see. And whether
the extra step is noticeable enough to be annoying: it runs after she has
finished speaking, but it is still a wait before the corrected text settles.

**The first real test failed, and what changed (September 2026).** With
"liquor → little" confirmed, "Dad brought a bottle of liquor." came back as
"Dad brought a bottle of → Little": the model matched the pattern without ever
asking whether the word as written already made sense, and the replacement
arrived capitalised mid-sentence with the full stop gone. Two fixes, both the
parent's call:

1. **The prompt now reads the original first.** For each word a list covers,
   the model is told to read the sentence with the word exactly as written and
   keep it if it makes sense; only if it does not, read it with the
   replacement, and change it only when that reads clearly better; and when
   neither does, keep the word. A confirmed correction is evidence, not an
   order. The tool asks for the reason *before* the replacement, so the model
   writes out why the original cannot be right before it commits to a word,
   and the worked example in the prompt is a pair that is not in her bank —
   the parent's own re-test of "liquor" proves the rule, not the example.
2. **A replacement is fitted to the word it replaces** before it is shown or
   logged: the original's case is copied and its punctuation kept, so
   "liquor." becomes "little." and only a sentence-initial "Liquor" becomes
   "Little". A change that fits back to the original is dropped, on both
   sides — the function also treats "Liquor" for "liquor." as no change.

The prompt is a lever, not a proof. Whether Sonnet 4.5 now leaves "a bottle
of liquor" alone is the next thing to check on the iPad, with a second
sentence where the change *is* right ("I want the liquor one") to confirm it
still fires.

**The second test failed too, and the provider changed (parent's decision,
September 2026).** With the read-as-written prompt in place, Sonnet 4.5 still
changed "a bottle of liquor" to "a bottle of little". Two facts settled what
to do about it. The Bedrock account has a model agreement for Sonnet 4.5
only — Opus 4.8 answers 403 *"not available for this account"* — so a stronger
model is not available there. And this is a judgement task: the prompt had
been made as explicit as it usefully can be, and the judgement was still the
failure. So the context-correction provider is now **Claude Opus 5 on the
direct Anthropic API** (`api.anthropic.com`), authenticated with
`ANTHROPIC_API_KEY` in Netlify, in a new provider file
(`netlify/functions/providers/anthropic-claude.mjs`). The request carries no
thinking parameter, which on Opus 5 means it thinks adaptively before it
answers — the thing a judgement call wants — and `max_tokens` has room for
that. `ANTHROPIC_MODEL` overrides the model.

Three things were kept deliberately:

1. **The Bedrock provider file is intact and switchable.** `CONTEXT_PROVIDER`
   selects the provider (`anthropic-claude` is the default,
   `bedrock-claude` the other), so when Sonnet 5 access on Bedrock comes
   through, returning to Sydney is one variable, not a rewrite. The
   residency reasoning above still stands; it has simply lost, for now, to
   a correction that is actually right.
2. **The prompt is one file, shared by both** (`providers/claude-prompt.mjs`).
   It is the load-bearing part, and a copy in the provider not in use would
   drift unnoticed. A test pins that neither provider carries its own.
3. **The diagnostic follows the switch.** `context-diagnose` asks whichever
   provider `CONTEXT_PROVIDER` selects — the same path her sentences take —
   and reports what that provider can see: through the direct API, the
   model IDs the key can see and whether the configured ID resolves; through
   Bedrock, the region's models, profiles and authorisation as before. The
   `?probe` one-token request goes through the same endpoint correction uses
   in either case.

The two sentences to re-test on the iPad are unchanged: "Dad brought a bottle
of liquor" must come back untouched, and "I want the liquor one" must change.

**The wait was too long, and effort is now the dial (parent's decision,
September 2026).** Opus 5 answered the judgement question, but it thinks before
it answers and the pause before the corrected text settles was longer than a
nine-year-old will sit through with the screen half-finished. Latency is not a
detail here: an accuracy feature she will not wait for does not get used, and
the whole point of §7's evaluation is whether she actually uses this.

So the request now carries `output_config: { effort }`, at **`medium`** — one
notch below the API's own default of `high`. The reasoning for stepping rather
than jumping: the model was changed *because* the judgement was failing, and
spending that judgement back to save a second would undo the fix. `medium` is
the smallest step that buys the wait back.

**It is an environment variable, `ANTHROPIC_EFFORT`, because the right level is
not knowable from here.** Only the iPad, mid-session, with her waiting, can say
whether the pause is short enough and the corrections still right — and those
two pull in opposite directions. The parent moves one variable and redeploys
rather than asking for a code change: `low` if it is still slow, `high` and up
if a word of hers gets changed that should not have been. A value that is not
one of the five real levels is ignored rather than sent, because the API would
answer 400 and the only visible symptom would be the banner saying
*provider-error* — a typo in Netlify must not be the thing that silently drops
her back to the blind find-and-replace. The diagnostic reports
`configuredEffort` so the live setting can be read back.

**What this does not settle.** Whether `medium` still passes both sentences is
not known from the code: it is a property of the model, and the check is the
same two sentences on the iPad. The level shipped is a starting point with a
documented ladder (README, *If the wait is too long*), not a measured result.

**Undo is a toggle, not a one-way door (parent's decision, September 2026).**
Tapping a changed word put the original back and that was the end of it: the
correction was gone, with no way to ask for it again. A marked word invites a
tap, and a nine-year-old will take that invitation out of curiosity — so the
one control that exists to make this feature safe was also the one control she
could use to destroy a correction, without either of them knowing which word it
had been.

So a tap now toggles, indefinitely: her word, Claude's word, her word. The word
stays marked in **both** states, because a word that stopped looking tappable
once it was put back would say the change was gone for good — which is the trap
being fixed, not a fix for it. The two states are told apart by three things
that all survive greyscale and a colour-blind reader: a different glyph (`↩`
against `→`), a dashed rule against a solid one, and regular weight against
bold. Colour is the last signal, not the only one, and an e2e check reads the
computed styles to pin that.

**The log follows the screen rather than counting taps.** An entry carries one
`reverted` flag, so reapplying a change clears it. A curious tap-and-tap-back
must not leave a permanent "she undid this" on a change the parent never
objected to — that would be noise in exactly the signal the log exists to
surface. A change genuinely left undone still reads as undone, which is what
§10's *The log* asks for. Nothing else about the log changes: still
`context_log`, still the most recent 50, still purely additive, and still
nothing that can feed the bank.

## 11. Changing the family code from Word Bank (parent's decision)

**The problem.** The family code is typed once, on the entry screen, and then
lives in the browser's storage for good. Moving a device to a different code —
a teacher setting up a school iPad against her family, or the parent leaving a
short code behind for a better one — meant clearing Safari's website data,
which is not something a teacher can be asked to do and not something the
parent should have to.

**The decision.** Word Bank gets a "Family code" card: it shows the code this
device is using, takes a new one, and switches the app to it.

**What it does, and what it deliberately does not.** The card uses exactly the
storage the entry screen uses — the same key, the same normalisation, the same
refusal of a code with no letter or digit in it — so a device that switches
ends up in the state it would be in had that code been typed on first open.
`firestore.js` reads the code once, when it connects, so the switch itself is a
restart of the app; the card says so before it happens. Nothing is deleted:
her data stays under the old code, and typing that code again brings it back.
There is no list of codes, no confirmation of who else uses one, and no way to
copy data between codes — export and import already do that, deliberately as
a separate, visible step.

**Storage stays exactly as it was.** Same key, same normalisation, in
`src/lib/family-code.js`; a test pins that the card carries no rules of its own.

## 12. Getting the text out of Speech-To-Text (parent's decisions)

**What the tab is actually for.** Speech-To-Text is used for homework, and
homework gets pasted into Seesaw, Word and the like. Until now there was no way
to get the finished text out of the app at all — the one thing the tab exists to
produce was trapped on screen.

### Copy

**The decision.** A Copy button under the corrected text, which puts the plain
finished text on the clipboard and says briefly that it did.

**The words only.** What is copied is her words with the corrections that are
showing — no arrows, no marks, no highlighting. The marks on screen are CSS
pseudo-elements today, so scraping the panel's text happens to give the right
answer; that is luck, not a guarantee, and a mark that becomes a real character
later would land an arrow in a Seesaw post without anyone noticing. So the view
and the clipboard are both built from one function over the same decisions, and
a test pins that what is copied equals what the panel reads, in every state the
panel has — Claude's changes, a change put back, the blind fallback, and typed
text.

**Safari on iPad is the constraint, and it shapes the code.** Three things,
all in `src/lib/clipboard.js`:

1. **The write happens in the turn of the tap.** Safari ties clipboard access
   to a user gesture and an `await` before the write spends it, so the text is
   built synchronously in the handler and handed over with nothing awaited
   first. A mutation that adds one microtask ahead of the write fails a test,
   because on the one device she uses that is the difference between working
   and silently refusing.
2. **`navigator.clipboard` is not always there** — it needs a secure context and
   older iPadOS lacks `writeText` — so there is a second path through
   `document.execCommand('copy')`, deprecated everywhere and still the only
   thing that works on those devices.
3. **iOS will not select a plain hidden textarea.** The fallback needs a
   `contentEditable` element that is in the layout but off-screen, a `Range`
   over it, and `setSelectionRange` after — all three. That is the whole reason
   it looks the way it does. It puts back whatever the person had selected, and
   leaves nothing in the page.

The clipboard API is tried first and a *rejection* falls through to the old way
as well as an absence, because iPadOS does reject. A copy that did not happen
says so plainly rather than looking like it worked: she is about to paste.

### Recording adds on, and a Clear button

**The decision.** Each recording appends to the end, so a paragraph is built a
sentence at a time, with the marks on earlier sentences kept. A Clear button
starts fresh, and asks first if there is anything to lose.

**What was actually wrong.** The raw text already appended; what was lost was
every correction mark on it. Tapping record re-read the entire paragraph, so
the earlier sentences dropped to the blind find-and-replace during the wait and
then came back *recomputed* — silently putting back anything the parent had
undone. So only the new words are sent now, and the decisions already made are
kept and their positions offset. That also stops the wait growing with every
sentence, which is what §10's effort dial exists to keep short.

**Typed text is read whole, not skipped.** Typing invalidates the decisions
about what is in the box, so when the parent has typed there is nothing to
protect — the lot goes to Claude together, which has the side benefit that the
typed words get read rather than stepped over.

**One limitation, deliberate.** If a reading fails, the whole box drops back to
the blind find-and-replace, earlier sentences included, rather than showing two
kinds of correction at once with no way to tell them apart. The banner says so,
as §10 requires, and the marks return with the next reading that succeeds.
*Reversed in §13, September 2026: the parent hit this with a dropped connection
and lost a paragraph of review to it. A failure now affects only the sentence
that was being read.*

**Clear asks, because the tap that throws a paragraph away sits next to the one
that copies it.** It empties the text, the marks and the notes, and touches
nothing else — her bank is not involved, and a test pins that.

## 13. Three things real use on the iPad found (parent's decisions)

All three came back from Harlie actually using Speech-To-Text for homework,
which is exactly the loop §7 asks for. None of them is a correctness bug; all
three are the app failing to say what it is doing.

### The wait before recording stops

**The decision.** Speech-To-Text's trailing-silence threshold drops from 3.5
seconds to 1.5, and every mode's threshold becomes tunable from Netlify.

**Why 3.5 was wrong, and why 1.5 is safe.** Three and a half seconds of nothing
happening after she stops talking does not read as patience, it reads as the
app having frozen — the parent's words. What makes the shorter pause safe is a
change that landed since the number was chosen: recordings now add to the end
rather than replacing (§12). Being cut off early used to lose the attempt; now
it ends that sentence and the next tap carries straight on. The cost of
impatience here is one extra tap.

**The other modes were reviewed and deliberately left alone.** Practice stays
at 1200ms — one word has nothing to pause inside it, and it was already the
most impatient. Sentences (2000ms) and Reading (2500ms) stay long, because
there the recording is scored against a target sentence: cutting her off
mid-sentence costs her the whole thing again, which is a worse failure than a
wait. The asymmetry is the point — Speech-To-Text can afford to be impatient
precisely because nothing there is scored.

**Tunable, with one honest caveat.** `VITE_SILENCE_MS_FREEFORM`, `_WORD`,
`_SENTENCE`, `_PASSAGE` and `VITE_NO_SPEECH_MS` override the defaults. These
are *build-time* variables — Vite substitutes them into the bundle — so
changing one needs a redeploy, unlike `ANTHROPIC_EFFORT` and the other
function-side variables, which are live. It is still not a code change, and
Netlify's Trigger deploy is the whole operation, but it is not as immediate
and the README says so. A value that is not a number in a sane range is
ignored rather than used, the same discipline as §10's effort level: a typo
must not be what leaves a recording running for a minute, or stops it before
she has drawn breath.

### Nothing on screen while the clip is transcribed

**The decision.** Turning a clip into text gets its own visible state.

**What was actually missing.** There was a label — *Working it out…* — but it
only ever appeared on a tap-to-stop, and even then the button kept its gold
recording fill for the entire upload. So the largest thing on screen said
"still recording" while nothing was being recorded. On an **auto-stop** there
was no signal at all: nothing in the app knew the recording had ended until the
transcript came back several seconds later. That is the case the parent hit,
and the same one the threshold above makes more common.

**The fix is a seam, not a label.** `startCapture` takes an `onSending`
callback and fires it the moment recording ends — before the silence check and
before the clip gates, because even a clip about to be refused has stopped
being a recording. The mic button then swaps the recording green for gold and
grows a ring, the label says so, and `bindMic` passes an `onWorking` hook up so
a screen can say it somewhere other than the mic. Speech-To-Text uses it:
*Writing down what she said…* appears under the corrected text, which is where
the parent is actually looking.

Only one of the three signals is motion, deliberately. The app has a global
`prefers-reduced-motion` rule that stops animations, so a spinner alone would
be invisible to anyone who has that on: the fill colour changes and the ring
appears whether or not it turns.

### A dropped connection undoing a paragraph of review

**The problem, in the parent's words.** The wifi went mid-paragraph. The
context reading failed, and the blind find-and-replace was applied to the
*whole* box — silently recomputing sentences that had already been read
correctly, and putting back words they had deliberately tapped to keep. One
dropped connection undid all of their earlier review.

This was a known, documented limitation (§12, *One limitation, deliberate*) and
it was the wrong call. The reasoning was that showing two kinds of correction
at once with no way to tell them apart would be worse. That trade only holds if
the two kinds are genuinely indistinguishable — and they can be told apart, so
the trade was never necessary.

**The decision.** A failed reading affects only the sentence that was being
read.

- Earlier sentences keep their context marks and every put-back decision,
  untouched.
- The stretch that was not read is marked as one **run** — a gold wash with a
  rule down its left and a leading `?` — rather than word by word, because what
  went wrong happened to the whole sentence, not to any word in it.
- Her confirmed corrections still fire *inside* that run, the way the whole box
  used to be treated. That is the §10 fallback, now confined to where it
  belongs, and it uses the bank's own single-token rule (`blindToken`) rather
  than a second copy of it that could drift.
- The note names the code, says the run is running on the blind
  find-and-replace, and says plainly that everything before it is untouched.
- **Read it again** retries that sentence, and only that sentence. The mark
  stays up while it asks: clearing it first would show the words with no
  correction at all for as long as the request takes, and would say the stretch
  had been read before anyone knew whether it had. A retry that fails puts the
  mark straight back.

Two things a retry deliberately will not do. It will not run against text that
has changed since the failure — the run's word positions would no longer mean
anything, and a retry landing on the wrong words is worse than no retry. And
editing the box clears the run along with everything else, because editing
already makes every decision about it stale; the way back from there is to
record the sentence again.

## 14. Speech-To-Text becomes a worksheet (parent's decisions)

**Why the page changed shape.** It was one scratch box, which is not the shape
of the work she actually does. Her schoolwork is a weekly creative-writing
piece in paragraphs — a diary entry written as a character — and short reading
and writing questions. Every one of them is *a question she has to answer*,
and every answer goes back into Seesaw. A single box made her hold the question
in her head, and gave the app no way to help with it.

**A sheet is one piece of schoolwork**: a name, and one or more
question-and-answer pairs.

### The question is hers to paste in

**Parent's decision: she does this herself.** She is nine, and copying the
question across from Seesaw is part of doing her own schoolwork. So the app
does not fetch it, guess it or ask the parent for it — it gives her a box.
The box is the largest input on the page, a textarea with a dashed gold border,
because a paste target on an iPad has to be unmissable and forgiving of a
mistimed tap.

**A speaker beside it reads it out, as many times as she wants.** This is not a
convenience. A question with a word she cannot read is a question she cannot
answer, and re-reading it aloud is the thing that unblocks her. It uses her
configured accent, the same as everywhere else, and `speak()` cancels whatever
was already talking so a second tap restarts rather than overlapping.

### Her answer is the old page, unchanged

The mic, recordings adding to the end, context correction, tap-to-toggle and
Copy all behave exactly as §10, §12 and §13 describe. What changed is that they
are no longer a singleton: `features/answer.js` is a factory, and a sheet has
one instance per question. Every piece of state that used to sit at module
level now belongs to one answer, because two answers on one sheet must not see
each other's decisions — a test drives two at once and pins that.

The one genuinely new control is **Read it to me**, and it is the parent's
decision and the reason for it: *she cannot proofread by reading, so hearing it
is how she checks it.* It speaks the **corrected** text — the same string Copy
puts on the clipboard, from the same function, pinned by a test. Reading her
the raw transcript would have her check the wrong thing.

### More than one question

**Add another question** appends a block. **Copy answer** copies that answer
alone. **Copy whole sheet** copies every question with its answer beneath it,
in order, blank line separated — and it uses the *live* corrected text for any
answer that is on screen, because only the page knows which corrections are
currently showing. The sheet's own name is deliberately not in that copy: what
she pastes into Seesaw is the work, not the label she gave it.

A sheet always has at least one question, so Remove is hidden when there is
only one, and asks first when the question it would take has anything in it.

### Saving

**Parent's decision: the five most recent, and no long history to manage.**
Older sheets drop off on their own. They are a synced field, `sheets`, on the
family document — the same way the rest of her data syncs — so a sheet started
on the iPad is on the parent's device too. The whole list is written on every
change, which is what bounds the field: five sheets is the cap, not a
suggestion. It is purely additive; the differential test pins that the fields
that were there before are untouched.

**Only her own words are stored, never Claude's.** A stored answer is the
transcript as the recogniser heard it. Freezing Claude's changes into storage
would make a guess indistinguishable from a transcript the next time the sheet
was opened, and §10's rule that this step "only ever changes what is on screen"
would stop being true. **What that costs, plainly:** a reopened answer shows
her confirmed corrections applied the blind way — the same treatment typed text
has always had — until she records into it again. Copy still gives what is on
screen, so nothing is wrong; it is just not as good as it was before the sheet
was closed. Storing the corrected text instead would be a one-line change, and
it is the wrong trade.

An empty sheet is never stored: opening the tab makes one, and a blank sheet
pushing real work off the end of a five-long list would be a bad bargain.
Starting a new sheet asks nothing, because nothing is lost — the sheet on
screen is saved on the way out and is the first row of the list underneath.

### Wording

Every label on this page was written for a parent testing corrections, and
this is a page a nine-year-old uses on her own. They are now short and plain:
*Say your answer*, *Your answer*, *Copy answer*, *Read it to me*, *Start
again*, *Paste the question here*. The notes changed too — *Checking your
words…*, *I changed 2 words. Tap a word to change it back.*, *Copied! Now paste
it into Seesaw.*

**One thing the rewrite was not allowed to drop.** §10 requires the fallback
note to name the error code, because that code is the only diagnostic there is
when something goes wrong on a device nobody is holding. The plain sentence is
hers; the code follows it in small grey text rather than disappearing. A test
pins that it is still there.

### What this does not settle

Whether the page reads clearly to *her* is not knowable from here. The specific
things to watch on the iPad: whether she finds the paste box without being
shown, whether the speaker button is where her hand goes when a word stops her,
and whether several question cards on one sheet scroll comfortably or turn into
a wall. The wording is a guess at nine-year-old plain, made by someone who is
not nine.

## 15. Four things the first worksheet build got wrong (parent's decisions)

All four came back from the iPad, which is the only place any of them was
findable.

### The question box was white all along

**The decision: remove the gold wash; white, like every other input.** The box
had three things saying "paste here" — a thick gold dashed rule, a second rule
on focus, and a filled background. The first two do the job. The wash made the
box read as *already filled in*, which is the opposite of an invitation, and it
was the one signal that did not survive being looked at on a real screen.

### "Read it to me" did not work on her answer

**What was actually wrong, and it was not the wiring.** The question spoke and
the answer did not, and the handler, the button and the text were all correct —
proved by driving the real page in a browser, where both reached
`speechSynthesis.speak()`. The difference is length: **Safari on iPad silently
fails to speak a long utterance.** A question is a sentence; her answer is a
paragraph.

**The fix is one utterance per word,** which is the documented way around that
limit — and it is the same mechanism §15's next item needs, so the two are one
change rather than two.

### Each word lights up as it is spoken

**Parent's decision, and the reason:** *this is a standard reading support for
dyslexia — seeing the word light up as she hears it links the sound to the
written word.* It applies to the question and to her answer.

**Why one utterance per word rather than `onboundary`.** The obvious
implementation is to speak the whole text and highlight from the API's word
boundary events. WebKit has never fired those reliably, so on the one device
that matters it would highlight nothing. Speaking word by word makes the
highlight *exact* rather than estimated: the word lit is the word being spoken,
because they are the same utterance. It also fixes the item above. The cost is
prosody — a paragraph read word by word is more deliberate than natural speech,
and whether that reads as "helping her follow" or "stilted" is the thing to
listen to on the iPad.

Two details that are load-bearing:

- **The words come from the same parts the panel is drawn from**, not from
  splitting the finished string. A confirmed correction can be two words for
  one token — "yo yo" for "yoyo" — and splitting would put the highlight one
  word out from there to the end. A test pins that case.
- **A question is a textarea, and a textarea cannot light up one word inside
  it.** So the question is repeated underneath as word spans, on screen only
  while it is being read.

Tapping the speaker again stops the reading rather than starting a second one
on top of it.

### The wait after she stops talking

**Parent's decision: show a rough live preview while she speaks.** The
browser's own recogniser runs alongside the recording, and its guesses appear
as she talks — greyed and italic in a box of their own, with a leading
ellipsis — then the accurate transcript replaces them. It was worst on a
paragraph built sentence by sentence, where the same wait is paid on every
recording.

**The preview is a preview and nothing else.** It is never saved, never
copied, never read aloud and never sent to be checked in context. That is not
a promise made by being careful: it holds because the preview never touches the
box everything else reads from. Saving, Copy, Read it to me and the context
step all read `rawText()`, and the preview writes only to its own element. A
mutation that puts the preview into that box fails four tests.

**It stays up through the wait, not just while she talks.** The recogniser
stops the moment recording ends, but the rough words stay on screen until the
real transcript arrives to replace them — the wait they exist to cover starts
exactly when she stops speaking. Clearing them at that point would leave the
gap the whole thing was for.

**Every way it can fail is silent.** No second recogniser, a recogniser that
refuses, an error part way through: the preview simply never appears and the
app behaves as it did before, with §13's working indicator doing the talking.
It is on its own recogniser instance rather than the shared one, because the
shared one is the fallback that stands in when the transcription service cannot
be reached, and reassigning its handlers from here would break that.

**One risk worth naming.** Two things now want the microphone at once — the
recorder and the browser recogniser. That combination is not something the
tests can settle, and iOS is the likeliest place for it to misbehave. If the
recording itself degrades on the iPad, the preview is the first thing to
suspect and it is one handler to remove.

### What this does not settle

Whether word-by-word reading sounds right to her, and whether two microphone
consumers coexist on iPadOS. Both are listen-and-see, on the device.

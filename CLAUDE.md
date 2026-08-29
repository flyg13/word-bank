# Harlie's Word Bank — Architecture & Build Plan (v2)

**Purpose of this document:** a spec to hand to Claude Code to properly rebuild what's currently a single 1,100-line HTML file into a real, maintainable project — while adding phonetic matching, staleness re-testing, and (later) on-device voice lock. Written by Claude (chat) as the architecture partner; built by Claude Code as the implementation partner.

**Current state:** a working static HTML app (`index.html`) hosted on GitHub Pages, synced via Firebase Firestore using a shared "family code." It has five tabs — Practice, Sentences, Reading Passage, Free Write, Word Bank — and a correction system that requires a mishearing to be confirmed twice before it auto-applies. It works, and Harlie is using it daily. This plan builds *on top of* that, not instead of it.

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
asked her for", which keeps the collision surface to a single entry. The
consequence is that Free Write gets no phonetic behaviour, since it has no
expected word to scope against.

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

## 7. Suggested build order

1. ~~**Scaffold the Vite project structure**~~ — **done.** Ported module-by-module, including the sentence-alignment fix. Schema parity with the original is pinned by a differential test.
2. ~~**Phonetic matching** (§3)~~ — **built, pending review.** Two deviations from the spec below, both deliberate.
3. **Staleness reminders** (§4) — small, valuable, low risk. Next.
4. **Voice Lock via sherpa-onnx** (§5) — biggest lift, do once the foundation is solid.
5. **Illustrated reading passages / story library** (§6) — additive, do once the content corpus from §2 exists to fill it.

## 8. How to use this document

Point Claude Code at the current GitHub repo, hand it this file, and start with step 1. When Claude Code finishes a milestone, bring the result back here — I'll review the approach, sanity-check the phonetic-matching logic and data model, and help think through anything that doesn't feel right before you build further on it. That loop — Claude Code builds and tests, you bring it back for review — is where this partnership actually works best.

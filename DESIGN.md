# Word Bank — Design translation from the Flying Giraffe brand

**Sources:** `docs/brand-style-sheet.pdf` (tokens, type, principles) and `docs/ui-mockups.pdf` (the worksheet generator's six screens). This document is the bridge: the mockups show a linear teacher tool; Word Bank is a tabbed practice tool with a child as the primary user of half its screens. Where the brand had to be *applied* rather than copied, the decision and its reasoning are here.

This is a restyle plus a tab restructure. **No logic changes. Every existing test must keep passing.** Data model untouched.

---

## 1. The big shift: dark → light

Current app: deep green backgrounds, cream text, amber accents. All of it goes.

Replace with the brand's three surfaces:
- **Shell** `#FBF8F4` — page background
- **White** `#FFFFFF` — cards, 1px `rgba(36,31,27,.10)` border, 12px radius, shadow `0 2px 10px rgba(36,31,27,.07)`
- **Paper** `#EFEAE3` — only if a canvas-behind-a-sheet surface is ever needed; likely unused here

Text is **Ink** `#241F1B`. Secondary copy **Muted** `#6B6259`. Labels/meta **Quiet** `#9A9188`. Never white text on a coloured ground except inside an ink button.

**Gold** `#C9A659` is border and fill only, never text. Gold text is `#8A6A1F`. Selected/notice backgrounds use **Gold wash** `#F4EFE2`.

**Holographic wash** (the four-stop gradient at 135°) appears on exactly one Word Bank surface: the family-code entry screen. Nowhere else.

---

## 2. Type — the one decision the brand sheet makes for us

The brand draws a line: **Atkinson Hyperlegible** for what the teacher sees, **Andika** for what the child reads. Word Bank has both users on different tabs, so:

| Surface | Face | Why |
|---|---|---|
| The target word in Practice | **Andika**, large (44–56px, weight 700) | She is reading it. Single-storey *a*, drawn for literacy learners. |
| Sentences and Reading Passage text | **Andika**, 22–28px, 1.55 line height | Same — this is her reading surface. |
| The heard-back text ("yoyo") | **Andika** | It's shown to her as what she said. |
| Everything else — chrome, tabs, labels, Corrections, Word Bank, buttons | **Atkinson Hyperlegible** | Parent-facing interface. |

Two weights only: 400 and 700. Nothing below 13px except the 12px uppercase eyebrow (`.16em` tracking). Self-host both fonts (both are free/open) so the app doesn't depend on a third-party CDN — a missing font on Harlie's reading surface is worse than a slow one.

---

## 3. Tabs — the pattern the mockups don't have

The worksheet generator is linear; it never needed tabs. The closest pattern in the mockups is the **year selector** on the configuration screen: a row of bordered boxes, the selected one filled ink with white text. Use that.

Restructure into the groups agreed with the parent:

```
[ Practice ] [ Sentences ] [ Reading ]   [ Speech-To-Text ]   [ Corrections ] [ Word Bank ]
 ─── build the bank ───                    use it              teach it        the brain
```

Grouping is carried by **spacing** (a wider gap between groups), optionally reinforced by a quiet 12px eyebrow above each group. Not by colour — the brand rule is "colour never carries meaning alone," and a colour-coded tab bar fails that on its own.

On narrow screens the bar scrolls horizontally; the selected tab is always brought into view.

**Corrections** is a new tab. It receives, from the current Word Bank tab: the "How she says her words" pronunciation section (with its new mic), and "Add a correction manually." Word Bank keeps: mastered count + fullness bar, the searchable list of all corrections (pending and active), the accent setting, recent sessions, export/import.

---

## 4. Component mapping

**Header.** Coin at 44px (never recoloured, never cropped, clear space = ¼ diameter) + "Harlie's Word Bank" in Atkinson 700. Sync status as a quiet meta line beneath, same as now but in Quiet grey with a small filled dot in Checked green / Gold / Ink for connected / connecting / error — plus the word, so it survives greyscale.

**The mic button.** This is "the thing you came to do," so it's the screen's one **ink button**: 84px circle, ink fill, white icon. Listening state = a **gold ring** that pulses gently (`cubic-bezier(.4,.05,.6,.95)`, ~1.2s), matching the brand's "happening now" progress-step vocabulary. When the mismatch action row is showing, the mic recedes to Quiet grey so the action row's primary button is the only ink on screen. Honours `prefers-reduced-motion`.

**Heard-back result.** Match: the heard word in Andika, then a Checked-green tick icon *and* the word "matched" — icon plus text, never colour alone. Mismatch: rendered inside a **gold notice box** (gold wash, gold border, 12px radius) — the brand's "the thing that will go wrong if ignored" container — with the heard word and the action row beneath.

**Action row after a mismatch.** One ink button ("That's her word — bank it"), one secondary ("Try again": white, 1px border), one text-link ("Skip"). Phonetic hit adds a fourth: gold-outline ("Yes, sounds like how she says it"), since gold-outline is reserved for the regenerate/confirm-again class of action.

**Repeat dots under a practice word.** Map directly to the brand's progress steps: done = Checked-green filled circle with tick, current = gold ring, not yet = quiet empty circle. Three of them, as now.

**Mastered progress.** This *is* the brand's fullness bar: gold gradient fill (the one gradient allowed in a control), always paired with "N / 355 words mastered" in words and numerals. Never the bar alone.

**Pending vs active corrections in the Word Bank list.** Pending rows get gold-wash background + gold left border + the text "needs confirming" + a "Confirm" text-link in gold text. Active rows are plain white. Again: background, border, *and* text together.

**Notices and empty states.** Plain notice (white card, quiet text) for "nothing recurring yet." Gold notice only for something the parent needs to act on — the collision warning is the canonical case.

**Selected states elsewhere** (accent picker, any future toggle): gold wash + gold border + 700 weight label. Three signals, as the brand specifies.

---

## 5. Screen by screen

**Entry / family code.** Replace the browser `prompt()` with a real screen modelled on the mockup's sign-in page: holographic wash background, centred white card, coin at 104px, "FLYING GIRAFFE" wordmark (12–15px, uppercase, `.26–.34em` tracking), then "Word Bank" as the product title, a single text input for the family code, one ink button "Continue." Meta line beneath: "Your code is the only key to her data. Keep it private." No giraffe mascot here — it's a waiting-state mascot and nothing is waiting.

**Practice.** Session bar as a quiet meta row. Target word large in Andika, speaker icon beside it. Repeat dots. Mic. Heard-back result per §4. Skip / reset as text links at the bottom, not buttons.

**Sentences / Reading.** Sentence in Andika, 22–28px, generous line height. Clean-read dots same as repeat dots. Per-word result: matched words plain ink; mismatched words ink with a dotted underline *and* a small ✗ before them (icon + treatment, not colour); dropped words shown struck through in Quiet; extra words in Quiet italics. Reading Passage's textarea: white card with 1px border, Andika, so what she'll read looks like what she'll read.

**Speech-To-Text.** Named for the term teachers and schools already use, so the
app is legible to them; the tab was "Free Write" during early parent-only use.
Unchanged behaviour. Output box white card; auto-applied corrections marked with a small ✓ before the word rather than coloured green.

**Corrections (new).** Two sections, each a white card with a section title: "How she says her words" (word + how-she-says-it inputs, mic button, Add; existing entries as chips — chip = white, 1px border, 999px radius; the collision warning as a gold notice box beneath the input, unmissable) and "Add a correction manually."

**Word Bank.** Fullness bar card first. Then the searchable corrections list. Then accent setting (selected state per §4). Then recent sessions as a quiet list. Export/import as two secondary buttons in a footer card.

---

## 6. Brand rules that fix current violations

- **No red/green as the only difference.** Match/mismatch, active/pending, connected/error all currently lean on colour. Every one now carries an icon or a word too. (§4.)
- **Minimum 44px hit height.** The current `.btn-sm` is under that. Raise it.
- **Minimum 13px text.** Current 12.5px buttons go to 13px.
- **Contrast.** Ink on shell, ink on white, gold-text on gold-wash all clear 4.5:1 per the brand sheet. Verify nothing else was introduced.
- **Copy.** Say "children with dyslexia," never "struggling learners." No outcome promises ("will fix," "will improve"). No countdowns or time promises. Australian English. The current tagline — "A personal speech-to-text trainer that learns her voice, one correction at a time." — passes.

---

## 7. What not to touch

- No changes to `src/lib/` logic, the data model, Firestore fields, or the matching/alignment code.
- All 110 unit tests and 50 browser checks keep passing. If a browser check asserts on a colour or class name that this restyle changes, update the assertion — don't weaken the check.
- The giraffe mascot is **not used**. The brand reserves it for a waiting state; Word Bank's only true wait (sync connecting) is a second long. Leave it out rather than misuse it.

---

## 7b. As built

Everything above is implemented except the entry screen, and two things came out
differently once measured.

**Deferred: the family-code entry screen (§5).** It is the one item in §5 that is
not a restyle — replacing `prompt()` means changing `getFamilyCode()` in
`src/lib/firestore.js` and the boot sequence, which §7 puts out of bounds and the
brief ruled out. The `prompt()` remains. Worth doing, as its own change.

**Corrected: gold text on gold wash does not clear 4.5:1.** §6 asserts it does;
measured, it is 4.39:1, and none of the sizes here qualify as large text. Gold on
a wash is now carried by the border and the icon, with the text itself ink
(14.21:1). `--gold-text` is still used on white, where it reaches 5.05:1.

**Corrected: Quiet is not a text colour.** `#9A9188` is 2.93:1 on shell and
3.10:1 on white — below AA at every size the app renders. Everything readable
that was specced as Quiet is Muted instead (5.6–6.0:1); Quiet survives only as a
non-text mark. `src/test/brand.test.js` pins both findings.

**Also:** the attempt log ("Recurring sounds not yet in her bank") went to
Corrections. §3 does not place it; it is a queue of sounds waiting to be taught,
which is what that tab is for.

The coin was re-exported at 192px (58 KB). The source is 2000px and 4.1 MB —
too heavy to ship for a 44px mark. Not recoloured, not cropped.

## 8. Open decisions (parent's call — defaults chosen if unanswered)

1. **In-app header name.** Default: "Harlie's Word Bank" (deliberate choice earlier; `noindex` is already set). Alternative: "Word Bank" as product name with the child's name shown only in the Word Bank tab. Default stands unless told otherwise.
2. **Tab group eyebrows.** Default: spacing only, no eyebrow labels — six tabs plus three labels is busy on an iPad. Can be added if the grouping doesn't read.
3. **Entry-screen headline.** Default: none — coin, wordmark, "Word Bank," input. The slogan "Small Change. Big Difference." belongs to the umbrella brand's landing page, not to each product's door.

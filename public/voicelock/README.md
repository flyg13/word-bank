# The Voice Lock model

`speaker.onnx` is a speaker-embedding model: it turns a few seconds of speech
into 192 numbers, and two recordings of the same person land close together.
It is the only thing Voice Lock needs, and it never leaves the device — the
recording is compared in the browser and the audio is never uploaded.

## What this file is

| | |
|---|---|
| Model | NVIDIA NeMo **TitaNet-small** |
| Bytes | 40,257,283 |
| SHA-256 | `ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e` |
| Downloaded from | [sherpa-onnx release `speaker-recongition-models`](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx) (their spelling) |
| Upstream | [NGC `nvidia/nemo/titanet_small`](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small) |
| Exported by | [k2-fsa/sherpa-onnx `scripts/nemo/speaker-verification`](https://github.com/k2-fsa/sherpa-onnx/tree/master/scripts/nemo/speaker-verification), Apache-2.0 |
| Licence | **Apache-2.0** — commercial use permitted with attribution. `LICENSE` + `NOTICE` beside this file |
| Changed here | **Nothing.** Redistributed byte for byte |

The export script is a plain
`EncDecSpeakerLabelModel.from_pretrained("titanet_small")` followed by an ONNX
export, so the chain from NVIDIA's published model to this file is short and
readable. The file's own embedded metadata agrees with it: `framework=nemo`,
`output_dim=192`, `sample_rate=16000`, `feat_dim=80`.

`npm run voice:verify` re-checks the size and hash against `model.json`.

## Licence — settled

**Apache License 2.0. Commercial use is permitted, with attribution.** The
parent read the licence first-hand and confirmed it; it had been flagged here
as unverified because NGC and Hugging Face are both unreachable from the
machine this was built on, and that flag is now withdrawn.

Both links in the chain are Apache-2.0: NVIDIA NeMo, which the weights come
from, and the sherpa-onnx export script that converted them to ONNX. The
licence is not a constraint on this project's own code — it applies to
`speaker.onnx` only, and nothing in `src/` is derived from it.

**What the licence asks for, and where this repo does it.** Apache-2.0 section
4 attaches four conditions to redistributing the file, and all four are met in
this directory:

| | Condition | Where |
|---|---|---|
| 4(a) | Keep the copyright, patent, trademark and attribution notices | `NOTICE` carries NVIDIA's copyright line verbatim |
| 4(b) | Say prominently if the files were changed | `NOTICE` — the ONNX conversion was Xiaomi's; **this project changed nothing**, and `npm run voice:verify` proves the file is byte-identical to the upstream release |
| 4(c) | Include a copy of the licence | `LICENSE`, the full text, as published by NVIDIA with NeMo |
| 4(d) | Reproduce the upstream `NOTICE` file, if there is one | NeMo ships no `NOTICE` file, so there is nothing to reproduce. This directory's own `NOTICE` is written to satisfy 4(a) and 4(b) |

`NOTICE` is the file to read if attribution ever needs to be reproduced
somewhere else — an about screen, a schools-procurement questionnaire, an app
listing. It is written to be copied as-is.

**Two things the licence does not cover, worth knowing anyway.** NVIDIA does
not endorse this project, and the NOTICE says so — Apache-2.0 grants no
trademark rights, so "NVIDIA", "NeMo" and "TitaNet" appear only to identify
where the model came from. And TitaNet's training mix includes VoxCeleb, which
is itself distributed for research use only, while NVIDIA licenses the
resulting weights under Apache-2.0 regardless. That is standard practice and
the basis on which these models are used commercially; it is a question about
the weights' lineage rather than about NVIDIA's grant, and it applies to
essentially every strong open speaker model. If Word Bank is sold to schools it
is worth a lawyer's glance — not because anything here is wrong, but because
"we checked" is a better answer than "it looked fine".

**Why this model and not the others.** The same release offers
`wespeaker_en_voxceleb_CAM++.onnx` (29 MB) and
`3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` (40 MB). Neither
carries a comparably clear commercial grant over the weights, so the licence
position is worse for the sake of ~11 MB. `nemo_en_titanet_large.onnx` is the
same family and the same licence at 101 MB — two and a half times the download
for accuracy this use does not need, given the gap TitaNet-small already leaves
between speakers (below).

## Does it work?

Measured on this exact file, in a real browser, through the bundled WASM, on
sherpa's own speaker-verification clips — seven recordings from three speakers:

| | n | lowest | highest | mean |
|---|---|---|---|---|
| Same speaker | 5 | **0.689** | 0.736 | 0.72 |
| Different speakers | 16 | 0.109 | **0.370** | 0.219 |

Nothing overlaps. The gap between the worst same-speaker pair and the best
different-speaker pair is 0.319, and its midpoint is 0.53 — which is where
`VOICE_THRESHOLD_DEFAULT` comes from. It is set slightly *under* the midpoint
on purpose: locking her out is worse than picking up a classmate.

Loading the runtime took 1.1s once; each comparison took 98–281ms.

**Those were adult voices reading Mandarin.** A nine-year-old Australian child
against her own classmates is a different problem, and children's voices are
genuinely harder to tell apart than adults'. Do not trust 0.5 — that is what
calibration mode is for, and it is why it was built before the gate.

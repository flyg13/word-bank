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

The export script is a plain
`EncDecSpeakerLabelModel.from_pretrained("titanet_small")` followed by an ONNX
export, so the chain from NVIDIA's published model to this file is short and
readable. The file's own embedded metadata agrees with it: `framework=nemo`,
`output_dim=192`, `sample_rate=16000`, `feat_dim=80`.

`npm run voice:verify` re-checks the size and hash against `model.json`.

## Licence — read this before shipping to a school

**The export script is Apache-2.0. The weights are NVIDIA's**, published on the
NGC page linked above, and NVIDIA's NeMo speaker models are normally released
**CC-BY-4.0, which permits commercial use with attribution.** That is the
expectation this choice was made on, and it is *not* verified here: NGC and
Hugging Face are both unreachable from the machine this was built on, so the
licence line on that page was never read first-hand. **Open the NGC link and
confirm it says CC-BY-4.0 before this goes anywhere commercial.**

One thing worth knowing even if it does. TitaNet was trained on a mix that
includes VoxCeleb, and VoxCeleb is distributed for research use only. NVIDIA
licenses the resulting weights under its own terms regardless, which is
standard practice and the basis on which these models are widely used
commercially — but it is a question about the weights' lineage rather than
about NVIDIA's grant, and it applies to essentially every strong open speaker
model, not just this one. If Word Bank becomes a product sold to schools, that
is a question for a lawyer, not for this README.

**Why this model and not the others.** The same release offers
`wespeaker_en_voxceleb_CAM++.onnx` (29 MB) and
`3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` (40 MB). Both are
trained on VoxCeleb and neither carries a clear commercial grant over the
weights, so the licence position is worse, not better, for the sake of ~11 MB.
`nemo_en_titanet_large.onnx` is the same family and licence at 101 MB, which is
two and a half times the download for accuracy this use does not need — the
gap TitaNet-small already leaves between speakers is wide (below).

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

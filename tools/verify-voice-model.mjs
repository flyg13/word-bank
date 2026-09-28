#!/usr/bin/env node
/**
 * Check that the Voice Lock model in the repo is the file it claims to be.
 *
 * The model is committed rather than fetched, so the build depends on npm and
 * nothing else and no audio or model request ever leaves the device. The cost
 * of that is a 40 MB binary in git that nobody can eyeball, so this says in
 * one command whether it is intact and whether it is the same file the
 * measurements in public/voicelock/README.md were taken on.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'public', 'voicelock');

const problems = [];
const say = (ok, line) => console.log((ok ? '  ok   ' : '  FAIL ') + line);

let manifest;
try {
  manifest = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'));
} catch (e) {
  console.error('No public/voicelock/model.json — nothing to check against.');
  process.exit(2);
}

const modelPath = join(dir, manifest.file);
let bytes;
try {
  bytes = await readFile(modelPath);
} catch (e) {
  console.error('Missing ' + manifest.file + '. See public/voicelock/README.md.');
  process.exit(2);
}

const size = (await stat(modelPath)).size;
const sizeOk = size === manifest.bytes;
say(sizeOk, 'size    ' + size.toLocaleString() + ' bytes'
  + (sizeOk ? '' : ' — expected ' + manifest.bytes.toLocaleString()));
if (!sizeOk) problems.push('size');

const sha = createHash('sha256').update(bytes).digest('hex');
const shaOk = sha === manifest.sha256;
say(shaOk, 'sha256  ' + sha + (shaOk ? '' : '\n         expected ' + manifest.sha256));
if (!shaOk) problems.push('sha256');

// The metadata sherpa actually reads, checked straight out of the file rather
// than taken from the manifest: a model with the wrong framework or dimension
// loads and then quietly scores nothing like it should. ONNX writes
// metadata_props after the graph, so this is the tail of the file.
const head = bytes.subarray(-8192).toString('latin1');
for (const [key, want] of [['framework', 'nemo'], ['output_dim', String(manifest.outputDim)],
                           ['sample_rate', String(manifest.sampleRate)]]) {
  const at = head.indexOf(key);
  const found = at >= 0 && head.slice(at, at + 64).includes(want);
  say(found, 'embedded ' + key + ' = ' + want);
  if (!found) problems.push(key);
}

if (problems.length) {
  console.log('\nThis is not the model the app was measured on (' + problems.join(', ')
    + '). Re-download it from the link in public/voicelock/README.md.');
  process.exit(1);
}
console.log('\nThe committed model is the one public/voicelock/README.md describes.');

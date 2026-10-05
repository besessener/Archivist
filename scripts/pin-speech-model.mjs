// Pins the Whisper model of the speech input: resolves the newest commit of the repository, downloads the files the
// app needs and writes their size and SHA-256 to packages/core/src/services/speech/model-pin.json.
// Needs network access to huggingface.co. Run it again to move to a newer commit, then commit the changed file.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'onnx-community/whisper-small';
// What transformers.js loads for `pipeline('automatic-speech-recognition', …, { dtype: 'q8' })`.
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/core/src/services/speech/model-pin.json');

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const { sha: revision } = await (await get(`https://huggingface.co/api/models/${REPOSITORY}`)).json();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Unexpected revision: ${revision}`);

const files = [];
for (const file of FILES) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of (await get(`https://huggingface.co/${REPOSITORY}/resolve/${revision}/${file}`)).body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  files.push({ path: file, bytes, sha256: hash.digest('hex') });
  console.log(`${file}: ${bytes} bytes`);
}
fs.writeFileSync(output, `${JSON.stringify({ revision, files }, null, 2)}\n`);
console.log(`Pinned ${REPOSITORY} at ${revision} (${files.reduce((sum, file) => sum + file.bytes, 0)} bytes) → ${path.relative(process.cwd(), output)}`);

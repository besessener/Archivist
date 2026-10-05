// Pins the Whisper model of the speech input: resolves the newest commit of its repository, downloads the files the
// app needs and writes model, commit, sizes and SHA-256 to packages/core/src/services/speech/model-pin.json.
// Usage: npm run speech:pin -- [--model small|medium|turbo]   (default: the model pinned now; only these names are accepted)
// Needs network access to huggingface.co. Run it again to move to a newer commit, then commit the changed file.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/core/src/services/speech');
const output = path.join(folder, 'model-pin.json');
const models = JSON.parse(fs.readFileSync(path.join(folder, 'models.json'), 'utf8'));

const { values } = parseArgs({ options: { model: { type: 'string' } } });
const model = values.model ?? JSON.parse(fs.readFileSync(output, 'utf8')).model;
if (!Object.hasOwn(models, model)) {
  console.error(`Unknown model "${model}". Choose one of: ${Object.keys(models).join(', ')}`);
  process.exit(1);
}
const REPOSITORY = models[model].repository;

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
fs.writeFileSync(output, `${JSON.stringify({ model, revision, files }, null, 2)}\n`);
console.log(`Pinned ${REPOSITORY} at ${revision} (${files.reduce((sum, file) => sum + file.bytes, 0)} bytes) → ${path.relative(process.cwd(), output)}`);

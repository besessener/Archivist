// Pins the Whisper models of the speech input: resolves the newest commit of each repository, downloads the files the
// app needs and writes commit, sizes and SHA-256 per model to packages/core/src/services/speech/model-pin.json.
// Usage: npm run speech:pin                    pins all models (small, medium, turbo; about 2 GB of download)
//        npm run speech:pin -- --model small   pins just that one and keeps the others (only these names are accepted)
// A model that fails (e.g. HTTP 404) keeps its old pin; the script then exits with an error after writing the rest.
// Needs network access to huggingface.co. Run it again to move to newer commits, then commit the changed file.
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
const names = values.model === undefined ? Object.keys(models) : [values.model];
const unknown = names.find((name) => !Object.hasOwn(models, name));
if (unknown !== undefined) {
  console.error(`Unknown model "${unknown}". Choose one of: ${Object.keys(models).join(', ')}`);
  process.exit(1);
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function pin(repository) {
  const { sha: revision } = await (await get(`https://huggingface.co/api/models/${repository}`)).json();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Unexpected revision: ${revision}`);
  const files = [];
  for (const file of FILES) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of (await get(`https://huggingface.co/${repository}/resolve/${revision}/${file}`)).body) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    files.push({ path: file, bytes, sha256: hash.digest('hex') });
    console.log(`${repository}/${file}: ${bytes} bytes`);
  }
  return { revision, files };
}

const pinned = JSON.parse(fs.readFileSync(output, 'utf8'));
const failed = [];
for (const name of names) {
  try {
    pinned[name] = await pin(models[name].repository);
    console.log(`Pinned ${name} at ${pinned[name].revision} (${pinned[name].files.reduce((sum, file) => sum + file.bytes, 0)} bytes)`);
  } catch (error) {
    failed.push(name);
    // Node's fetch reports every network problem as "fetch failed"; the reason (proxy, certificate, DNS) is in the cause.
    const cause = error.cause ? ` (${error.cause.code ?? error.cause.message})` : '';
    console.error(`Could not pin ${name}: ${error.message}${cause}`);
  }
}
fs.writeFileSync(output, `${JSON.stringify(pinned, null, 2)}\n`);
console.log(`Written ${path.relative(process.cwd(), output)}`);
if (failed.length > 0) process.exit(1);

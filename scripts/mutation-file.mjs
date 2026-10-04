// Quick local mutation run for one source file against the tests that import it (directly or through a source file that imports it).
// Faster than a full run, but static mutants only meet these tests: a low score here can still be caught by the full suite in CI.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('Usage: npm run mutation:file -- <path/to/source.ts>');
  process.exit(1);
}

const stem = (file) => path.basename(file, path.extname(file));
const importsFile = (text, file) => text.includes(`/${stem(file)}'`) || text.includes(`/${stem(file)}"`);
const readAll = (files) => new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
const importers = (file, texts) => [...texts.keys()].filter((other) => other !== file && importsFile(texts.get(other), file));

const tests = readAll(fs.globSync('tests/{unit,integration}/**/*.test.ts'));
const sources = readAll(fs.globSync('packages/*/src/**/*.ts'));
const reaching = [...new Set([target, ...importers(target, sources)].flatMap((file) => importers(file, tests)))];
if (reaching.length === 0) {
  console.error(`No test imports ${target}, directly or through another source file.`);
  process.exit(1);
}
console.log(`Running ${reaching.length} test file(s) against ${target}`);

fs.writeFileSync(
  'vitest.quick.config.mts',
  `import base from './vitest.mutation.config.mts';\nexport default { ...base, test: { ...base.test, include: ${JSON.stringify(reaching)} } };\n`,
);
fs.writeFileSync(
  'stryker.quick.config.mjs',
  `import base from './stryker.config.mjs';\nexport default { ...base, vitest: { configFile: 'vitest.quick.config.mts' }, mutate: [${JSON.stringify(target)}], reporters: ['clear-text'], tempDirName: '.stryker-tmp', thresholds: { high: 95, low: 95, break: null } };\n`,
);
const run = spawnSync('npx', ['stryker', 'run', 'stryker.quick.config.mjs'], { stdio: 'inherit', shell: process.platform === 'win32' });
fs.rmSync('vitest.quick.config.mts', { force: true });
fs.rmSync('stryker.quick.config.mjs', { force: true });
process.exit(run.status ?? 1);

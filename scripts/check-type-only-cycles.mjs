// `node scripts/check-type-only-cycles.mjs`: fails when a type-only import cycle among services is not in the baseline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(root, 'scripts/type-only-cycles.baseline.json');
const rule = 'no-type-only-service-cycles';

const run = (args) => {
  try {
    return execFileSync('npx', ['depcruise', '--config', '.dependency-cruiser.cjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.startsWith('{')) return error.stdout;
    throw error;
  }
};

const report = JSON.parse(run(['packages/core/src/services', '-T', 'json']));
const found = [...new Set(report.summary.violations.filter((v) => v.rule.name === rule).map((v) => `${v.from} -> ${v.to}`))].sort();
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));

const added = found.filter((edge) => !baseline.includes(edge));
const stale = baseline.filter((edge) => !found.includes(edge));
for (const edge of stale) console.warn(`Baseline entry no longer needed, please remove it: ${edge}`);
if (added.length > 0) {
  for (const edge of added) console.error(`::error::New type-only service cycle (${rule}): ${edge}`);
  console.error('Break the cycle (narrow interface) or, if wire() is really intended, add the edge to scripts/type-only-cycles.baseline.json.');
  process.exit(1);
}
console.log(`Type-only service cycles: ${found.length} known edge(s), no new ones.`);

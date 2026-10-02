// Checks whether the native modules (better-sqlite3, sharp) load in Node AND in the Electron runtime.
// better-sqlite3 (>= 13) and sharp use N-API prebuilds: the same binary runs in Node and Electron,
// no electron-rebuild is needed. This script makes that reproducibly verifiable.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const probe = `
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const fts = db.prepare("select count(*) c from pragma_compile_options where compile_options like '%FTS5%'").get().c;
const sharp = require('sharp');
console.log(JSON.stringify({ sqlite: db.prepare('select sqlite_version() v').get().v, fts5: fts > 0, sharp: sharp.versions.sharp, abi: process.versions.modules, electron: process.versions.electron ?? null }));
`;

function run(label, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`✗ ${label} failed:\n${r.stderr || r.stdout}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${label}: ${r.stdout.trim()}`);
}

run('Node', process.execPath, ['-e', probe]);
try {
  const electron = require('electron');
  run('Electron', electron, ['-e', probe], { ELECTRON_RUN_AS_NODE: '1' });
} catch {
  console.log('• Electron not installed – check skipped.');
}

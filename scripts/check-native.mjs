// Checks that better-sqlite3 and sharp load in Node AND in Electron: their N-API prebuilds need no electron-rebuild.
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

function run(label, runtime) {
  const result = spawnSync(runtime.executable, ['-e', probe], { encoding: 'utf8', env: { ...process.env, ...runtime.env } });
  if (result.status !== 0) {
    console.error(`✗ ${label} failed:\n${result.stderr || result.stdout}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${label}: ${result.stdout.trim()}`);
}

run('Node', { executable: process.execPath });
try {
  const electron = require('electron');
  run('Electron', { executable: electron, env: { ELECTRON_RUN_AS_NODE: '1' } });
} catch {
  console.log('• Electron not installed – check skipped.');
}

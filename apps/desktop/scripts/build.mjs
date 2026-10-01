// Bündelt Main-Prozess, Preload und Worker mit esbuild und kopiert Migrationen + statisches Frontend nach dist/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '../..');
const dist = path.join(desktop, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// Native bzw. nicht bündelbare Module bleiben extern und werden von electron-builder mitgeliefert (siehe package.json dependencies).
const external = ['electron', 'better-sqlite3', 'sharp', 'pdfjs-dist', 'pdfjs-dist/*', 'tesseract.js', '@napi-rs/canvas'];
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external, logLevel: 'warning', legalComments: 'none' };

await build({ ...common, entryPoints: [path.join(desktop, 'src/main.ts')], outfile: path.join(dist, 'main.cjs') });
await build({ ...common, entryPoints: [path.join(desktop, 'src/preload.ts')], outfile: path.join(dist, 'preload.cjs') });
await build({ ...common, entryPoints: [path.join(repo, 'packages/core/src/workers/worker-entry.ts')], outfile: path.join(dist, 'worker.cjs') });

fs.cpSync(path.join(repo, 'packages/core/migrations'), path.join(dist, 'migrations'), { recursive: true });

const rendererOut = path.join(repo, 'apps/renderer/out');
if (!fs.existsSync(path.join(rendererOut, 'index.html'))) {
  console.error('Fehler: apps/renderer/out fehlt – bitte zuerst `npm run build -w @archivist/renderer` ausführen.');
  process.exit(1);
}
fs.cpSync(rendererOut, path.join(dist, 'renderer'), { recursive: true });
console.log('Desktop-Build fertig:', dist);

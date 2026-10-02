// Development mode: starts the Next.js dev server and Electron (hot reload for the frontend).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '../..');
const require = createRequire(import.meta.url);

const run = (cmd, args, opts = {}) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

// The frontend build is not needed in dev mode, but dist/ (main, preload, worker, migrations) is.
const buildDist = run(process.execPath, [path.join(here, 'build.mjs')], { cwd: desktop, env: { ...process.env } });
buildDist.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const next = run('npx', ['next', 'dev', '-p', '3210'], { cwd: path.join(repo, 'apps/renderer') });
  setTimeout(() => {
    const electron = run(require('electron'), ['.'], { cwd: desktop, env: { ...process.env, ARCHIVIST_DEV_URL: 'http://localhost:3210/chat/' } });
    electron.on('exit', () => {
      next.kill();
      process.exit(0);
    });
  }, 6000);
});

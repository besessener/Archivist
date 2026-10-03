// Runs drizzle-kit next to exactly the project's drizzle-orm: drizzle-kit loads drizzle-orm from its own folder, and its deprecated dependencies stay out of the lockfile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIZZLE_KIT_VERSION = '0.31.11';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { npmVersion: ormVersion } = await import('drizzle-orm/version');
const toolDir = path.join(root, 'node_modules', '.cache', `drizzle-kit-${DRIZZLE_KIT_VERSION}-orm-${ormVersion}`);
const bin = path.join(toolDir, 'node_modules', 'drizzle-kit', 'bin.cjs');

if (!fs.existsSync(bin)) {
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, 'package.json'), '{ "private": true }\n');
  execFileSync(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', `drizzle-kit@${DRIZZLE_KIT_VERSION}`, `drizzle-orm@${ormVersion}`],
    { cwd: toolDir, stdio: 'inherit', shell: process.platform === 'win32' },
  );
}

execFileSync(process.execPath, [bin, 'generate', ...process.argv.slice(2)], { cwd: path.join(root, 'packages', 'core'), stdio: 'inherit' });

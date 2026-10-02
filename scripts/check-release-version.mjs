// Prüft vor dem Veröffentlichen, dass der Versions-Tag (z. B. v1.2.3) zur Version in apps/desktop/package.json passt.
// Aufruf: node scripts/check-release-version.mjs v1.2.3
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readVersion = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version;

const tag = process.argv[2] ?? '';
const desktop = readVersion('apps/desktop/package.json');
const monorepo = readVersion('package.json');
const errors = [];
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) errors.push(`„${tag}“ ist kein Versions-Tag der Form v1.2.3 (optional v1.2.3-beta.1).`);
else if (tag.slice(1) !== desktop) errors.push(`Tag ${tag} passt nicht zur Version ${desktop} in apps/desktop/package.json.`);
if (monorepo !== desktop) errors.push(`Die Versionen in package.json (${monorepo}) und apps/desktop/package.json (${desktop}) weichen voneinander ab.`);

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`Version ${desktop} passt zu ${tag}.`);

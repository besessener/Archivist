import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCsp, inlineScriptHashes, serveRenderer } from '../../apps/desktop/src/renderer-server';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-render-'));
  fs.mkdirSync(path.join(root, 'chat'));
  fs.mkdirSync(path.join(root, '_next'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>root</body></html>');
  fs.writeFileSync(
    path.join(root, 'chat', 'index.html'),
    '<html><head><script src="/_next/a.js"></script></head><body><script>self.__next_f.push([1,"x"])</script></body></html>',
  );
  fs.writeFileSync(path.join(root, 'chat', 'index.txt'), 'rsc');
  fs.writeFileSync(path.join(root, '_next', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'geheim');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('serving the frontend (app://)', () => {
  it('resolves routes and sets a restrictive CSP with script hashes', async () => {
    const res = await serveRenderer(root, 'app://archivist/chat/');
    expect(res.status).toBe(200);
    const csp = res.headers['Content-Security-Policy']!;
    const hash = createHash('sha256').update('self.__next_f.push([1,"x"])').digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("object-src 'none'");
    expect((await serveRenderer(root, 'app://archivist/')).status).toBe(200);
    expect((await serveRenderer(root, 'app://archivist/chat')).status).toBe(200);
  });

  it('serves Next payload data as text/plain and scripts with the correct type', async () => {
    expect((await serveRenderer(root, 'app://archivist/chat/index.txt')).headers['Content-Type']).toContain('text/plain');
    expect((await serveRenderer(root, 'app://archivist/_next/a.js')).headers['Content-Type']).toContain('javascript');
  });

  it('blocks path traversal, foreign origins and symlink escapes', async () => {
    for (const u of [
      'app://archivist/../secret.txt',
      'app://archivist/%2e%2e/secret.txt',
      'app://archivist/chat/..%2f..%2fsecret.txt',
      'app://archivist/%00',
      'https://evil.example/chat/',
      'file:///etc/passwd',
    ]) {
      const r = await serveRenderer(root, u);
      expect([400, 403, 404], u).toContain(r.status);
      expect(String(r.body)).not.toContain('geheim');
    }
    fs.symlinkSync(path.join(path.dirname(root), 'secret.txt'), path.join(root, 'link.txt'));
    expect((await serveRenderer(root, 'app://archivist/link.txt')).status).toBe(403);
    expect((await serveRenderer(root, 'app://archivist/gibt-es-nicht.js')).status).toBe(404);
  });

  it('hashes inline scripts only', () => {
    expect(inlineScriptHashes('<script src="a.js"></script><script>1+1</script><script> </script>')).toHaveLength(1);
    expect(buildCsp([], true)).toContain("'unsafe-eval'");
  });
});

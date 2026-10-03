import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const APP_ORIGIN = 'app://archivist';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Next.js loads RSC payloads as .txt – it is important that they arrive as text/plain
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

/** Restrictive Content Security Policy; inline scripts from Next.js are allowed by hash (no 'unsafe-inline' for scripts, no eval). */
export function buildCsp(scriptHashes: string[], { dev = false }: { dev?: boolean } = {}): string {
  const script = ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`), ...(dev ? ["'unsafe-eval'", "'unsafe-inline'"] : [])];
  return [
    "default-src 'none'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const body = m[2] ?? '';
    if (body.trim()) hashes.push(createHash('sha256').update(body).digest('base64'));
  }
  return hashes;
}

export interface ServedFile {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

/** Serves the exported Next.js frontend, only files below `root` (no path traversal, no symlink escapes). */
export async function serveRenderer(root: string, requestUrl: string): Promise<ServedFile> {
  const notFound = (status = 404): ServedFile => ({
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
    body: status === 404 ? 'Nicht gefunden' : 'Nicht erlaubt',
  });
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return notFound(400);
  }
  if (url.origin !== APP_ORIGIN && !(url.protocol === 'app:' && url.hostname === 'archivist')) return notFound(403);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(400);
  }
  if (pathname.includes('\0') || pathname.split('/').some((s) => s === '..')) return notFound(403);
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const realRoot = await fsp.realpath(root);
  let target = path.resolve(realRoot, rel);
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) target = path.join(target, 'index.html');
  } catch {
    if (!path.extname(target)) target = `${target}.html`;
  }
  let real: string;
  try {
    real = await fsp.realpath(target);
  } catch {
    return notFound();
  }
  const relToRoot = path.relative(realRoot, real);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return notFound(403);
  const ext = path.extname(real).toLowerCase();
  const body = await fsp.readFile(real);
  const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...SECURITY_HEADERS };
  if (ext === '.html') headers['Content-Security-Policy'] = buildCsp(inlineScriptHashes(body.toString('utf8')));
  return { status: 200, headers, body };
}

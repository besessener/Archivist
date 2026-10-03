import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface RealTesseract {
  createWorker: (...args: unknown[]) => Promise<{ terminate: () => Promise<unknown> }>;
}

const created = vi.hoisted(() => ({ count: 0, terminated: 0 }));

vi.mock('tesseract.js', async (importOriginal) => {
  const real = await importOriginal<RealTesseract>();
  return {
    ...real,
    createWorker: async (...args: Parameters<RealTesseract['createWorker']>) => {
      created.count += 1;
      const worker = await real.createWorker(...args);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = async () => {
        created.terminated += 1;
        return terminate();
      };
      return worker;
    },
  };
});

const { recognizeImage, releaseOcrWorker } = await import('../../packages/core/src/parsers/ocr');

let dir: string;
let image: string;
const options = (languages: string) => ({ tessdataDir: path.join(dir, 'tessdata'), languages });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-ocr-reuse-'));
  image = path.join(dir, 'page.png');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="100%" height="100%" fill="white"/><text x="30" y="120" font-size="64" fill="black">Rechnung 4711</text></svg>';
  await sharp(Buffer.from(svg)).png().toFile(image);
});

afterAll(async () => {
  await releaseOcrWorker();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shared tesseract worker (#226)', () => {
  it('creates one worker for any number of pages and documents', async () => {
    await Promise.all([recognizeImage(image, options('deu+eng')), recognizeImage(image, options('deu+eng'))]);
    expect((await recognizeImage(image, options('deu+eng'))).text).toContain('4711');
    expect(created.count).toBe(1);
  }, 120_000);

  it('replaces the worker when the languages change and terminates the old one', async () => {
    await recognizeImage(image, options('eng'));
    expect(created.count).toBe(2);
    expect(created.terminated).toBe(1);
  }, 120_000);

  it('stops the worker on release and creates a fresh one afterwards', async () => {
    await releaseOcrWorker();
    expect(created.terminated).toBe(2);
    await recognizeImage(image, options('eng'));
    expect(created.count).toBe(3);
  }, 120_000);

  it('discards the worker after a failed recognition', async () => {
    const before = created.terminated;
    await expect(recognizeImage(path.join(dir, 'missing.png'), options('eng'))).rejects.toThrow();
    expect(created.terminated).toBe(before + 1);
    await recognizeImage(image, options('eng'));
    expect(created.count).toBe(4);
  }, 120_000);

  it('does not cache a worker whose creation failed', async () => {
    await releaseOcrWorker();
    await expect(recognizeImage(image, options('xyz'))).rejects.toThrow(/nicht installiert/);
    expect((await recognizeImage(image, options('eng'))).text).toContain('4711');
  }, 120_000);
});

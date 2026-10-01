import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTessdata } from '../../packages/core/src/parsers/ocr';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-tessdata-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureTessdata', () => {
  it('installs language data safely when many OCR jobs start at the same time', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureTessdata(dir, 'deu+eng')));
    for (const r of results) expect(r).toEqual(['deu', 'eng']);
    expect(fs.readdirSync(dir).sort()).toEqual(['deu.traineddata.gz', 'eng.traineddata.gz']);
    expect(fs.statSync(path.join(dir, 'deu.traineddata.gz')).size).toBeGreaterThan(0);
  });

  it('uses unique temporary names (PID and random part)', async () => {
    const tmpNames: string[] = [];
    const realCopy = fsp.copyFile.bind(fsp);
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dest, mode) => {
      tmpNames.push(String(dest));
      return realCopy(src, dest, mode);
    });
    await Promise.all([ensureTessdata(dir, 'deu'), ensureTessdata(dir, 'deu')]);
    expect(tmpNames).toHaveLength(2);
    expect(new Set(tmpNames).size).toBe(2);
    for (const n of tmpNames) expect(path.basename(n)).toMatch(new RegExp(`^deu\\.traineddata\\.gz\\.${process.pid}-[0-9a-f]+\\.tmp$`));
  });

  it('keeps the existing file when another job installed it first and the rename fails', async () => {
    const target = path.join(dir, 'deu.traineddata.gz');
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      // simulates Windows: a parallel job created the target, renaming onto it is refused
      fs.writeFileSync(target, 'already there');
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    });
    await expect(ensureTessdata(dir, 'deu')).resolves.toEqual(['deu']);
    expect(fs.readFileSync(target, 'utf8')).toBe('already there');
    expect(fs.readdirSync(dir)).toEqual(['deu.traineddata.gz']);
  });

  it('reports a genuine rename failure and leaves no temporary file behind', async () => {
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' }));
    await expect(ensureTessdata(dir, 'deu')).rejects.toThrow(/EACCES/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

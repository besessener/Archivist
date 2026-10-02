import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OCR_LANGUAGE_CODE } from '@archivist/shared';

/**
 * Local text recognition (OCR) with tesseract.js. Everything runs offline:
 * the worker and the WASM core ship in the npm packages, the language data (@tesseract.js-data/*) is copied into the
 * index directory on first use. Nothing is downloaded from the network.
 */
export interface OcrOptions {
  /** Target folder for the language data (e.g. <data directory>/index/tessdata) */
  tessdataDir: string;
  /** Tesseract language codes, e.g. "deu+eng" */
  languages: string;
}

const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'noop.js'));

/**
 * Copies `source` to `target` via a temporary file with a unique name (PID + random part), so that parallel OCR jobs
 * (several worker threads share one PID) never touch each other's temporary file. If another job installed the
 * target in the meantime, that copy is kept and ours is discarded.
 */
async function installAtomically(source: string, target: string): Promise<void> {
  const tmp = `${target}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.copyFile(source, tmp, fs.constants.COPYFILE_EXCL);
    try {
      await fsp.rename(tmp, target);
    } catch (err) {
      // Renaming onto an existing target can fail (e.g. EPERM on Windows while another job reads it) – that job was faster, fine.
      if (!fs.existsSync(target)) throw err;
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Copies the packaged language data (4.0.0_best_int) into the local folder – only if it is missing. */
export async function ensureTessdata(dir: string, languages: string): Promise<string[]> {
  await fsp.mkdir(dir, { recursive: true });
  const langs = languages
    .split('+')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const lang of langs) {
    if (!OCR_LANGUAGE_CODE.test(lang)) throw new Error(`Ungültiger Sprachcode: ${lang}`);
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    let pkgDir: string;
    try {
      pkgDir = path.dirname(nodeRequire.resolve(`@tesseract.js-data/${lang}/package.json`));
    } catch {
      throw new Error(`Sprachdaten für „${lang}“ sind nicht installiert (Paket @tesseract.js-data/${lang}).`);
    }
    const source = [path.join(pkgDir, '4.0.0_best_int', `${lang}.traineddata.gz`), path.join(pkgDir, '4.0.0', `${lang}.traineddata.gz`)].find((p) =>
      fs.existsSync(p),
    );
    if (!source) throw new Error(`Sprachdatei für „${lang}“ nicht gefunden.`);
    await installAtomically(source, target);
  }
  return langs;
}

/** Prepares an image for recognition: rotate per EXIF, grayscale, contrast, sensible size. */
export async function prepareForOcr(input: string | Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const base = sharp(input, { failOn: 'none', limitInputPixels: 268_000_000 }).rotate();
  const meta = await base.metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  let pipeline = base.grayscale().normalize();
  if (longest > 0 && longest < 1500) pipeline = pipeline.resize({ width: Math.round((meta.width ?? 1) * 2), kernel: 'lanczos3' });
  else if (longest > 4500)
    pipeline = pipeline.resize({
      width: meta.width && meta.width >= (meta.height ?? 0) ? 4500 : undefined,
      height: meta.height && meta.height > (meta.width ?? 0) ? 4500 : undefined,
      fit: 'inside',
    });
  return pipeline.sharpen().png().toBuffer();
}

export interface OcrResult {
  text: string;
  /** mean recognition confidence 0..100 */
  confidence: number;
}

/** Recognizes text in several images with one shared worker. */
export async function recognizeImages(
  images: Array<string | Buffer>,
  opts: OcrOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<OcrResult[]> {
  const langs = await ensureTessdata(opts.tessdataDir, opts.languages);
  const tess = await import('tesseract.js');
  const createWorker = tess.createWorker ?? (tess as unknown as { default: typeof tess }).default.createWorker;
  const worker = await createWorker(langs, 1, { langPath: opts.tessdataDir, gzip: true, cacheMethod: 'none' });
  try {
    const out: OcrResult[] = [];
    for (let i = 0; i < images.length; i += 1) {
      const png = await prepareForOcr(images[i]!);
      const res = await worker.recognize(png);
      out.push({ text: res.data.text ?? '', confidence: res.data.confidence ?? 0 });
      onProgress?.(i + 1, images.length);
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

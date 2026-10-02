import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OCR_LANGUAGE_CODE } from '@archivist/shared';

// Offline OCR with tesseract.js: worker and WASM ship in npm packages, language data is copied from @tesseract.js-data/*.

interface OcrOptions {
  /** Target folder for the language data (e.g. <data directory>/index/tessdata) */
  tessdataDir: string;
  /** Tesseract language codes, e.g. "deu+eng" */
  languages: string;
}

/** OCR settings from the parse options (default: ./tessdata, German and English). */
export const ocrOptionsFor = (options: { tessdataDir?: string; ocrLanguages?: string }): OcrOptions => ({
  tessdataDir: options.tessdataDir ?? path.join(process.cwd(), 'tessdata'),
  languages: options.ocrLanguages ?? 'deu+eng',
});

const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'noop.js'));

/** Copies via a uniquely named temporary file, since parallel OCR jobs share one PID; a copy installed first wins. */
async function installAtomically(source: string, target: string): Promise<void> {
  const temporaryFile = `${target}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.copyFile(source, temporaryFile, fs.constants.COPYFILE_EXCL);
    try {
      await fsp.rename(temporaryFile, target);
    } catch (err) {
      // Renaming onto an existing target can fail (e.g. EPERM on Windows while another job reads it) – that job was faster, fine.
      if (!fs.existsSync(target)) throw err;
    }
  } finally {
    await fsp.rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

/** Copies the packaged language data (4.0.0_best_int) into the local folder – only if it is missing. */
export async function ensureTessdata(dir: string, languages: string): Promise<string[]> {
  await fsp.mkdir(dir, { recursive: true });
  const codes = languages
    .split('+')
    .map((code) => code.trim())
    .filter(Boolean);
  for (const code of codes) {
    if (!OCR_LANGUAGE_CODE.test(code)) throw new Error(`Ungültiger Sprachcode: ${code}`);
    const target = path.join(dir, `${code}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    await installAtomically(packagedLanguageFile(code), target);
  }
  return codes;
}

function packagedLanguageFile(code: string): string {
  let packageDir: string;
  try {
    packageDir = path.dirname(nodeRequire.resolve(`@tesseract.js-data/${code}/package.json`));
  } catch {
    throw new Error(`Sprachdaten für „${code}“ sind nicht installiert (Paket @tesseract.js-data/${code}).`);
  }
  const candidates = [path.join(packageDir, '4.0.0_best_int', `${code}.traineddata.gz`), path.join(packageDir, '4.0.0', `${code}.traineddata.gz`)];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error(`Sprachdatei für „${code}“ nicht gefunden.`);
  return source;
}

/** Prepares an image for recognition: rotate per EXIF, grayscale, contrast, sensible size. */
async function prepareForOcr(input: string | Buffer): Promise<Buffer> {
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

interface OcrResult {
  text: string;
  /** mean recognition confidence 0..100 */
  confidence: number;
}

/** Recognizes text in several images with one shared worker. */
export async function recognizeImages(images: Array<string | Buffer>, options: OcrOptions): Promise<OcrResult[]> {
  const codes = await ensureTessdata(options.tessdataDir, options.languages);
  const tesseract = await import('tesseract.js');
  const createWorker = tesseract.createWorker ?? (tesseract as unknown as { default: typeof tesseract }).default.createWorker;
  const worker = await createWorker(codes, 1, { langPath: options.tessdataDir, gzip: true, cacheMethod: 'none' });
  try {
    const results: OcrResult[] = [];
    for (const image of images) {
      const png = await prepareForOcr(image);
      const recognized = await worker.recognize(png);
      results.push({ text: recognized.data.text ?? '', confidence: recognized.data.confidence ?? 0 });
    }
    return results;
  } finally {
    await worker.terminate();
  }
}

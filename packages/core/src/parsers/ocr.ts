import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Lokale Texterkennung (OCR) mit tesseract.js. Alles läuft offline:
 * Worker und WASM-Kern liegen in den npm-Paketen, die Sprachdaten (@tesseract.js-data/*) werden beim ersten Einsatz
 * in das Index-Verzeichnis kopiert. Es wird nichts aus dem Netz nachgeladen.
 */
export interface OcrOptions {
  /** Zielordner für die Sprachdaten (z. B. <Datenverzeichnis>/index/tessdata) */
  tessdataDir: string;
  /** Tesseract-Sprachcodes, z. B. "deu+eng" */
  languages: string;
}

const LANG_RE = /^[a-z]{3}(_[a-z]+)?$/;

const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'noop.js'));

/** Kopiert die gepackten Sprachdaten (4.0.0_best_int) in den lokalen Ordner – nur wenn sie fehlen. */
export async function ensureTessdata(dir: string, languages: string): Promise<string[]> {
  await fsp.mkdir(dir, { recursive: true });
  const langs = languages.split('+').map((l) => l.trim()).filter(Boolean);
  for (const lang of langs) {
    if (!LANG_RE.test(lang)) throw new Error(`Ungültiger Sprachcode: ${lang}`);
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    let pkgDir: string;
    try {
      pkgDir = path.dirname(nodeRequire.resolve(`@tesseract.js-data/${lang}/package.json`));
    } catch {
      throw new Error(`Sprachdaten für „${lang}“ sind nicht installiert (Paket @tesseract.js-data/${lang}).`);
    }
    const source = [path.join(pkgDir, '4.0.0_best_int', `${lang}.traineddata.gz`), path.join(pkgDir, '4.0.0', `${lang}.traineddata.gz`)].find((p) => fs.existsSync(p));
    if (!source) throw new Error(`Sprachdatei für „${lang}“ nicht gefunden.`);
    const tmp = `${target}.tmp`;
    await fsp.copyFile(source, tmp);
    await fsp.rename(tmp, target);
  }
  return langs;
}

/** Bereitet ein Bild für die Erkennung auf: drehen nach EXIF, Graustufen, Kontrast, sinnvolle Größe. */
export async function prepareForOcr(input: string | Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const base = sharp(input, { failOn: 'none', limitInputPixels: 268_000_000 }).rotate();
  const meta = await base.metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  let pipeline = base.grayscale().normalize();
  if (longest > 0 && longest < 1500) pipeline = pipeline.resize({ width: Math.round((meta.width ?? 1) * 2), kernel: 'lanczos3' });
  else if (longest > 4500) pipeline = pipeline.resize({ width: meta.width && meta.width >= (meta.height ?? 0) ? 4500 : undefined, height: meta.height && meta.height > (meta.width ?? 0) ? 4500 : undefined, fit: 'inside' });
  return pipeline.sharpen().png().toBuffer();
}

export interface OcrResult {
  text: string;
  /** mittlere Erkennungssicherheit 0..100 */
  confidence: number;
}

/** Erkennt Text in mehreren Bildern mit einem gemeinsamen Worker. */
export async function recognizeImages(images: Array<string | Buffer>, opts: OcrOptions, onProgress?: (done: number, total: number) => void): Promise<OcrResult[]> {
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

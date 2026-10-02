import path from 'node:path';

/** Renders text as a PNG so that local text recognition (OCR) has something to read. */
export async function writeTextImage(image: { dir: string; name: string; lines: string[] }): Promise<string> {
  const sharp = (await import('sharp')).default;
  const file = path.join(image.dir, image.name);
  const text = image.lines
    .map((line, index) => `<text x="40" y="${100 + index * 100}" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" fill="black">${line}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${60 + image.lines.length * 100}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

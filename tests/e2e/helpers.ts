import path from 'node:path';

/** Rendert einen Text als PNG, damit die lokale Texterkennung (OCR) etwas zu lesen hat. */
export async function writeTextImage(dir: string, name: string, lines: string[]): Promise<string> {
  const sharp = (await import('sharp')).default;
  const file = path.join(dir, name);
  const text = lines
    .map((line, i) => `<text x="40" y="${100 + i * 100}" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" fill="black">${line}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${60 + lines.length * 100}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

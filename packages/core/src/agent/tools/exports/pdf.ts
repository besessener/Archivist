import type { PDFDocument, PDFFont } from 'pdf-lib';

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** extra space before the line */
  gap?: number;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;

/** Replaces characters the standard font cannot encode (WinAnsi) with '?'. */
function encodable(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text.replaceAll('\t', '    ')].map((character) => (set.has(character.codePointAt(0)!) ? character : '?')).join('');
}

interface TextBox {
  font: PDFFont;
  size: number;
  width: number;
}

/** A single word longer than the line is cut hard; the last piece starts the next line. */
function cutWord(word: string, { font, size, width }: TextBox): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  let rest = word;
  while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
    let n = rest.length - 1;
    while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n -= 1;
    pieces.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return { pieces, rest };
}

function wrap(text: string, box: TextBox): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/ +/)) {
    const next = line ? `${line} ${word}` : word;
    if (box.font.widthOfTextAtSize(next, box.size) <= box.width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    const { pieces, rest } = cutWord(word, box);
    lines.push(...pieces);
    line = rest;
  }
  lines.push(line);
  return lines;
}

/** Draws text lines onto new pages (wrapped, with page breaks); returns the number of pages added. */
export async function drawText(pdf: PDFDocument, lines: PdfLine[]): Promise<number> {
  const { StandardFonts } = await import('pdf-lib');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = A4[0] - 2 * MARGIN;
  let page = pdf.addPage(A4);
  let pages = 1;
  let y = A4[1] - MARGIN;
  for (const line of lines) {
    const font = line.bold ? bold : regular;
    const size = line.size ?? 10;
    const lead = size * 1.35;
    y -= line.gap ?? 0;
    for (const part of wrap(encodable(font, line.text), { font, size, width })) {
      if (y - lead < MARGIN) {
        page = pdf.addPage(A4);
        pages += 1;
        y = A4[1] - MARGIN;
      }
      y -= lead;
      if (part) page.drawText(part, { x: MARGIN, y, size, font });
    }
  }
  return pages;
}

const HEADING_SIZE: Record<number, number> = { 1: 16, 2: 13 };
const withoutMarkup = (text: string) => text.replaceAll('**', '').replaceAll('__', '').replaceAll('`', '');

/** Markdown as PDF lines: headings bold and larger, list items with bullets, blank lines as gaps. */
export function markdownPdfLines(title: string, markdown: string): PdfLine[] {
  const lines: PdfLine[] = [{ text: title, size: 18, bold: true }];
  let gap = 8;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      gap = 6;
      continue;
    }
    const heading = /^(#{1,6}) +(\S.*)$/.exec(line);
    if (heading) lines.push({ text: withoutMarkup(heading[2]!), size: HEADING_SIZE[heading[1]!.length] ?? 11, bold: true, gap: gap + 6 });
    else lines.push({ text: withoutMarkup(line.replace(/^(\s*)[*-]\s+/, '$1• ')), gap });
    gap = 0;
  }
  return lines;
}

import fsp from 'node:fs/promises';
import type { ParsedDocument } from './index';
import { cleanText } from './text';

export async function readZipXml(buffer: Buffer, names: RegExp): Promise<Array<{ name: string; xml: string }>> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const parts: Array<{ name: string; xml: string }> = [];
  for (const name of Object.keys(zip.files)) {
    if (names.test(name) && !zip.files[name]!.dir) parts.push({ name, xml: await zip.files[name]!.async('string') });
  }
  return parts;
}

export const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Title, author and creation date from docProps/core.xml. */
export function coreProps(xml: string): ParsedDocument['meta'] {
  const meta: ParsedDocument['meta'] = {};
  const pick = (tag: string) => new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml)?.[1];
  const title = pick('dc:title');
  const creator = pick('dc:creator');
  const created = pick('dcterms:created');
  if (title) meta.title = decodeXml(title);
  if (creator) meta.author = decodeXml(creator);
  if (created) meta.created = created;
  return meta;
}

export async function parseDocx(file: string): Promise<ParsedDocument> {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const buffer = await fsp.readFile(file);
  const result = await mammoth.extractRawText({ buffer });
  let meta: ParsedDocument['meta'] = {};
  try {
    const core = await readZipXml(buffer, /^docProps\/core\.xml$/);
    if (core[0]) meta = coreProps(core[0].xml);
  } catch {
    // metadata is optional
  }
  const text = cleanText(result.value);
  return {
    text: text.text,
    status: text.text ? 'extracted' : 'partial',
    error: text.text ? null : 'Das Dokument enthält keinen Text.',
    meta,
    truncated: text.truncated,
  };
}

// eslint-disable-next-line sonarjs/super-linear-regex -- file name or HTML excerpt, length is bounded
const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

const paragraphsOf = (xml: string) =>
  [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)]
    .map((paragraph) => [...paragraph[0].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((run) => decodeXml(run[1] ?? '')).join(''))
    .filter(Boolean)
    .join('\n');

export async function parsePptx(file: string): Promise<ParsedDocument> {
  const buffer = await fsp.readFile(file);
  const files = await readZipXml(buffer, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$|^docProps\/core\.xml$/);
  const slides = files.filter((part) => part.name.startsWith('ppt/slides/')).sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  const notes = new Map(files.filter((part) => part.name.startsWith('ppt/notesSlides/')).map((part) => [slideNumber(part.name), paragraphsOf(part.xml)]));
  const parts = slides.map((slide, index) => {
    const note = notes.get(slideNumber(slide.name));
    return `Folie ${index + 1}:\n${paragraphsOf(slide.xml)}${note ? `\nNotizen: ${note}` : ''}`;
  });
  const core = files.find((part) => part.name === 'docProps/core.xml');
  const text = cleanText(parts.join('\n\n'));
  return {
    text: text.text,
    status: text.text ? 'extracted' : 'partial',
    error: text.text ? null : 'Keine Folientexte gefunden.',
    meta: { slides: slides.length, ...(core ? coreProps(core.xml) : {}) },
    truncated: text.truncated,
  };
}

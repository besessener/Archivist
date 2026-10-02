import { z } from 'zod';
import type { DocumentRecord, DocumentStatus } from '@archivist/shared';
import { folderOf } from '../../services/archive-structure';
import { list, optText } from '../registry';
import { ARCHIVED, INBOX, allDocs, docDay, docLine, lower, normalizeExtension, normalizeFolder, type ToolDeps, type ToolScope } from './common';

export const PAGE_SIZE = 50;
/** Characters per section when a document is read section by section (#190). */
export const SECTION_CHARS = 6_000;

export const FindArgs = z.object({
  ext: list.nullish().describe('Dateiendung(en), z. B. ["pptx","ppt"]'),
  name: optText.describe('Teil von Titel oder Dateiname'),
  folder: optText.describe('Ordner im Archiv bzw. dessen Anfang, z. B. "work/hr"'),
  topic: optText,
  project: optText,
  docType: optText.describe('z. B. "Rechnung", "Vertrag", "Präsentation"'),
  person: optText,
  tag: optText,
  from: optText.describe('fachliches Datum (Dokumentdatum) ab, YYYY-MM-DD'),
  to: optText.describe('fachliches Datum bis, YYYY-MM-DD'),
  archivedFrom: optText.describe('Archivierungsdatum ab, YYYY-MM-DD'),
  archivedTo: optText.describe('Archivierungsdatum bis, YYYY-MM-DD'),
  minKb: z.coerce.number().min(0).nullish(),
  maxKb: z.coerce.number().min(0).nullish(),
  status: z.enum(['archived', 'inbox', 'all', 'failed', 'quarantined']).nullish().describe('archived (Standard), inbox, failed, quarantined oder all'),
  within: z.string().nullish().describe('nur innerhalb einer früheren Ergebnismenge (S…)'),
  sort: z.enum(['date', 'name', 'size', 'archived']).nullish(),
  page: z.coerce.number().int().min(1).nullish(),
  pageSize: z.coerce.number().int().min(1).max(200).nullish(),
});
type FindFilter = z.output<typeof FindArgs>;

const STATUS_FILTER: Record<NonNullable<FindFilter['status']>, (status: DocumentStatus) => boolean> = {
  archived: (status) => ARCHIVED.includes(status),
  inbox: (status) => INBOX.includes(status),
  all: () => true,
  failed: (status) => status === 'failed',
  quarantined: (status) => status === 'quarantined',
};

const SORT_ORDER: Record<NonNullable<FindFilter['sort']>, (x: DocumentRecord, y: DocumentRecord) => number> = {
  name: (x, y) => x.title.localeCompare(y.title),
  size: (x, y) => y.size - x.size,
  archived: (x, y) => (y.archivedAt ?? '').localeCompare(x.archivedAt ?? ''),
  date: (x, y) => docDay(y).localeCompare(docDay(x)),
};

const contains = (value: string | null | undefined, wanted: string | null) => !wanted || lower(value).includes(wanted.toLowerCase());
const isSet = (value: number | null | undefined): value is number => value !== null && value !== undefined;

function inFolder(d: DocumentRecord, folder: string | null): boolean {
  if (!folder) return true;
  if (d.archiveRelPath === null) return false;
  const own = folderOf(d).toLowerCase();
  return own === folder || own.startsWith(`${folder}/`);
}

function matchesDates(d: DocumentRecord, args: FindFilter): boolean {
  return (
    (!args.from || docDay(d) >= args.from) &&
    (!args.to || docDay(d) <= args.to) &&
    (!args.archivedFrom || (d.archivedAt ?? '').slice(0, 10) >= args.archivedFrom) &&
    (!args.archivedTo || (d.archivedAt ?? '9999').slice(0, 10) <= args.archivedTo)
  );
}

function matchesMetadata(d: DocumentRecord, args: FindFilter): boolean {
  return (
    (!args.name || contains(d.title, args.name) || contains(d.originalName, args.name)) &&
    contains(d.topicName, args.topic) &&
    contains(d.projectName, args.project) &&
    contains(d.docType, args.docType) &&
    (!args.person || d.persons.some((p) => contains(p, args.person))) &&
    (!args.tag || d.tags.some((t) => contains(t, args.tag)))
  );
}

const matchesSize = (d: DocumentRecord, args: FindFilter) =>
  (!isSet(args.minKb) || d.size / 1024 >= args.minKb) && (!isSet(args.maxKb) || d.size / 1024 <= args.maxKb);

export function filterDocuments({ deps, ctx }: ToolScope, args: FindFilter): DocumentRecord[] {
  const extensions = new Set((args.ext ?? []).map(normalizeExtension));
  const statusMatches = STATUS_FILTER[args.status ?? 'archived'];
  const folder = args.folder ? normalizeFolder(args.folder).toLowerCase() : null;
  const within = args.within ? new Set(ctx.refs.resolveMany([args.within]).ids) : null;
  const hits = allDocs(deps).filter(
    (d) =>
      (!within || within.has(d.id)) &&
      statusMatches(d.status) &&
      (!extensions.size || extensions.has(normalizeExtension(d.ext))) &&
      inFolder(d, folder) &&
      matchesMetadata(d, args) &&
      matchesDates(d, args) &&
      matchesSize(d, args),
  );
  return hits.toSorted(SORT_ORDER[args.sort ?? 'date']);
}

/** Lines of one page of a document list, with total and result set (#222). */
export function pageOf(scope: ToolScope, docs: DocumentRecord[], page: { number: number; size: number }): string {
  const set = scope.ctx.refs.set(docs.map((d) => d.id));
  const pages = Math.max(1, Math.ceil(docs.length / page.size));
  const shown = docs.slice((page.number - 1) * page.size, page.number * page.size);
  return [
    `${docs.length} Dokument(e), Ergebnismenge ${set} (steht für ALLE Treffer)${pages > 1 ? `; Seite ${page.number}/${pages} – weitere mit page` : ''}:`,
    ...shown.map((d) => `- ${docLine(scope, d)}`),
  ].join('\n');
}

/** Section (for read_document) and page of a passage within the document text, e.g. " (Abschnitt 3, Seite 5)". */
export function locate(text: string, passage: string): string {
  const probe = passage.trim().slice(0, 60);
  const at = probe ? text.indexOf(probe) : -1;
  if (at < 0) return '';
  const section = Math.floor(at / SECTION_CHARS) + 1;
  const page = text.includes('\f') ? text.slice(0, at).split('\f').length : null;
  return ` (Abschnitt ${section}${page ? `, Seite ${page}` : ''})`;
}

/** The document, or undefined when it no longer exists. */
export function findDocument(deps: ToolDeps, id: string): DocumentRecord | undefined {
  try {
    return deps.docs.get(id);
  } catch {
    return undefined;
  }
}

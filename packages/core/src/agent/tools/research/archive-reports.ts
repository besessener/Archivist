import type { DocumentRecord } from '@archivist/shared';
import { nameSimilarity, truncate } from '../../../util/text';
import { folderLabel, folderOf } from '../../../services/archive-structure';
import type { ToolOutput } from '../../registry';
import { allDocs, docLine, lower, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from '../common';
import { archivedDocs, businessDate, documentText, skippedNote } from './access';
import { mailHeadersOf, mailThreads } from './mail';
import { problemReasons } from './problems';
import { scanSecrets } from './secrets';

const megabytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export async function secretsReport(scope: ToolScope, refs: readonly string[] | null | undefined): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs: found, unknown } = refs?.length ? resolveDocs(scope, refs) : { docs: archivedDocs(deps), unknown: [] as string[] };
  const lines: string[] = [];
  for (const d of found) {
    const entries = Object.entries(scanSecrets(documentText(deps, d.id)));
    if (!entries.length) continue;
    const what = entries.map(([kind, n]) => `${n}× ${kind}`).join(', ');
    lines.push(
      deps.privacy.mayShareDocument(d) ? `- ${docLine(scope, d)}\n  enthält: ${what}` : `- ${ctx.refs.doc(d.id)} [nicht freigegeben]: enthält ${what}`,
    );
  }
  if (!lines.length) return { content: `In ${found.length} geprüften Dokumenten nichts gefunden.${unknownNote(unknown)}`, summary: 'nichts gefunden' };
  return {
    content: `${lines.length} von ${found.length} Dokumenten enthalten mögliche Geheimnisse (Werte werden nie angezeigt):\n${lines.join('\n')}\nVorschlag: diese Dokumente mit exclude_from_llm von der Übertragung an das LLM ausschließen.${unknownNote(unknown)}`,
    summary: `${lines.length} Dokument(e) mit möglichen Geheimnissen`,
  };
}

export async function problemFilesReport(scope: ToolScope): Promise<ToolOutput> {
  const lines: string[] = [];
  let skipped = 0;
  for (const d of allDocs(scope.deps)) {
    const reasons = problemReasons(d);
    if (!reasons.length) continue;
    if (!scope.deps.privacy.mayShareDocument(d)) {
      skipped += 1;
      continue;
    }
    lines.push(`- ${docLine(scope, d)}\n  ${reasons.join('\n  ')}`);
  }
  if (!lines.length) return { content: `Keine Problemdateien gefunden.${skippedNote(skipped)}`, summary: 'keine Probleme' };
  return {
    content: lines.slice(0, 100).join('\n') + (lines.length > 100 ? `\n… und ${lines.length - 100} weitere` : '') + skippedNote(skipped),
    summary: `${lines.length} Problemdatei(en)`,
  };
}

const wastedBytes = (group: DocumentRecord[]) => group[0]!.size * (group.length - 1);

/** Groups of documents with the same content, the most wasted space first. */
function exactDuplicates(docs: DocumentRecord[]): DocumentRecord[][] {
  const bySha = new Map<string, DocumentRecord[]>();
  for (const d of docs) bySha.set(d.sha256, [...(bySha.get(d.sha256) ?? []), d]);
  return [...bySha.values()].filter((g) => g.length > 1).toSorted((x, y) => wastedBytes(y) - wastedBytes(x));
}

/** The oldest archived documents without topic, project or a meaningful link (at most 10). */
function lonelyDocuments(deps: ToolDeps, docs: DocumentRecord[]): DocumentRecord[] {
  const lonely: DocumentRecord[] = [];
  const hasMeaningfulLink = (d: DocumentRecord) =>
    deps.graph
      .relationsOf(d.id)
      .filter((r) => r.status !== 'rejected' && r.status !== 'outdated')
      .some((r) => {
        const other = deps.graph.getEntity(r.sourceEntityId === d.id ? r.targetEntityId : r.sourceEntityId);
        return other && other.type !== 'category' && other.type !== 'tag';
      });
  for (const d of docs.toSorted((x, y) => (x.archivedAt ?? x.createdAt).localeCompare(y.archivedAt ?? y.createdAt))) {
    if (lonely.length >= 10) break;
    if (!hasMeaningfulLink(d) && !d.topicId && !d.projectId) lonely.push(d);
  }
  return lonely;
}

export async function storageReport(scope: ToolScope): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const all = archivedDocs(deps);
  const shareable = all.filter((d) => deps.privacy.mayShareDocument(d));
  const total = all.reduce((sum, d) => sum + d.size, 0);
  const largest = shareable.toSorted((x, y) => y.size - x.size).slice(0, 15);
  const duplicates = exactDuplicates(shareable);
  const wasted = duplicates.reduce((sum, g) => sum + wastedBytes(g), 0);
  const lonely = lonelyDocuments(deps, shareable);
  return {
    content: [
      `Archiv: ${all.length} Dokumente, ${megabytes(total)} gesamt.`,
      `Größte Dateien:`,
      ...largest.map((d) => `- ${megabytes(d.size)}: ${docLine(scope, d)}`),
      duplicates.length ? `Exakte Duplikate (gleicher Inhalt): ${duplicates.length} Gruppen, ${megabytes(wasted)} verschwendet:` : 'Keine exakten Duplikate.',
      ...duplicates
        .slice(0, 15)
        .map((g) => `- ${g.length}× ${megabytes(g[0]!.size)}: ${g.map((d) => ctx.refs.doc(d.id)).join(', ')} – „${truncate(g[0]!.title, 60)}“`),
      lonely.length
        ? 'Vermutlich lange nicht genutzt (Näherung: Archivist erfasst nicht, wann ein Dokument zuletzt geöffnet wurde – gezeigt werden die ältesten archivierten Dokumente ohne Thema, Projekt oder Verknüpfung):'
        : null,
      ...lonely.map((d) => `- ${docLine(scope, d)}`),
      'Nur Hinweise – gelöscht oder verschoben wird nichts ohne ausdrücklichen Auftrag (find_duplicates / mark_duplicates).',
    ]
      .filter(Boolean)
      .join('\n')
      .concat(skippedNote(all.length - shareable.length)),
    summary: `${megabytes(total)}, ${duplicates.length} Duplikatgruppen`,
  };
}

export async function mailThreadsReport(scope: ToolScope, refs: readonly string[] | null | undefined): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const source = refs?.length
    ? resolveDocs(scope, refs)
    : { docs: allDocs(deps).filter((d) => lower(d.ext) === 'eml' && d.status !== 'ignored'), unknown: [] as string[] };
  const mails = source.docs.filter((d) => lower(d.ext) === 'eml');
  const shareable = mails.filter((d) => deps.privacy.mayShareDocument(d));
  const threads = mailThreads(shareable.map((doc) => ({ doc, headers: mailHeadersOf(deps.docs.findRow(doc.id)?.technicalMeta) })));
  const notes = skippedNote(mails.length - shareable.length) + unknownNote(source.unknown);
  if (!threads.length)
    return { content: `Keine Verläufe mit mehreren Nachrichten gefunden (${shareable.length} E-Mails geprüft).${notes}`, summary: 'keine Verläufe' };
  const basis = { headers: 'nach Message-ID und Antwort-Kopfzeilen', subject: 'nur nach Betreff, keine Kopfzeilen gespeichert – eine Vermutung' };
  const lines = threads.slice(0, 40).map(({ label, mails: group, basis: how }) => {
    const sorted = group.toSorted((x, y) => businessDate(x).localeCompare(businessDate(y)));
    return `Verlauf „${truncate(label, 80)}“ (${group.length} Nachrichten, zugeordnet ${basis[how]}, Ergebnismenge ${ctx.refs.set(sorted.map((d) => d.id))}):\n${sorted.map((d) => `  - ${docLine(scope, d)}`).join('\n')}`;
  });
  return { content: lines.join('\n') + notes, summary: `${threads.length} Verläufe` };
}

interface FilingMatch {
  d: DocumentRecord;
  score: number;
  sameType: boolean;
  sharedPersons: number;
  title: number;
}

function filingScorer(target: DocumentRecord): (d: DocumentRecord) => FilingMatch {
  const persons = new Set(target.persons.map((p) => p.toLowerCase()));
  return (d) => {
    const sameType = Boolean(target.docType && d.docType && lower(target.docType) === lower(d.docType));
    const sharedPersons = d.persons.filter((p) => persons.has(p.toLowerCase())).length;
    const title = nameSimilarity(target.title, d.title);
    return { d, score: (sameType ? 0.4 : 0) + (sharedPersons ? 0.25 : 0) + title * 0.35, sameType, sharedPersons, title };
  };
}

const similarityReasons = (match: FilingMatch) =>
  [match.sameType ? 'gleichem Typ' : null, match.sharedPersons ? 'gleichen Personen' : null, match.title >= 0.5 ? 'ähnlichem Titel' : null]
    .filter(Boolean)
    .join(', ') || 'Titel';

export async function similarFilingsReport(scope: ToolScope, ref: string): Promise<ToolOutput> {
  const { deps } = scope;
  const { docs: found, unknown } = resolveDocs(scope, [ref]);
  const target = found[0];
  if (!target) return { content: `Unbekannte Dokument-ID „${ref}“.${unknownNote(unknown)}`, isError: true };
  const matches = archivedDocs(deps)
    .filter((d) => d.id !== target.id && d.status === 'archived' && d.archiveRelPath && deps.privacy.mayShareDocument(d))
    .map(filingScorer(target))
    .filter((x) => x.score >= 0.25)
    .toSorted((x, y) => y.score - x.score)
    .slice(0, 5);
  if (!matches.length) return { content: 'Keine ähnlich abgelegten Dokumente gefunden.', summary: 'keine Beispiele' };
  return {
    content: [
      `BEISPIELE (keine Regel) – so wurden ähnliche Dokumente zu ${docLine(scope, target)} abgelegt:`,
      ...matches.map((x) => `- Ordner ${folderLabel(folderOf(x.d))}: ${docLine(scope, x.d)} (ähnlich wegen ${similarityReasons(x)})`),
    ].join('\n'),
    summary: `${matches.length} Beispiel(e)`,
  };
}

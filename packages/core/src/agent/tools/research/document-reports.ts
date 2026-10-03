import { localDate, type DocumentRecord } from '@archivist/shared';
import { truncate } from '../../../util/text';
import type { ToolContext, ToolOutput } from '../../registry';
import { asData } from '../../security';
import { docDay, docLine, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from '../common';
import { archivedDocs, businessDate, documentText, shareableDocs, skippedNote } from './access';
import { formatEuro, invoiceTotal, sumAmounts } from './amounts';
import { coverageLookup, scanDeadlines, type DeadlineCoverage } from './deadline-coverage';
import { DEADLINE_LABEL, type Deadline } from './deadlines';
import { monthGaps, numberGaps, sequenceNumber } from './gaps';
import { invoiceNumber, matchPayments, parseStatement, type InvoiceInfo, type Payment } from './payments';

export async function sumAmountsReport(scope: ToolScope, refs: readonly string[]): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs: found, skipped, unknown } = shareableDocs(scope, refs);
  const rows: string[] = [];
  const without: string[] = [];
  const values: number[] = [];
  for (const d of found.toSorted((x, y) => docDay(x).localeCompare(docDay(y)))) {
    const total = invoiceTotal(documentText(deps, d.id));
    if (!total) {
      without.push(ctx.refs.doc(d.id));
      continue;
    }
    values.push(total.amount);
    rows.push(`- ${docLine(scope, d)}\n  Datum: ${docDay(d)} | Betrag: ${formatEuro(total.amount)} | Fundstelle: ${asData(ctx.refs.doc(d.id), total.line)}`);
  }
  const sum = sumAmounts(values);
  return {
    content: [
      `Belegliste (${values.length}):`,
      ...rows,
      `SUMME: ${formatEuro(sum)} (${values.length} Belege, deterministisch berechnet)`,
      without.length ? `Ohne erkennbaren Betrag: ${without.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n')
      .concat(skippedNote(skipped), unknownNote(unknown)),
    summary: `Summe ${formatEuro(sum)} aus ${values.length} Beleg${values.length === 1 ? '' : 'en'}`,
  };
}

const DATE_LINE = /\b\d{4}-\d{2}(?:-\d{2})?\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\b\d{1,2}\.\s?[A-Za-zä]+\s\d{4}\b/;

/** First and last document of a series with the verbatim line the position was read from (marked as data, with the D-ref). */
function boundaryEvidence(ctx: ToolContext, ends: Array<{ d: DocumentRecord; line: string }>): string {
  const shown = ends.length > 1 ? [ends[0]!, ends.at(-1)!] : ends;
  return shown.map((e) => `Fundstelle ${asData(ctx.refs.doc(e.d.id), truncate(e.line, 200))}`).join('\n');
}

function monthGapsOutput(scope: ToolScope, found: DocumentRecord[]): ToolOutput {
  const { deps, ctx } = scope;
  const ends = found
    .toSorted((x, y) => businessDate(x).localeCompare(businessDate(y)))
    .map((d) => ({
      d,
      line:
        documentText(deps, d.id)
          .split(/\r?\n/)
          .find((l) => DATE_LINE.test(l)) ?? `${d.title} (${businessDate(d)})`,
    }));
  const gaps = monthGaps(found.map(businessDate));
  const counts = new Map<string, number>();
  for (const d of found) counts.set(businessDate(d).slice(0, 7), (counts.get(businessDate(d).slice(0, 7)) ?? 0) + 1);
  const doubles = [...counts].filter(([, n]) => n > 1).map(([month, n]) => `${month} (${n}×)`);
  return {
    content: [
      `Zeitraum ${gaps.first} bis ${gaps.last}: ${gaps.present.length} Monate vorhanden, ${gaps.missing.length} fehlen.`,
      gaps.missing.length ? `Fehlende Monate: ${gaps.missing.join(', ')}` : 'Keine Lücke.',
      doubles.length ? `Mehrfach vorhanden: ${doubles.join(', ')}` : null,
      boundaryEvidence(ctx, ends),
    ]
      .filter(Boolean)
      .join('\n'),
    summary: gaps.missing.length ? `${gaps.missing.length} Monat(e) fehlen` : 'keine Lücke',
  };
}

function numberGapsOutput(ctx: ToolContext, found: DocumentRecord[]): ToolOutput {
  const named = (d: DocumentRecord) => (sequenceNumber(d.title) ? d.title : d.originalName);
  const sequence = found.map((d) => ({ d, number: sequenceNumber(d.title) ?? sequenceNumber(d.originalName) }));
  const months = sequence.flatMap((x) => (x.number?.kind === 'month' ? [x.number.month] : []));
  const numbers = sequence.flatMap((x) => (x.number?.kind === 'number' ? [x.number.n] : []));
  const without = sequence.filter((x) => !x.number).map((x) => ctx.refs.doc(x.d.id));
  const ends = sequence
    .filter((x) => x.number)
    .toSorted(
      (x, y) => (x.number!.kind === 'number' ? x.number!.n : 0) - (y.number!.kind === 'number' ? y.number!.n : 0) || named(x.d).localeCompare(named(y.d)),
    )
    .map((x) => ({ d: x.d, line: named(x.d) }));
  const withoutNote = `${without.length ? `\nOhne erkennbare Nummer: ${without.join(', ')}` : ''}${ends.length ? `\n${boundaryEvidence(ctx, ends)}` : ''}`;
  if (months.length > numbers.length) {
    const gaps = monthGaps(months.map((month) => `${month}-01`));
    return {
      content: `Nummerierung nach Monat im Namen, ${gaps.first} bis ${gaps.last}: ${gaps.missing.length ? `fehlend ${gaps.missing.join(', ')}` : 'keine Lücke'}.${withoutNote}`,
      summary: gaps.missing.length ? `${gaps.missing.length} fehlen` : 'keine Lücke',
    };
  }
  if (!numbers.length) return { content: 'In Titel und Dateinamen ist keine laufende Nummer erkennbar – by="month" versuchen.' };
  const missing = numberGaps(numbers);
  const sorted = [...new Set(numbers)].toSorted((x, y) => x - y);
  return {
    content: `Nummern ${sorted[0]} bis ${sorted.at(-1)} (${sorted.length} vorhanden): ${missing.length ? `fehlend ${missing.join(', ')}` : 'keine Lücke'}.${withoutNote}`,
    summary: missing.length ? `${missing.length} Nummer(n) fehlen` : 'keine Lücke',
  };
}

export async function gapsReport(scope: ToolScope, args: { documents: string[]; by: 'month' | 'number' }): Promise<ToolOutput> {
  const { docs: found, skipped, unknown } = shareableDocs(scope, args.documents);
  if (!found.length) return { content: `Keine auswertbaren Dokumente.${skippedNote(skipped)}${unknownNote(unknown)}`, isError: true };
  const output = args.by === 'month' ? monthGapsOutput(scope, found) : numberGapsOutput(scope.ctx, found);
  return { ...output, content: output.content + skippedNote(skipped) + unknownNote(unknown) };
}

/** Deadlines listed per call; the rest is counted. */
const MAX_LISTED_DEADLINES = 60;
/** Documents scanned when no documents are given (the newest ones). */
const MAX_SCANNED_DOCUMENTS = 1000;

const SKIPPED_REFS_SHOWN = 10;

function blockedNote({ ctx }: ToolScope, blocked: DocumentRecord[]): string {
  if (!blocked.length) return '';
  const refs = blocked.slice(0, SKIPPED_REFS_SHOWN).map((d) => ctx.refs.doc(d.id));
  const more = blocked.length > SKIPPED_REFS_SHOWN ? ` und ${blocked.length - SKIPPED_REFS_SHOWN} weitere` : '';
  return `\n${blocked.length} nicht freigegebene Dokumente übersprungen (nicht geprüft): ${refs.join(', ')}${more}.`;
}

function deadlineLine(scope: ToolScope, found: { hit: Deadline; documentId: string; covered: ReturnType<typeof coverageLookup> }): string {
  const { ctx } = scope;
  const { hit, documentId } = found;
  const coverage = hit.date && !hit.past ? found.covered(documentId, { kind: hit.kind, date: hit.date }) : null;
  const note = !hit.date || hit.past ? '' : coverage ? ` | ${coverageText(scope, coverage)}` : ' | keine Erinnerung';
  return `  • ${DEADLINE_LABEL[hit.kind]}: ${hit.date ?? 'Datum offen'}${hit.past ? ' (bereits vorbei)' : ''} (Art: ${hit.kind})${note}\n    Rechenweg: ${hit.rechenweg}\n    Fundstelle: ${asData(ctx.refs.doc(documentId), hit.evidence)}`;
}

function coverageText({ ctx }: ToolScope, coverage: DeadlineCoverage): string {
  return coverage.by === 'reminder'
    ? `Erinnerung vorhanden (${localDate(coverage.reminder.remindAt)})`
    : `offener Punkt vorhanden (${ctx.refs.entry(coverage.openItem.id)}, fällig ${coverage.openItem.dueAt ? localDate(coverage.openItem.dueAt) : '–'})`;
}

const firstDate = (hits: Deadline[]) => hits[0]?.date ?? '9999';

type DeadlineGroups = Array<[DocumentRecord, Deadline[]]>;

/** Deadlines per document, earliest first; with `all` the past ones are only counted. */
function groupDeadlines(deps: ToolDeps, found: { documents: DocumentRecord[]; all: boolean }): { groups: DeadlineGroups; past: number } {
  const groups = new Map<DocumentRecord, Deadline[]>();
  let past = 0;
  for (const { document, deadline } of scanDeadlines(deps, { documents: found.documents, today: new Date() })) {
    if (found.all && deadline.past) past += 1;
    else groups.set(document, [...(groups.get(document) ?? []), deadline]);
  }
  return { groups: [...groups].toSorted(([, a], [, b]) => (found.all ? firstDate(a).localeCompare(firstDate(b)) : 0)), past };
}

function deadlineLines(scope: ToolScope, groups: DeadlineGroups): { lines: string[]; listed: number } {
  const covered = coverageLookup(scope.deps);
  const lines: string[] = [];
  let listed = 0;
  for (const [document, hits] of groups) {
    if (listed >= MAX_LISTED_DEADLINES) break;
    const shown = hits.slice(0, MAX_LISTED_DEADLINES - listed);
    listed += shown.length;
    lines.push(`- ${docLine(scope, document)}`, ...shown.map((hit) => deadlineLine(scope, { hit, documentId: document.id, covered })));
  }
  return { lines, listed };
}

/** Deadlines per document; without documents all archived ones (newest first, past deadlines left out). */
export async function deadlinesReport(scope: ToolScope, refs: readonly string[] | null | undefined): Promise<ToolOutput> {
  const { deps } = scope;
  const all = !refs?.length;
  const { docs: found, unknown } = all ? { docs: archivedDocs(deps), unknown: [] as string[] } : resolveDocs(scope, refs);
  const shareable = found.filter((d) => deps.privacy.mayShareDocument(d));
  const blocked = found.filter((d) => !shareable.includes(d));
  const scanned = all ? shareable.toSorted((a, b) => docDay(b).localeCompare(docDay(a))).slice(0, MAX_SCANNED_DOCUMENTS) : shareable;
  const { groups, past } = groupDeadlines(deps, { documents: scanned, all });
  const { lines, listed } = deadlineLines(scope, groups);
  const total = groups.reduce((n, [, hits]) => n + hits.length, 0);
  const notes = [
    all
      ? `Geprüft: ${scanned.length} von ${shareable.length} freigegebenen archivierten Dokumenten${shareable.length > scanned.length ? ' (nur die neuesten)' : ''}.`
      : null,
    total > listed ? `… und ${total - listed} weitere Fristen – mit documents gezielt abfragen.` : null,
    past ? `${past} bereits vorbeigegangene Fristen ausgelassen (mit documents gezielt abfragen).` : null,
  ].filter(Boolean);
  const tail = (notes.length ? `\n${notes.join('\n')}` : '') + blockedNote(scope, blocked) + unknownNote(unknown);
  if (!lines.length) return { content: `Keine Fristen erkannt.${tail}`, summary: 'keine Fristen' };
  return { content: lines.join('\n') + tail, summary: `${total} Frist(en) erkannt` };
}

export async function paymentsReport(scope: ToolScope, args: { statements: string[]; invoices: string[] }): Promise<ToolOutput> {
  const { deps } = scope;
  const statements = shareableDocs(scope, args.statements);
  const invoices = shareableDocs(scope, args.invoices);
  const payments = statements.docs.flatMap((d) => parseStatement(documentText(deps, d.id), Number(businessDate(d).slice(0, 4))));
  const infos: InvoiceInfo[] = invoices.docs.map((d) => {
    const text = documentText(deps, d.id);
    return { id: d.id, date: businessDate(d).slice(0, 10), amount: invoiceTotal(text)?.amount ?? null, number: invoiceNumber(text) };
  });
  const result = matchPayments(infos, payments);
  const byId = new Map(invoices.docs.map((d) => [d.id, d]));
  const invoiceLine = (i: InvoiceInfo) =>
    `${docLine(scope, byId.get(i.id)!)} | ${i.amount === null ? 'Betrag unbekannt' : formatEuro(i.amount)}${i.number ? ` | Nr. ${i.number}` : ''}`;
  const paymentLine = (p: Payment) => asData('Kontoauszug', `${p.date} ${formatEuro(p.amount)} ${truncate(p.text, 120)}`);
  return {
    content: [
      `${payments.length} Buchungen aus ${statements.docs.length} Auszügen, ${infos.length} Rechnungen.`,
      `Bezahlt (${result.matched.length}):`,
      ...result.matched.map(
        (m) => `- ${invoiceLine(m.invoice)}\n  Zahlung (${m.by === 'number' ? 'Rechnungsnummer im Text' : 'gleicher Betrag'}): ${paymentLine(m.payment)}`,
      ),
      `Offen (${result.unpaid.length}):`,
      ...result.unpaid.map((i) => `- ${invoiceLine(i)}`),
      `Zahlungen ohne Rechnung (${result.unmatched.length}${result.unmatched.length > 30 ? ', die ersten 30' : ''}):`,
      ...result.unmatched.slice(0, 30).map((p) => `- ${paymentLine(p)}`),
    ]
      .join('\n')
      .concat(skippedNote(statements.skipped + invoices.skipped), unknownNote([...statements.unknown, ...invoices.unknown])),
    summary: `${result.matched.length} bezahlt, ${result.unpaid.length} offen`,
  };
}

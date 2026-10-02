import type { DocumentRecord, Reminder } from '@archivist/shared';
import { truncate } from '../../../util/text';
import type { ToolContext, ToolOutput } from '../../registry';
import { asData } from '../../security';
import { docDay, docLine, resolveDocs, unknownNote, type ToolScope } from '../common';
import { businessDate, documentText, shareableDocs, skippedNote } from './access';
import { formatEuro, invoiceTotal, sumAmounts } from './amounts';
import { DEADLINE_LABEL, findDeadlines, type Deadline } from './deadlines';
import { MAX_DIFF_LINES, diffLines } from './diff';
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

function monthGapsOutput(found: DocumentRecord[]): ToolOutput {
  const gaps = monthGaps(found.map(businessDate));
  const counts = new Map<string, number>();
  for (const d of found) counts.set(businessDate(d).slice(0, 7), (counts.get(businessDate(d).slice(0, 7)) ?? 0) + 1);
  const doubles = [...counts].filter(([, n]) => n > 1).map(([month, n]) => `${month} (${n}×)`);
  return {
    content: [
      `Zeitraum ${gaps.first} bis ${gaps.last}: ${gaps.present.length} Monate vorhanden, ${gaps.missing.length} fehlen.`,
      gaps.missing.length ? `Fehlende Monate: ${gaps.missing.join(', ')}` : 'Keine Lücke.',
      doubles.length ? `Mehrfach vorhanden: ${doubles.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    summary: gaps.missing.length ? `${gaps.missing.length} Monat(e) fehlen` : 'keine Lücke',
  };
}

function numberGapsOutput(ctx: ToolContext, found: DocumentRecord[]): ToolOutput {
  const sequence = found.map((d) => ({ d, number: sequenceNumber(d.title) ?? sequenceNumber(d.originalName) }));
  const months = sequence.flatMap((x) => (x.number?.kind === 'month' ? [x.number.month] : []));
  const numbers = sequence.flatMap((x) => (x.number?.kind === 'number' ? [x.number.n] : []));
  const without = sequence.filter((x) => !x.number).map((x) => ctx.refs.doc(x.d.id));
  const withoutNote = without.length ? `\nOhne erkennbare Nummer: ${without.join(', ')}` : '';
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
  const output = args.by === 'month' ? monthGapsOutput(found) : numberGapsOutput(scope.ctx, found);
  return { ...output, content: output.content + skippedNote(skipped) + unknownNote(unknown) };
}

const showLines = (lines: string[]) => lines.slice(0, 80).join('\n') + (lines.length > 80 ? `\n… und ${lines.length - 80} weitere Zeilen` : '');

export async function compareReport(scope: ToolScope, args: { a: string; b: string }): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs: found, unknown } = resolveDocs(scope, [args.a, args.b]);
  const first = found.find((d) => d.id === ctx.refs.resolve(args.a));
  const second = found.find((d) => d.id === ctx.refs.resolve(args.b));
  if (!first || !second) return { content: `Zwei bekannte Dokument-IDs nötig.${unknownNote(unknown)}`, isError: true };
  if (!deps.privacy.mayShareDocument(first) || !deps.privacy.mayShareDocument(second))
    return { content: 'Mindestens eines der Dokumente ist nicht zur Übertragung freigegeben – der Vergleich ist nicht möglich.', isError: true };
  const diff = diffLines(documentText(deps, first.id), documentText(deps, second.id));
  const refA = ctx.refs.doc(first.id);
  const refB = ctx.refs.doc(second.id);
  return {
    content: [
      `A = ${docLine(scope, first)}`,
      `B = ${docLine(scope, second)}`,
      `${diff.common} gemeinsame Zeilen, ${diff.onlyA.length} nur in A, ${diff.onlyB.length} nur in B${diff.capped ? ` (nur die ersten ${MAX_DIFF_LINES} Zeilen verglichen)` : ''}.`,
      diff.onlyA.length ? `Nur in A:\n${asData(`${refA}-nur-A`, showLines(diff.onlyA))}` : 'Nur in A: –',
      diff.onlyB.length ? `Nur in B:\n${asData(`${refB}-nur-B`, showLines(diff.onlyB))}` : 'Nur in B: –',
    ].join('\n'),
    summary: `${diff.onlyA.length} nur in A, ${diff.onlyB.length} nur in B`,
  };
}

function reminderNote(pending: Reminder[], documentId: string): string {
  const reminders = pending.filter((r) => r.targetId === documentId);
  return reminders.length ? ` | Erinnerung vorhanden (${reminders.map((r) => r.remindAt.slice(0, 10)).join(', ')})` : ' | keine Erinnerung';
}

function documentDeadlineLines(scope: ToolScope, found: { document: DocumentRecord; hits: Deadline[]; reminderNote: string }): string[] {
  const { ctx, deps } = scope;
  const { document: d, hits } = found;
  if (!deps.privacy.mayShareDocument(d))
    return hits.map(
      (h) => `- ${ctx.refs.doc(d.id)} [nicht freigegeben]: Frist am ${h.date ?? 'unbekannt'} (Art: ${DEADLINE_LABEL[h.kind]})${found.reminderNote}`,
    );
  return [
    `- ${docLine(scope, d)}${found.reminderNote}`,
    ...hits.map(
      (h) =>
        `  • ${DEADLINE_LABEL[h.kind]}: ${h.date ?? 'Datum offen'}${h.past ? ' (bereits vorbei)' : ''} – Rechenweg: ${h.rechenweg}\n    Fundstelle: ${asData(ctx.refs.doc(d.id), h.evidence)}`,
    ),
  ];
}

export async function deadlinesReport(scope: ToolScope, refs: readonly string[]): Promise<ToolOutput> {
  const { deps } = scope;
  const { docs: found, unknown } = resolveDocs(scope, refs);
  const pending = deps.reminders.list('pending');
  const today = new Date();
  const lines: string[] = [];
  let count = 0;
  for (const d of found) {
    const baseDate = d.documentDate ? d.documentDate.slice(0, 10) : docDay(d);
    const hits = findDeadlines(documentText(deps, d.id), { baseDate, today, baseLabel: d.documentDate ? 'Dokumentdatum' : 'Archivdatum' });
    if (!hits.length) continue;
    count += hits.length;
    lines.push(...documentDeadlineLines(scope, { document: d, hits, reminderNote: reminderNote(pending, d.id) }));
  }
  if (!lines.length) return { content: `Keine Fristen erkannt.${unknownNote(unknown)}`, summary: 'keine Fristen' };
  return { content: lines.join('\n') + unknownNote(unknown), summary: `${count} Frist(en) erkannt` };
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

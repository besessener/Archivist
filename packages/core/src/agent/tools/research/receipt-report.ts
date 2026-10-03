import type { DocumentRecord } from '@archivist/shared';
import { truncate } from '../../../util/text';
import type { ToolOutput } from '../../registry';
import { asData } from '../../security';
import { ARCHIVED, docLine, lower, resolveDocs, unknownNote, type ToolScope } from '../common';
import { archivedDocs, businessDate, documentText, skippedNote } from './access';
import { formatEuro, invoiceTotal } from './amounts';
import { matchReceipt, MIN_MATCH_SCORE, receiptFacts, type ReceiptFacts } from './receipt-photos';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg']);
const RECEIPT_TYPE_RE = /rechnung|beleg|quittung|kassenbon|invoice|receipt/i;
const WINDOW_DAYS = 14;
const MAX_SUGGESTIONS = 3;

const isImage = (d: DocumentRecord) => IMAGE_EXT.has(lower(d.ext));
const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Invoices and receipts of the archive, or documents dated close to the photo, as possible partners of a receipt photo. */
function possiblePartners(documents: DocumentRecord[], facts: ReceiptFacts): DocumentRecord[] {
  return documents.filter(
    (d) =>
      !isImage(d) && (RECEIPT_TYPE_RE.test(d.docType ?? '') || (facts.date !== null && daysApart(facts.date, businessDate(d).slice(0, 10)) <= WINDOW_DAYS)),
  );
}

function factsLine(facts: ReceiptFacts): string {
  return [
    facts.amount === null ? null : `Betrag ${formatEuro(facts.amount)}`,
    facts.date ? `Datum ${facts.date}` : null,
    facts.merchant ? `Händler: ${facts.merchant}` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

/** The case, topic and project of a partner document: what the photo would be filed under as well. */
function filing(scope: ToolScope, partner: DocumentRecord, photoRef: string): string {
  const { deps, ctx } = scope;
  const cases = deps.graph.neighbors(partner.id, { types: ['case'] });
  const parts = [
    partner.topicName ? `Thema „${partner.topicName}“` : null,
    partner.projectName ? `Projekt „${partner.projectName}“` : null,
    ...cases.map((c) => `Vorgang ${ctx.refs.entry(c.id)} „${truncate(c.name, 50)}“`),
  ].filter(Boolean);
  if (!parts.length) return '  Der Beleg selbst hat weder Thema, Projekt noch Vorgang.';
  const apply = [
    partner.topicName || partner.projectName
      ? `set_metadata targets=[${photoRef}]${partner.topicName ? ` topic="${partner.topicName}"` : ''}${partner.projectName ? ` project="${partner.projectName}"` : ''}`
      : null,
    ...cases.map((c) => `add_to_case case=${ctx.refs.entry(c.id)} entries=[${photoRef}]`),
  ].filter(Boolean);
  return `  Gleiche Zuordnung: ${parts.join(', ')}\n  Übernehmen nur auf Wunsch des Benutzers mit: ${apply.join(' bzw. ')}`;
}

/** Receipt photos (PNG/JPG with recognised text) and the invoice, case or project they most likely belong to. */
export async function receiptPhotosReport(scope: ToolScope, refs: readonly string[] | null | undefined): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const source = refs?.length ? resolveDocs(scope, refs) : { docs: archivedDocs(deps), unknown: [] as string[] };
  const photos = source.docs.filter((d) => isImage(d) && ARCHIVED.includes(d.status));
  const shareable = photos.filter((d) => deps.privacy.mayShareDocument(d));
  const readable = shareable.filter((d) => documentText(deps, d.id).trim());
  const partners = archivedDocs(deps).filter((d) => deps.privacy.mayShareDocument(d));
  const lines = readable.map((photo) => {
    const facts = receiptFacts(documentText(deps, photo.id));
    const matches = possiblePartners(partners, facts)
      .map((partner) => {
        const text = documentText(deps, partner.id);
        const candidate = {
          amount: invoiceTotal(text)?.amount ?? null,
          date: businessDate(partner).slice(0, 10),
          names: [partner.title, ...partner.persons],
          text,
        };
        return { partner, ...matchReceipt(facts, candidate) };
      })
      .filter((m) => m.score >= MIN_MATCH_SCORE)
      .toSorted((x, y) => y.score - x.score)
      .slice(0, MAX_SUGGESTIONS);
    const evidence = asData(`Belegfoto ${ctx.refs.doc(photo.id)}`, [facts.merchant, facts.amountLine].filter(Boolean).join('\n') || '(nichts erkannt)');
    const head = `- ${docLine(scope, photo)}\n  Erkannt: ${factsLine(facts) || 'weder Betrag, Datum noch Händler'}\n  Fundstellen: ${evidence}`;
    if (!matches.length) return `${head}\n  Kein passender Beleg oder Vorgang gefunden.`;
    const [best, ...others] = matches;
    return [
      head,
      `  Wahrscheinlichster Beleg: ${docLine(scope, best!.partner)} (${best!.reasons.join(', ')})`,
      filing(scope, best!.partner, ctx.refs.doc(photo.id)),
      ...others.map((m) => `  Weitere Möglichkeit: ${docLine(scope, m.partner)} (${m.reasons.join(', ')})`),
    ].join('\n');
  });
  const unreadable = shareable.length - readable.length;
  const content = [
    `${readable.length} Belegfoto(s) mit erkanntem Text geprüft${unreadable ? `, ${unreadable} ohne Text (Texterkennung fehlt – problem_files erklärt es)` : ''}.`,
    ...lines,
    'Das sind Vorschläge anhand von Betrag, Datum und Händler – zugeordnet wird erst auf Wunsch des Benutzers.',
  ].join('\n');
  return { content: content + skippedNote(photos.length - shareable.length) + unknownNote(source.unknown), summary: `${readable.length} Belegfoto(s) geprüft` };
}

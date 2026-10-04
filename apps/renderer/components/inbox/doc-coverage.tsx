import { EXTRACTION_LIMITS } from '@archivist/shared';
import type { DocRecord } from '@/lib/types';

type Proposal = NonNullable<DocRecord['proposal']>;

const count = (value: number) => value.toLocaleString('de-DE');

const COVERAGE_LIMIT_NOTE = `Das Dokument ist länger als die Grenze beim Einlesen (${count(EXTRACTION_LIMITS.textChars)} Zeichen, ${EXTRACTION_LIMITS.pdfPages} PDF-Seiten bzw. ${EXTRACTION_LIMITS.ocrPages} Seiten mit Texterkennung). Der Rest wurde nicht erfasst und lässt sich nicht durchsuchen.`;

/** True when the extraction stopped before the end of the document, so its text is incomplete. */
export const isIncompletelyRead = (proposal: Proposal | null | undefined): boolean =>
  Boolean(proposal?.coverage && (proposal.coverage.extractionTruncated || (proposal.coverage.ocrPagesSkipped ?? 0) > 0));

/** What the analysis did not see of a long document – in words, so a missing decision is not mistaken for none in the text (#190). */
export function coverageNotes(proposal: Proposal): string[] {
  const { coverage } = proposal;
  if (!coverage) return [];
  const notes: string[] = [];
  if (coverage.extractionTruncated) notes.push(COVERAGE_LIMIT_NOTE);
  const ocrPagesSkipped = coverage.ocrPagesSkipped ?? 0;
  if (ocrPagesSkipped > 0) {
    notes.push(
      `Bei ${ocrPagesSkipped === 1 ? '1 gescannten Seite' : `${count(ocrPagesSkipped)} gescannten Seiten`} ohne Textebene wurde die Texterkennung nicht ausgeführt (Grenze: ${EXTRACTION_LIMITS.ocrPages} Seiten pro Dokument). Ihr Text fehlt und lässt sich nicht durchsuchen.`,
    );
  }
  if (proposal.analyzedBy === 'llm' && coverage.llmChars < coverage.textChars) {
    notes.push(
      `Die KI hat nur die ersten ${count(coverage.llmChars)} von ${count(coverage.textChars)} Zeichen gelesen. Entscheidungen und offene Punkte weiter hinten wurden nicht erkannt. Mehr liest sie, wenn du unter Einstellungen → KI die maximale Eingabegröße erhöhst und das Dokument erneut verarbeitest.`,
    );
  } else if (proposal.analyzedBy === 'llm' && coverage.llmParts > 1) {
    notes.push(`Langes Dokument: Die KI hat es in ${coverage.llmParts} Teilen gelesen.`);
  }
  return notes;
}

export function DocCoverage({ proposal }: { proposal: Proposal }) {
  const notes = coverageNotes(proposal);
  if (notes.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 rounded-md border border-dashed p-2 text-xs" data-testid="document-coverage">
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

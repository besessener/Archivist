import type { DocumentRecord } from '@archivist/shared';
import { ARCHIVED, allDocs, docDay, resolveDocs, type ToolDeps, type ToolScope } from '../common';

export const skippedNote = (count: number) => (count ? `\n${count} nicht freigegebene Dokumente übersprungen.` : '');

export const documentText = (deps: ToolDeps, id: string) => deps.docs.findRow(id)?.extractedText ?? '';

export const archivedDocs = (deps: ToolDeps) => allDocs(deps).filter((d) => ARCHIVED.includes(d.status));

/** The business date as stored: the document's own date, else the archive or import day. */
export const businessDate = (d: DocumentRecord) => d.documentDate ?? docDay(d);

/** Shareable documents of the refs; the rest is counted. */
export function shareableDocs(scope: ToolScope, refs: readonly string[]): { docs: DocumentRecord[]; skipped: number; unknown: string[] } {
  const { docs: found, unknown } = resolveDocs(scope, refs);
  const shareable = found.filter((d) => scope.deps.privacy.mayShareDocument(d));
  return { docs: shareable, skipped: found.length - shareable.length, unknown };
}

import type { DocumentProposal } from '@archivist/shared';
import { and, eq, sql } from 'drizzle-orm';
import { documents, relations } from '../../db/schema';
import type { CheckRun } from './findings';

/** Proposed relations with low confidence that nobody decided yet: one aggregated hint. */
export function checkLowConfidenceRelations(run: CheckRun): void {
  const ids = run.deps.ctx.database.db
    .select({ id: relations.id })
    .from(relations)
    .where(and(eq(relations.status, 'proposed'), sql`${relations.confidence} < 0.5`))
    .all()
    .map((row) => row.id);
  if (ids.length === 0) return;
  run.findings.insightKeys.add('low-rel');
  run.deps.insights.upsert({
    kind: 'low_confidence_relation',
    title: `${ids.length} ungeklärte Beziehung(en) mit niedriger Confidence`,
    explanation: 'Diese vorgeschlagenen Beziehungen wurden noch nicht bestätigt oder abgelehnt. Prüfe sie im Bereich „Wissen“.',
    confidence: 0.5,
    sourceIds: ids,
    dedupeKey: 'low-rel',
  });
  run.findings.count('low_confidence_relation');
}

/** External, already analysed files whose proposed topic or project is known in the archive. */
export function checkExternalFiles(run: CheckRun): void {
  const { deps, findings } = run;
  const pending = deps.ctx.database.db
    .select({
      id: documents.id,
      title: documents.title,
      proposal: documents.proposal,
      sourcePath: documents.sourcePath,
      stagedPath: documents.stagedPath,
      confidence: documents.confidence,
    })
    .from(documents)
    .where(eq(documents.status, 'proposed'))
    .all();
  const known = (name: string) => deps.graph.findByName('topic', name) || deps.graph.findByName('project', name);
  for (const document of pending) {
    const proposal = document.proposal as DocumentProposal | null;
    const topic = proposal?.topic ?? proposal?.project;
    if (!topic || !document.sourcePath || document.stagedPath || !known(topic)) continue;
    findings.insightKeys.add(`external:${document.id}`);
    deps.insights.upsert({
      kind: 'external_file',
      title: `Datei außerhalb des Archivs passt zu „${topic}“`,
      explanation: `${document.title} (${document.sourcePath}) ist noch nicht archiviert.`,
      confidence: document.confidence ?? 0.5,
      affected: [{ type: 'document', id: document.id, label: document.title }],
      dedupeKey: `external:${document.id}`,
    });
    findings.count('external_file');
  }
}

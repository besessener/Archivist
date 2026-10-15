import type { DocumentProposal } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import { documents } from '../../db/schema';
import { shownProposalIds } from '../links/proposal-list';
import type { CheckRun } from './findings';

/** Proposals of the review list with low confidence that nobody decided yet: one aggregated hint; below the user's minimum none count. */
export function checkLowConfidenceRelations(run: CheckRun): void {
  const ids = shownProposalIds(run.deps.ctx.database.sqlite, { minConfidence: run.deps.settings.get().links.minConfidence, atMost: 0.5 });
  if (ids.length === 0) return;
  run.findings.insightKeys.add('low-rel');
  run.deps.insights.upsert({
    kind: 'low_confidence_relation',
    title: `${ids.length} ungeklärte Beziehung(en) mit geringer Sicherheit`,
    explanation: 'Diese vorgeschlagenen Verknüpfungen wurden noch nicht bestätigt oder abgelehnt. Prüfe sie unten unter „Verknüpfungsvorschläge“.',
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
  const known = (name: string) => deps.graph.findByNameOrAlias('topic', name) || deps.graph.findByNameOrAlias('project', name);
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

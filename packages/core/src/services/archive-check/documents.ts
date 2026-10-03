import type { InsightKind } from '@archivist/shared';
import { inArray } from 'drizzle-orm';
import { documents } from '../../db/schema';
import { NearDuplicateIndex } from '../near-duplicates';
import { idsHash, type CheckRun } from './findings';

/** The document columns the check reads – never extracted_text (#213). */
const CHECKED_COLUMNS = {
  id: documents.id,
  title: documents.title,
  status: documents.status,
  sha256: documents.sha256,
  textHash: documents.textHash,
  archiveRelPath: documents.archiveRelPath,
  sourcePath: documents.sourcePath,
  size: documents.size,
  categoryPath: documents.categoryPath,
  topicId: documents.topicId,
  projectId: documents.projectId,
};
export type CheckedDocument = Pick<typeof documents.$inferSelect, keyof typeof CHECKED_COLUMNS>;

/** Archived and index-only documents, metadata only: SELECT * loaded every extracted text into the main process (#213). */
export function checkedDocuments(run: CheckRun): CheckedDocument[] {
  return run.deps.ctx.database.db
    .select(CHECKED_COLUMNS)
    .from(documents)
    .where(inArray(documents.status, ['archived', 'indexed_only']))
    .all();
}

/** Documents with a further confirmed topic or project – that counts as an assignment as well (#287). */
function withFurtherSubject(run: CheckRun): Set<string> {
  const rows = run.deps.ctx.database.sqlite
    .prepare(
      `SELECT DISTINCT r.source_entity_id AS id FROM relations r JOIN entities s ON s.id = r.target_entity_id WHERE s.type IN ('topic','project') AND r.status = 'confirmed'`,
    )
    .all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** One aggregated hint listing up to 15 documents. */
function upsertListHint(run: CheckRun, hint: { kind: InsightKind; title: string; key: string; list: CheckedDocument[] }): void {
  run.findings.insightKeys.add(hint.key);
  run.deps.insights.upsert({
    kind: hint.kind,
    title: hint.title,
    explanation: hint.list
      .slice(0, 15)
      .map((document) => `• ${document.title}`)
      .join('\n'),
    confidence: 0.9,
    affected: hint.list.slice(0, 15).map((document) => ({ type: 'document' as const, id: document.id, label: document.title })),
    sourceIds: hint.list.map((document) => document.id),
    dedupeKey: hint.key,
  });
  run.findings.count(hint.kind);
}

/** Documents without topic or project and documents without category. */
export function checkAssignments(run: CheckRun, archived: CheckedDocument[]): void {
  const withSubject = withFurtherSubject(run);
  const noTopic = archived.filter((document) => !document.topicId && !document.projectId && !withSubject.has(document.id));
  if (noTopic.length > 0) {
    const title = `${noTopic.length} Dokument${noTopic.length === 1 ? '' : 'e'} ohne Thema- oder Projektzuordnung`;
    upsertListHint(run, { kind: 'orphan_document', title, key: 'missing-topic', list: noTopic });
  }
  const noCategory = archived.filter((document) => !document.categoryPath);
  if (noCategory.length > 0)
    upsertListHint(run, { kind: 'missing_metadata', title: `${noCategory.length} Dokument(e) ohne Kategorie`, key: 'missing-category', list: noCategory });
}

/** Dedupe-key prefix of the hints about documents with similar (not identical) content. */
export const SIMILAR_KEY_PREFIX = 'similar:';

function groupBy(archived: CheckedDocument[], keyOf: (document: CheckedDocument) => string | null): CheckedDocument[][] {
  const groups = new Map<string, CheckedDocument[]>();
  for (const document of archived) {
    const key = keyOf(document);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  return [...groups.values()];
}

/** Splits a group so that no two documents the user marked as different (rejected duplicate_of) stay together. */
function withoutDifferentPairs(group: CheckedDocument[], differ: (a: string, b: string) => boolean): CheckedDocument[][] {
  const clusters: CheckedDocument[][] = [];
  for (const document of group) {
    const cluster = clusters.find((members) => members.every((member) => !differ(member.id, document.id)));
    if (cluster) cluster.push(document);
    else clusters.push([document]);
  }
  return clusters;
}

/** Documents with identical content (same file hash or same text hash): a hint and a notification per group. */
export function checkDuplicates(run: CheckRun, archived: CheckedDocument[]): void {
  const { findings, deps } = run;
  const markedDifferent = (a: string, b: string) =>
    deps.graph.relationsOf(a, { statuses: ['rejected'], types: ['duplicate_of'] }).some((r) => r.sourceEntityId === b || r.targetEntityId === b);
  const groups = [...groupBy(archived, (document) => document.sha256), ...groupBy(archived, (document) => document.textHash || null)].flatMap((group) =>
    withoutDifferentPairs(group, markedDifferent),
  );
  for (const group of groups) {
    if (group.length < 2) continue;
    const ids = group.map((document) => document.id);
    const key = `dup:${idsHash(ids)}`;
    if (findings.insightKeys.has(key)) continue;
    findings.insightKeys.add(key);
    findings.notificationKeys.add(key);
    deps.insights.upsert({
      kind: 'duplicate',
      title: `Mögliche Duplikate: ${group.map((document) => document.title).join(' / ')}`,
      explanation: `${group.length} Dokumente haben identischen Inhalt. Es wird nichts gelöscht – bitte prüfe, ob eines davon entfallen kann.`,
      confidence: 0.95,
      affected: group.map((document) => ({ type: 'document' as const, id: document.id, label: document.title })),
      sourceIds: ids,
      dedupeKey: key,
    });
    deps.notifications.create({
      title: 'Mögliche Duplikate erkannt',
      description: group.map((document) => document.title).join(', '),
      type: 'duplicate',
      priority: 'low',
      affectedEntityIds: ids,
      proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
      dedupeKey: key,
    });
    findings.notifications += 1;
    findings.count('duplicate');
  }
}

/** Of documents with identical content (same file or same text) only the first stays: they are already reported as identical. */
function distinctContent(group: CheckedDocument[]): CheckedDocument[] {
  const seen = new Set<string>();
  return group.filter((document) => {
    const keys = [`sha:${document.sha256}`, ...(document.textHash ? [`text:${document.textHash}`] : [])];
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
}

/** Documents (inbox included) whose text is nearly, but not exactly, the same: one hint per group and one summary notification (#230). */
export function checkSimilarDocuments(run: CheckRun): void {
  const { findings, deps } = run;
  const groupIds = new NearDuplicateIndex(deps.ctx).groups();
  if (groupIds.length === 0) return;
  const byId = new Map(
    deps.ctx.database.db
      .select(CHECKED_COLUMNS)
      .from(documents)
      .where(inArray(documents.id, groupIds.flat()))
      .all()
      .map((document) => [document.id, document]),
  );
  const markedDifferent = (a: string, b: string) =>
    deps.graph.relationsOf(a, { statuses: ['rejected'], types: ['duplicate_of'] }).some((r) => r.sourceEntityId === b || r.targetEntityId === b);
  let reported = 0;
  for (const ids of groupIds) {
    const members = distinctContent(ids.flatMap((id) => byId.get(id) ?? []).sort((a, b) => a.title.localeCompare(b.title)));
    for (const group of withoutDifferentPairs(members, markedDifferent)) {
      if (group.length < 2) continue;
      const key = `${SIMILAR_KEY_PREFIX}${idsHash(group.map((document) => document.id))}`;
      findings.insightKeys.add(key);
      deps.insights.upsert({
        kind: 'duplicate',
        title: `Ähnlicher Inhalt: ${group.map((document) => document.title).join(' / ')}`,
        explanation: `${group.length} Dokumente haben ähnlichen, aber nicht identischen Inhalt – etwa Entwürfe, Fassungen oder Weiterleitungen desselben Textes. Es wird nichts gelöscht – bitte prüfe, ob sie zusammengehören oder eines davon entfallen kann.`,
        confidence: 0.8,
        affected: group.map((document) => ({ type: 'document' as const, id: document.id, label: document.title })),
        sourceIds: group.map((document) => document.id),
        dedupeKey: key,
      });
      findings.count('duplicate');
      reported += 1;
    }
  }
  if (reported === 0) return;
  const key = `${SIMILAR_KEY_PREFIX}summary`;
  findings.notificationKeys.add(key);
  deps.notifications.create({
    title: 'Dokumente mit ähnlichem Inhalt erkannt',
    description: reported === 1 ? 'Eine Gruppe von Dokumenten hat ähnlichen Inhalt.' : `${reported} Gruppen von Dokumenten haben ähnlichen Inhalt.`,
    type: 'duplicate',
    priority: 'low',
    proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
    dedupeKey: key,
  });
  findings.notifications += 1;
}

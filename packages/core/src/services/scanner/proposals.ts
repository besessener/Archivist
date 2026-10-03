import type { DocumentProposal, ScanProposalGroup } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { documents, scanFiles } from '../../db/schema';
import type { DocRow } from '../documents';
import type { KnowledgeGraphService } from '../knowledge-graph';

export interface ScanProposalDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
}

interface GroupKey {
  key: string;
  label: string;
  topic: string | null;
  project: string | null;
}

interface RowGroup extends Omit<GroupKey, 'key'> {
  rows: DocRow[];
}

const proposalOf = (row: DocRow) => row.proposal as DocumentProposal | null;

/** Group of a document: its proposed project, else topic, else the parent of its category path. */
function groupKey(proposal: DocumentProposal | null, category: string | null): GroupKey {
  const project = proposal?.project ?? null;
  const topic = proposal?.topic ?? null;
  const name = project ?? topic ?? category?.split('/').slice(0, -1).join('/') ?? category ?? 'Unsortiert';
  return { key: `${project ? 'project' : topic ? 'topic' : 'category'}:${name}`.toLowerCase(), label: name, topic, project };
}

function groupRows(rows: DocRow[]): Map<string, RowGroup> {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const { key, ...group } = groupKey(proposalOf(row), row.categoryPath);
    const current = groups.get(key) ?? { ...group, rows: [] };
    current.rows.push(row);
    groups.set(key, current);
  }
  return groups;
}

/** The confirmation-required proposal to archive a group's documents (copies) under its topic or project. */
function archiveProposal(group: RowGroup, label: string) {
  const count = group.rows.length;
  const items = group.rows.map((row) => ({
    documentId: row.id,
    mode: 'copy' as const,
    categoryPath: proposalOf(row)?.location.categoryPath ?? row.categoryPath ?? undefined,
    // null would mean "explicitly without topic/project"; a group without one only leaves it open.
    topic: group.topic ?? undefined,
    project: group.project ?? undefined,
  }));
  return {
    actionType: 'archive_documents' as const,
    label: `${count} Dokument(e) archivieren und zuordnen (${group.label})`,
    rationale: `${count} analysierte Datei(en) gehören vermutlich zu ${label}.`,
    confidence: Math.min(...group.rows.map((row) => row.confidence ?? 0.4)),
    affectedEntities: group.rows.map((row) => ({ type: 'document' as const, id: row.id, label: row.title })),
    requiredConfirmation: 'confirm' as const,
    proposedParameters: { items, approveNewCategories: [] },
  };
}

/** Assignment proposals of a scan: per topic/project group an insight with an archive action and a notification. */
export class ScanProposals {
  // the scanner stores the planned insights itself: importing the insight service here would close an import cycle
  constructor(private readonly deps: ScanProposalDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** One plan per group, computed lazily so each group sees what the previous one stored. */
  *plans(docIds: string[]) {
    const rows = docIds.length
      ? this.db
          .select()
          .from(documents)
          .where(and(inArray(documents.id, docIds), eq(documents.status, 'proposed')))
          .all()
      : [];
    for (const [key, group] of groupRows(rows)) yield this.planGroup(key, group);
  }

  private planGroup(key: string, group: RowGroup) {
    const { graph } = this.deps;
    const known = (group.project && graph.findByName('project', group.project)) || (group.topic && graph.findByName('topic', group.topic)) || null;
    const decisions = group.rows.filter((row) => (proposalOf(row)?.possibleDecisions.length ?? 0) > 0).length;
    const duplicates = group.rows.filter((row) => proposalOf(row)?.duplicateOfDocumentId).length;
    const label = known ? `${known.type === 'project' ? 'Projekt' : 'Thema'} „${known.name}“` : `„${group.label}“`;
    const count = group.rows.length;
    const proposal = archiveProposal(group, label);
    const ids = group.rows.map((row) => row.id).sort();
    const dedupeKey = `scan-group:${key}:${ids.join(',').slice(0, 120)}`;
    const documentLines = group.rows.map((row) => `• ${row.title} → ${proposalOf(row)?.location.categoryPath ?? row.categoryPath}`).join('\n');
    const insight = {
      kind: known ? ('assignment' as const) : ('archive_proposal' as const),
      title: `${count} Dokument${count === 1 ? '' : 'e'} ${known ? 'gehören vermutlich zu' : 'passen zu'} ${label}`,
      explanation: `${documentLines}${decisions ? `\n${decisions} enthalten mögliche Entscheidungen.` : ''}${duplicates ? `\n${duplicates} scheinen Duplikate zu sein.` : ''}`,
      confidence: proposal.confidence,
      affected: proposal.affectedEntities,
      sourceIds: ids,
      // proposed only if the insight is (still) open: no orphaned proposals when the group is analyzed again
      action: { proposal, label: 'Alle kopieren und archivieren' },
      dedupeKey,
    };
    const notification = {
      title: `${count} Dokument${count === 1 ? '' : 'e'} ${known ? `zu ${label}` : 'bereit zur Archivierung'}`,
      description: `${count} davon gehören vermutlich zu ${label}${decisions ? `, ${decisions} enthalten mögliche Entscheidungen` : ''}${duplicates ? `, ${duplicates} scheinen Duplikate zu sein` : ''}.`,
      type: 'assignment_proposal' as const,
      priority: known ? ('high' as const) : ('normal' as const),
      affectedEntityIds: ids,
      proposedActions: [
        { label: 'Prüfen', kind: 'navigate' as const, target: '/scan/' },
        { label: 'Ablehnen', kind: 'ignore' as const },
      ],
      dedupeKey,
    };
    return { insight, notification };
  }

  /** Proposal groups for the scan view (analyzed scan documents that are not archived yet). */
  groups(): ScanProposalGroup[] {
    const files = this.db.select().from(scanFiles).where(eq(scanFiles.status, 'analyzed')).all();
    const ids = files.map((file) => file.documentId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    const rows = this.db
      .select()
      .from(documents)
      .where(and(inArray(documents.id, ids), eq(documents.status, 'proposed')))
      .all();
    const groups = new Map<string, ScanProposalGroup>();
    for (const row of rows) {
      const group = groupKey(proposalOf(row), row.categoryPath);
      const current = groups.get(group.key) ?? { ...group, documentIds: [], confidence: 1 };
      current.documentIds.push(row.id);
      current.confidence = Math.min(current.confidence, row.confidence ?? 0.4);
      groups.set(group.key, current);
    }
    return [...groups.values()].sort((a, b) => b.documentIds.length - a.documentIds.length);
  }
}

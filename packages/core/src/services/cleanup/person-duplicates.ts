import type { EntityRef } from '@archivist/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { auditLog, entities, relations } from '../../db/schema';
import { isNotAPersonName, parsePersonName } from '../../util/person-names';
import type { InsightService } from '../insights';
import type { KnowledgeGraphService, MergeRequest } from '../knowledge-graph';
import type { SettingsService } from '../settings';

/** Audit action of an automatic merge; its undone entries mark groups that are never merged automatically again. */
export const PERSON_AUTO_MERGE_ACTION = 'persons.auto_merge';
/** Insight dedupe key prefix; one insight per run, keyed by the audit entry of its merges. */
export const PERSONS_MERGED_KEY_PREFIX = 'persons-merged:';

type EntityRow = typeof entities.$inferSelect;

interface Candidate {
  row: EntityRow;
  cleanName: string;
  roles: string[];
  references: number;
}

export interface PersonMergeGroup {
  targetId: string;
  targetName: string;
  sourceIds: string[];
  /** Names of all entries of the group as they were before the merge. */
  names: string[];
  roles: string[];
}

/**
 * How "clean" a spelling is: capitalized words, a hyphen kept in double names and real umlauts beat lower case,
 * "Lor Zade" and "ue"; the name itself without roles or titles beats a decorated one.
 */
function spellingScore(c: Candidate): number {
  const words = c.cleanName.split(' ');
  let score = 0;
  if (words.every((w) => /^\p{Lu}/u.test(w))) score += 4;
  if (c.cleanName.includes('-')) score += 2;
  if (/[äöüÄÖÜß]/.test(c.cleanName)) score += 1;
  if (c.row.name === c.cleanName) score += 1;
  return score;
}

/**
 * Archive check step: merges unambiguous person duplicates without asking. Unambiguous means the names are equal once
 * roles, titles, case, hyphen vs. space, umlaut spellings and the order "Nachname, Vorname" are ignored (the comparison
 * key of {@link parsePersonName}). All merges of a run form one undoable audit entry and one insight with „Rückgängig“.
 * A group whose merge was undone is never merged automatically again.
 */
export class PersonDuplicateService {
  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly graph: KnowledgeGraphService,
    private readonly insights: InsightService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Groups of unambiguous duplicates (at least two entries each), with the entry to keep and its clean name. */
  findGroups(): PersonMergeGroup[] {
    const rows = this.db.select().from(entities).where(eq(entities.type, 'person')).all();
    if (rows.length < 2) return [];
    const refCounts = this.referenceCounts();
    const byKey = new Map<string, Candidate[]>();
    for (const row of rows) {
      if (isNotAPersonName(row.name)) continue;
      const parsed = parsePersonName(row.name);
      if (!parsed.comparisonKey) continue;
      const list = byKey.get(parsed.comparisonKey) ?? [];
      list.push({ row, cleanName: parsed.cleanName, roles: parsed.roles, references: refCounts.get(row.id) ?? 0 });
      byKey.set(parsed.comparisonKey, list);
    }
    const blocked = this.undoneGroups();
    const groups: PersonMergeGroup[] = [];
    for (const members of byKey.values()) {
      if (members.length < 2) continue;
      const ids = members.map((m) => m.row.id);
      if (blocked.some((set) => ids.filter((id) => set.has(id)).length >= 2)) continue;
      // the cleanest spelling becomes the name; the entry already carrying it (or the most referenced one) is kept
      const best = [...members].sort((a, b) => spellingScore(b) - spellingScore(a) || b.cleanName.length - a.cleanName.length)[0]!;
      const target =
        members.find((m) => m.row.name === best.cleanName) ??
        [...members].sort((a, b) => b.references - a.references || a.row.createdAt.localeCompare(b.row.createdAt))[0]!;
      groups.push({
        targetId: target.row.id,
        targetName: best.cleanName,
        sourceIds: ids.filter((id) => id !== target.row.id),
        names: members.map((m) => m.row.name),
        roles: [...new Set(members.flatMap((m) => m.roles))],
      });
    }
    return groups;
  }

  /** Runs as part of the archive check: merges all groups at once and reports them in one insight. */
  async check(count: (kind: string, n?: number) => void): Promise<void> {
    if (!this.settings.get().consistency.autoMergePersons) return;
    const groups = this.findGroups();
    if (groups.length === 0) return;
    const requests: MergeRequest[] = groups.map((g) => ({ targetId: g.targetId, sourceIds: g.sourceIds, targetName: g.targetName, addRoles: g.roles }));
    const { auditId, results } = await this.graph.mergeMany(requests, { actor: 'agent', trigger: 'consistency', action: PERSON_AUTO_MERGE_ACTION });
    const merged = groups.reduce((n, g) => n + g.sourceIds.length + 1, 0);
    const first = results[0]!;
    const title =
      results.length === 1
        ? `${merged} Einträge zu „${first.targetName}“ zusammengeführt`
        : `${merged} Personen-Einträge zu ${results.length} Personen zusammengeführt`;
    const explanation = [
      'Diese Einträge meinen eindeutig dieselbe Person (gleicher Name ohne Rolle, Titel, Groß-/Kleinschreibung, Bindestrich und Reihenfolge) und wurden automatisch zusammengeführt:',
      ...groups.map((g) => {
        const roles = g.roles.length ? ` – Rollen: ${g.roles.join(', ')}` : '';
        return `• „${g.targetName}“ ← ${g.names.map((n) => `„${n}“`).join(', ')}${roles}`;
      }),
      'Die alten Schreibweisen bleiben als Aliasse erhalten. „Rückgängig“ stellt alle Einträge wieder her; diese Gruppen werden danach nicht mehr automatisch zusammengeführt.',
    ].join('\n');
    const affected: EntityRef[] = results.map((r) => ({ type: 'person', id: r.targetId, label: r.targetName }));
    this.insights.upsert({
      kind: 'persons_merged',
      title,
      explanation,
      confidence: 1,
      affected,
      sourceIds: results.map((r) => r.targetId),
      action: {
        proposal: {
          actionType: 'undo_change',
          label: 'Zusammenführung rückgängig machen',
          rationale: 'Automatische Zusammenführung von Personen-Dubletten zurücknehmen.',
          confidence: 1,
          affectedEntities: affected,
          requiredConfirmation: 'confirm',
          proposedParameters: { auditId },
        },
        label: 'Rückgängig',
      },
      dedupeKey: `${PERSONS_MERGED_KEY_PREFIX}${auditId}`,
    });
    count('persons_merged', merged);
  }

  /** Relations per person; the most referenced entry is kept when none carries the clean name yet. */
  private referenceCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.db.select({ source: relations.sourceEntityId, target: relations.targetEntityId }).from(relations).all())
      for (const id of [r.source, r.target]) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }

  /** Entity ids of every automatic merge group the user undid. */
  private undoneGroups(): Array<Set<string>> {
    const rows = this.db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, PERSON_AUTO_MERGE_ACTION), isNotNull(auditLog.undoneAt)))
      .all();
    const sets: Array<Set<string>> = [];
    for (const r of rows) {
      const results = Array.isArray(r.after) ? (r.after as Array<{ targetId?: unknown; mergedIds?: unknown }>) : [];
      for (const res of results) {
        const merged: unknown[] = Array.isArray(res.mergedIds) ? res.mergedIds : [];
        const ids = [res.targetId, ...merged].filter((x): x is string => typeof x === 'string');
        sets.push(new Set(ids));
      }
    }
    return sets;
  }
}

import type { Contradiction, Decision } from '@archivist/shared';
import { ContradictionProposal } from '@archivist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { contradictions } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeName, truncate } from '../util/text';
import type { ActionService } from './actions';
import type { DecisionService } from './decisions';
import { ACTIVE_DECISION_STATUSES } from './decisions';
import type { InsightService } from './insights';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { LlmService } from './llm';
import type { NotificationService } from './notifications';

type Row = typeof contradictions.$inferSelect;

const STOP = [
  /nicht\s+(?:mehr\s+)?(?:weiter(?:machen|führen|verfolgen|entwickeln)|fortsetzen|fortführen|einführen|starten|umsetzen)/i,
  /\b(?:pausier\w*|ein(?:ge)?stell\w*|stopp\w*|beend\w*|abbrech\w*|abgebrochen|aussetz\w*|zurückstell\w*|verwerf\w*|absag\w*|aufgeben|aufgegeben)\b/i,
  /vorerst\s+nicht|erstmal\s+nicht|auf\s+eis/i,
  /\bkein(?:e|en)?\s+(?:weiter\w*|fortsetzung)/i,
  /\bstell\w*\b[^.]{0,40}\bein\b/i,
  /\bbrech\w*\b[^.]{0,40}\bab\b/i,
  /\bsetz\w*\b[^.]{0,40}\baus\b/i,
  /\bgeb\w*\b[^.]{0,40}\bauf\b/i,
];
const GO = [
  /\b(?:führ\w*|fuehr\w*|mach\w*|verfolg\w*|entwickl\w*)\b[^.]{0,40}\bweiter\b/i,
  /\b(?:setz\w*)\b[^.]{0,40}\b(?:um|fort)\b/i,
  /\bnehm\w*\b[^.]{0,40}\bwieder\s+auf\b/i,
  /\b(?:weiterführen|weiterfuehren|fortsetzen|fortführen|fortfuehren|weitermachen|weiterverfolgen|weiterentwickeln|wiederaufnehmen|aufnehmen)\b/i,
  /\b(?:starten|einführen|einfuehren|beauftragen|freigeben|freigegeben|genehmigt|umsetzen|umgesetzt|fortgeführt|weitergeführt|fortgesetzt|reaktivier\w*)\b/i,
];

export type Polarity = 'go' | 'stop' | null;

/** Grobe lexikalische Polarität einer Entscheidung/Aussage (Fortführen vs. Stoppen). */
export function polarity(text: string): Polarity {
  if (STOP.some((p) => p.test(text))) return 'stop';
  if (GO.some((p) => p.test(text))) return 'go';
  return null;
}

/** Auswahlentscheidung „… für X“ / „… auf X“ → X */
export function chosenOption(text: string): string | null {
  const m =
    /(?:entscheiden\s+uns|entschieden|wählen|wählten|setzen|nutzen|verwenden|bleiben)[^.]*?\b(?:für|auf|bei|mit)\s+(?:das\s+|die\s+|den\s+|dem\s+)?([\p{L}0-9][\p{L}0-9._+-]*(?:\s+[A-Z0-9][\p{L}0-9._+-]*)?)/iu.exec(
      text,
    );
  return m?.[1]?.trim() ?? null;
}

const map = (r: Row): Contradiction => ({
  id: r.id,
  title: r.title,
  description: r.description,
  affectedEntityIds: r.affectedEntityIds,
  excerpts: r.excerpts as Contradiction['excerpts'],
  sourceIds: r.sourceIds,
  timestamps: r.timestamps,
  confidence: r.confidence,
  status: r.status as Contradiction['status'],
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

/**
 * Widersprüche sind zunächst nur Hinweise. Entscheidungen werden nie autonom widerrufen oder ersetzt –
 * die empfohlene Auflösung ist eine Aktion, die der Benutzer bestätigen muss.
 */
export class ContradictionService {
  private actions!: ActionService;

  constructor(
    private readonly ctx: AppContext,
    private readonly decisions: DecisionService,
    private readonly graph: KnowledgeGraphService,
    private readonly insights: InsightService,
    private readonly notifications: NotificationService,
    private readonly llm: LlmService,
  ) {}

  wire(deps: { actions: ActionService }): void {
    this.actions = deps.actions;
  }

  private get db() {
    return this.ctx.database.db;
  }

  list(status?: Contradiction['status']): Contradiction[] {
    return this.db
      .select()
      .from(contradictions)
      .where(status ? eq(contradictions.status, status) : undefined)
      .orderBy(desc(contradictions.createdAt))
      .all()
      .map(map);
  }

  get(id: string): Contradiction {
    const r = this.db.select().from(contradictions).where(eq(contradictions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Widerspruch nicht gefunden.');
    return map(r);
  }

  /** Lexikalische Prüfung zweier Entscheidungen. */
  private compareLexically(a: Decision, b: Decision): { conflict: boolean; reason: string; confidence: number } | null {
    const pa = polarity(a.decisionText);
    const pb = polarity(b.decisionText);
    if (pa && pb && pa !== pb) {
      return {
        conflict: true,
        reason:
          pa === 'go'
            ? 'Eine Entscheidung führt das Thema weiter, die andere stoppt oder pausiert es.'
            : 'Eine Entscheidung stoppt oder pausiert das Thema, die andere führt es weiter.',
        confidence: 0.75,
      };
    }
    const oa = chosenOption(a.decisionText);
    const ob = chosenOption(b.decisionText);
    if (
      oa &&
      ob &&
      normalizeName(oa) !== normalizeName(ob) &&
      !normalizeName(oa).includes(normalizeName(ob)) &&
      !normalizeName(ob).includes(normalizeName(oa))
    ) {
      return { conflict: true, reason: `Unterschiedliche Auswahl: „${oa}“ vs. „${ob}“.`, confidence: 0.55 };
    }
    return pa || pb || (oa && ob) ? { conflict: false, reason: '', confidence: 0 } : null;
  }

  private async confirmWithLlm(a: Decision, b: Decision): Promise<{ isContradiction: boolean; confidence: number; description: string } | null> {
    if (!this.llm.canUse()) return null;
    try {
      const res = await this.llm.completeJson(ContradictionProposal, {
        schemaName: 'ContradictionProposal',
        purpose: 'Widerspruchsprüfung',
        instructions:
          'Du prüfst, ob zwei Entscheidungen zum selben Thema einander widersprechen. Sei zurückhaltend: Ergänzungen oder Präzisierungen sind keine Widersprüche.',
        input: `Entscheidung A (${a.decidedAt ?? 'ohne Datum'}, id=${a.id}): ${truncate(a.decisionText, 800)}\n\nEntscheidung B (${b.decidedAt ?? 'ohne Datum'}, id=${b.id}): ${truncate(b.decisionText, 800)}`,
      });
      return { isContradiction: res.isContradiction, confidence: res.confidence, description: res.description };
    } catch (err) {
      this.ctx.logger.warn('contradictions', 'LLM-Prüfung nicht möglich, lexikalisches Ergebnis wird verwendet', { error: err });
      return null;
    }
  }

  /** Prüft eine (neue) Entscheidung gegen aktive Entscheidungen zum gleichen Thema/Projekt. */
  async checkDecision(decisionId: string): Promise<Contradiction[]> {
    const d = this.decisions.get(decisionId);
    if (!ACTIVE_DECISION_STATUSES.includes(d.status)) return [];
    const others = this.decisions.activeFor(d.topicId, d.projectId, d.id);
    const created: Contradiction[] = [];
    for (const o of others) {
      const lex = this.compareLexically(d, o);
      if (!lex) continue;
      let conflict = lex.conflict;
      let confidence = lex.confidence;
      let reason = lex.reason;
      const llm = await this.confirmWithLlm(d, o);
      if (llm) {
        conflict = llm.isContradiction;
        confidence = llm.isContradiction ? Math.max(confidence, llm.confidence) : 0;
        reason = llm.description || reason;
      }
      if (!conflict) continue;
      created.push(await this.record(d, o, reason, confidence));
    }
    return created;
  }

  /** Prüft alle aktiven Entscheidungen paarweise je Thema (Archivprüfung). */
  async scanAll(): Promise<Contradiction[]> {
    const active = this.decisions.list().filter((d) => ACTIVE_DECISION_STATUSES.includes(d.status));
    const created: Contradiction[] = [];
    const seen = new Set<string>();
    for (const d of active) {
      for (const o of this.decisions.activeFor(d.topicId, d.projectId, d.id)) {
        const key = [d.id, o.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const lex = this.compareLexically(d, o);
        if (lex?.conflict) created.push(await this.record(d, o, lex.reason, lex.confidence));
      }
    }
    return created;
  }

  private async record(a: Decision, b: Decision, reason: string, confidence: number): Promise<Contradiction> {
    const [older, newer] = [a, b].sort((x, y) => (x.decidedAt ?? x.createdAt).localeCompare(y.decidedAt ?? y.createdAt)) as [Decision, Decision];
    const dedupeKey = `decision:${[a.id, b.id].sort().join('|')}`;
    const existing = this.db.select().from(contradictions).where(eq(contradictions.dedupeKey, dedupeKey)).get();
    if (existing) return map(existing);
    const topic = a.topicName ?? b.topicName ?? a.projectName ?? 'diesem Thema';
    const now = nowIso();
    const row: Row = {
      id: newId(),
      title: `Mögliche widersprüchliche Entscheidungen zu „${topic}“`,
      description: `${reason}\n\n1. ${older.decidedAt?.slice(0, 10) ?? 'ohne Datum'}: ${truncate(older.decisionText, 240)}\n2. ${newer.decidedAt?.slice(0, 10) ?? 'ohne Datum'}: ${truncate(newer.decisionText, 240)}`,
      affectedEntityIds: [older.id, newer.id],
      excerpts: [
        { entityId: older.id, text: truncate(older.decisionText, 300) },
        { entityId: newer.id, text: truncate(newer.decisionText, 300) },
      ] as ArchivistJson,
      sourceIds: [...new Set([...older.sourceIds, ...newer.sourceIds, older.id, newer.id])],
      timestamps: [older.decidedAt ?? older.createdAt, newer.decidedAt ?? newer.createdAt],
      confidence,
      status: 'detected',
      dedupeKey,
      createdAt: now,
      resolvedAt: null,
    };
    this.db.insert(contradictions).values(row).run();
    this.graph.link(newer.id, older.id, 'contradicts', { confidence, status: 'proposed' });

    // Vorschlag: neuere Entscheidung ersetzt die ältere – erfordert Bestätigung
    const action = this.actions.propose({
      actionType: 'supersede_decision',
      rationale: `Die neuere Entscheidung (${newer.decidedAt?.slice(0, 10) ?? 'ohne Datum'}) könnte die ältere (${older.decidedAt?.slice(0, 10) ?? 'ohne Datum'}) überholt haben.`,
      confidence,
      affectedEntities: [
        { type: 'decision', id: older.id, label: older.title },
        { type: 'decision', id: newer.id, label: newer.title },
      ],
      requiredConfirmation: 'confirm',
      proposedParameters: { oldDecisionId: older.id, newDecisionId: newer.id },
      label: 'Neuere Entscheidung ersetzt die ältere (ältere als überholt markieren)',
    });
    this.insights.upsert({
      kind: 'contradiction',
      title: row.title,
      explanation: row.description,
      confidence,
      affected: [
        { type: 'decision', id: older.id, label: older.title },
        { type: 'decision', id: newer.id, label: newer.title },
      ],
      sourceIds: row.sourceIds,
      recommendedActionId: action.id,
      recommendedActionLabel: 'Neuere Entscheidung ersetzt die ältere',
      dedupeKey: `contradiction:${row.id}`,
    });
    this.notifications.create({
      title: 'Möglicher Widerspruch erkannt',
      description: row.title,
      type: 'contradiction',
      priority: 'high',
      affectedEntityIds: [older.id, newer.id],
      proposedActions: [
        { label: 'Insights öffnen', kind: 'navigate', target: '/insights/' },
        { label: 'Ersetzen bestätigen', kind: 'confirm_action', target: action.id },
      ],
      dedupeKey: `contradiction:${row.id}`,
    });
    this.ctx.events.changed('contradictions', 'insights', 'knowledge');
    return map(row);
  }

  resolve(
    id: string,
    resolution: 'acknowledged' | 'resolved' | 'false_positive',
    opts: { confirmed: boolean; supersedeOldDecisionId?: string; supersedeNewDecisionId?: string },
  ): Contradiction {
    if (!opts.confirmed) throw new AppError('permission_error', 'Widersprüche dürfen nur nach ausdrücklicher Bestätigung aufgelöst werden.');
    const c = this.get(id);
    if (opts.supersedeOldDecisionId && opts.supersedeNewDecisionId) {
      this.decisions.supersede(opts.supersedeOldDecisionId, opts.supersedeNewDecisionId, { confirmed: true, trigger: 'contradiction' });
    }
    const resolvedAt = resolution === 'acknowledged' ? null : nowIso();
    this.db.update(contradictions).set({ status: resolution, resolvedAt }).where(eq(contradictions.id, id)).run();
    if (resolution !== 'acknowledged') {
      this.notifications.resolveByDedupePrefix(`contradiction:${id}`);
    }
    this.ctx.events.changed('contradictions', 'insights');
    return { ...c, status: resolution, resolvedAt };
  }
}

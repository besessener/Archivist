import {
  DECISION_FIELD_LABELS,
  type ChatContext,
  type Decision,
  type DecisionField,
  type OpenItem,
  type SourceReference,
  type StoredAgentAction,
} from '@archivist/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { ChatIntent } from '@archivist/shared';
import type { AppContext } from '../context';
import { messages } from '../db/schema';
import { AppError } from '../util/errors';
import { normalizeDateInput, normalizeDecisionDate, parseDecisionDate, parseGermanDate } from '../util/dates';
import { nameSimilarity, normalizeName, truncate } from '../util/text';
import { isSelfReference } from '../util/person-names';
import type { ActionService } from './actions';
import type { ContradictionService } from './contradictions';
import type { DecisionService } from './decisions';
import { questionFor } from './decisions';
import type { InsightService } from './insights';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { PersonService } from './persons';
import type { NoteService } from './notes';
import type { EventService } from './events';
import { findOpenItemDuplicate } from './cleanup/open-item-duplicates';
import { ACTIVE_STATUSES, hintTokens, matchOpenItems, type OpenItemService } from './open-items';
import type { ReminderService } from './reminders';
import type { SettingsService } from './settings';
import {
  appendDescription,
  conversationState,
  decisionRef,
  decisionSource,
  deriveOpenItem,
  mergeReplies,
  OPEN_ITEM_PREFIX_RE,
  openItemAsks,
  openItemPending,
  shortAnswer,
  TOPIC_KIND_QUICK_REPLIES,
  UNKNOWN_RE,
  unknownFieldsIn,
  words,
  type ConvState,
  type OpenItemAsk,
  type OpenItemField,
  type OpenItemPending,
  type Pending,
  type Reply,
} from './chat-state';

const CAPTURE_INTENTS = new Set<ChatIntent['intent']>([
  'decision_new',
  'decision_amend',
  'decision_supersede',
  'event_record',
  'note_capture',
  'open_item_new',
  'open_item_update',
  'open_item_close',
  'reminder_create',
  'reminder_snooze',
]);

/** Outcome of a capture request for the agent tools (#307): the reply, proposal cards and the handler's follow-up question. */
export interface CaptureResult {
  content: string;
  /** Proposal cards the handler created (e.g. „ältere Entscheidung als überholt markieren?“). */
  actionIds: string[];
  /** The handler would have asked this (required field, duplicate …). */
  question: string | null;
  decisionId: string | null;
  openItemId: string | null;
  /** Older decisions the new one may replace when the hint was not unique („Welche Entscheidung wird ersetzt?“). */
  supersedeCandidateIds: string[];
}

/**
 * Capturing knowledge (#307): decisions with required fields, follow-up questions, superseding and the contradiction check;
 * notes; events; open items with duplicate check and person resolution; reminders. One module, two callers: the agent's
 * capture tools (`forAgent`, follow-up questions go through the agent's question exit) and the rule-based chat (fallback
 * without LLM, in mode „nur lokal“ or without tool calling), which keeps its `Pending` follow-up questions in the
 * conversation state.
 */
export class CaptureService {
  private actions!: ActionService;

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly decisions: DecisionService,
    private readonly openItems: OpenItemService,
    private readonly reminders: ReminderService,
    private readonly graph: KnowledgeGraphService,
    private readonly persons: PersonService,
    private readonly contradictions: ContradictionService,
    private readonly insights: InsightService,
    private readonly notes: NoteService,
    private readonly events: EventService,
  ) {}

  wire(deps: { actions: ActionService }): void {
    this.actions = deps.actions;
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** One capture request of the agent: the handler of the intent, with the conversation's last items as context. */
  async forAgent(conversationId: string | null, text: string, intent: ChatIntent, opts: { force?: boolean } = {}): Promise<CaptureResult> {
    const conv = conversationId ?? '';
    const state: ConvState = { last: conversationId ? conversationState(this.db, conversationId).last : undefined };
    const reply = await this.handle(conv, text, intent, state, { viaLlm: true, force: opts.force });
    const pending = reply.state?.pending ?? null;
    return {
      content: reply.content,
      actionIds: (reply.actions ?? []).map((a) => a.id),
      question: pending && !(pending.kind === 'open_item' && pending.optional) ? reply.content : null,
      decisionId: reply.state?.last?.decisionId ?? null,
      openItemId: pending?.kind === 'open_item_duplicate' ? null : (reply.state?.last?.openItemId ?? null),
      supersedeCandidateIds: pending?.kind === 'supersede_choice' ? pending.candidateIds : [],
    };
  }

  /** The agent's answer to „Welche Entscheidung wird ersetzt?“: the same proposal card as the chat's (confirmation required). */
  proposeSupersedeOf(conversationId: string | null, olderId: string, newerId: string): StoredAgentAction {
    const older = this.decisions.get(olderId);
    if (!['active', 'confirmed'].includes(older.status))
      throw new AppError('validation_error', `„${older.title}“ ist nicht mehr aktiv und kann nicht ersetzt werden.`);
    return this.proposeSupersede(conversationId ?? '', older, this.decisions.get(newerId));
  }

  /** Is this a capture request? (the chat's dispatch hands those over to `handle`) */
  static handles(intent: ChatIntent['intent']): boolean {
    return CAPTURE_INTENTS.has(intent);
  }

  /** Runs a capture request; `state.pending` is set only when the request answers the open follow-up question. */
  handle(conv: string, text: string, intent: ChatIntent, state: ConvState, opts: { viaLlm: boolean; force?: boolean }): Promise<Reply> {
    switch (intent.intent) {
      case 'decision_new':
      case 'decision_amend':
      case 'decision_supersede':
        return this.decisionFlow(conv, text, intent, state, opts.viaLlm);
      case 'event_record':
        return this.eventRecord(text, intent, state);
      case 'note_capture':
        return this.noteCapture(text, intent, state);
      case 'open_item_new':
        return this.openItemNew(conv, text, intent, state, opts.force ?? false);
      case 'open_item_update':
        return this.openItemUpdate(conv, text, intent, state);
      case 'open_item_close':
        return this.openItemClose(conv, text, intent, state);
      case 'reminder_create':
      case 'reminder_snooze':
        return this.reminderFlow(text, intent, state);
      default:
        throw new AppError('validation_error', `Kein Erfassungs-Anliegen: ${intent.intent}`);
    }
  }

  private decisionContext(d: Decision): Partial<ChatContext> {
    return {
      decisions: [decisionRef(d)],
      topics: d.topicId ? [{ type: 'topic', id: d.topicId, label: d.topicName ?? '' }] : [],
      projects: d.projectId ? [{ type: 'project', id: d.projectId, label: d.projectName ?? '' }] : [],
      persons: d.participants.map((p) => {
        const e = this.persons.resolve(p, { context: 'chat', create: false }).entity;
        return { type: 'person' as const, id: e?.id ?? p, label: p };
      }),
    };
  }

  // ---------- Decisions ----------
  private async decisionFlow(conv: string, text: string, intent: ChatIntent, state: ConvState, viaLlm: boolean): Promise<Reply> {
    const ex = intent.decision ?? { participants: [], alternatives: [], unknownFields: [], confidence: 0.5 };
    const pending = state.pending?.kind === 'decision' ? state.pending : null;
    // an addition always changes an existing decision – also without a running follow-up question (#177)
    const isNew = intent.intent !== 'decision_amend';

    // determine the target decision of an addition without a running follow-up question
    let target: Decision | null = null;
    if (pending) target = this.decisions.get(pending.decisionId);
    else if (intent.intent === 'decision_amend') {
      const id = state.last?.decisionId;
      const topic = ex.topic ?? intent.topic;
      target = id
        ? this.decisions.get(id)
        : topic
          ? (this.decisions.list().find((d) => normalizeName(d.topicName ?? '') === normalizeName(topic)) ?? null)
          : null;
      if (!target)
        return {
          intent: intent.intent,
          content: 'Zu welcher Entscheidung möchtest du etwas ergänzen? Nenne bitte das Thema oder formuliere die Entscheidung neu.',
          confidence: 0.4,
          state,
        };
    }

    // answers to follow-up questions: recognize „unbekannt“ details (in addition to the LLM's evaluation)
    const asked = pending?.asked ?? [];
    const unknownFields = new Set<DecisionField>(ex.unknownFields ?? []);
    if (pending && UNKNOWN_RE.test(text) && unknownFields.size === 0 && asked.length === 1) unknownFields.add(asked[0]!);

    // topic vs. project
    const topic = ex.topic?.trim() || null;
    let project = ex.project?.trim() || null;
    if (ex.topicIsProject === true && topic) project = project ?? topic;
    let clarify = isNew && topic && !project && intent.intent === 'decision_new' && ex.topicIsProject === null ? topic : null;
    // do not ask for names that are already known, use the existing entry instead
    if (clarify && this.graph.findByName('project', clarify)) {
      project = clarify;
      clarify = null;
    } else if (clarify && this.graph.findByName('topic', clarify)) clarify = null;

    if (isNew) {
      const created = this.decisions.create(
        {
          title: ex.title?.trim() || undefined,
          decisionText: ex.decisionText?.trim() || text,
          decidedAt: normalizeDecisionDate(ex.decidedAt ?? null) ?? undefined,
          topic,
          project,
          participants: ex.participants ?? [],
          rationale: ex.rationale,
          consequences: ex.consequences,
          alternatives: ex.alternatives ?? [],
          validFrom: ex.validFrom,
          validUntil: ex.validUntil,
          unknownFields: [...unknownFields],
          sourceIds: [],
          confidence: ex.confidence ?? 0.8,
          asDraft: false,
        },
        { actor: 'user', trigger: 'chat' },
      );
      return this.afterDecisionChange(
        conv,
        created,
        {
          asked: [],
          clarifyTopic: clarify,
          supersedesHint: intent.intent === 'decision_supersede' ? (intent.topic ?? topic ?? intent.query ?? '') : null,
          supersedesId: intent.intent === 'decision_supersede' ? (ex.supersedesId ?? null) : null,
          newlyCreated: true,
        },
        state,
        viaLlm,
      );
    }

    const t = target!;
    const patch: Parameters<DecisionService['update']>[1] = {};
    if (ex.decisionText && !t.decisionText) patch.decisionText = ex.decisionText;
    const date =
      normalizeDecisionDate(ex.decidedAt ?? null) ?? (asked.includes('decidedAt') && !unknownFields.has('decidedAt') ? parseDecisionDate(text) : null);
    if (date) patch.decidedAt = date;
    if (topic) patch.topic = topic;
    if (project) patch.project = project;
    if (ex.topicIsProject === true && !patch.project && pending?.clarifyTopic) {
      patch.project = pending.clarifyTopic;
      if (!patch.topic && !t.topicName) patch.topic = pending.clarifyTopic;
    }
    if ((ex.participants ?? []).length) patch.participants = [...new Set([...t.participants, ...ex.participants])];
    if (ex.rationale) patch.rationale = ex.rationale;
    if (ex.consequences) patch.consequences = ex.consequences;
    if ((ex.alternatives ?? []).length) patch.alternatives = [...new Set([...t.alternatives, ...ex.alternatives])];
    if (ex.validFrom) patch.validFrom = ex.validFrom;
    if (ex.validUntil) patch.validUntil = ex.validUntil;
    // the patch replaces the stored list, so keep what was confirmed as unknown before
    if (unknownFields.size) patch.unknownFields = [...new Set([...t.unknownFields, ...unknownFields])];
    if (!pending && Object.keys(patch).length === 0)
      return {
        intent: intent.intent,
        content: `Was soll ich an der Entscheidung „${t.title}“ ergänzen? Nenne bitte Datum, Beteiligte, Begründung, Thema oder Projekt.`,
        sources: [decisionSource(t)],
        confidence: 0.4,
        state: { ...state, last: { ...(state.last ?? {}), decisionId: t.id } },
      };
    const updated = this.decisions.update(t.id, patch, { trigger: 'chat' });
    // „Thema oder Projekt?“ stays asked until it is answered (or another topic was named)
    const stillClarify =
      pending?.clarifyTopic &&
      (ex.topicIsProject === null || ex.topicIsProject === undefined) &&
      (!topic || normalizeName(topic) === normalizeName(pending.clarifyTopic))
        ? pending.clarifyTopic
        : null;
    return this.afterDecisionChange(
      conv,
      updated,
      { asked: [], clarifyTopic: stillClarify, supersedesHint: pending?.supersedes ?? null, supersedesId: pending?.supersedesId ?? null, newlyCreated: false },
      state,
      viaLlm,
    );
  }

  private async afterDecisionChange(
    conv: string,
    d: Decision,
    opts: { asked: DecisionField[]; clarifyTopic: string | null; supersedesHint: string | null; supersedesId?: string | null; newlyCreated: boolean },
    state: ConvState,
    viaLlm: boolean,
  ): Promise<Reply> {
    const missing = d.missingFields;
    const last = { ...(state.last ?? {}), decisionId: d.id };
    if (missing.length > 0) {
      // targeted follow-up questions (with LLM several at once, otherwise one after the other)
      const askFields = viaLlm ? missing : [missing[0]!];
      const questions = askFields.map((f) => `• ${questionFor(f, { topic: d.topicName })}`);
      if (opts.clarifyTopic) questions.push(`• Ist „${opts.clarifyTopic}“ das Thema oder der Name des Projekts?`);
      const known = this.decisions.format(d);
      return {
        intent: 'decision_new',
        content: `Ich habe die Entscheidung als **Entwurf** gespeichert. Damit sie vollständig ist, brauche ich noch:\n\n${questions.join('\n')}\n\n(Wenn du etwas nicht weißt, sage „unbekannt“ – dann speichere ich es so.)\n\n${known}`,
        sources: [decisionSource(d)],
        context: this.decisionContext(d),
        confidence: d.confidence,
        uncertainties: missing.map((f) => `${DECISION_FIELD_LABELS[f]} fehlt noch`),
        state: {
          pending: {
            kind: 'decision',
            decisionId: d.id,
            asked: askFields,
            clarifyTopic: opts.clarifyTopic,
            supersedes: opts.supersedesHint,
            supersedesId: opts.supersedesId ?? null,
          },
          last,
        },
      };
    }

    // complete → check for contradictions and propose superseding if needed
    const actions: StoredAgentAction[] = [];
    const lines: string[] = [];
    const conflicts = await this.contradictions.checkDecision(d.id);
    for (const c of conflicts) {
      const insight = this.insights.byDedupeKey(`contradiction:${c.id}`);
      if (insight?.recommendedActionId) {
        const a = this.actions.get(insight.recommendedActionId);
        actions.push(a);
      }
      lines.push(`⚠ ${c.title}: ${c.description.split('\n')[0]}`);
    }
    let next: Pending | null = null;
    // eslint-disable-next-line sonarjs/different-types-comparison -- defensive: null may come from stored JSON
    if (opts.supersedesHint !== null && opts.supersedesHint !== undefined) {
      const named = opts.supersedesId ? this.activeDecisions(d.id).filter((o) => o.id === opts.supersedesId) : [];
      const candidates = named.length ? named : this.supersedeCandidates(d, opts.supersedesHint);
      const proposed = (o: Decision) => actions.some((a) => (a.proposedParameters as { oldDecisionId?: string }).oldDecisionId === o.id);
      if (candidates.length === 1) {
        if (!proposed(candidates[0]!)) {
          actions.push(this.proposeSupersede(conv, candidates[0]!, d));
          lines.push(
            `Soll die ältere Entscheidung „${candidates[0]!.title}“ (${candidates[0]!.decidedAt?.slice(0, 10) ?? 'ohne Datum'}) als überholt markiert werden?`,
          );
        }
      } else {
        // without a unique match we ask – never just take the first active decision that comes along
        const list = (candidates.length ? candidates : this.activeDecisions(d.id)).slice(0, 5);
        if (list.length === 0) lines.push('Eine ältere aktive Entscheidung, die dadurch ersetzt würde, habe ich nicht gefunden.');
        else {
          lines.push(
            `Welche Entscheidung wird ersetzt?\n${list.map((o, i) => `${i + 1}. ${o.title} (${o.decidedAt?.slice(0, 10) ?? 'ohne Datum'})`).join('\n')}\n\nAntworte mit der Nummer oder dem Titel – oder „keine“.`,
          );
          next = { kind: 'supersede_choice', newDecisionId: d.id, candidateIds: list.map((o) => o.id) };
        }
      }
    }
    // „Thema oder Projekt?“ even for an otherwise complete decision – the question blocks no further requests
    const clarify = !next && opts.clarifyTopic ? opts.clarifyTopic : null;
    if (clarify) {
      lines.push(`Ist „${clarify}“ das Thema oder der Name des Projekts?`);
      next = { kind: 'decision', decisionId: d.id, asked: [], clarifyTopic: clarify, optional: true };
    }
    const uncertainties = d.unknownFields.map((f) => `${DECISION_FIELD_LABELS[f]}: als unbekannt bestätigt`);
    return {
      intent: 'decision_new',
      content: `Die Entscheidung ist gespeichert.\n\n${this.decisions.format(d)}${lines.length ? `\n\n${lines.join('\n')}` : ''}`,
      ...(clarify ? { quickReplies: TOPIC_KIND_QUICK_REPLIES } : {}),
      sources: [decisionSource(d)],
      context: { ...this.decisionContext(d), contradictions: conflicts.map((c) => ({ type: 'contradiction' as const, id: c.id, label: c.title })) },
      actions,
      confidence: d.confidence,
      uncertainties,
      state: { pending: next, last },
    };
  }

  private activeDecisions(exceptId: string): Decision[] {
    return this.decisions.list().filter((o) => o.id !== exceptId && ['active', 'confirmed'].includes(o.status));
  }

  /** Older decisions that d might supersede according to the hint (topic, title) or the same topic/project. */
  private supersedeCandidates(d: Decision, hint: string): Decision[] {
    const active = this.activeDecisions(d.id);
    const h = normalizeName(hint);
    if (h)
      return active.filter((o) => [o.topicName, o.projectName, o.title].some((x) => x && normalizeName(x).includes(h)) || nameSimilarity(o.title, hint) >= 0.6);
    if (!d.topicId && !d.projectId) return [];
    return active.filter((o) => (d.topicId && o.topicId === d.topicId) || (d.projectId && o.projectId === d.projectId));
  }

  private proposeSupersede(conv: string, older: Decision, d: Decision): StoredAgentAction {
    return this.actions.propose({
      actionType: 'supersede_decision',
      label: `„${older.title}“ als überholt markieren`,
      rationale: 'Du hast angegeben, dass diese Entscheidung eine ältere ersetzt.',
      confidence: 0.7,
      affectedEntities: [decisionRef(older), decisionRef(d)],
      requiredConfirmation: 'confirm',
      proposedParameters: { oldDecisionId: older.id, newDecisionId: d.id },
      conversationId: conv,
    });
  }

  /** Answer to „Welche Entscheidung wird ersetzt?“: number, „keine“, or title or topic. Otherwise null. */
  answerSupersedeChoice(conv: string, text: string, p: Extract<Pending, { kind: 'supersede_choice' }>, state: ConvState): Reply | null {
    const t = normalizeName(text);
    const d = this.decisions.get(p.newDecisionId);
    if (/^(keine|keiner|nichts|gar keine)\b/.test(t) || shortAnswer(text) === 'no')
      return { intent: 'decision_supersede', content: 'Okay, ich markiere keine Entscheidung als überholt.', confidence: 0.9, state };
    const num = /^(?:nummer\s+|nr\s+)?(\d+)$/.exec(t)?.[1];
    const listed = p.candidateIds.flatMap((id) => {
      try {
        return [this.decisions.get(id)];
      } catch {
        return [];
      }
    });
    let older: Decision | undefined = num ? listed[Number(num) - 1] : undefined;
    if (!older && t && words(text) <= 10) {
      const matches = this.supersedeCandidates(d, text);
      if (matches.length === 1) older = matches[0];
    }
    if (!older || !['active', 'confirmed'].includes(older.status)) return null;
    const action = this.proposeSupersede(conv, older, d);
    return {
      intent: 'decision_supersede',
      content: `Soll die ältere Entscheidung „${older.title}“ (${older.decidedAt?.slice(0, 10) ?? 'ohne Datum'}) als überholt markiert werden? Bitte bestätige.`,
      actions: [action],
      context: { decisions: [decisionRef(older), decisionRef(d)] },
      confidence: 0.8,
      state,
    };
  }

  // ---------- Notes ----------
  private async noteCapture(text: string, intent: ChatIntent, state: ConvState): Promise<Reply> {
    const content = (intent.note ?? text).trim();
    const topic = intent.topic ? this.graph.ensureEntity('topic', intent.topic) : null;
    const { note } = await this.notes.createUnlessExists({
      content,
      links: topic ? [{ targetId: topic.id, relationType: 'relates_to', confidence: 0.8 }] : [],
    });
    return {
      intent: 'note_capture',
      content: `Notiz gespeichert${intent.topic ? ` (Thema: ${intent.topic})` : ''}.`,
      sources: [{ id: note.id, type: 'note', title: note.name, snippet: truncate(content, 200), score: 1, path: null, date: note.createdAt }],
      context: { topics: topic ? [{ type: 'topic', id: topic.id, label: intent.topic ?? topic.name }] : [] },
      confidence: intent.confidence,
      state,
    };
  }

  // ---------- Events ----------
  private async eventRecord(text: string, intent: ChatIntent, state: ConvState): Promise<Reply> {
    const pending = state.pending?.kind === 'event' ? state.pending : null;
    const ev = intent.event ?? {};
    const title = (pending?.title ?? ev.title?.trim() ?? truncate(intent.segment ?? text, 100)).slice(0, 160);
    const occurredAt = normalizeDateInput(ev.occurredAt ?? null) ?? parseGermanDate(pending ? text : (intent.segment ?? text));
    const description =
      pending?.description ??
      ev.description?.trim() ??
      ((intent.segment ?? text).trim().length > title.length + 10 ? (intent.segment ?? text).trim().slice(0, 2000) : null);
    const participants = pending?.participants ?? (ev.participants ?? []).map((p) => p.trim()).filter(Boolean);
    const clear: ConvState = { ...state, pending: null };
    if (!occurredAt) {
      return {
        intent: 'event_record',
        content: `An welchem Datum war das Ereignis „${title}“? Nenne bitte ein Datum, damit ich es in der Timeline einordnen kann.`,
        confidence: 0.4,
        state: {
          ...state,
          pending: {
            kind: 'event',
            title,
            description,
            topic: pending?.topic ?? intent.topic ?? null,
            project: pending?.project ?? intent.project ?? null,
            participants,
            source: pending?.source ?? text.slice(0, 4000),
          },
        },
      };
    }
    const event = this.events.create(
      { title, description, occurredAt, topic: pending?.topic ?? intent.topic, project: pending?.project ?? intent.project, participants, sourceIds: [] },
      { actor: 'user', trigger: 'chat' },
    );
    const sources: SourceReference[] = [
      { id: event.id, type: 'event', title: event.title, snippet: truncate(event.description ?? '', 200), score: 1, path: null, date: event.occurredAt },
    ];
    return {
      intent: 'event_record',
      content: `Ereignis in der Timeline eingetragen: **${event.title}** (${event.occurredAt.slice(0, 10)})${event.topicName ? `, Thema: ${event.topicName}` : ''}${event.projectName ? `, Projekt: ${event.projectName}` : ''}${event.participants.length ? `, Beteiligte: ${event.participants.join(', ')}` : ''}.`,
      sources,
      context: {
        topics: event.topicName ? [{ type: 'topic', id: event.topicId!, label: event.topicName }] : [],
        projects: event.projectName ? [{ type: 'project', id: event.projectId!, label: event.projectName }] : [],
      },
      confidence: intent.confidence,
      state: clear,
    };
  }

  // ---------- Open items ----------
  /** „ich/mir/mich“ as the owner is the user's own person (profile name; without a name the placeholder „Ich“). */
  private responsibleName(raw: string | null | undefined): { name: string | null; self: boolean } {
    const v = raw?.trim();
    if (!v) return { name: null, self: false };
    if (!isSelfReference(v)) return { name: v, self: false };
    return { name: this.persons.resolve(v, { context: 'chat' }).entity?.name ?? null, self: true };
  }

  /** The user message of this conversation currently being processed (source of newly created items). */
  private latestUserMessageId(conv: string): string | null {
    return (
      this.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, conv), eq(messages.role, 'user')))
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .get()?.id ?? null
    );
  }

  private async openItemNew(conv: string, text: string, intent: ChatIntent, state: ConvState, force = false): Promise<Reply> {
    const oi = intent.openItem ?? {};
    const segment = (intent.segment ?? text).trim();
    const derived = deriveOpenItem(segment);
    const llmTitle = oi.title?.replace(OPEN_ITEM_PREFIX_RE, '').trim();
    // a „title“ that is the whole message is no title
    const title = llmTitle && llmTitle.length <= 120 && llmTitle !== text.trim() ? llmTitle : derived.title;
    const description = oi.description?.trim() || (derived.description && derived.description !== title ? derived.description : null);
    const who = this.responsibleName(oi.responsible);
    // is there already a similar active item? Then ask first (title, description, topic/project, owner).
    if (!force) {
      // a name without an entity yet is a new, different value (never equal to an existing one)
      const ref = (type: 'topic' | 'project' | 'person', name: string | null | undefined) => {
        if (!name?.trim()) return null;
        // persons are looked up like everywhere else (other spelling, role or title still finds the same person)
        const found = type === 'person' ? this.persons.resolve(name, { context: 'chat', create: false }).entity : this.graph.findByNameOrAlias(type, name);
        return found?.id ?? `new:${normalizeName(name)}`;
      };
      const draft = {
        title,
        description,
        topicId: ref('topic', intent.topic),
        projectId: ref('project', intent.project),
        responsiblePersonId: ref('person', who.name),
      };
      const existing = findOpenItemDuplicate(draft, this.openItems.list({ onlyActive: true }));
      if (existing)
        return {
          intent: 'open_item_new',
          content: `Gibt es schon: ‚${existing.title}‘ – ergänzen oder neu anlegen?`,
          quickReplies: ['Ergänzen', 'Neu anlegen'],
          context: { openItems: [{ type: 'task', id: existing.id, label: existing.title }] },
          confidence: 0.6,
          state: {
            ...state,
            pending: { kind: 'open_item_duplicate', existingId: existing.id, text, intent: { ...intent, openItem: { ...oi, title, description } } },
          },
        };
    }
    const source = this.latestUserMessageId(conv);
    const item = this.openItems.create(
      {
        title,
        description,
        topic: intent.topic,
        project: intent.project,
        responsible: who.name,
        dueAt: normalizeDateInput(oi.dueAt ?? null) ?? undefined,
        priority: oi.priority ?? 'normal',
        sourceIds: source ? [source] : [],
        confidence: intent.confidence,
      },
      { actor: 'user', trigger: 'chat' },
    );
    const asked: OpenItemField[] = [];
    if (!item.responsiblePersonId && !who.self) asked.push('responsible');
    if (!item.dueAt) asked.push('due');
    // short, optional follow-up question – it does not hold up further requests
    const q = asked.length ? `\n\n_Optional:_ ${asked.map((a) => (a === 'responsible' ? 'Wer ist verantwortlich?' : 'Bis wann?')).join(' ')}` : '';
    const selfNote =
      who.self && !this.settings.get().profile.name.trim()
        ? ' Hinterlege deinen Namen unter Einstellungen → Über dich, damit ich auch Dokumente mit deinem Namen dir zuordnen kann.'
        : '';
    return {
      intent: 'open_item_new',
      content: `Offenen Punkt angelegt: **${item.title}**${item.dueAt ? ` (fällig ${item.dueAt.slice(0, 10)})` : ''}${item.responsibleName ? `, Verantwortlich: ${who.self ? 'du' : item.responsibleName}` : ''}.${selfNote}${q}`,
      sources: [{ id: item.id, type: 'task', title: item.title, snippet: item.description ?? '', score: 1, path: null, date: item.createdAt }],
      context: {
        openItems: [{ type: 'task', id: item.id, label: item.title }],
        topics: item.topicId ? [{ type: 'topic', id: item.topicId, label: item.topicName ?? '' }] : [],
      },
      confidence: item.confidence,
      uncertainties: asked.map((a) => (a === 'responsible' ? 'Verantwortlicher unbekannt' : 'Fälligkeitsdatum unbekannt')),
      state: {
        pending: openItemPending(asked.length ? [{ openItemId: item.id, asked }] : [], true),
        last: { ...(state.last ?? {}), openItemId: item.id },
      },
    };
  }

  /** Answer to „Gibt es schon: ‚…‘ – ergänzen oder neu anlegen?“. Otherwise null. */
  async answerOpenItemDuplicate(conv: string, text: string, p: Extract<Pending, { kind: 'open_item_duplicate' }>, state: ConvState): Promise<Reply | null> {
    const t = normalizeName(text);
    if (words(text) > 8) return null;
    if (/\bneu\b|\bneuen?\b|anlegen/.test(t) && !/erganz/.test(t)) return this.openItemNew(conv, p.text, p.intent, state, true);
    if (!/erganz|hinzufug|dazu|anhang|zusammen|bestehend/.test(t) && shortAnswer(text) !== 'yes') return null;
    const existing = this.openItemOrNull(p.existingId);
    if (!existing) return null;
    const oi = p.intent.openItem ?? {};
    const addition = [oi.description, oi.title !== existing.title ? oi.title : null].filter(Boolean).join(' – ');
    const who = this.responsibleName(oi.responsible);
    const patch: Parameters<OpenItemService['update']>[1] = {};
    const merged = appendDescription(existing.description, addition);
    if (merged !== existing.description) patch.description = merged;
    if (!existing.responsiblePersonId && who.name) patch.responsible = who.name;
    const due = normalizeDateInput(oi.dueAt ?? null);
    if (!existing.dueAt && due) patch.dueAt = due;
    const updated = Object.keys(patch).length ? this.openItems.update(existing.id, patch, { trigger: 'chat' }) : existing;
    return {
      intent: 'open_item_update',
      content: `Ich habe den bestehenden Punkt **${updated.title}** ergänzt.`,
      context: { openItems: [{ type: 'task', id: updated.id, label: updated.title }] },
      confidence: 0.8,
      state: { ...state, last: { ...(state.last ?? {}), openItemId: updated.id } },
    };
  }

  private async openItemUpdate(conv: string, text: string, intent: ChatIntent, state: ConvState): Promise<Reply> {
    const oi = intent.openItem ?? {};
    const pending = state.pending?.kind === 'open_item' ? state.pending : null;
    const group = pending ? this.openItemGroup(pending) : [];
    let chosen = group;
    if (group.length > 1 && (oi.targetId || oi.targetHint?.trim())) {
      // a named item answers only for itself; otherwise the answer applies to every item asked about
      const named = this.targetOpenItem(oi.targetId, oi.targetHint).item;
      const own = group.filter((g) => g.item.id === named?.id);
      if (own.length) chosen = own;
    }
    if (!chosen.length) {
      const target = this.targetOpenItem(oi.targetId, oi.targetHint);
      if (target.ambiguous.length) return this.askWhichOpenItem(text, intent, target.ambiguous, state);
      const item = target.item ?? this.lastOpenItem(state, target);
      if (!item) return { intent: 'open_item_update', content: this.noOpenItemQuestion(oi.targetHint, 'meinst du'), confidence: 0.3, state };
      chosen = [{ item, asked: [] }];
    }
    if (oi.newStatus === 'resolved' || oi.newStatus === 'dismissed') {
      const closes: Reply[] = [];
      for (const { item } of chosen)
        closes.push(await this.openItemClose(conv, text, { ...intent, openItem: { ...oi, targetId: item.id, targetHint: item.title } }, state));
      return mergeReplies(closes, closes.at(-1)!.state ?? state);
    }
    const results = chosen.map(({ item, asked }) => this.applyOpenItemAnswer(item, oi, text, asked));
    const remaining: OpenItemAsk[] = [
      ...results.filter((r) => r.stillAsked.length).map((r) => ({ openItemId: r.updated.id, asked: r.stillAsked })),
      ...group.filter((g) => !chosen.includes(g)).map((g) => ({ openItemId: g.item.id, asked: g.asked })),
    ];
    const stillAsked = [...new Set(results.flatMap((r) => r.stillAsked))];
    // what is still missing is visible in the reply – otherwise the follow-up question would be invisible
    const open = stillAsked.length
      ? `\n\nNoch offen: ${stillAsked.map((a) => (a === 'responsible' ? 'Wer ist verantwortlich?' : 'Bis wann?')).join(' ')} (Du kannst auch „unbekannt“ sagen.)`
      : '';
    const line = (u: OpenItem) =>
      `**${u.title}**${u.dueAt ? ` – fällig ${u.dueAt.slice(0, 10)}` : u.dueUnknown ? ', Termin: unbekannt' : ''}${u.responsibleName ? `, Verantwortlich: ${u.responsibleName}` : u.responsibleUnknown ? ', Verantwortlicher: unbekannt' : ''}`;
    const updated = results.map((r) => r.updated);
    return {
      intent: 'open_item_update',
      content:
        updated.length === 1
          ? `Offenen Punkt aktualisiert: ${line(updated[0]!)}.${open}`
          : `Offene Punkte aktualisiert:\n${updated.map((u) => `• ${line(u)}`).join('\n')}${open}`,
      context: { openItems: updated.map((u) => ({ type: 'task' as const, id: u.id, label: u.title })) },
      confidence: 0.8,
      state: {
        pending: openItemPending(remaining, pending?.optional),
        last: { ...(state.last ?? {}), openItemId: updated.at(-1)!.id },
      },
    };
  }

  /** Applies an answer or change to one open item; `asked` are the fields the follow-up question asked for. */
  private applyOpenItemAnswer(
    item: OpenItem,
    oi: NonNullable<ChatIntent['openItem']>,
    text: string,
    asked: OpenItemField[],
  ): { updated: OpenItem; stillAsked: OpenItemField[] } {
    const patch: Parameters<OpenItemService['update']>[1] = {};
    const who = this.responsibleName(oi.responsible);
    const unknown = unknownFieldsIn(text);
    if (who.name) patch.responsible = who.name;
    else if (asked.includes('responsible') && (unknown.responsible || (unknown.generic && !unknown.due))) patch.responsibleUnknown = true;
    const due = normalizeDateInput(oi.dueAt ?? null);
    if (due) patch.dueAt = due;
    // „Anna, Termin unbekannt“: owner set and due date deliberately unknown
    else if (asked.includes('due') && (unknown.due || (unknown.generic && !unknown.responsible))) patch.dueUnknown = true;
    // additions are appended to the description
    if (oi.description) {
      const merged = appendDescription(item.description, oi.description);
      if (merged !== item.description) patch.description = merged;
    }
    if (oi.priority) patch.priority = oi.priority;
    if (oi.newStatus && oi.newStatus !== 'resolved' && oi.newStatus !== 'dismissed') patch.status = oi.newStatus;
    const updated = Object.keys(patch).length ? this.openItems.update(item.id, patch, { trigger: 'chat' }) : item;
    const stillAsked: OpenItemField[] = [];
    if (!updated.responsiblePersonId && !updated.responsibleUnknown && asked.includes('responsible') && !patch.responsible) stillAsked.push('responsible');
    if (!updated.dueAt && !updated.dueUnknown && asked.includes('due') && !patch.dueAt) stillAsked.push('due');
    return { updated, stillAsked };
  }

  private async openItemClose(conv: string, text: string, intent: ChatIntent, state: ConvState): Promise<Reply> {
    const hint = intent.openItem?.targetHint ?? text;
    const target = this.targetOpenItem(intent.openItem?.targetId, hint);
    if (target.ambiguous.length) return this.askWhichOpenItem(text, intent, target.ambiguous, state);
    const item = target.item ?? this.lastOpenItem(state, target);
    if (!item)
      return { intent: 'open_item_close', content: this.noOpenItemQuestion(target.hinted ? hint : null, 'soll ich schließen'), confidence: 0.3, state };
    const dismiss = intent.openItem?.newStatus === 'dismissed';
    const note = intent.openItem?.resolutionNote?.trim() || null;
    const action = this.actions.propose({
      actionType: 'close_open_item',
      label: `„${item.title}“ ${dismiss ? 'verwerfen' : 'als erledigt schließen'}`,
      rationale: 'Das Schließen eines offenen Punkts erfordert deine Bestätigung.',
      confidence: intent.confidence,
      affectedEntities: [{ type: 'task', id: item.id, label: item.title }],
      requiredConfirmation: 'confirm',
      proposedParameters: { openItemId: item.id, status: dismiss ? 'dismissed' : 'resolved', resolutionNote: note },
      conversationId: conv,
    });
    return {
      intent: 'open_item_close',
      content: `Soll ich den offenen Punkt **${item.title}** wirklich ${dismiss ? 'verwerfen' : 'als erledigt schließen'}?${note ? ` Als ${dismiss ? 'Grund' : 'Lösung'} halte ich fest: „${truncate(note, 300)}“.` : ''} Bitte bestätige.`,
      actions: [action],
      context: { openItems: [{ type: 'task', id: item.id, label: item.title }] },
      confidence: intent.confidence,
      state: { ...state, last: { ...(state.last ?? {}), openItemId: item.id } },
    };
  }

  // ---------- Reminders ----------
  private async reminderFlow(text: string, intent: ChatIntent, state: ConvState): Promise<Reply> {
    const r = intent.reminder ?? {};
    const pending = state.pending?.kind === 'reminder' ? state.pending : null;
    // without a hint of its own (target, title or text), „daran“ refers to the item mentioned last
    const named = pending?.targetId ? { item: null, ambiguous: [], hinted: true } : this.targetOpenItem(r.targetId, r.targetHint ?? r.title ?? text);
    if (named.ambiguous.length) return this.askWhichOpenItem(text, intent, named.ambiguous, state);
    const when = normalizeDateInput(r.remindAt ?? null) ?? parseGermanDate(r.relativeText ?? text);
    if (!when) {
      // remember the follow-up question so that the answer („31.10.“) is understood in context
      const target = named.item ?? this.lastOpenItem(state, named);
      const title = pending?.title ?? target?.title ?? r.title?.trim() ?? truncate(text, 80);
      return {
        intent: intent.intent,
        content: 'Wann soll ich dich erinnern? Nenne bitte ein Datum oder z. B. „nächsten Montag“.',
        confidence: 0.4,
        state: {
          ...state,
          pending: {
            kind: 'reminder',
            title,
            targetId: pending?.targetId ?? target?.id ?? null,
            snooze: intent.intent === 'reminder_snooze',
            source: pending?.source ?? text.slice(0, 4000),
          },
        },
      };
    }
    state = { ...state, pending: null };
    const hinted = named.item;
    const item = (pending?.targetId ? this.openItemOrNull(pending.targetId) : null) ?? hinted ?? (pending ? null : this.lastOpenItem(state, named));
    // an already fired reminder is rescheduled as well (instead of creating a new one)
    const existing = item ? this.reminders.latestFor(item.id) : null;
    if (existing && intent.intent === 'reminder_snooze') {
      this.reminders.snooze(existing.id, when);
      return { intent: 'reminder_snooze', content: `Erinnerung verschoben auf ${when}.`, confidence: 0.9, state };
    }
    let target = item;
    let created: { openItem: string; note: string | null } | null = null;
    if (!target && intent.intent === 'reminder_create') {
      // A reminder belongs to an open item – without an existing reference, create the item (and keep the text as a note).
      const source = (pending?.source ?? text).trim();
      const title = (pending?.title ?? r.title?.trim() ?? truncate(source.replace(/\s+/g, ' '), 100)).slice(0, 160);
      target = this.openItems.create(
        {
          title,
          description: source.length > title.length + 10 ? source.slice(0, 2000) : undefined,
          topic: intent.topic,
          project: intent.project,
          dueAt: when,
          priority: 'normal',
          sourceIds: [],
          confidence: 0.7,
        },
        { actor: 'user', trigger: 'chat' },
      );
      let noteTitle: string | null = null;
      if (source.length > 120) {
        const { note } = await this.notes.createUnlessExists({
          content: source,
          links: [{ targetId: target.id, relationType: 'relates_to', confidence: 0.8 }],
        });
        noteTitle = note.name;
      }
      created = { openItem: target.title, note: noteTitle };
    }
    const rem = this.reminders.create({
      targetType: target ? 'open_item' : 'custom',
      targetId: target?.id ?? null,
      title: target?.title ?? pending?.title ?? r.title?.trim() ?? truncate(text, 80),
      remindAt: when,
    });
    const extra = created
      ? `\n\nDazu habe ich den offenen Punkt **${created.openItem}** (fällig ${when}) angelegt${created.note ? ' und deinen Text als Notiz gespeichert' : ''}. Eine Entscheidung war in der Nachricht nicht enthalten – deshalb habe ich keine erfasst.`
      : '';
    return {
      intent: 'reminder_create',
      content: `Erinnerung für den ${when} angelegt${target && !created ? ` (Offener Punkt: ${target.title})` : ''}. Du siehst sie dann in der Notification Bell – solange Archivist läuft.${extra}`,
      context: target ? { openItems: [{ type: 'task', id: target.id, label: target.title }] } : undefined,
      confidence: 0.9,
      uncertainties: ['Erinnerungen werden nur angezeigt, solange Archivist geöffnet ist.'],
      state: { ...state, last: { ...(state.last ?? {}), openItemId: target?.id ?? state.last?.openItemId } },
      sources: [
        { id: rem.id, type: 'reminder', title: rem.title, snippet: `Erinnerung am ${when}`, score: 1, path: null, date: when },
        ...(target ? [{ id: target.id, type: 'task' as const, title: target.title, snippet: `Fällig ${when}`, score: 1, path: null, date: when }] : []),
      ],
    };
  }

  // ---------- Open items: lookup and follow-up questions ----------
  openItemOrNull(id: string | null | undefined): OpenItem | null {
    if (!id) return null;
    try {
      const item = this.openItems.get(id);
      return ACTIVE_STATUSES.includes(item.status) ? item : null;
    } catch {
      return null;
    }
  }

  /** Items of an open-item follow-up question that still lack an asked field – answered, closed or deleted ones drop out. */
  openItemGroup(p: OpenItemPending): Array<{ item: OpenItem; asked: OpenItemField[] }> {
    return openItemAsks(p).flatMap(({ openItemId, asked }) => {
      const item = this.openItemOrNull(openItemId);
      if (!item) return [];
      const still = asked.filter((a) => (a === 'due' ? !item.dueAt && !item.dueUnknown : !item.responsiblePersonId && !item.responsibleUnknown));
      return still.length ? [{ item, asked: still }] : [];
    });
  }

  /** The open item meant: id from the LLM, otherwise a unique match for the hint; ambiguous → candidates for the follow-up question. */
  private targetOpenItem(
    targetId: string | null | undefined,
    hint: string | null | undefined,
  ): { item: OpenItem | null; ambiguous: OpenItem[]; hinted: boolean } {
    const byId = this.openItemOrNull(targetId);
    if (byId) return { item: byId, ambiguous: [], hinted: true };
    // `hinted`: the message names something of its own – then there is no fallback to the item mentioned last
    if (!hint?.trim() || hintTokens(hint).length === 0) return { item: null, ambiguous: [], hinted: false };
    const m = this.openItems.matchByHint(hint);
    if (m.status === 'match') return { item: m.item, ambiguous: [], hinted: true };
    return { item: null, ambiguous: m.status === 'ambiguous' ? m.items : [], hinted: true };
  }

  /** The item mentioned last – only if the message contains no hint of its own („der ist erledigt“). */
  private lastOpenItem(state: ConvState, target: { hinted: boolean }): OpenItem | null {
    return target.hinted ? null : this.openItemOrNull(state.last?.openItemId);
  }

  private noOpenItemQuestion(hint: string | null | undefined, verb: string): string {
    const words = hint ? hintTokens(hint) : [];
    return `Welchen offenen Punkt ${verb}?${words.length ? ` Zu „${truncate(hint!.trim(), 80)}“ finde ich keinen aktiven Punkt.` : ''} Nenne bitte den Titel.`;
  }

  /** „Meinst du ‚A‘ oder ‚B‘?“ – choice by button, number or title; afterwards the request continues. */
  private askWhichOpenItem(text: string, intent: ChatIntent, candidates: OpenItem[], state: ConvState): Reply {
    const names = candidates.map((c) => `‚${c.title}‘`);
    return {
      intent: intent.intent,
      content: `Meinst du ${names.slice(0, -1).join(', ')} oder ${names.at(-1)}?`,
      quickReplies: candidates.map((c) => c.title),
      context: { openItems: candidates.map((c) => ({ type: 'task' as const, id: c.id, label: c.title })) },
      confidence: 0.5,
      state: { ...state, pending: { kind: 'open_item_choice', text, intent, candidateIds: candidates.map((c) => c.id) } },
    };
  }

  answerOpenItemChoice(text: string, p: Extract<Pending, { kind: 'open_item_choice' }>): OpenItem | null {
    const candidates = p.candidateIds.map((id) => this.openItemOrNull(id)).filter((x): x is OpenItem => Boolean(x));
    const t = normalizeName(text);
    const num = /^(?:nummer\s+|nr\s+)?(\d+)$/.exec(t)?.[1];
    if (num) return candidates[Number(num) - 1] ?? null;
    const exact = candidates.find((c) => normalizeName(c.title) === t);
    if (exact) return exact;
    const m = matchOpenItems(text, candidates);
    return m.status === 'match' ? m.item : null;
  }
}

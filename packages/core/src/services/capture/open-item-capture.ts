import type { ChatIntent, OpenItem } from '@archivist/shared';
import { and, desc, eq } from 'drizzle-orm';
import { messages } from '../../db/schema';
import { normalizeDateInput } from '../../util/dates';
import { isSelfReference } from '../../util/person-names';
import { normalizeName, truncate } from '../../util/text';
import {
  appendDescription,
  deriveOpenItem,
  mergeReplies,
  OPEN_ITEM_PREFIX_RE,
  openItemPending,
  shortAnswer,
  unknownFieldsIn,
  words,
  type OpenItemAsk,
  type OpenItemField,
  type Pending,
  type Reply,
} from '../chat-state';
import { findOpenItemDuplicate } from '../cleanup/open-item-duplicates';
import type { OpenItemService } from '../open-items';
import type { CaptureDeps, CaptureRequest } from './capture-deps';
import { noOpenItemQuestion, type OpenItemLookup } from './open-item-lookup';

type ExtractedOpenItem = NonNullable<ChatIntent['openItem']>;
type OpenItemPatch = Parameters<OpenItemService['update']>[1]['patch'];
type AskedItem = { item: OpenItem; asked: OpenItemField[] };

/** Title, description and owner of a new open item, from the LLM's extraction or derived from the message. */
interface OpenItemDraft {
  extracted: ExtractedOpenItem;
  title: string;
  description: string | null;
  responsible: { name: string | null; self: boolean };
}

const askedQuestion = (field: OpenItemField) => (field === 'responsible' ? 'Wer ist verantwortlich?' : 'Bis wann?');

function openItemLine(item: OpenItem): string {
  const due = item.dueAt ? ` – fällig ${item.dueAt.slice(0, 10)}` : item.dueUnknown ? ', Termin: unbekannt' : '';
  const responsible = item.responsibleName ? `, Verantwortlich: ${item.responsibleName}` : item.responsibleUnknown ? ', Verantwortlicher: unbekannt' : '';
  return `**${item.title}**${due}${responsible}`;
}

/** Open items from chat and agent: create with duplicate check and person resolution, answer follow-up questions, close. */
export class OpenItemCapture {
  constructor(
    private readonly deps: CaptureDeps,
    private readonly lookup: OpenItemLookup,
  ) {}

  /** „ich/mir/mich“ as the owner is the user's own person (profile name; without a name the placeholder „Ich“). */
  private responsibleName(raw: string | null | undefined): { name: string | null; self: boolean } {
    const value = raw?.trim();
    if (!value) return { name: null, self: false };
    if (!isSelfReference(value)) return { name: value, self: false };
    return { name: this.deps.persons.resolve(value, { context: 'chat' }).entity?.name ?? null, self: true };
  }

  /** The user message of this conversation currently being processed (source of newly created items). */
  private latestUserMessageId(conv: string): string | null {
    return (
      this.deps.ctx.database.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, conv), eq(messages.role, 'user')))
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .get()?.id ?? null
    );
  }

  private draft(request: CaptureRequest): OpenItemDraft {
    const { text, intent } = request;
    const extracted = intent.openItem ?? {};
    const derived = deriveOpenItem((intent.segment ?? text).trim());
    const llmTitle = extracted.title?.replace(OPEN_ITEM_PREFIX_RE, '').trim();
    // a „title“ that is the whole message is no title
    const title = llmTitle && llmTitle.length <= 120 && llmTitle !== text.trim() ? llmTitle : derived.title;
    const description = extracted.description?.trim() || (derived.description && derived.description !== title ? derived.description : null);
    return { extracted, title, description, responsible: this.responsibleName(extracted.responsible) };
  }

  /** Entity id for the duplicate check; a name without an entity yet is a new value, never equal to an existing one. */
  private entityRef(type: 'topic' | 'project' | 'person', name: string | null | undefined): string | null {
    if (!name?.trim()) return null;
    // persons are looked up like everywhere else (other spelling, role or title still finds the same person)
    const found =
      type === 'person' ? this.deps.persons.resolve(name, { context: 'chat', create: false }).entity : this.deps.graph.findByNameOrAlias(type, name);
    return found?.id ?? `new:${normalizeName(name)}`;
  }

  /** A new open item; a similar active one (title, description, topic/project, owner) is asked about first. */
  async create(request: CaptureRequest): Promise<Reply> {
    const draft = this.draft(request);
    const { intent } = request;
    const existing = findOpenItemDuplicate(
      {
        title: draft.title,
        description: draft.description,
        topicId: this.entityRef('topic', intent.topic),
        projectId: this.entityRef('project', intent.project),
        responsiblePersonId: this.entityRef('person', draft.responsible.name),
      },
      this.deps.openItems.list({ onlyActive: true }),
    );
    if (!existing) return this.store(request, draft);
    const { title, description } = draft;
    return {
      intent: 'open_item_new',
      content: `Gibt es schon: ‚${existing.title}‘ – ergänzen oder neu anlegen?`,
      quickReplies: ['Ergänzen', 'Neu anlegen'],
      context: { openItems: [{ type: 'task', id: existing.id, label: existing.title }] },
      confidence: 0.6,
      state: {
        ...request.state,
        pending: {
          kind: 'open_item_duplicate',
          existingId: existing.id,
          text: request.text,
          intent: { ...intent, openItem: { ...draft.extracted, title, description } },
        },
      },
    };
  }

  /** A new open item even though a similar one exists (the user chose „neu anlegen“). */
  async createDespiteDuplicate(request: CaptureRequest): Promise<Reply> {
    return this.store(request, this.draft(request));
  }

  private store(request: CaptureRequest, draft: OpenItemDraft): Reply {
    const { intent, state } = request;
    const { extracted, responsible } = draft;
    const source = this.latestUserMessageId(request.conv);
    const item = this.deps.openItems.create(
      {
        title: draft.title,
        description: draft.description,
        topic: intent.topic,
        project: intent.project,
        responsible: responsible.name,
        dueAt: normalizeDateInput(extracted.dueAt ?? null) ?? undefined,
        priority: extracted.priority ?? 'normal',
        sourceIds: source ? [source] : [],
        confidence: intent.confidence,
      },
      { actor: 'user', trigger: 'chat' },
    );
    const asked: OpenItemField[] = [];
    if (!item.responsiblePersonId && !responsible.self) asked.push('responsible');
    if (!item.dueAt) asked.push('due');
    // short, optional follow-up question – it does not hold up further requests
    const question = asked.length ? `\n\n_Optional:_ ${asked.map(askedQuestion).join(' ')}` : '';
    const selfNote =
      responsible.self && !this.deps.settings.get().profile.name.trim()
        ? ' Hinterlege deinen Namen unter Einstellungen → Allgemein → Über dich, damit ich auch Dokumente mit deinem Namen dir zuordnen kann.'
        : '';
    const due = item.dueAt ? ` (fällig ${item.dueAt.slice(0, 10)})` : '';
    const owner = item.responsibleName ? `, Verantwortlich: ${responsible.self ? 'du' : item.responsibleName}` : '';
    return {
      intent: 'open_item_new',
      content: `Offenen Punkt angelegt: **${item.title}**${due}${owner}.${selfNote}${question}`,
      sources: [{ id: item.id, type: 'task', title: item.title, snippet: item.description ?? '', score: 1, path: null, date: item.createdAt }],
      context: {
        openItems: [{ type: 'task', id: item.id, label: item.title }],
        topics: item.topicId ? [{ type: 'topic', id: item.topicId, label: item.topicName ?? '' }] : [],
      },
      confidence: item.confidence,
      uncertainties: asked.map((field) => (field === 'responsible' ? 'Verantwortlicher unbekannt' : 'Fälligkeitsdatum unbekannt')),
      state: {
        pending: openItemPending(asked.length ? [{ openItemId: item.id, asked }] : [], { optional: true }),
        last: { ...(state.last ?? {}), openItemId: item.id },
      },
    };
  }

  /** Answer to „Gibt es schon: ‚…‘ – ergänzen oder neu anlegen?“. Otherwise null. */
  async answerDuplicate(request: Omit<CaptureRequest, 'intent'>, pending: Extract<Pending, { kind: 'open_item_duplicate' }>): Promise<Reply | null> {
    const { text, state } = request;
    const normalized = normalizeName(text);
    if (words(text) > 8) return null;
    if (/\bneu\b|\bneuen?\b|anlegen/.test(normalized) && !/erganz/.test(normalized))
      return this.createDespiteDuplicate({ ...request, text: pending.text, intent: pending.intent });
    if (!/erganz|hinzufug|dazu|anhang|zusammen|bestehend/.test(normalized) && shortAnswer(text) !== 'yes') return null;
    const existing = this.lookup.openItemOrNull(pending.existingId);
    if (!existing) return null;
    const extracted = pending.intent.openItem ?? {};
    const addition = [extracted.description, extracted.title !== existing.title ? extracted.title : null].filter(Boolean).join(' – ');
    const responsible = this.responsibleName(extracted.responsible);
    const patch: OpenItemPatch = {};
    const merged = appendDescription(existing.description, addition);
    if (merged !== existing.description) patch.description = merged;
    if (!existing.responsiblePersonId && responsible.name) patch.responsible = responsible.name;
    const due = normalizeDateInput(extracted.dueAt ?? null);
    if (!existing.dueAt && due) patch.dueAt = due;
    const updated = Object.keys(patch).length ? this.deps.openItems.update(existing.id, { patch, trigger: 'chat' }) : existing;
    return {
      intent: 'open_item_update',
      content: `Ich habe den bestehenden Punkt **${updated.title}** ergänzt.`,
      context: { openItems: [{ type: 'task', id: updated.id, label: updated.title }] },
      confidence: 0.8,
      state: { ...state, last: { ...(state.last ?? {}), openItemId: updated.id } },
    };
  }

  /** The asked items the answer is about: a named item answers only for itself, otherwise it applies to every one. */
  private answeredItems(group: AskedItem[], extracted: ExtractedOpenItem): AskedItem[] {
    if (group.length <= 1 || !(extracted.targetId || extracted.targetHint?.trim())) return group;
    const named = this.lookup.target(extracted.targetId, extracted.targetHint).item;
    const own = group.filter((entry) => entry.item.id === named?.id);
    return own.length ? own : group;
  }

  async update(request: CaptureRequest): Promise<Reply> {
    const { intent, state } = request;
    const extracted = intent.openItem ?? {};
    const pending = state.pending?.kind === 'open_item' ? state.pending : null;
    const group = pending ? this.lookup.openItemGroup(pending) : [];
    let chosen = this.answeredItems(group, extracted);
    if (!chosen.length) {
      const target = this.lookup.target(extracted.targetId, extracted.targetHint);
      if (target.ambiguous.length) return this.lookup.askWhich(request, target.ambiguous);
      const item = target.item ?? this.lookup.lastOpenItem(state, target);
      if (!item) return { intent: 'open_item_update', content: noOpenItemQuestion(extracted.targetHint, 'meinst du'), confidence: 0.3, state };
      chosen = [{ item, asked: [] }];
    }
    if (extracted.newStatus === 'resolved' || extracted.newStatus === 'dismissed') {
      const closes: Reply[] = [];
      for (const { item } of chosen)
        closes.push(await this.close({ ...request, intent: { ...intent, openItem: { ...extracted, targetId: item.id, targetHint: item.title } } }));
      return mergeReplies(closes, closes.at(-1)!.state ?? state);
    }
    const results = chosen.map((entry) => this.applyAnswer(entry, { extracted, text: request.text }));
    const remaining: OpenItemAsk[] = [
      ...results.filter((result) => result.stillAsked.length).map((result) => ({ openItemId: result.updated.id, asked: result.stillAsked })),
      ...group.filter((entry) => !chosen.includes(entry)).map((entry) => ({ openItemId: entry.item.id, asked: entry.asked })),
    ];
    const stillAsked = [...new Set(results.flatMap((result) => result.stillAsked))];
    // what is still missing is visible in the reply – otherwise the follow-up question would be invisible
    const open = stillAsked.length ? `\n\nNoch offen: ${stillAsked.map(askedQuestion).join(' ')} (Du kannst auch „unbekannt“ sagen.)` : '';
    const updated = results.map((result) => result.updated);
    return {
      intent: 'open_item_update',
      content:
        updated.length === 1
          ? `Offenen Punkt aktualisiert: ${openItemLine(updated[0]!)}.${open}`
          : `Offene Punkte aktualisiert:\n${updated.map((item) => `• ${openItemLine(item)}`).join('\n')}${open}`,
      context: { openItems: updated.map((item) => ({ type: 'task' as const, id: item.id, label: item.title })) },
      confidence: 0.8,
      state: {
        pending: openItemPending(remaining, { optional: pending?.optional }),
        last: { ...(state.last ?? {}), openItemId: updated.at(-1)!.id },
      },
    };
  }

  /** The change an answer makes; `asked` are the fields the follow-up question asked for. */
  private answerPatch(entry: AskedItem, answer: { extracted: ExtractedOpenItem; text: string }): OpenItemPatch {
    const { item, asked } = entry;
    const { extracted } = answer;
    const patch: OpenItemPatch = {};
    const responsible = this.responsibleName(extracted.responsible);
    const unknown = unknownFieldsIn(answer.text);
    if (responsible.name) patch.responsible = responsible.name;
    else if (asked.includes('responsible') && (unknown.responsible || (unknown.generic && !unknown.due))) patch.responsibleUnknown = true;
    const due = normalizeDateInput(extracted.dueAt ?? null);
    if (due) patch.dueAt = due;
    // „Anna, Termin unbekannt“: owner set and due date deliberately unknown
    else if (asked.includes('due') && (unknown.due || (unknown.generic && !unknown.responsible))) patch.dueUnknown = true;
    // additions are appended to the description
    const merged = extracted.description ? appendDescription(item.description, extracted.description) : item.description;
    if (merged !== item.description) patch.description = merged;
    if (extracted.priority) patch.priority = extracted.priority;
    if (extracted.newStatus && extracted.newStatus !== 'resolved' && extracted.newStatus !== 'dismissed') patch.status = extracted.newStatus;
    return patch;
  }

  /** Applies an answer or change to one open item; returns the fields that are still missing. */
  private applyAnswer(entry: AskedItem, answer: { extracted: ExtractedOpenItem; text: string }): { updated: OpenItem; stillAsked: OpenItemField[] } {
    const { item, asked } = entry;
    const patch = this.answerPatch(entry, answer);
    const updated = Object.keys(patch).length ? this.deps.openItems.update(item.id, { patch, trigger: 'chat' }) : item;
    const stillAsked: OpenItemField[] = [];
    if (!updated.responsiblePersonId && !updated.responsibleUnknown && asked.includes('responsible') && !patch.responsible) stillAsked.push('responsible');
    if (!updated.dueAt && !updated.dueUnknown && asked.includes('due') && !patch.dueAt) stillAsked.push('due');
    return { updated, stillAsked };
  }

  /** Proposes closing (or dismissing) the meant item; closing always needs the user's confirmation. */
  async close(request: CaptureRequest): Promise<Reply> {
    const { conv, text, intent, state } = request;
    const hint = intent.openItem?.targetHint ?? text;
    const target = this.lookup.target(intent.openItem?.targetId, hint);
    if (target.ambiguous.length) return this.lookup.askWhich(request, target.ambiguous);
    const item = target.item ?? this.lookup.lastOpenItem(state, target);
    if (!item) return { intent: 'open_item_close', content: noOpenItemQuestion(target.hinted ? hint : null, 'soll ich schließen'), confidence: 0.3, state };
    const dismiss = intent.openItem?.newStatus === 'dismissed';
    const note = intent.openItem?.resolutionNote?.trim() || null;
    const action = this.deps.actions().propose({
      actionType: 'close_open_item',
      label: `„${item.title}“ ${dismiss ? 'verwerfen' : 'als erledigt schließen'}`,
      rationale: 'Das Schließen eines offenen Punkts erfordert deine Bestätigung.',
      confidence: intent.confidence,
      affectedEntities: [{ type: 'task', id: item.id, label: item.title }],
      requiredConfirmation: 'confirm',
      proposedParameters: { openItemId: item.id, status: dismiss ? 'dismissed' : 'resolved', resolutionNote: note },
      conversationId: conv,
    });
    const noteText = note ? ` Als ${dismiss ? 'Grund' : 'Lösung'} halte ich fest: „${truncate(note, 300)}“.` : '';
    return {
      intent: 'open_item_close',
      content: `Soll ich den offenen Punkt **${item.title}** wirklich ${dismiss ? 'verwerfen' : 'als erledigt schließen'}?${noteText} Bitte bestätige.`,
      actions: [action],
      context: { openItems: [{ type: 'task', id: item.id, label: item.title }] },
      confidence: intent.confidence,
      state: { ...state, last: { ...(state.last ?? {}), openItemId: item.id } },
    };
  }
}

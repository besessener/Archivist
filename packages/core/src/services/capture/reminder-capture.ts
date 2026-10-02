import type { OpenItem, Reminder } from '@archivist/shared';
import { normalizeDateInput, parseGermanDate } from '../../util/dates';
import { truncate } from '../../util/text';
import type { ConvState, Pending, Reply } from '../chat-state';
import type { CaptureDeps, CaptureRequest } from './capture-deps';
import type { OpenItemLookup, OpenItemTarget } from './open-item-lookup';

type ReminderPending = Extract<Pending, { kind: 'reminder' }>;

type CreatedOpenItem = { item: OpenItem; note: string | null };

function createdReply(outcome: { state: ConvState; when: string; reminder: Reminder; target: OpenItem | null; created: CreatedOpenItem | null }): Reply {
  const { state, when, reminder, target, created } = outcome;
  const extra = created
    ? `\n\nDazu habe ich den offenen Punkt **${created.item.title}** (fällig ${when}) angelegt${created.note ? ' und deinen Text als Notiz gespeichert' : ''}. Eine Entscheidung war in der Nachricht nicht enthalten – deshalb habe ich keine erfasst.`
    : '';
  return {
    intent: 'reminder_create',
    content: `Erinnerung für den ${when} angelegt${target && !created ? ` (Offener Punkt: ${target.title})` : ''}. Du siehst sie dann in der Notification Bell – solange Archivist läuft.${extra}`,
    context: target ? { openItems: [{ type: 'task', id: target.id, label: target.title }] } : undefined,
    confidence: 0.9,
    uncertainties: ['Erinnerungen werden nur angezeigt, solange Archivist geöffnet ist.'],
    state: { ...state, last: { ...(state.last ?? {}), openItemId: target?.id ?? state.last?.openItemId } },
    sources: [
      { id: reminder.id, type: 'reminder', title: reminder.title, snippet: `Erinnerung am ${when}`, score: 1, path: null, date: when },
      ...(target ? [{ id: target.id, type: 'task' as const, title: target.title, snippet: `Fällig ${when}`, score: 1, path: null, date: when }] : []),
    ],
  };
}

/** Reminders from chat and agent: always about an open item – one is created from the message when none is meant. */
export class ReminderCapture {
  constructor(
    private readonly deps: CaptureDeps,
    private readonly lookup: OpenItemLookup,
  ) {}

  async capture(request: CaptureRequest): Promise<Reply> {
    const { text, intent } = request;
    const extracted = intent.reminder ?? {};
    const pending = request.state.pending?.kind === 'reminder' ? request.state.pending : null;
    // without a hint of its own (target, title or text), „daran“ refers to the item mentioned last
    const named: OpenItemTarget = pending?.targetId
      ? { item: null, ambiguous: [], hinted: true }
      : this.lookup.target(extracted.targetId, extracted.targetHint ?? extracted.title ?? text);
    if (named.ambiguous.length) return this.lookup.askWhich(request, named.ambiguous);
    const when = normalizeDateInput(extracted.remindAt ?? null) ?? parseGermanDate(extracted.relativeText ?? text);
    if (!when) return this.askWhen(request, { pending, named });
    const state: ConvState = { ...request.state, pending: null };
    const pendingTarget = pending?.targetId ? this.lookup.openItemOrNull(pending.targetId) : null;
    const item = pendingTarget ?? named.item ?? (pending ? null : this.lookup.lastOpenItem(state, named));
    // an already fired reminder is rescheduled as well (instead of creating a new one)
    const existing = item ? this.deps.reminders.latestFor(item.id) : null;
    if (existing && intent.intent === 'reminder_snooze') {
      this.deps.reminders.snooze(existing.id, when);
      return { intent: 'reminder_snooze', content: `Erinnerung verschoben auf ${when}.`, confidence: 0.9, state };
    }
    const created = !item && intent.intent === 'reminder_create' ? await this.createOpenItem(request, { pending, when }) : null;
    const target = item ?? created?.item ?? null;
    const reminder = this.deps.reminders.create({
      targetType: target ? 'open_item' : 'custom',
      targetId: target?.id ?? null,
      title: target?.title ?? pending?.title ?? extracted.title?.trim() ?? truncate(text, 80),
      remindAt: when,
    });
    return createdReply({ state, when, reminder, target, created });
  }

  /** Asks for the date and remembers the question, so the answer („31.10.“) is understood in context. */
  private askWhen(request: CaptureRequest, scope: { pending: ReminderPending | null; named: OpenItemTarget }): Reply {
    const { text, intent, state } = request;
    const { pending, named } = scope;
    const target = named.item ?? this.lookup.lastOpenItem(state, named);
    const title = pending?.title ?? target?.title ?? intent.reminder?.title?.trim() ?? truncate(text, 80);
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

  /** The open item a reminder without reference belongs to; a longer message is kept as a linked note as well. */
  private async createOpenItem(request: CaptureRequest, scope: { pending: ReminderPending | null; when: string }): Promise<CreatedOpenItem> {
    const { text, intent } = request;
    const { pending, when } = scope;
    const source = (pending?.source ?? text).trim();
    const title = (pending?.title ?? intent.reminder?.title?.trim() ?? truncate(source.replace(/\s+/g, ' '), 100)).slice(0, 160);
    const item = this.deps.openItems.create(
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
    if (source.length <= 120) return { item, note: null };
    const { note } = await this.deps.notes.createUnlessExists({
      content: source,
      links: [{ targetId: item.id, relationType: 'relates_to', confidence: 0.8 }],
    });
    return { item, note: note.name };
  }
}

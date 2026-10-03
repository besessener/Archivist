import { z } from 'zod';
import type { OpenItemPatch } from '@archivist/shared';
import { normalizeDueDate } from '../../util/dates';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolOutput } from '../registry';
import type { ToolDeps, ToolScope } from './common';
import { agentIntent, dueDateArg, entryRef, followUpQuestion } from './knowledge-capture';
import { linkHint } from './link-methods';
import { REMINDER_SNOOZE_UNDO, type ReminderSnoozeUndoData } from './tool-undo';

const CreateArgs = z.object({
  title: z.string().min(1).describe('Kurzer Titel aus Subjekt und Tätigkeit'),
  description: optText,
  responsible: optText,
  dueAt: dueDateArg,
  priority: z.enum(['low', 'normal', 'high']).nullish(),
  topic: optText,
  project: optText,
  sources: list.nullish(),
  ifDuplicate: z.enum(['report', 'create']).default('report'),
});

const UpdateArgs = z.object({
  id: z.string().min(1),
  title: optText,
  description: optText,
  appendDescription: z.boolean().default(true),
  responsible: optText,
  dueAt: dueDateArg,
  priority: z.enum(['low', 'normal', 'high']).nullish(),
  status: z.enum(['open', 'waiting', 'blocked']).nullish(),
});

async function createOpenItem(scope: ToolScope, args: z.output<typeof CreateArgs>): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const result = await deps.capture.forAgent({
    conversationId: ctx.conversationId,
    text: [args.title, args.description].filter(Boolean).join(' – '),
    intent: {
      ...agentIntent('open_item_new', args.title),
      topic: args.topic,
      project: args.project,
      openItem: {
        title: args.title,
        description: args.description,
        responsible: args.responsible,
        dueAt: args.dueAt,
        priority: args.priority ?? null,
        targetId: null,
        targetHint: null,
        newStatus: null,
        resolutionNote: null,
      },
    },
    force: args.ifDuplicate === 'create',
  });
  if (result.openItemId)
    for (const docId of ctx.refs.resolveMany(args.sources ?? []).ids)
      deps.openItems.addSource(result.openItemId, { sourceId: docId, extra: {}, origin: { actor: 'agent', trigger: 'agent' } });
  return {
    content: `${entryRef(ctx, result.openItemId)} ${result.content}${followUpQuestion(result)}${await linkHint(scope, result.openItemId)}`,
    summary: result.openItemId ? 'angelegt' : 'nicht angelegt',
    change: result.openItemId ? `Offener Punkt „${truncate(args.title, 60)}“ angelegt` : undefined,
  };
}

/** Only the given fields; a description is appended to the current one unless told otherwise. */
function openItemPatch(args: z.output<typeof UpdateArgs>, currentDescription: string | null): OpenItemPatch {
  const patch: OpenItemPatch = {};
  if (args.title) patch.title = args.title;
  if (args.description) patch.description = args.appendDescription && currentDescription ? `${currentDescription}\n${args.description}` : args.description;
  if (args.responsible) patch.responsible = args.responsible;
  if (args.dueAt) patch.dueAt = args.dueAt;
  if (args.priority) patch.priority = args.priority;
  if (args.status) patch.status = args.status;
  return patch;
}

function reminderTargetType(deps: ToolDeps, targetId: string | null): 'custom' | 'document' | 'open_item' {
  if (!targetId) return 'custom';
  if (deps.docs.findRow(targetId)) return 'document';
  try {
    deps.openItems.get(targetId);
    return 'open_item';
  } catch {
    return 'custom';
  }
}

async function createReminder({ deps, ctx }: ToolScope, args: { title: string; remindAt: string; target: string | null }): Promise<ToolOutput> {
  const when = normalizeDueDate(args.remindAt) ?? args.remindAt;
  if (!/^\d{4}-\d{2}-\d{2}/.test(when)) return { content: `Ungültiges Datum „${args.remindAt}“ – erwartet YYYY-MM-DD.`, isError: true };
  const targetId = args.target ? ctx.refs.resolve(args.target) : null;
  const targetType = reminderTargetType(deps, targetId);
  const sameTarget = (r: { targetId: string | null; title: string }) =>
    targetId ? r.targetId === targetId : r.title.toLowerCase() === args.title.toLowerCase();
  const duplicate = deps.reminders.list('pending').find((r) => r.remindAt.slice(0, 10) === when.slice(0, 10) && sameTarget(r));
  if (duplicate)
    return {
      content: `Es gibt schon eine Erinnerung „${duplicate.title}“ am ${duplicate.remindAt.slice(0, 10)} – keine zweite angelegt.`,
      summary: 'schon vorhanden',
    };
  const reminder = deps.reminders.create({ targetType, targetId: targetType === 'custom' ? null : targetId, title: args.title, remindAt: when });
  deps.audit.log({
    action: 'reminder.create',
    actor: 'agent',
    trigger: 'agent',
    confirmed: true,
    entityIds: [reminder.id],
    after: { title: reminder.title, remindAt: reminder.remindAt },
  });
  return {
    content: `Erinnerung „${reminder.title}“ am ${reminder.remindAt.slice(0, 16)} angelegt.`,
    summary: `am ${reminder.remindAt.slice(0, 10)}`,
    change: `Erinnerung „${truncate(reminder.title, 50)}“ am ${reminder.remindAt.slice(0, 10)}`,
  };
}

async function snoozeReminder({ deps, ctx }: ToolScope, args: { id: string; remindAt: string }): Promise<ToolOutput> {
  const id = ctx.refs.resolve(args.id);
  const when = normalizeDueDate(args.remindAt) ?? args.remindAt;
  if (!id) return { content: `Unbekannte ID „${args.id}“.`, isError: true };
  const before = deps.reminders.get(id);
  const reminder = deps.reminders.snooze(id, when);
  const undoData: ReminderSnoozeUndoData = { id, before: { remindAt: before.remindAt, status: before.status }, after: { remindAt: reminder.remindAt } };
  deps.audit.log({
    action: 'reminder.snooze',
    actor: 'agent',
    trigger: 'agent',
    confirmed: true,
    entityIds: [id],
    before: { remindAt: before.remindAt },
    after: { remindAt: reminder.remindAt },
    undo: { type: REMINDER_SNOOZE_UNDO, data: undoData },
  });
  return {
    content: `Erinnerung „${reminder.title}“ auf ${reminder.remindAt.slice(0, 16)} verschoben.`,
    summary: 'verschoben',
    change: `Erinnerung „${truncate(reminder.title, 50)}“ verschoben`,
  };
}

/** Open items and reminders. */
export function taskTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'create_open_item',
      description:
        'Einen offenen Punkt anlegen (Dubletten-Prüfung; „ich/mir“ = Benutzer). Gibt es schon einen ähnlichen, wird nichts angelegt und das gemeldet – nach Rückfrage mit ifDuplicate="create" trotzdem anlegen oder update_open_item verwenden. sources: D-IDs der Dokumente, aus denen der Punkt stammt.',
      schema: CreateArgs,
      risk: 'write',
      label: (a) => `Lege den offenen Punkt „${truncate(a.title, 60)}“ an`,
      run: (a, ctx) => createOpenItem({ deps, ctx }, a),
    }),
    defineTool({
      name: 'update_open_item',
      description: 'Einen offenen Punkt (K…) ändern: Titel, Beschreibung (ergänzen), Verantwortlicher, Fälligkeit, Priorität, Status (open, waiting, blocked).',
      schema: UpdateArgs,
      risk: 'write',
      label: () => 'Ändere einen offenen Punkt',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        const patch = openItemPatch(a, deps.openItems.get(id).description);
        if (!Object.keys(patch).length) return { content: 'Nichts zu ändern angegeben.', isError: true };
        const openItem = deps.openItems.update(id, { patch, trigger: 'agent' });
        return {
          content: `${ctx.refs.entry(openItem.id)} „${openItem.title}“ geändert (${Object.keys(patch).join(', ')}).`,
          summary: 'geändert',
          change: `Offener Punkt „${truncate(openItem.title, 60)}“ geändert`,
        };
      },
    }),
    defineTool({
      name: 'close_open_item',
      description: 'Einen offenen Punkt (K…) schließen: resolved (erledigt) oder dismissed (hat sich erledigt), optional mit Lösungsnotiz.',
      schema: z.object({ id: z.string().min(1), status: z.enum(['resolved', 'dismissed']).default('resolved'), note: optText }),
      risk: 'write',
      label: () => 'Schließe einen offenen Punkt',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        const openItem = deps.openItems.close(id, { status: a.status, confirmed: true, trigger: 'agent', resolutionNote: a.note });
        return {
          content: `${ctx.refs.entry(openItem.id)} „${openItem.title}“ ist jetzt ${a.status === 'resolved' ? 'erledigt' : 'verworfen'}.`,
          summary: 'geschlossen',
          change: `Offener Punkt „${truncate(openItem.title, 60)}“ geschlossen`,
        };
      },
    }),
    defineTool({
      name: 'create_reminder',
      description:
        'Eine Erinnerung anlegen. target: K-ID eines offenen Punkts oder D-ID eines Dokuments (optional). remindAt: Datum (YYYY-MM-DD) oder Zeitpunkt. Gibt es für dasselbe Ziel schon eine Erinnerung am selben Tag, wird keine zweite angelegt.',
      schema: z.object({ title: z.string().min(1), remindAt: z.string().min(4), target: optText }),
      risk: 'write',
      label: (a) => `Lege eine Erinnerung an: „${truncate(a.title, 50)}“`,
      run: (a, ctx) => createReminder({ deps, ctx }, a),
    }),
    defineTool({
      name: 'snooze_reminder',
      description: 'Eine bestehende Erinnerung (K…) verschieben.',
      schema: z.object({ id: z.string().min(1), remindAt: z.string().min(4) }),
      risk: 'write',
      label: () => 'Verschiebe eine Erinnerung',
      run: (a, ctx) => snoozeReminder({ deps, ctx }, a),
    }),
  ];
}

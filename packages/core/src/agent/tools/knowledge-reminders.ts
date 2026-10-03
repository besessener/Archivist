import { z } from 'zod';
import { localToday } from '@archivist/shared';
import { normalizeDueDate } from '../../util/dates';
import { truncate } from '../../util/text';
import { optText, type ToolOutput } from '../registry';
import type { ToolDeps, ToolScope } from './common';
import { coverageLookup, deadlineTitlePrefix, reminderDay, type DatedDeadline } from './research/deadline-coverage';
import { DEADLINE_KINDS, DEADLINE_LABEL } from './research/deadlines';

export const ReminderArgs = z.object({
  title: z.string().min(1),
  remindAt: z.string().min(4).nullish().describe('Datum (YYYY-MM-DD) oder Zeitpunkt; bei einer Frist optional (Standard: Vorlauf vor der Frist)'),
  target: optText,
  deadline: z
    .object({ kind: z.enum(DEADLINE_KINDS), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD') })
    .nullish()
    .describe('Frist aus find_deadlines (Art und Datum): verhindert Doppelte je Frist; target muss dann das Dokument (D…) sein'),
});

type ReminderInput = z.output<typeof ReminderArgs>;

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

const refusal = (content: string): ToolOutput => ({ content, isError: true });

/** What a deadline reminder is about: the document, the day and the title that carries the deadline key. */
function deadlinePlan(scope: ToolScope, args: ReminderInput & { deadline: DatedDeadline }): { targetId: string; when: string; title: string } | ToolOutput {
  const { deps, ctx } = scope;
  const targetId = args.target ? ctx.refs.resolve(args.target) : null;
  if (!targetId || !deps.docs.findRow(targetId)) return refusal('Für eine Frist ist target die D-ID des Dokuments (aus find_deadlines) nötig.');
  const today = localToday();
  if (args.deadline.date < today)
    return refusal(`Die Frist am ${args.deadline.date} ist schon vorbei – keine Erinnerung angelegt. Frage den Benutzer, was gelten soll.`);
  const leadDays = deps.settings.get().agent.background.deadlineLeadDays;
  const when = args.remindAt ? (normalizeDueDate(args.remindAt) ?? args.remindAt) : reminderDay({ deadline: args.deadline, leadDays, today });
  if (when.slice(0, 10) > args.deadline.date) return refusal(`Die Erinnerung am ${when.slice(0, 10)} läge nach der Frist am ${args.deadline.date}.`);
  const prefix = deadlineTitlePrefix(args.deadline);
  return { targetId, when, title: args.title.startsWith(prefix) ? args.title : `${prefix}: ${args.title}` };
}

function coveredNote(scope: ToolScope, args: { targetId: string; deadline: DatedDeadline }): string | null {
  const covered = coverageLookup(scope.deps)(args.targetId, args.deadline);
  if (!covered) return null;
  const what =
    covered.by === 'reminder'
      ? `die Erinnerung „${covered.reminder.title}“ am ${covered.reminder.remindAt.slice(0, 10)}`
      : `der offene Punkt ${scope.ctx.refs.entry(covered.openItem.id)} „${covered.openItem.title}“`;
  return `Für die Frist ${DEADLINE_LABEL[args.deadline.kind]} am ${args.deadline.date} gibt es schon ${what} – keine zweite angelegt.`;
}

export async function createReminder(scope: ToolScope, args: ReminderInput): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const plan = args.deadline ? deadlinePlan(scope, { ...args, deadline: args.deadline }) : null;
  if (plan && 'content' in plan) return plan;
  const rawWhen = plan?.when ?? (args.remindAt ? (normalizeDueDate(args.remindAt) ?? args.remindAt) : '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(rawWhen)) return refusal(`Ungültiges Datum „${args.remindAt ?? ''}“ – erwartet YYYY-MM-DD.`);
  const targetId = plan?.targetId ?? (args.target ? ctx.refs.resolve(args.target) : null);
  const title = plan?.title ?? args.title;
  if (plan && args.deadline) {
    const note = coveredNote(scope, { targetId: plan.targetId, deadline: args.deadline });
    if (note) return { content: note, summary: 'schon vorhanden' };
  }
  const sameTarget = (r: { targetId: string | null; title: string }) => (targetId ? r.targetId === targetId : r.title.toLowerCase() === title.toLowerCase());
  const duplicate = deps.reminders.list('pending').find((r) => r.remindAt.slice(0, 10) === rawWhen.slice(0, 10) && sameTarget(r));
  if (duplicate)
    return {
      content: `Es gibt schon eine Erinnerung „${duplicate.title}“ am ${duplicate.remindAt.slice(0, 10)} – keine zweite angelegt.`,
      summary: 'schon vorhanden',
    };
  const targetType = reminderTargetType(deps, targetId);
  const reminder = deps.reminders.create({ targetType, targetId: targetType === 'custom' ? null : targetId, title, remindAt: rawWhen });
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

import { localDate, localToday } from '@archivist/shared';
import type { AppStateService } from '../services/app-state';
import type { NotificationService } from '../services/notifications';
import type { SettingsService } from '../services/settings';
import type { AgentRunService } from './runs';
import type { ToolDeps } from './tools/common';
import { truncate } from '../util/text';

const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Posts a message as Archivist into a conversation of its own (weekly review); returns the conversation id. */
export type PostToConversation = (title: string, content: string, existingId: string | null) => string;

interface Deps {
  settings: SettingsService;
  appState: AppStateService;
  notifications: NotificationService;
  runs: AgentRunService;
  tools: Pick<ToolDeps, 'openItems' | 'reminders' | 'decisions' | 'docs' | 'actions' | 'insights'>;
  post: PostToConversation;
}

/** Remembered „already reported“ keys with the day they were reported (repeated hints are bundled, not sent again). */
function loadReported(appState: AppStateService, key: string): Record<string, string> {
  try {
    return JSON.parse(appState.get(key) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Deadline watcher and weekly review (#314). Both run in the background without the LLM: they only collect what is
 * stored (deadlines as reminders and due dates, open items, proposals, the agent's background runs).
 */
export class DeadlineWatcher {
  constructor(private readonly d: Deps) {}

  /**
   * Upcoming deadlines (due open items, pending reminders within the lead time) and overdue items, reported as ONE
   * notification per day. An item already reported is repeated only once it becomes due within two days or overdue.
   * Returns the number of reported items.
   */
  checkDeadlines(now = new Date()): number {
    const s = this.d.settings.get().agent.background;
    if (!s.deadlineWatch) return 0;
    const today = localToday(now);
    if (this.d.appState.get('agent.deadlines.lastDay') === today) return 0;
    const horizon = addDays(today, s.deadlineLeadDays);
    const soon = addDays(today, 2);
    const reported = loadReported(this.d.appState, 'agent.deadlines.reported');
    const items: Array<{ key: string; day: string; text: string; urgent: boolean }> = [];
    for (const o of this.d.tools.openItems.list({ onlyActive: true })) {
      if (!o.dueAt) continue;
      const due = localDate(o.dueAt);
      if (due > horizon) continue;
      items.push({
        key: `oi:${o.id}`,
        day: due,
        urgent: due <= soon,
        text: due < today ? `überfällig seit ${due}: ${o.title}` : `fällig am ${due}: ${o.title}`,
      });
    }
    for (const r of this.d.tools.reminders.list('pending')) {
      const day = localDate(r.remindAt);
      if (day > horizon || day < today) continue;
      items.push({ key: `rem:${r.id}`, day, urgent: day <= soon, text: `Frist/Erinnerung am ${day}: ${r.title}` });
    }
    const fresh = items.filter((i) => !reported[i.key] || (i.urgent && reported[i.key]! < addDays(today, -1)));
    this.d.appState.set('agent.deadlines.lastDay', today);
    if (!fresh.length) return 0;
    fresh.sort((a, b) => a.day.localeCompare(b.day));
    for (const i of fresh) reported[i.key] = today;
    this.d.appState.set('agent.deadlines.reported', JSON.stringify(reported));
    const overdue = fresh.filter((i) => i.day < today).length;
    this.d.notifications.create({
      title: overdue ? `${overdue} überfällig, ${fresh.length - overdue} stehen an` : `${fresh.length} Frist(en) in den nächsten ${s.deadlineLeadDays} Tagen`,
      description: fresh
        .slice(0, 8)
        .map((i) => i.text)
        .join(' · ')
        .concat(fresh.length > 8 ? ` · und ${fresh.length - 8} weitere` : ''),
      type: 'deadline_watch',
      priority: overdue ? 'high' : 'normal',
      proposedActions: [{ label: 'Offene Punkte', kind: 'navigate', target: '/open-items/' }],
      dedupeKey: `deadlines:${today}`,
    });
    return fresh.length;
  }

  /** Markdown of the weekly review for the 7 days before `now`. */
  reviewText(now = new Date()): { text: string; listed: string[] } {
    const today = localToday(now);
    const since = addDays(today, -7);
    const inWeek = (iso: string | null | undefined) => Boolean(iso) && localDate(iso!) > since && localDate(iso!) <= today;
    const docs = this.d.tools.docs.list({ status: 'archived', limit: 5000 }).filter((d) => inWeek(d.archivedAt));
    const decisions = this.d.tools.decisions.list().filter((d) => inWeek(d.createdAt));
    const items = this.d.tools.openItems.list();
    const closed = items.filter((o) => (o.status === 'resolved' || o.status === 'dismissed') && inWeek(o.updatedAt));
    const created = items.filter((o) => inWeek(o.createdAt));
    const active = items.filter((o) => ['open', 'waiting', 'blocked'].includes(o.status));
    let listedBefore: unknown = [];
    try {
      listedBefore = JSON.parse(this.d.appState.get('agent.review.listed') ?? '[]');
    } catch {
      /* start fresh */
    }
    const previously = new Set<string>(Array.isArray(listedBefore) ? (listedBefore as string[]) : []);
    const stillOpen = active.filter((o) => previously.has(o.id));
    const newlyOpen = active.filter((o) => !previously.has(o.id));
    const horizon = addDays(today, 14);
    const upcoming = [
      ...active.filter((o) => o.dueAt && localDate(o.dueAt) <= horizon).map((o) => `${localDate(o.dueAt!)}: ${o.title}`),
      ...this.d.tools.reminders
        .list('pending')
        .filter((r) => localDate(r.remindAt) <= horizon)
        .map((r) => `${localDate(r.remindAt)}: ${r.title}`),
    ].sort();
    const proposals = this.d.tools.actions.list('proposed').length;
    const insights = this.d.tools.insights.list('open').length;
    const background = this.d.runs.list({ trigger: 'background', limit: 200 }).filter((r) => inWeek(r.startedAt));
    const bgChanges = background.reduce((n, r) => n + r.steps.filter((s) => s.outcome === 'ok' && s.risk !== 'read').length, 0);
    const list = (xs: string[], max = 8) =>
      xs
        .slice(0, max)
        .map((x) => `- ${truncate(x, 120)}`)
        .join('\n') + (xs.length > max ? `\n- … und ${xs.length - max} weitere` : '');
    const text = [
      `## Wochenrückblick ${since} – ${today}`,
      `**Neu archiviert:** ${docs.length} Dokument(e)${docs.length ? `\n${list(docs.map((d) => d.title))}` : ''}`,
      `**Getroffene Entscheidungen:** ${decisions.length}${decisions.length ? `\n${list(decisions.map((d) => d.title))}` : ''}`,
      `**Offene Punkte:** ${closed.length} erledigt, ${created.length} neu, ${active.length} offen${newlyOpen.length ? `\n${list(newlyOpen.map((o) => o.title + (o.dueAt ? ` (fällig ${localDate(o.dueAt)})` : '')))}` : ''}${stillOpen.length ? `\n_Weiterhin offen seit letzter Woche: ${stillOpen.length}_` : ''}`,
      `**Anstehende Fristen (14 Tage):** ${upcoming.length ? `\n${list(upcoming)}` : 'keine'}`,
      `**Offene Vorschläge:** ${proposals} Karte(n), ${insights} Hinweis(e)`,
      `**Im Hintergrund:** ${background.length} Lauf/Läufe, ${bgChanges} Änderung(en)`,
    ].join('\n\n');
    return { text, listed: active.map((o) => o.id) };
  }

  /** Posts the weekly review once per week on the configured weekday. Returns the conversation id or null. */
  weeklyReview(now = new Date()): string | null {
    const s = this.d.settings.get().agent.background;
    if (!s.weeklyReview || now.getDay() !== s.weeklyReviewDay) return null;
    const today = localToday(now);
    const last = this.d.appState.get('agent.review.lastDay');
    if (last && last > addDays(today, -6)) return null;
    const { text, listed } = this.reviewText(now);
    const conv = this.d.post('Wochenrückblick', text, this.d.appState.get('agent.review.conversation'));
    this.d.appState.set('agent.review.conversation', conv);
    this.d.appState.set('agent.review.lastDay', today);
    this.d.appState.set('agent.review.listed', JSON.stringify(listed));
    this.d.notifications.create({
      title: 'Dein Wochenrückblick ist da',
      description: truncate(text.replace(/[#*_]/g, '').replace(/\s+/g, ' '), 300),
      type: 'weekly_review',
      priority: 'low',
      proposedActions: [{ label: 'Rückblick öffnen', kind: 'navigate', target: `/chat/?c=${conv}` }],
      dedupeKey: `weekly-review:${today}`,
    });
    return conv;
  }
}

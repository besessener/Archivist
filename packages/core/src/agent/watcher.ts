import { localDate, localToday } from '@archivist/shared';
import type { AppStateService } from '../services/app-state';
import type { NotificationService } from '../services/notifications';
import type { SettingsService } from '../services/settings';
import type { AgentRunService } from './runs';
import type { ToolDeps } from './tools/common';
import { truncate } from '../util/text';
import { collectDeadlineItems, decisionHref, documentHref, OPEN_ITEMS_HREF, type DeadlineItem } from './watcher-items';
import { loadRemembered, plainReview, reviewList, saveRemembered, type ReviewLine, type ReviewRemembered } from './watcher-review';

const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const REVIEW_HORIZON_DAYS = 14;
const MAX_NOTIFICATION_LINKS = 3;

/** Posts a message as Archivist into a conversation of its own (weekly review); returns the conversation id. */
export type PostToConversation = (message: { title: string; content: string; existingId: string | null }) => string;

interface Deps {
  settings: SettingsService;
  appState: AppStateService;
  notifications: NotificationService;
  runs: AgentRunService;
  tools: Pick<ToolDeps, 'openItems' | 'reminders' | 'decisions' | 'docs' | 'actions' | 'insights' | 'privacy'>;
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

/** Links to the first distinct pages of the items (overdue and earliest first), at most a few. */
function linkActions(items: DeadlineItem[]) {
  const pages = new Map(items.map((i) => [i.href, i]));
  return [...pages.values()].slice(0, MAX_NOTIFICATION_LINKS).map((item) => ({
    label: item.href === OPEN_ITEMS_HREF ? 'Offene Punkte' : `Öffnen: ${truncate(item.title, 40)}`,
    kind: 'navigate' as const,
    target: item.href,
  }));
}

/** Deadline watcher and weekly review (#314), without the LLM: they only collect what is stored. */
export class DeadlineWatcher {
  constructor(private readonly deps: Deps) {}

  /** Due and overdue items as ONE notification per day; a reported item repeats only once due within two days. Returns the count. */
  checkDeadlines(now = new Date()): number {
    const background = this.deps.settings.get().agent.background;
    if (!background.deadlineWatch) return 0;
    const today = localToday(now);
    if (this.deps.appState.get('agent.deadlines.lastDay') === today) return 0;
    const reported = loadReported(this.deps.appState, 'agent.deadlines.reported');
    const items = collectDeadlineItems(this.deps.tools, { today, horizon: addDays(today, background.deadlineLeadDays), soon: addDays(today, 2), now });
    const fresh = items.filter((i) => !reported[i.key] || (i.urgent && reported[i.key]! < addDays(today, -1)));
    this.deps.appState.set('agent.deadlines.lastDay', today);
    this.deps.appState.set('agent.deadlines.reported', JSON.stringify(this.stillRelevant({ items, fresh, reported, today })));
    if (!fresh.length) return 0;
    fresh.sort((a, b) => a.day.localeCompare(b.day));
    const overdue = fresh.filter((i) => i.day < today).length;
    this.deps.notifications.create({
      title: overdue
        ? `${overdue} überfällig, ${fresh.length - overdue} stehen an`
        : `${fresh.length} Frist(en) in den nächsten ${background.deadlineLeadDays} Tagen`,
      description: fresh
        .slice(0, 8)
        .map((i) => i.text)
        .join(' · ')
        .concat(fresh.length > 8 ? ` · und ${fresh.length - 8} weitere` : ''),
      type: 'deadline_watch',
      priority: overdue ? 'high' : 'normal',
      proposedActions: linkActions(fresh),
      dedupeKey: `deadlines:${today}`,
    });
    return fresh.length;
  }

  /** Reported keys of items still in the window; the rest drops out so the state does not grow. */
  private stillRelevant({ items, fresh, reported, today }: { items: DeadlineItem[]; fresh: DeadlineItem[]; reported: Record<string, string>; today: string }) {
    const freshKeys = new Set(fresh.map((i) => i.key));
    const kept: Record<string, string> = {};
    for (const { key } of items) {
      const day = freshKeys.has(key) ? today : reported[key];
      if (day) kept[key] = day;
    }
    return kept;
  }

  /** Markdown of the weekly review for the 7 days before `now`; `listed` is what it mentions (for „weiterhin“ next week). */
  reviewText(now = new Date()): { text: string; listed: ReviewRemembered } {
    const today = localToday(now);
    const since = addDays(today, -7);
    const inWeek = (iso: string | null | undefined) => Boolean(iso) && localDate(iso!) > since && localDate(iso!) <= today;
    const { tools } = this.deps;
    const docs = tools.docs.list({ status: 'archived', limit: 5000 }).filter((d) => inWeek(d.archivedAt));
    const shownDocs = docs.filter((d) => tools.privacy.mayShareDocument(d));
    const decisions = tools.decisions.list().filter((d) => inWeek(d.createdAt));
    const items = tools.openItems.list();
    const closed = items.filter((o) => (o.status === 'resolved' || o.status === 'dismissed') && inWeek(o.updatedAt));
    const created = items.filter((o) => inWeek(o.createdAt));
    const active = items.filter((o) => ['open', 'waiting', 'blocked'].includes(o.status));
    const previously = loadRemembered(this.deps.appState);
    const newlyOpen = active.filter((o) => !previously.openItems.has(o.id));
    const stillOpen = active.length - newlyOpen.length;
    const upcoming = collectDeadlineItems(tools, { today, horizon: addDays(today, REVIEW_HORIZON_DAYS), soon: today, now }).sort((a, b) =>
      a.day.localeCompare(b.day),
    );
    const newUpcoming = upcoming.filter((i) => !previously.deadlines.has(i.key));
    const cardIds = tools.actions.list('proposed').map((a) => a.id);
    const proposalIds = [...cardIds, ...tools.insights.list({ status: 'open' }).map((i) => i.id)];
    const background = this.deps.runs.list({ trigger: 'background', limit: 200 }).filter((r) => inWeek(r.startedAt));
    const backgroundChanges = background.reduce((n, r) => n + r.steps.filter((s) => s.outcome === 'ok' && s.risk !== 'read').length, 0);
    const carried = (count: number, word = 'offen') => (count ? `\n_Weiterhin ${word} seit letzter Woche: ${count}_` : '');
    const text = [
      `## Wochenrückblick ${since} – ${today}`,
      `**Neu archiviert:** ${docs.length} Dokument(e)${shownDocs.length ? `\n${reviewList(shownDocs.map((d) => ({ title: d.title, href: documentHref(d.id) })))}` : ''}${docs.length > shownDocs.length ? `\n_${docs.length - shownDocs.length} nicht freigegeben, ohne Titel_` : ''}`,
      `**Getroffene Entscheidungen:** ${decisions.length}${decisions.length ? `\n${reviewList(decisions.map((d) => ({ title: d.title, href: decisionHref(d.id) })))}` : ''}`,
      `**Offene Punkte:** ${closed.length} erledigt, ${created.length} neu, ${active.length} offen${newlyOpen.length ? `\n${reviewList(newlyOpen.map((o) => ({ title: o.title, href: OPEN_ITEMS_HREF, note: o.dueAt ? ` (fällig ${localDate(o.dueAt)})` : '' })))}` : ''}${carried(stillOpen)}`,
      `**Anstehende Fristen (${REVIEW_HORIZON_DAYS} Tage):** ${newUpcoming.length ? `\n${reviewList(newUpcoming.map((i) => this.upcomingLine(i, today)))}` : upcoming.length ? 'keine neuen' : 'keine'}${carried(upcoming.length - newUpcoming.length, 'anstehend')}`,
      `**Offene Vorschläge:** ${cardIds.length} Karte(n), ${proposalIds.length - cardIds.length} Hinweis(e)${carried(proposalIds.filter((id) => previously.proposals.has(id)).length)}`,
      `**Im Hintergrund:** ${background.length} Lauf/Läufe, ${backgroundChanges} Änderung(en)`,
    ].join('\n\n');
    return { text, listed: { openItems: active.map((o) => o.id), deadlines: upcoming.map((i) => i.key), proposals: proposalIds } };
  }

  private upcomingLine(item: DeadlineItem, today: string): ReviewLine {
    return { title: item.title, href: item.href, note: item.day < today ? ` – überfällig seit ${item.day}` : ` – ${item.day}` };
  }

  /** Posts the weekly review once per week on the configured weekday. Returns the conversation id or null. */
  weeklyReview(now = new Date()): string | null {
    const background = this.deps.settings.get().agent.background;
    if (!background.weeklyReview || now.getDay() !== background.weeklyReviewDay) return null;
    const today = localToday(now);
    const last = this.deps.appState.get('agent.review.lastDay');
    if (last && last > addDays(today, -6)) return null;
    const { text, listed } = this.reviewText(now);
    const conv = this.deps.post({ title: 'Wochenrückblick', content: text, existingId: this.deps.appState.get('agent.review.conversation') });
    this.deps.appState.set('agent.review.conversation', conv);
    this.deps.appState.set('agent.review.lastDay', today);
    saveRemembered(this.deps.appState, listed);
    this.deps.notifications.create({
      title: 'Dein Wochenrückblick ist da',
      description: plainReview(text),
      type: 'weekly_review',
      priority: 'low',
      proposedActions: [{ label: 'Rückblick öffnen', kind: 'navigate', target: `/chat/?c=${conv}` }],
      dedupeKey: `weekly-review:${today}`,
    });
    return conv;
  }
}

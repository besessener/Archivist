import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundSchedule } from '../../packages/core/src/agent/background-schedule';
import { documents } from '../../packages/core/src/db/schema';
import { agentApp, archived, scriptedTurns } from '../helpers/agent';
import type { TestApp } from '../helpers/harness';
import { toolDepsOf } from '../helpers/tool-deps';
import { deadlineWatcher } from '../helpers/watcher';

/** A Monday, the default weekday of the weekly review. */
const MONDAY = new Date('2026-10-05T09:00:00');
const NEXT_MONDAY = new Date('2026-10-12T09:00:00');

let app: TestApp;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MONDAY);
  app = await agentApp();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.cleanup();
});

const watcher = () => deadlineWatcher(app);
const notifications = async (type: string) => (await app.ok('notifications:list', {})).filter((n) => n.type === type);
const openItem = (title: string, dueAt?: string) => app.services.openItems.create({ title, dueAt, priority: 'normal', sourceIds: [], confidence: 0.9 });
const warranty = (name: string, until = '15.10.2026') =>
  archived(app, { name, content: `Küchengerät\nGarantie bis ${until}`, folder: 'Privat/garantien', documentDate: '2026-01-10' });

describe('weekly review (#314)', () => {
  async function fillWeek() {
    const doc = await warranty('toaster.txt');
    await app.ok('decisions:create', {
      decisionText: 'Wir kaufen einen Toaster',
      title: 'Toaster kaufen',
      decidedAt: '2026-10-02',
      participants: [],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
    });
    openItem('Steuer abgeben', '2026-10-12');
    app.services.openItems.close(openItem('Alten Punkt erledigen').id, { status: 'resolved', confirmed: true });
    app.services.reminders.create({ targetType: 'custom', targetId: null, title: 'TÜV', remindAt: '2026-10-08' });
    app.services.actions.propose({
      actionType: 'relocate_documents',
      label: 'Verschieben',
      rationale: 'test',
      confidence: 0.8,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { items: [{ documentId: doc, categoryPath: 'Privat/ziel' }] },
    });
    app.services.insights.upsert({ kind: 'orphan_document', title: 'Dokument ohne Verknüpfung', explanation: 'test', confidence: 0.8, dedupeKey: 'orphan:1' });
    await app.ok('knowledge:createEntity', { type: 'topic', name: 'Küche' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: {} }] },
      { calls: [{ name: 'list_subjects', args: { type: 'topic' } }] },
      { calls: [{ name: 'link', args: { a: 'D1', b: 'K1', onUserRequest: true } }] },
      { text: 'Eine Verknüpfung vorgeschlagen.' },
    );
    await app.services.agent.runBackground('links');
    return doc;
  }

  it('lists what happened in the week with links to the entries', async () => {
    const doc = await fillWeek();

    const { text } = watcher().reviewText(MONDAY);

    expect(text).toContain('## Wochenrückblick 2026-09-28 – 2026-10-05');
    expect(text).toContain(`**Neu archiviert:** 1 Dokument(e)\n- [toaster](/documents/?id=${doc})`);
    expect(text).toMatch(/\*\*Getroffene Entscheidungen:\*\* 1\n- \[Toaster kaufen\]\(\/decisions\/\?id=[^)]+\)/);
    expect(text).toContain('**Offene Punkte:** 1 erledigt, 2 neu, 1 offen\n- [Steuer abgeben](/open-items/) (fällig 2026-10-12)');
    expect(text).toContain('**Offene Vorschläge:** 1 Karte(n), 1 Hinweis(e)');
    expect(text).toContain('**Im Hintergrund:** 1 Lauf/Läufe, 1 Änderung(en)');
  });

  it('includes document deadlines among the upcoming ones, sorted by day', async () => {
    const doc = await fillWeek();

    const { text } = watcher().reviewText(MONDAY);

    expect(text).toContain(
      `**Anstehende Fristen (14 Tage):** \n- [TÜV](/open-items/) – 2026-10-08\n- [Steuer abgeben](/open-items/) – 2026-10-12\n- [Garantie/Gewährleistung: toaster](/documents/?id=${doc}) – 2026-10-15`,
    );
  });

  it('does not list a document deadline that a reminder already stands for, nor one that is not released', async () => {
    const covered = await warranty('mixer.txt', '16.10.2026');
    app.services.reminders.create({ targetType: 'document', targetId: covered, title: 'Garantie/Gewährleistung 16.10.2026: Mixer', remindAt: '2026-10-14' });
    const locked = await warranty('geheim.txt', '17.10.2026');
    app.services.settings.update({ privacy: { llmMode: 'confirm' } });
    app.services.database.db.update(documents).set({ llmStatus: 'pending' }).where(eq(documents.id, locked)).run();

    const { text } = watcher().reviewText(MONDAY);

    expect(text).toContain('Garantie/Gewährleistung 16.10.2026: Mixer');
    expect(text).not.toContain('2026-10-16');
    expect(text).toContain('**Neu archiviert:** 2 Dokument(e)');
    expect(text).toContain('_1 nicht freigegeben, ohne Titel_');
    expect(text).not.toContain('geheim');
    expect(text).not.toContain('2026-10-17');
  });

  it('merges hints repeated from the last review: open items, deadlines and proposals', async () => {
    await fillWeek();
    const w = watcher();
    const conversation = w.weeklyReview(MONDAY)!;

    expect(w.weeklyReview(NEXT_MONDAY)).toBe(conversation);

    const second = (await app.ok('chat:history', { conversationId: conversation })).at(-1)!.content;
    expect(second).toContain('**Anstehende Fristen (14 Tage):** keine neuen\n_Weiterhin anstehend seit letzter Woche: 3_');
    expect(second).toContain('**Offene Vorschläge:** 1 Karte(n), 1 Hinweis(e)\n_Weiterhin offen seit letzter Woche: 2_');
    expect(second).toContain('1 offen\n_Weiterhin offen seit letzter Woche: 1_');
    expect(second).not.toContain('[Steuer abgeben]');
  });

  it('posts once per week on the configured weekday only, and not when switched off', () => {
    const w = watcher();
    expect(w.weeklyReview(new Date('2026-10-06T09:00:00'))).toBeNull();
    app.services.settings.update({ agent: { background: { weeklyReview: false } } });
    expect(w.weeklyReview(MONDAY)).toBeNull();
    app.services.settings.update({ agent: { background: { weeklyReview: true } } });
    const conversation = w.weeklyReview(MONDAY);
    expect(conversation).toBeTruthy();
    expect(w.weeklyReview(new Date('2026-10-05T18:00:00'))).toBeNull();
  });

  it('sends one notification with a plain summary and the link to the review conversation', async () => {
    await fillWeek();
    const conversation = watcher().weeklyReview(MONDAY)!;

    const [note, ...rest] = await notifications('weekly_review');

    expect(rest).toEqual([]);
    expect(note!.proposedActions).toEqual([{ label: 'Rückblick öffnen', kind: 'navigate', target: `/chat/?c=${conversation}` }]);
    expect(note!.description).toContain('Wochenrückblick 2026-09-28 – 2026-10-05');
    expect(note!.description).toContain('toaster');
    expect(note!.description).not.toContain('](');
  });
});

describe('deadline watcher (#314)', () => {
  it('reports an overdue pending reminder', async () => {
    app.services.reminders.create({ targetType: 'custom', targetId: null, title: 'Müll rausstellen', remindAt: '2026-10-01' });

    expect(watcher().checkDeadlines(MONDAY)).toBe(1);

    const [note] = await notifications('deadline_watch');
    expect(note).toMatchObject({ title: '1 überfällig, 0 stehen an', priority: 'high' });
    expect(note!.description).toBe('überfällig seit 2026-10-01: Müll rausstellen');
  });

  it('reports a document deadline within the lead time that nothing stands for, linked to the document', async () => {
    const doc = await warranty('toaster.txt');
    await warranty('alt.txt', '01.10.2026');

    expect(watcher().checkDeadlines(MONDAY)).toBe(1);

    const [note] = await notifications('deadline_watch');
    expect(note!.description).toBe('Frist am 2026-10-15: Garantie/Gewährleistung: toaster');
    expect(note!.proposedActions).toEqual([{ label: 'Öffnen: Garantie/Gewährleistung: toaster', kind: 'navigate', target: `/documents/?id=${doc}` }]);
  });

  it('leaves a document deadline to its reminder or open item and to documents that are not released', async () => {
    const withReminder = await warranty('mixer.txt', '16.10.2026');
    const withItem = await warranty('wasserkocher.txt', '17.10.2026');
    const locked = await warranty('geheim.txt', '18.10.2026');
    app.services.reminders.create({
      targetType: 'document',
      targetId: withReminder,
      title: 'Garantie/Gewährleistung 16.10.2026: Mixer',
      remindAt: '2026-10-14',
    });
    app.services.openItems.create({ title: 'Wasserkocher reklamieren', dueAt: '2026-10-17', priority: 'normal', sourceIds: [withItem], confidence: 0.9 });
    app.services.settings.update({ privacy: { llmMode: 'confirm' } });
    app.services.database.db.update(documents).set({ llmStatus: 'pending' }).where(eq(documents.id, locked)).run();

    expect(watcher().checkDeadlines(MONDAY)).toBe(2);

    const [note] = await notifications('deadline_watch');
    expect(note!.description).toContain('Wasserkocher reklamieren');
    expect(note!.description).toContain('Garantie/Gewährleistung 16.10.2026: Mixer');
    expect(note!.description).not.toContain('geheim');
    expect(note!.description).not.toContain('2026-10-18');
  });

  it.each([
    { leadDays: 14, inside: '2026-10-19', outside: '2026-10-20' },
    { leadDays: 7, inside: '2026-10-12', outside: '2026-10-13' },
    { leadDays: 1, inside: '2026-10-06', outside: '2026-10-07' },
  ])('includes exactly the items within $leadDays days', async ({ leadDays, inside, outside }) => {
    app.services.settings.update({ agent: { background: { deadlineLeadDays: leadDays } } });
    openItem('Innerhalb', inside);
    openItem('Außerhalb', outside);

    expect(watcher().checkDeadlines(MONDAY)).toBe(1);

    const [note] = await notifications('deadline_watch');
    expect(note!.description).toContain('Innerhalb');
    expect(note!.title).toBe(`1 Frist(en) in den nächsten ${leadDays} Tagen`);
  });

  it('links the first distinct pages of what it reports, at most three', async () => {
    const doc = await warranty('toaster.txt');
    openItem('Steuer abgeben', '2026-10-07');
    app.services.reminders.create({ targetType: 'document', targetId: doc, title: 'Garantie prüfen', remindAt: '2026-10-08' });

    watcher().checkDeadlines(MONDAY);

    const [note] = await notifications('deadline_watch');
    expect(note!.proposedActions.map((a) => a.target)).toEqual(['/open-items/', `/documents/?id=${doc}`]);
    expect(note!.proposedActions[0]!.label).toBe('Offene Punkte');
  });

  it('forgets reported keys of items that are no longer relevant', () => {
    const item = openItem('Steuer abgeben', '2026-10-12');
    const w = watcher();
    w.checkDeadlines(MONDAY);
    expect(Object.keys(JSON.parse(app.services.appState.get('agent.deadlines.reported')!) as object)).toEqual([`oi:${item.id}`]);

    app.services.openItems.close(item.id, { status: 'resolved', confirmed: true });
    w.checkDeadlines(new Date('2026-10-06T09:00:00'));

    expect(JSON.parse(app.services.appState.get('agent.deadlines.reported')!)).toEqual({});
  });
});

describe('background tick (#313, #314)', () => {
  const schedule = (queued: string[]) => {
    const deps = { ...toolDepsOf(app), memory: app.services.memory };
    const background = new BackgroundSchedule({
      ctx: app.services.ctx,
      tools: deps,
      appState: app.services.appState,
      runs: app.services.agentRuns,
      memory: app.services.memory,
      llm: app.services.llm,
      isActive: () => true,
    });
    background.start({ enqueue: (kind) => queued.push(kind), post: (message) => app.services.chat.postAssistant(message) });
    return background;
  };

  it('runs watcher, weekly review and the nightly runs once per day with a fixed clock', async () => {
    app.services.settings.update({ agent: { background: { nightlyHour: 2, archiveCheck: true } } });
    openItem('Steuer abgeben', '2026-10-07');
    const queued: string[] = [];
    const background = schedule(queued);
    const night = new Date('2026-10-05T02:00:00');

    background.tick(night);
    background.tick(new Date('2026-10-05T02:10:00'));
    background.stop();

    expect(queued).toEqual(['archive_check', 'links']);
    expect(await notifications('deadline_watch')).toHaveLength(1);
    expect(await notifications('weekly_review')).toHaveLength(1);
    expect(app.services.appState.get('agent.nightly.lastDay')).toBe('2026-10-05');

    const nextNight = schedule(queued);
    nextNight.tick(new Date('2026-10-06T02:00:00'));
    nextNight.stop();
    expect(queued).toEqual(['archive_check', 'links', 'archive_check', 'links']);
    expect(await notifications('weekly_review')).toHaveLength(1);
  });

  it('does a first check shortly after the start, unless it is stopped before', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.setSystemTime(MONDAY);
    schedule([]).stop();
    vi.advanceTimersByTime(60_000);
    expect(app.services.appState.get('agent.deadlines.lastDay')).toBeNull();

    const running = schedule([]);
    vi.advanceTimersByTime(60_000);
    running.stop();
    expect(app.services.appState.get('agent.deadlines.lastDay')).toBe('2026-10-05');
  });
});

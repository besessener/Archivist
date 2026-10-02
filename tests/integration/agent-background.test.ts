import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeadlineWatcher } from '../../packages/core/src/agent/watcher';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, inInbox, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const watcher = () =>
  new DeadlineWatcher({
    settings: app.services.settings,
    appState: app.services.appState,
    notifications: app.services.notifications,
    runs: app.services.agentRuns,
    tools: {
      openItems: app.services.openItems,
      reminders: app.services.reminders,
      decisions: app.services.decisions,
      docs: app.services.documents,
      actions: app.services.actions,
      insights: app.services.insights,
    },
    post: (title, content, existing) => app.services.chat.postAssistant(title, content, existing),
  });

describe('Background agent (#313)', () => {
  it('sorts new inbox files in mode „Auto“ and sends ONE bundled notification with the run', async () => {
    const a = await inInbox(app, 'rechnung-1.txt', 'Rechnung Stadtwerke 120 €');
    const b = await inInbox(app, 'rechnung-2.txt', 'Rechnung Stadtwerke 80 €');
    app.llm.agent = scriptedTurns(
      ({ body }) => {
        expect(String(body.instructions)).toContain('HINTERGRUND');
        expect((body.tools as Array<{ name: string }>).some((t) => t.name === 'ask_user')).toBe(false);
        return { calls: [{ name: 'archive_inbox', args: { documents: ['S1'], mode: 'copy', folder: 'private/rechnungen' } }] };
      },
      { text: 'Zwei Rechnungen nach private/rechnungen archiviert.' },
    );
    const run = await app.services.agent.runBackground('inbox', { docIds: [a, b] });
    expect(run?.status).toBe('done');
    expect(run?.trigger).toBe('background:inbox');
    expect(folderOf(app, a)).toBe('private/rechnungen');
    expect(folderOf(app, b)).toBe('private/rechnungen');
    const notes = (await app.ok('notifications:list', {})).filter((n) => n.type === 'agent_run');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.proposedActions[0]?.target).toContain(run!.id);
    // the run can be undone as a whole
    const undo = await app.ok('agent:undoRun', { runId: run!.id });
    expect(undo.undone).toBe(2);
  });

  it('follows the same mode: „Fragen“ leaves the files in the inbox with a proposal', async () => {
    app.services.settings.update({ agent: { mode: 'ask' } });
    const a = await inInbox(app, 'rechnung.txt', 'Rechnung');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'archive_inbox', args: { documents: ['S1'], folder: 'private/rechnungen' } }] },
      { text: 'Vorschlag gemacht.' },
    );
    await app.services.agent.runBackground('inbox', { docIds: [a] });
    expect(app.services.documents.getRow(a).status).toBe('proposed');
    expect((await app.ok('actions:list', { status: 'proposed' })).some((x) => x.actionType === 'agent_batch')).toBe(true);
    expect((await app.ok('notifications:list', {})).find((n) => n.type === 'agent_run')?.description).toMatch(/Vorschl/);
  });

  it('does nothing without background permission (privacy mode „vorher fragen“) and skips documents already handled', async () => {
    const a = await inInbox(app, 'rechnung.txt', 'Rechnung');
    app.services.settings.update({ privacy: { llmMode: 'confirm' } });
    expect(await app.services.agent.runBackground('inbox', { docIds: [a] })).toBeNull();
    app.services.settings.update({ privacy: { llmMode: 'auto' } });
    app.services.agent.markInboxSeen([a]);
    expect(app.services.agent.inboxCandidates()).not.toContain(a);
  });

  it('a new scan analysis schedules ONE inbox run as a job', async () => {
    const queued: Array<{ kind: string; docIds: string[] }> = [];
    app.services.agent.start({ enqueue: (kind, docIds) => queued.push({ kind, docIds }), post: () => 'x' });
    const a = await inInbox(app, 'neu.txt', 'Neu');
    app.services.agent.scheduleInbox(0);
    app.services.agent.scheduleInbox(0);
    await new Promise((r) => setTimeout(r, 20));
    app.services.agent.stop();
    expect(queued).toEqual([{ kind: 'inbox', docIds: [a] }]);
  });

  it('agentic archive check and links run with their own task; links stay proposals', async () => {
    const doc = await archived(app, 'mietvertrag.txt', 'Mietvertrag', 'private/wohnen');
    const topic = await app.ok('knowledge:createEntity', { type: 'topic', name: 'Wohnung' });
    app.llm.agent = scriptedTurns(
      ({ body }) => {
        expect(String(JSON.stringify(body.input))).toContain('Verknüpfungen pflegen');
        return { calls: [{ name: 'find_documents', args: {} }] };
      },
      { calls: [{ name: 'list_subjects', args: { type: 'topic' } }] },
      { calls: [{ name: 'link', args: { a: 'D1', b: 'K1', onUserRequest: true } }] },
      { text: 'Eine Verknüpfung vorgeschlagen.' },
    );
    await app.services.agent.runBackground('links');
    const rel = app.services.graph.relationsOf(doc).find((r) => r.targetEntityId === topic.entity.id || r.sourceEntityId === topic.entity.id);
    // in the background a link is never „on the user's request“
    expect(rel?.status).toBe('proposed');
    expect(rel?.origin).toBe('agent');
  });
});

describe('Deadline watcher and weekly review (#314)', () => {
  const now = new Date('2026-10-05T09:00:00');

  it('reports upcoming and overdue items once per day, bundled; repeats an item only when it becomes urgent', async () => {
    await app.ok('openItems:create', { title: 'Steuer abgeben', dueAt: '2026-10-12', priority: 'normal', confidence: 0.9 } as never);
    await app.ok('openItems:create', { title: 'Zahnarzt', dueAt: '2026-10-01', priority: 'normal', confidence: 0.9 } as never);
    await app.ok('openItems:create', { title: 'Weit weg', dueAt: '2027-03-01', priority: 'normal', confidence: 0.9 } as never);
    await app.ok('reminders:create', { targetType: 'custom', targetId: null, title: 'TÜV', remindAt: '2026-10-08' });
    const w = watcher();
    expect(w.checkDeadlines(now)).toBe(3);
    const note = (await app.ok('notifications:list', {})).find((n) => n.type === 'deadline_watch')!;
    expect(note.title).toContain('überfällig');
    expect(note.description).toContain('Steuer abgeben');
    expect(note.description).not.toContain('Weit weg');
    expect(w.checkDeadlines(now)).toBe(0); // once per day
    // next day: everything was reported yesterday → bundled, not repeated
    expect(w.checkDeadlines(new Date('2026-10-06T09:00:00'))).toBe(0);
    // later: what is urgent now (Steuer due in two days, the overdue item) is reported again – once
    expect(w.checkDeadlines(new Date('2026-10-10T09:00:00'))).toBe(2);
  });

  it('switched off: no notification', () => {
    app.services.settings.update({ agent: { background: { deadlineWatch: false } } });
    expect(watcher().checkDeadlines(now)).toBe(0);
  });

  it('weekly review: once per week on the configured weekday, in its own conversation, with what was new and what stays open', async () => {
    app.services.settings.update({ agent: { background: { weeklyReviewDay: now.getDay() } } });
    await app.ok('openItems:create', { title: 'Garage aufräumen', priority: 'normal', confidence: 0.9 } as never);
    const w = watcher();
    const conv = w.weeklyReview(now)!;
    expect(conv).toBeTruthy();
    const history = await app.ok('chat:history', { conversationId: conv });
    expect(history.at(-1)!.content).toContain('Wochenrückblick');
    expect(history.at(-1)!.content).toContain('Garage aufräumen');
    expect(w.weeklyReview(now)).toBeNull();
    const nextWeek = new Date('2026-10-12T09:00:00');
    expect(w.weeklyReview(nextWeek)).toBe(conv);
    const again = (await app.ok('chat:history', { conversationId: conv })).at(-1)!.content;
    // repeated hints are bundled, not listed again
    expect(again).toContain('Weiterhin offen seit letzter Woche: 1');
    expect((await app.ok('notifications:list', {})).filter((n) => n.type === 'weekly_review').length).toBeGreaterThanOrEqual(1);
  });
});

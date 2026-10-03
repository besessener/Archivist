import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundLimitsFor } from '../../packages/core/src/agent/background-tasks';
import type { TestApp } from '../helpers/harness';
import { agentApp, folderOf, inInbox, scriptedTurns } from '../helpers/agent';

const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.cleanup();
});

const sql = (query: string, ...params: unknown[]) => app.services.database.sqlite.prepare(query).run(...params);
/** The checkpoint the job stored while it was running – what a crash leaves behind. */
const storedCheckpoint = (jobId: string) =>
  (app.services.database.sqlite.prepare('SELECT result FROM jobs WHERE id = ?').get(jobId) as { result: string }).result;
/** Puts the job back as the next start finds it after a crash. */
const crashJob = (jobId: string, checkpoint: string) =>
  sql("UPDATE jobs SET status = 'running', attempts = 1, cancel_requested = 0, result = ? WHERE id = ?", checkpoint, jobId);
const requestText = (index: number) => JSON.stringify(app.llm.agentRequests[index]?.input ?? '');

describe('Background runs: notification, resume, limits (#313)', () => {
  it('the notification offers „Rückgängig“ for the whole run, next to „Lauf ansehen“', async () => {
    const a = await inInbox(app, { name: 'rechnung-1.txt', content: 'Rechnung 1' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'archive_inbox', args: { documents: ['S1'], mode: 'copy', folder: 'Privat/rechnungen' } }] },
      { text: 'Archiviert.' },
    );
    const run = await app.services.agent.runBackground('inbox', { docIds: [a] });
    const note = (await app.ok('notifications:list', {})).find((n) => n.type === 'agent_run')!;
    expect(note.proposedActions.map((x) => x.kind)).toEqual(['navigate', 'undo_run']);
    const undo = note.proposedActions.find((x) => x.kind === 'undo_run')!;
    expect(undo).toMatchObject({ label: 'Rückgängig', target: run!.id });
    const result = await app.ok('agent:undoRun', { runId: undo.target! });
    expect(result.undone).toBe(1);
    expect(app.services.documents.getRow(a).status).toBe('proposed');
  });

  it('an interrupted inbox job resumes after a restart without analysing the finished documents again', async () => {
    const a = await inInbox(app, { name: 'rechnung-a.txt', content: 'Rechnung A' });
    const b = await inInbox(app, { name: 'rechnung-b.txt', content: 'Rechnung B' });
    const jobs = app.services.jobs;
    let checkpoint = '';
    const job = jobs.enqueue('agent.background', { label: 'Test', payload: { kind: 'inbox', docIds: [a, b] }, maxAttempts: 2 });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'rechnung-a', status: 'inbox' } }] },
      { calls: [{ name: 'archive_inbox', args: { documents: ['D1'], mode: 'copy', folder: 'Privat/rechnungen' } }] },
      () => {
        checkpoint = storedCheckpoint(job.id);
        jobs.cancel(job.id); // the app goes down while the run works on the second document
        return { calls: [{ name: 'find_documents', args: { name: 'rechnung-b', status: 'inbox' } }] };
      },
      { text: 'unterbrochen' },
    );
    await jobs.whenIdle(10_000);
    expect(app.services.documents.getRow(a).status).toBe('archived');
    expect(app.services.documents.getRow(b).status).toBe('proposed');
    // not marked as seen: the run did not finish its decision about b
    expect(app.services.agent.inboxCandidates()).toEqual([b]);

    // next start: the job is resumed with the same payload
    await jobs.stop();
    crashJob(job.id, checkpoint);
    const before = app.llm.agentRequests.length;
    app.llm.agent = scriptedTurns({ text: 'b bleibt im Eingang.' });
    jobs.start();
    await jobs.whenIdle(10_000);
    const resumed = requestText(before);
    expect(resumed).toContain('(1 Dokument(e))');
    expect(app.llm.agentRequests.length - before).toBe(1);
    expect(app.services.agent.inboxCandidates()).toEqual([]);
  });

  it('a resumed archive check is told what the interrupted attempt had already done', async () => {
    const jobs = app.services.jobs;
    let checkpoint = '';
    const job = jobs.enqueue('agent.background', { label: 'Test', payload: { kind: 'archive_check' }, maxAttempts: 2 });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'archive_overview', args: {} }] }, () => {
      checkpoint = storedCheckpoint(job.id);
      jobs.cancel(job.id);
      return { calls: [{ name: 'problem_files', args: {} }] };
    });
    await jobs.whenIdle(10_000);
    await jobs.stop();
    crashJob(job.id, checkpoint);
    const before = app.llm.agentRequests.length;
    app.llm.agent = scriptedTurns({ text: 'fertig' });
    jobs.start();
    await jobs.whenIdle(10_000);
    const resumed = requestText(before);
    expect(resumed).toContain('schon erledigt');
    expect(resumed).toContain('Agentische Archivprüfung');
    expect(resumed).toContain('- Verschaffe');
  });

  it('an archive check run uses its own task and trigger and cannot ask', async () => {
    app.llm.agent = scriptedTurns(({ body }) => {
      expect((body.tools as Array<{ name: string }>).some((t) => t.name === 'ask_user')).toBe(false);
      expect(JSON.stringify(body.input)).toContain('Agentische Archivprüfung');
      return { text: 'Nichts zu tun.' };
    });
    const run = await app.services.agent.runBackground('archive_check');
    expect(run).toMatchObject({ trigger: 'background:archive_check', status: 'done' });
  });

  it('limits per trigger override the general background limits; the rest falls back', async () => {
    const agent = app.services.settings.get().agent;
    const general = { maxRounds: 80, maxTokens: 2_000_000, timeoutMs: 45 * 60_000 };
    expect(backgroundLimitsFor(agent, 'background:inbox')).toEqual(general);
    app.services.settings.update({ agent: { backgroundKindLimits: { inbox: { maxRounds: 1 }, workflow: { maxTokens: 9_000 } } } });
    const tuned = app.services.settings.get().agent;
    expect(backgroundLimitsFor(tuned, 'background:inbox')).toEqual({ ...general, maxRounds: 1 });
    expect(backgroundLimitsFor(tuned, 'background:workflow')).toEqual({ ...general, maxTokens: 9_000 });
    expect(backgroundLimitsFor(tuned, 'background:links')).toEqual(general);

    const a = await inInbox(app, { name: 'rechnung.txt', content: 'Rechnung' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'document_details', args: { documents: ['D1'] } }] });
    const run = await app.services.agent.runBackground('inbox', { docIds: [a] });
    expect(run?.status).toBe('limit');
  });
});

describe('Schedules (#313)', () => {
  it('every analyzed document of an import schedules the inbox run', async () => {
    const scheduled = vi.spyOn(app.services.agent, 'scheduleInbox');
    await inInbox(app, { name: 'import.txt', content: 'Import' });
    expect(scheduled).toHaveBeenCalled();
  });

  it('debounces: ONE inbox run 20 seconds after the last analysis', async () => {
    const a = await inInbox(app, { name: 'neu.txt', content: 'Neu' });
    const queued: Array<{ kind: string; docIds: string[] }> = [];
    app.services.agent.start({ enqueue: (kind, docIds) => queued.push({ kind, docIds }), post: () => 'x' });
    fakeClock();
    app.services.agent.scheduleInbox();
    await vi.advanceTimersByTimeAsync(15_000);
    app.services.agent.scheduleInbox(); // another file: the wait starts over
    await vi.advanceTimersByTimeAsync(15_000);
    expect(queued).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queued).toEqual([{ kind: 'inbox', docIds: [a] }]);
    app.services.agent.stop();
  });

  it('nightly tick at the configured hour runs archive check, links and the workflows of that weekday – once a day', async () => {
    app.services.settings.update({ agent: { background: { nightlyHour: 3, archiveCheck: true, links: true, deadlineWatch: false, weeklyReview: false } } });
    const monday = app.services.memory.save({ kind: 'workflow', name: 'Montags', content: 'Montagsablauf', data: { steps: ['a'], scheduleWeekday: 1 } });
    app.services.memory.save({ kind: 'workflow', name: 'Dienstags', content: 'Dienstagsablauf', data: { steps: ['b'], scheduleWeekday: 2 } });
    const queued: string[] = [];
    fakeClock();
    vi.setSystemTime(new Date('2026-10-05T02:50:00')); // a Monday
    app.services.agent.start({ enqueue: (kind) => queued.push(kind), post: () => 'x' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toEqual([]); // not the hour yet
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 30_000);
    expect(queued).toEqual(['archive_check', 'links', `workflow:${monday.id}`]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(queued).toHaveLength(3); // the same night only once
    app.services.agent.stop();
  });

  it('a scheduled workflow does not run with a disabled workflow or without a nightly hour', async () => {
    const wf = app.services.memory.save({ kind: 'workflow', name: 'Montags', content: 'x', data: { steps: ['a'], scheduleWeekday: 1 } });
    app.services.memory.update(wf.id, { enabled: false });
    app.services.settings.update({ agent: { background: { nightlyHour: 3, archiveCheck: false, links: false, deadlineWatch: false, weeklyReview: false } } });
    const queued: string[] = [];
    fakeClock();
    vi.setSystemTime(new Date('2026-10-05T03:05:00'));
    app.services.agent.start({ enqueue: (kind) => queued.push(kind), post: () => 'x' });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(queued).toEqual([]);
    app.services.agent.stop();
  });
});

describe('Inbox run applies learned rules (#313, #315)', () => {
  const rule = { when: { docType: 'Rechnung' }, then: { folder: 'Privat/finanzen/energie', tags: ['Strom'] } };

  it('mode „Auto“: a rule files the inbox document into its folder with its tags', async () => {
    app.services.memory.save({ kind: 'rule', name: 'Rechnung → Energie', content: 'Rechnungen nach energie', data: rule });
    const a = await inInbox(app, { name: 'rechnung.txt', content: 'Rechnung Strom' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'apply_rules', args: { documents: ['S1'], preview: false } }] }, { text: 'Regel angewendet.' });
    const run = await app.services.agent.runBackground('inbox', { docIds: [a] });
    expect(run?.status).toBe('done');
    expect(folderOf(app, a)).toBe('Privat/finanzen/energie');
    expect(app.services.documents.get(a).tags).toContain('Strom');
    expect(run?.applied.map((x) => x.label)).toContain('Rechnung → Energie');
    expect((await app.ok('agent:undoRun', { runId: run!.id })).undone).toBeGreaterThan(0);
  });

  it('mode „Fragen“: the rule becomes a proposal and the document stays in the inbox until confirmed', async () => {
    app.services.settings.update({ agent: { mode: 'ask' } });
    app.services.memory.save({ kind: 'rule', name: 'Rechnung → Energie', content: 'Rechnungen nach energie', data: rule });
    const a = await inInbox(app, { name: 'rechnung.txt', content: 'Rechnung Strom' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'apply_rules', args: { documents: ['S1'], preview: false } }] }, { text: 'Vorschlag.' });
    await app.services.agent.runBackground('inbox', { docIds: [a] });
    expect(app.services.documents.getRow(a).status).toBe('proposed');
    const card = (await app.ok('actions:list', { status: 'proposed' })).find((x) => x.actionType === 'agent_batch')!;
    expect(card).toBeTruthy();
    await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });
    expect(folderOf(app, a)).toBe('Privat/finanzen/energie');
  });
});

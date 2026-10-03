import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@archivist/shared';
import { FILE_JOB_TYPE, type FileJobPayload } from '../../packages/core/src/agent/file-jobs';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, inInbox, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
  // small numbers instead of 50 files per job and 25 per chunk – the logic is the same
  app.services.agentFileJobs.threshold = 2;
  app.services.agentFileJobs.chunk = 2;
});
afterEach(async () => {
  await app.cleanup();
});

const fileJobs = (): Job[] => app.services.jobs.list().filter((j) => j.type === FILE_JOB_TYPE);
const relocations = (runId: string) => app.services.audit.forRun(runId).filter((e) => e.action === 'archive.relocate');

async function slides(n: number, from = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = from; i < from + n; i += 1) ids.push(await archived(app, { name: `folie-${i}.md`, content: `Folie ${i}`, folder: 'work/misc' }));
  return ids;
}

const moveScript = () =>
  scriptedTurns(
    { calls: [{ name: 'find_documents', args: { name: 'folie' } }] },
    { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'work/presentations' } }] },
    { text: 'Verschoben.' },
  );

describe('Large file operations as a job of their own (#304)', () => {
  it('runs as ONE job under the run id: every change carries it, the step shows the progress, the job links to the run', async () => {
    const ids = await slides(5);
    app.llm.agent = moveScript();
    const progress: Array<{ done: number; total: number; id: string | null }> = [];
    app.services.events.on('agent:progress', (p: { steps: Array<{ tool: string; job?: { done: number; total: number; id: string | null } }> }) => {
      const job = p.steps.find((s) => s.tool === 'move_documents')?.job;
      if (job) progress.push(job);
    });
    const res = await app.ok('chat:send', { text: 'Verschiebe alle Folien nach work/presentations' });
    const runId = res.assistantMessage.runId!;
    for (const id of ids) expect(folderOf(app, id)).toBe('work/presentations');

    // exactly one job – not one per chunk – finished, and it names the run
    const jobs = fileJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'succeeded', runId, summary: '5 von 5 erledigt' });
    expect((await app.ok('jobs:list', { limit: 50 })).find((j) => j.id === jobs[0]!.id)?.runId).toBe(runId);

    // every change of the job carries the run id and is the agent's
    const audit = relocations(runId);
    expect(audit).toHaveLength(5);
    expect(audit.every((e) => e.actor === 'agent')).toBe(true);

    // the step of the run: done, with the job's progress and all audit entries (undo per step)
    const run = await app.ok('agent:run', { id: runId });
    const step = run.steps.find((s) => s.tool === 'move_documents')!;
    expect(step.outcome).toBe('ok');
    expect(step.job).toEqual({ id: jobs[0]!.id, done: 5, total: 5 });
    expect((step.auditIds ?? []).toSorted()).toEqual(audit.map((e) => e.id).toSorted());
    expect(step.result).toContain('als eigener Auftrag ausgeführt');
    // the live view got the job step with growing progress
    expect(progress.some((p) => p.id === jobs[0]!.id && p.done < 5)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ done: 5, total: 5 });

    // undo per step takes back the whole job
    const undo = await app.ok('agent:undoStep', { runId, stepId: step.id });
    expect(undo).toMatchObject({ undone: 5, failed: 0 });
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
  });

  it('„Lauf rückgängig“ undoes the job together with the other changes of the run', async () => {
    const ids = await slides(3);
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'folie' } }] },
      {
        calls: [
          { name: 'move_documents', args: { documents: ['S1'], folder: 'work/presentations' } },
          { name: 'create_open_item', args: { title: 'Folien prüfen' } },
        ],
      },
      { text: 'ok' },
    );
    const res = await app.ok('chat:send', { text: 'Verschiebe die Folien und leg einen Punkt an' });
    expect(fileJobs()).toHaveLength(1);
    const undo = await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(undo.failed).toBe(0);
    expect(undo.undone).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
    expect((await app.ok('openItems:list', {})).map((o) => o.title)).not.toContain('Folien prüfen');
  });

  it('„Stopp“ cancels the job between two chunks; what is done stays and stays undoable', async () => {
    const ids = await slides(6);
    app.llm.agent = moveScript();
    // stop as soon as the job has done its first chunk
    app.services.events.on('job:updated', (j: Job) => {
      if (j.type === FILE_JOB_TYPE && j.status === 'running' && (j.progress ?? 0) > 0 && (j.progress ?? 0) < 1) app.services.chat.cancel();
    });
    const res = await app.ok('chat:send', { text: 'Verschiebe alle Folien nach work/presentations' });
    const runId = res.assistantMessage.runId!;
    expect(res.assistantMessage.content).toContain('Abgebrochen');
    const moved = ids.filter((id) => folderOf(app, id) === 'work/presentations');
    expect(moved).toHaveLength(2);
    expect(fileJobs()[0]).toMatchObject({ status: 'cancelled', runId });
    const run = await app.ok('agent:run', { id: runId });
    expect(run.status).toBe('cancelled');
    const step = run.steps.find((s) => s.tool === 'move_documents')!;
    expect(step.result).toContain('4 wegen Abbruch nicht mehr bearbeitet');
    expect(step.auditIds).toHaveLength(2);
    expect(relocations(runId)).toHaveLength(2);
    const undo = await app.ok('agent:undoRun', { runId });
    expect(undo).toMatchObject({ undone: 2, failed: 0 });
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
  });

  it('a stop before the job could start (queue busy) cancels it without touching a file', async () => {
    const ids = await slides(3);
    // the queue is paused: the job waits as pending
    await app.services.jobs.stop();
    app.llm.agent = moveScript();
    const sent = app.ok('chat:send', { text: 'Verschiebe alle Folien nach work/presentations' });
    for (let i = 0; i < 200 && !fileJobs().length; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(fileJobs()[0]?.status).toBe('pending');
    app.services.chat.cancel();
    const res = await sent;
    expect(res.assistantMessage.content).toContain('Abgebrochen');
    expect(fileJobs()[0]?.status).toBe('cancelled');
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
    app.services.jobs.start();
  });

  it('mode „Fragen“ and the mass-action threshold still apply: a proposal first, the confirmed card then runs as a job of the run', async () => {
    const ids = await slides(3);
    app.services.settings.update({ agent: { mode: 'ask' } });
    app.llm.agent = moveScript();
    const res = await app.ok('chat:send', { text: 'Verschiebe alle Folien nach work/presentations' });
    // nothing moved, no job: only the card
    expect(fileJobs()).toHaveLength(0);
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
    const card = res.assistantMessage.actions.find((x) => x.actionType === 'agent_batch')!;
    const done = await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });
    expect(done.status).toBe('executed');
    const runId = res.assistantMessage.runId!;
    expect(fileJobs()).toHaveLength(1);
    expect(fileJobs()[0]).toMatchObject({ status: 'succeeded', runId });
    for (const id of ids) expect(folderOf(app, id)).toBe('work/presentations');
    expect(relocations(runId)).toHaveLength(3);
    const undo = await app.ok('agent:undoRun', { runId });
    expect(undo).toMatchObject({ undone: 3, failed: 0 });

    // „Auto“, but above the mass-action threshold: again only a proposal, no job
    app.services.settings.update({ agent: { mode: 'auto', massActionThreshold: 2 } });
    app.llm.agent = moveScript();
    const again = await app.ok('chat:send', { text: 'Verschiebe alle Folien nach work/presentations' });
    expect(again.assistantMessage.actions.some((x) => x.actionType === 'agent_batch')).toBe(true);
    expect(fileJobs()).toHaveLength(1);
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
  });

  it('small amounts stay inline; a background run (already a job) reports its progress instead of starting another job', async () => {
    const [one] = await slides(1);
    app.llm.agent = moveScript();
    await app.ok('chat:send', { text: 'Verschiebe die Folie nach work/presentations' });
    expect(folderOf(app, one!)).toBe('work/presentations');
    expect(fileJobs()).toHaveLength(0);

    const more = await slides(4, 2);
    const reports: string[] = [];
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'folie', folder: 'work/misc' } }] },
      { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'work/archiv' } }] },
      { text: 'ok' },
    );
    const run = await app.services.agent.runBackground('archive_check', { report: (_p, m) => reports.push(m) });
    expect(run?.status).toBe('done');
    for (const id of more) expect(folderOf(app, id)).toBe('work/archiv');
    expect(fileJobs()).toHaveLength(0);
    expect(reports).toEqual(['2 von 4 Dateien', '4 von 4 Dateien']);
    expect(relocations(run!.id)).toHaveLength(4);
  });

  it('quitting interrupts the job instead of cancelling it: it continues after the next start and its changes join the step', async () => {
    const ids = await slides(6);
    app.llm.agent = moveScript();
    const quit: { done: Promise<unknown> | null } = { done: null };
    app.services.events.on('job:updated', (j: Job) => {
      if (quit.done || j.type !== FILE_JOB_TYPE || j.status !== 'running' || !((j.progress ?? 0) > 0)) return;
      // the order of `shutdown()`: the agent first, then the queue
      app.services.agent.stop();
      quit.done = app.services.jobs.interrupt(5_000);
    });
    const res = await app.ok('chat:send', { text: 'Verschiebe alle Folien nach work/presentations' });
    await quit.done;
    const runId = res.assistantMessage.runId!;
    expect(fileJobs()[0]).toMatchObject({ status: 'pending', runId });
    let step = (await app.ok('agent:run', { id: runId })).steps.find((s) => s.tool === 'move_documents')!;
    expect(step.result).toContain('folgen nach dem nächsten Start');
    expect(step.auditIds).toHaveLength(2);

    // next start: the job continues from its checkpoint – without the run, under its id
    app.services.jobs.start();
    await app.services.jobs.whenIdle();
    for (const id of ids) expect(folderOf(app, id)).toBe('work/presentations');
    expect(fileJobs()[0]).toMatchObject({ status: 'succeeded', runId });
    expect(relocations(runId)).toHaveLength(6);
    step = (await app.ok('agent:run', { id: runId })).steps.find((s) => s.tool === 'move_documents')!;
    expect(step.auditIds).toHaveLength(6);
    const undo = await app.ok('agent:undoStep', { runId, stepId: step.id });
    expect(undo).toMatchObject({ undone: 6, failed: 0 });
  });

  it('a job continued after a restart (no waiting run any more) still logs under the run and adds to the step', async () => {
    const ids = await slides(3);
    // a finished run with the step that had started the job
    const runId = app.services.agentRuns.start({ conversationId: null, trigger: 'chat', task: 'x', provider: 'openai', model: 'm', mode: 'auto' });
    const stepId = 'step-1';
    app.services.agentRuns.finish(runId, {
      status: 'cancelled',
      summary: '',
      steps: [
        {
          id: stepId,
          round: 1,
          tool: 'move_documents',
          risk: 'write',
          label: 'Verschiebe',
          summary: '',
          outcome: 'ok',
          result: '',
          auditIds: [],
          actionId: null,
          startedAt: new Date().toISOString(),
          durationMs: null,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, retries: 0 },
      costUsd: null,
      rounds: 1,
      applied: [],
      files: [],
      error: null,
    });
    app.services.jobs.enqueue<FileJobPayload>(FILE_JOB_TYPE, {
      label: 'Fortsetzung',
      payload: {
        runId,
        stepId,
        explicit: true,
        op: 'relocate',
        items: ids.map((documentId) => ({ documentId, categoryPath: 'work/presentations' })),
      },
    });
    await app.services.jobs.whenIdle();
    for (const id of ids) expect(folderOf(app, id)).toBe('work/presentations');
    expect(relocations(runId)).toHaveLength(3);
    const step = (await app.ok('agent:run', { id: runId })).steps[0]!;
    expect(step.auditIds).toHaveLength(3);
    const undo = await app.ok('agent:undoStep', { runId, stepId });
    expect(undo).toMatchObject({ undone: 3, failed: 0 });
    for (const id of ids) expect(folderOf(app, id)).toBe('work/misc');
  });

  it('archiving many inbox documents also runs as one job under the run id, undoable as a whole', async () => {
    const ids = [
      await inInbox(app, { name: 'brief-1.txt', content: 'Brief 1' }),
      await inInbox(app, { name: 'brief-2.txt', content: 'Brief 2' }),
      await inInbox(app, { name: 'brief-3.txt', content: 'Brief 3' }),
    ];
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { status: 'inbox' } }] },
      { calls: [{ name: 'archive_inbox', args: { documents: ['S1'], folder: 'private/post' } }] },
      { text: 'Archiviert.' },
    );
    const res = await app.ok('chat:send', { text: 'Leg alle Briefe im Eingang unter private/post ab' });
    for (const id of ids) expect(folderOf(app, id)).toBe('private/post');
    const jobs = fileJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'succeeded', runId: res.assistantMessage.runId });
    expect(app.services.audit.forRun(res.assistantMessage.runId!).filter((e) => e.action === 'archive.copy')).toHaveLength(3);
    const undo = await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(undo.undone).toBe(3);
    for (const id of ids) expect(app.services.documents.getRow(id).status).not.toBe('archived');
  });
});

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool, ToolContext, ToolOutput } from '../../packages/core/src/agent/registry';
import { researchTools } from '../../packages/core/src/agent/tools/research';
import { taskTools } from '../../packages/core/src/agent/tools/knowledge-tasks';
import { documents } from '../../packages/core/src/db/schema';
import { archived, emptyToolContext } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';
import { toolDepsOf } from '../helpers/tool-deps';

const CONTRACT = 'Mobilfunkvertrag\nVertragsende: 31.12.2026\nKündigungsfrist 3 Monate zum Vertragsende.';
const NOTICE = { kind: 'kuendigung', date: '2026-09-30' };

let app: TestApp;
let tools: Map<string, AgentTool>;
let ctx: ToolContext;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T10:00:00'));
  app = await createTestApp({ privacy: 'auto' });
  const deps = toolDepsOf(app);
  tools = new Map([...researchTools(deps), ...taskTools(deps)].map((t) => [t.name, t]));
  ctx = emptyToolContext();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.cleanup();
});

async function call(name: string, args: unknown): Promise<ToolOutput> {
  const tool = tools.get(name)!;
  return tool.run(tool.schema.parse(args), ctx);
}

const archive = (name: string, content: string, documentDate = '2024-12-01') => archived(app, { name, content, folder: 'Privat/vertraege', documentDate });
const pendingReminders = () => app.services.reminders.list('pending');

describe('deadline to reminder', () => {
  it('creates a reminder linked to the document at the lead time before the deadline, once per deadline', async () => {
    const id = await archive('handyvertrag.txt', CONTRACT);
    const target = ctx.refs.doc(id);

    const first = await call('create_reminder', { title: 'Handyvertrag kündigen', target, deadline: NOTICE });
    const reminder = pendingReminders().at(-1)!;
    expect(first.content).toContain('angelegt');
    expect(reminder).toMatchObject({
      targetType: 'document',
      targetId: id,
      remindAt: '2026-09-16',
      title: 'Kündigungsfrist 30.09.2026: Handyvertrag kündigen',
    });

    const second = await call('create_reminder', { title: 'Noch eine Erinnerung', target, deadline: NOTICE, remindAt: '2026-09-20' });
    expect(second.content).toContain('keine zweite angelegt');
    expect(pendingReminders()).toHaveLength(1);
  });

  it('uses the changed lead time from the settings, but never a day in the past', async () => {
    const id = await archive('handyvertrag.txt', CONTRACT);
    app.services.settings.update({ agent: { background: { deadlineLeadDays: 5 } } });
    await call('create_reminder', { title: 'Kündigen', target: ctx.refs.doc(id), deadline: NOTICE });
    expect(pendingReminders()[0]!.remindAt).toBe('2026-09-25');

    app.services.settings.update({ agent: { background: { deadlineLeadDays: 60 } } });
    await call('create_reminder', { title: 'Versicherung', target: ctx.refs.doc(id), deadline: { kind: 'ablauf', date: '2026-12-31' } });
    expect(pendingReminders().find((r) => r.title.startsWith('Ablauf'))?.remindAt).toBe('2026-11-01');
    await call('create_reminder', { title: 'Knapp', target: ctx.refs.doc(id), deadline: { kind: 'faelligkeit', date: '2026-09-10' } });
    expect(pendingReminders().find((r) => r.title.startsWith('Fälligkeit'))?.remindAt).toBe('2026-09-01');
  });

  it('refuses a deadline that is over, a missing document and a reminder after the deadline', async () => {
    const id = await archive('handyvertrag.txt', CONTRACT);
    const target = ctx.refs.doc(id);
    expect((await call('create_reminder', { title: 'x', target, deadline: { kind: 'kuendigung', date: '2026-08-01' } })).content).toContain('schon vorbei');
    expect((await call('create_reminder', { title: 'x', deadline: NOTICE })).isError).toBe(true);
    expect((await call('create_reminder', { title: 'x', target, deadline: NOTICE, remindAt: '2026-10-05' })).content).toContain('nach der Frist');
    expect((await call('create_reminder', { title: 'x' })).isError).toBe(true);
    expect(pendingReminders()).toHaveLength(0);
  });

  it('counts an open item of the document with the same due date as covering the deadline', async () => {
    const id = await archive('handyvertrag.txt', CONTRACT);
    const item = app.services.openItems.create({ title: 'Handy kündigen', dueAt: '2026-09-30', priority: 'normal', sourceIds: [id], confidence: 0.9 });

    const out = await call('create_reminder', { title: 'Kündigen', target: ctx.refs.doc(id), deadline: NOTICE });

    expect(out.content).toContain(`der offene Punkt ${ctx.refs.entry(item.id)}`);
    expect(pendingReminders()).toHaveLength(0);
    expect((await call('find_deadlines', { documents: [ctx.refs.doc(id)] })).content).toContain('offener Punkt vorhanden');
  });

  it('still prevents a second reminder for the same target on the same day', async () => {
    const id = await archive('handyvertrag.txt', CONTRACT);
    const target = ctx.refs.doc(id);
    await call('create_reminder', { title: 'Anrufen', target, remindAt: '2026-09-16' });
    const out = await call('create_reminder', { title: 'Kündigen', target, deadline: NOTICE });
    expect(out.content).toContain('Erinnerung „Anrufen“');
    expect(pendingReminders()).toHaveLength(1);
  });
});

describe('find_deadlines', () => {
  it('marks every deadline of a document on its own: one reminder covers one of two deadlines', async () => {
    const id = await archive('handyvertrag.txt', CONTRACT);
    await call('create_reminder', { title: 'Kündigen', target: ctx.refs.doc(id), deadline: NOTICE });

    const out = await call('find_deadlines', { documents: [ctx.refs.doc(id)] });

    expect(out.content).toMatch(/Kündigungsfrist: 2026-09-30 \(Art: kuendigung\) \| Erinnerung vorhanden \(2026-09-16\)/);
    expect(out.content).toMatch(/Ablauf\/Vertragsende: 2026-12-31 \(Art: ablauf\) \| keine Erinnerung/);
  });

  it('checks all archived documents without a list, leaves past deadlines out and says what it scanned', async () => {
    await archive('handyvertrag.txt', CONTRACT);
    await archive('alt.txt', 'Garantie bis 31.12.2020', '2019-01-01');
    await archive('brief.txt', 'Ein Brief ohne Frist.');

    const out = await call('find_deadlines', {});

    expect(out.summary).toBe('2 Frist(en) erkannt');
    expect(out.content).toContain('Geprüft: 3 von 3 freigegebenen archivierten Dokumenten.');
    expect(out.content).toContain('1 bereits vorbeigegangene Fristen ausgelassen');
    expect(out.content).not.toContain('2020-12-31');
  });

  it('names documents that are not released only by count and reference, without title, date or passage', async () => {
    const open = await archive('handyvertrag.txt', CONTRACT);
    const locked = await archive('ausweis.txt', 'Personalausweis Max Muster\nGültig bis 14.02.2031');
    app.services.settings.update({ privacy: { llmMode: 'confirm' } });
    app.services.database.db.update(documents).set({ llmStatus: 'analyzed' }).where(eq(documents.id, open)).run();
    app.services.database.db.update(documents).set({ llmStatus: 'pending' }).where(eq(documents.id, locked)).run();

    for (const args of [{}, { documents: [ctx.refs.doc(open), ctx.refs.doc(locked)] }]) {
      const out = await call('find_deadlines', args);
      expect(out.content).toContain(`1 nicht freigegebene Dokumente übersprungen (nicht geprüft): ${ctx.refs.doc(locked)}.`);
      for (const secret of ['ausweis', 'Personalausweis', '2031', 'Max Muster']) expect(out.content).not.toContain(secret);
      expect(out.content).toContain('2026-09-30');
    }
  });

  it('lists at most 60 deadlines and counts the rest', async () => {
    const lines = Array.from(
      { length: 65 },
      (_, i) => `Garantie bis ${String((i % 28) + 1).padStart(2, '0')}.${String((i % 9) + 1).padStart(2, '0')}.2027 Position ${i}`,
    );
    await archive('viele.txt', lines.join('\n'));
    const out = await call('find_deadlines', {});
    expect(out.content.match(/Rechenweg:/g)?.length).toBeLessThanOrEqual(60);
    expect(out.content).toMatch(/… und \d+ weitere Fristen/);
  });
});

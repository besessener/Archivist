import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const lastAudit = async (action: string) => (await app.ok('audit:list', {})).find((e) => e.action === action)!;

describe('Cases („Vorgänge“, #286)', () => {
  it('create, assign several entries as ONE undo step, a page with timeline and open items, close and reopen – all undoable', async () => {
    app = await createTestApp({ configured: false });
    const { case: c, created } = await app.ok('cases:create', { name: 'Autokauf', description: 'Neues Auto 2026' });
    expect(created).toBe(true);
    expect((await app.ok('cases:create', { name: 'autokauf' })).created).toBe(false);

    const item = await app.ok('openItems:create', { title: 'Probefahrt vereinbaren', dueAt: '2026-11-05' });
    const event = await app.ok('events:create', { title: 'Besuch beim Händler', occurredAt: '2026-10-01T10:00:00.000Z' });
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Modelle', description: 'Kombi oder SUV?' })).entity;
    expect(await app.ok('cases:assign', { entryIds: [item.id, event.id, note.id], caseId: c.id })).toEqual({ assigned: 3 });
    // the same again changes nothing
    expect(await app.ok('cases:assign', { entryIds: [item.id], caseId: c.id })).toEqual({ assigned: 0 });

    const detail = await app.ok('cases:detail', { id: c.id });
    expect(detail.entries).toHaveLength(3);
    expect(detail.entries[0]).toMatchObject({ id: item.id, date: '2026-11-05', status: 'open', proposed: false });
    expect(detail.openItems.map((e) => e.id)).toEqual([item.id]);
    expect(await app.ok('cases:list', {})).toEqual([expect.objectContaining({ id: c.id, name: 'Autokauf', status: 'open', entries: 3, openItems: 1 })]);

    // an entry can belong to several cases
    const other = (await app.ok('cases:create', { name: 'Finanzierung' })).case;
    await app.ok('cases:assign', { entryIds: [item.id], caseId: other.id });
    expect((await app.ok('cases:detail', { id: other.id })).entries.map((e) => e.id)).toEqual([item.id]);

    // one undo takes back the whole assignment
    const assign = (await app.ok('audit:list', {})).filter((e) => e.action === 'case.assign').at(-1)!;
    await app.ok('audit:undo', { auditId: assign.id });
    expect((await app.ok('cases:detail', { id: c.id })).entries).toEqual([]);

    await app.ok('cases:setStatus', { id: c.id, status: 'closed' });
    expect((await app.ok('cases:list', { includeClosed: false })).map((x) => x.name)).toEqual(['Finanzierung']);
    await app.ok('audit:undo', { auditId: (await lastAudit('case.close')).id });
    expect((await app.ok('cases:list', { includeClosed: false })).map((x) => x.name).toSorted()).toEqual(['Autokauf', 'Finanzierung']);

    // creating is undoable as well
    const tmp = (await app.ok('cases:create', { name: 'Umzug' })).case;
    await app.ok('audit:undo', { auditId: (await lastAudit('case.create')).id });
    expect(app.services.graph.getEntity(tmp.id)).toBeUndefined();
  });

  it('a similar entry is proposed for the open case of its look-alike; a closed case gets nothing', async () => {
    app = await createTestApp({ configured: false, autoLinks: true });
    const c = (await app.ok('cases:create', { name: 'Wohnung' })).case;
    const text = (w: string) => `${w} für die Wohnung in der Hauptstraße 5. Vermieter Schmidt, Kaution 1500 Euro, Miete monatlich.`;
    const lease = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Mietvertrag', description: text('Mietvertrag') })).entity;
    await app.services.jobs.whenIdle();
    await app.ok('cases:assign', { entryIds: [lease.id], caseId: c.id });

    const costs = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Nebenkosten', description: text('Nebenkosten') })).entity;
    await app.services.jobs.whenIdle();
    const proposal = app.services.graph.relationsOf(costs.id, { types: ['belongs_to'] }).find((r) => r.targetEntityId === c.id);
    expect(proposal).toMatchObject({ status: 'proposed', method: 'similarity' });
    expect(proposal!.evidence).toContain('„Mietvertrag“ aus dem Vorgang „Wohnung“');
    expect((await app.ok('cases:detail', { id: c.id })).entries.find((e) => e.id === costs.id)).toMatchObject({ proposed: true });

    await app.ok('cases:setStatus', { id: c.id, status: 'closed' });
    const third = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Kündigung', description: text('Kündigung') })).entity;
    await app.services.jobs.whenIdle();
    expect(app.services.graph.relationsOf(third.id, { types: ['belongs_to'] }).filter((r) => r.targetEntityId === c.id)).toEqual([]);
  });

  it('knowledge questions about a case take its entries as sources', async () => {
    app = await createTestApp({ configured: false });
    const c = (await app.ok('cases:create', { name: 'Steuererklärung 2025' })).case;
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Belege', description: 'Handwerkerrechnung fehlt noch.' })).entity;
    await app.ok('cases:assign', { entryIds: [note.id], caseId: c.id });
    const answer = await app.services.answers.verifiedAnswer('Was ist der Stand bei der Steuererklärung 2025?', null);
    expect(answer).toContain('Belege');
  });
});

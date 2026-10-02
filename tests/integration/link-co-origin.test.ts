import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { agentApp, archived, scriptedTurns } from '../helpers/agent';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const coOrigin = () =>
  app.services.database.sqlite
    .prepare(`SELECT source_entity_id AS s, target_entity_id AS t, status, origin, evidence, source_ids AS src FROM relations WHERE method = 'co_origin'`)
    .all() as Array<{ s: string; t: string; status: string; origin: string; evidence: string; src: string }>;
const pairKey = (a: string, b: string) => [a, b].toSorted().join('|');
const pairs = () => new Set(coOrigin().map((r) => pairKey(r.s, r.t)));

describe('Entries created together are linked (#272)', () => {
  it('one chat message with three requests: the note, the open item and the event are proposed as linked, with the message as evidence', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({ intent: 'note_capture', segment: 'Notiz: Angebot kam per Post.', note: 'Angebot kam per Post' }),
        intent({ intent: 'open_item_new', segment: 'Offen: Angebot prüfen', openItem: { title: 'Angebot prüfen', dueAt: '2026-11-30' } }),
        intent({ intent: 'event_record', segment: 'Heute Termin beim Händler', event: { title: 'Termin beim Händler', occurredAt: '2026-10-02' } }),
      ],
    }));
    const text = 'Notiz: Angebot kam per Post. Offen: Angebot prüfen bis Ende November. Heute Termin beim Händler.';
    const res = await app.ok('chat:send', { text });

    const note = app.services.graph.listEntities({ type: 'note' })[0]!.id;
    const item = (await app.ok('openItems:list', {}))[0]!.id;
    const event = (await app.ok('events:list', {}))[0]!.id;
    expect(pairs()).toEqual(new Set([pairKey(note, item), pairKey(note, event), pairKey(item, event)]));
    for (const r of coOrigin()) {
      expect(r).toMatchObject({ status: 'proposed', origin: 'system' });
      expect(r.evidence).toBe(`Aus derselben Nachricht: „${text}“`);
      expect(JSON.parse(r.src)).toEqual([res.userMessage.id]);
    }
  });

  it('a message that creates only one entry links nothing', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    app.llm.on('ChatIntent', () => intent({ intent: 'note_capture', note: 'Nur eine Notiz' }));
    await app.ok('chat:send', { text: 'Notiz: nur eine Notiz' });
    expect(coOrigin()).toEqual([]);
  });

  it('agent: entries of one message are linked; undoing the run removes them together with these links', async () => {
    app = await agentApp({ autoLinks: true });
    app.llm.agent = scriptedTurns(
      {
        calls: [
          { name: 'create_open_item', args: { title: 'Steuer abgeben', dueAt: '2026-12-31' } },
          { name: 'record_note', args: { content: 'Belege liegen im Ordner Steuer.' } },
        ],
      },
      { text: 'Alles erfasst.' },
    );
    const res = await app.ok('chat:send', { text: 'Leg an: Steuer abgeben bis 31.12. und notiere, dass die Belege im Ordner Steuer liegen.' });
    expect(coOrigin()).toHaveLength(1);
    const undo = await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(undo.failed).toBe(0);
    expect(coOrigin()).toEqual([]);
  });

  it('entries taken from the same document are linked with each other – also when created at different times', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    const doc = await archived(app, 'protokoll.md', 'Protokoll der Eigentümerversammlung: Dach wird saniert, Angebote einholen.', 'private/haus');
    const other = await archived(app, 'rechnung.md', 'Rechnung Handwerker für die Heizung.', 'private/haus');
    const decision = app.services.decisions.create({
      decisionText: 'Das Dach wird 2027 saniert.',
      title: 'Dachsanierung',
      decidedAt: '2026-09-01',
      participants: [],
      alternatives: [],
      unknownFields: [],
      sourceIds: [doc],
      confidence: 0.8,
    });
    const item = app.services.openItems.create({ title: 'Angebote einholen', sourceIds: [doc], priority: 'normal', confidence: 0.8 });
    const unrelated = app.services.openItems.create({ title: 'Heizung bezahlen', sourceIds: [other], priority: 'normal', confidence: 0.8 });

    expect(pairs()).toEqual(new Set([pairKey(decision.id, item.id)]));
    const [r] = coOrigin();
    expect(r!.evidence).toBe('Beide stammen aus dem Dokument „protokoll“.');
    expect(JSON.parse(r!.src)).toEqual([doc]);
    expect([...pairs()].some((p) => p.includes(unrelated.id))).toBe(false);
  });

  it('a pair the user rejected or already linked is not proposed again', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    const doc = await archived(app, 'protokoll.md', 'Protokoll: drei Punkte.', 'private/haus');
    const mk = (title: string) => app.services.openItems.create({ title, sourceIds: [doc], priority: 'normal', confidence: 0.8 });
    const a = mk('Punkt A');
    const b = mk('Punkt B');
    const r = app.services.graph.relationsOf(a.id).find((x) => x.method === 'co_origin')!;
    app.services.graph.decideRelation(r.id, 'rejected');
    const c = mk('Punkt C');
    // C is proposed with A and B; A–B stays rejected
    expect(pairs()).toEqual(new Set([pairKey(a.id, b.id), pairKey(c.id, a.id), pairKey(c.id, b.id)]));
    expect(coOrigin().find((x) => pairKey(x.s, x.t) === pairKey(a.id, b.id))!.status).toBe('rejected');
  });
});

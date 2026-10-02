import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });
const item = (title: string, extra: Record<string, unknown> = {}) =>
  app.ok('openItems:create', { title, priority: 'normal', sourceIds: [], confidence: 0.9, ...extra });
const lastIntentInput = () => app.llm.calls.filter((c) => c.schema === 'ChatIntent').at(-1)!.input;
/** Kurz-ID eines Titels aus der Kontextliste im Prompt, z. B. „P2“. */
const shortId = (input: string, title: string) => new RegExp(`- ([PEV]\\d+): ${title}`).exec(input)?.[1];

describe('Kontext für das LLM (#38)', () => {
  it('der Prompt enthält offene Punkte, Entscheidungen, Vorschläge und den Benutzer – mit IDs', async () => {
    app.services.settings.update({ profile: { name: 'Max Mustermann', nicknames: ['Maxi'] } });
    await item('Steuererklärung abgeben', { dueAt: '2026-11-30', responsible: 'Anna' });
    await app.ok('decisions:create', {
      decisionText: 'Wir nutzen Kafka',
      title: 'Wir nutzen Kafka',
      topic: 'Messaging',
      decidedAt: '2026-01-10',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    app.llm.on('ChatIntent', () => intent({ intent: 'smalltalk' }));

    await send('Hallo');

    const input = lastIntentInput();
    expect(input).toContain('Der Benutzer heißt Max Mustermann (Spitznamen: Maxi)');
    expect(input).toMatch(/- P1: Steuererklärung abgeben \| fällig 2026-11-30 \| Anna/);
    expect(input).toMatch(/- E1: Wir nutzen Kafka \| Messaging \| 2026-01-10 \| aktiv/);
    expect(input).toContain('Offene Vorschläge in diesem Gespräch (ID: Beschreibung):\n- keine');
  });

  it('eine gelieferte ID bestimmt den offenen Punkt – nicht die unscharfe Suche', async () => {
    await item('Vertrag prüfen');
    const kuendigen = await item('Vertrag kündigen');
    let id: string | undefined;
    app.llm.on('ChatIntent', (_s, input) => {
      id = shortId(input, 'Vertrag kündigen');
      return intent({ intent: 'open_item_close', openItem: { targetId: id, targetHint: 'Vertrag' } });
    });

    const r = await send('Die Kündigung ist raus, Punkt kann zu.');

    expect(id).toMatch(/^P\d$/);
    const action = r.assistantMessage.actions[0]!;
    expect((action.proposedParameters as { openItemId: string }).openItemId).toBe(kuendigen.id);
  });

  it('unbekannte IDs werden verworfen', async () => {
    await item('Zahnarzt anrufen');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_close', openItem: { targetId: 'P99', targetHint: 'Zahnarzt' } }));
    const r = await send('Zahnarzt ist erledigt');
    expect(r.assistantMessage.actions[0]!.label).toContain('Zahnarzt anrufen');
  });

  it('eine Erinnerung hängt an dem Punkt mit der gelieferten ID', async () => {
    await item('Präsentation für Kunde X vorbereiten');
    const tuev = await item('Auto zum TÜV bringen');
    app.llm.on('ChatIntent', (_s, input) =>
      intent({ intent: 'reminder_create', reminder: { targetId: shortId(input, 'Auto zum TÜV bringen'), remindAt: '2026-11-02' } }),
    );
    await send('Erinnere mich am 2.11. an den TÜV');
    expect((await app.ok('reminders:list', {}))[0]!.targetId).toBe(tuev.id);
  });

  it('offene Vorschläge dieses Gesprächs stehen mit ID im Prompt; proposalId wählt genau diese Karte', async () => {
    const g = app.services.graph;
    const relA = g.link(g.ensureEntity('topic', 'Hauskauf').id, g.ensureEntity('project', 'Nordlicht').id, 'relates_to', {
      confidence: 0.6,
      status: 'proposed',
    })!;
    const relB = g.link(g.ensureEntity('topic', 'Steuer').id, g.ensureEntity('project', 'Südwind').id, 'relates_to', { confidence: 0.6, status: 'proposed' })!;
    app.llm.on('ChatIntent', () => intent({ intent: 'relation_decide' }));
    const r1 = await send('Welche Beziehungen sind offen?');
    app.llm.on('ChatIntent', (_s, input) => intent({ intent: 'proposal_confirm', proposalId: shortId(input, 'Beziehung: Steuer') }));

    await send('Die mit Steuer passt.', r1.conversationId);

    expect(lastIntentInput()).toMatch(/- V\d: Beziehung: Hauskauf/);
    expect(g.getRelation(relB.id)?.status).toBe('confirmed');
    expect(g.getRelation(relA.id)?.status).toBe('proposed');
  });

  it('ohne erlaubte LLM-Auswertung (local_only) wird kein Kontext gesendet', async () => {
    await item('Geheimes Projekt planen');
    app.services.settings.update({ privacy: { llmMode: 'local_only' } });
    await send('Hallo');
    expect(app.llm.calls.filter((c) => c.schema === 'ChatIntent')).toHaveLength(0);
  });
});

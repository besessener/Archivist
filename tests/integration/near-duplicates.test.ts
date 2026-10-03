import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archived, inInbox } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';
import { NEAR_DUPLICATE_BACKFILL_JOB } from '../../packages/core/src/services/near-duplicates';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

const SENTENCES = Array.from(
  { length: 40 },
  (_, n) => `Punkt ${n}: Der Dachdecker Kowalski liefert ${n * 3 + 2} Ziegel an Adresse ${n + 10} und stellt dafür ${n * 17 + 5} Euro in Rechnung.`,
);
const letter = (edit?: string) => SENTENCES.map((sentence, n) => (n === 20 && edit ? edit : sentence)).join(' ');

const duplicateInsights = async () => (await app.ok('insights:list', {})).filter((i) => i.kind === 'duplicate');
const signatureCount = () => (app.services.ctx.database.sqlite.prepare('SELECT count(*) AS n FROM document_minhash').get() as { n: number }).n;

describe('Near-duplicate detection (#230)', () => {
  it('reports an edited copy as similar, not as identical', async () => {
    await archived(app, { name: 'brief.txt', content: letter(), folder: 'private/haus' });
    await archived(app, { name: 'brief-entwurf.txt', content: letter('Punkt 20: Geändert – der Preis steht noch nicht fest.'), folder: 'private/haus' });

    await app.services.consistency.run();

    const insights = await duplicateInsights();
    expect(insights).toHaveLength(1);
    expect(insights[0]!.title).toMatch(/^Ähnlicher Inhalt/);
    expect(insights[0]!.explanation).toContain('nicht identisch');
  });

  it('reports an exact copy only as identical', async () => {
    await archived(app, { name: 'brief.txt', content: letter(), folder: 'private/haus' });
    await archived(app, { name: 'brief-kopie.txt', content: `${letter()} `, folder: 'private/haus' });

    await app.services.consistency.run();

    const insights = await duplicateInsights();
    expect(insights.map((i) => i.title.split(':')[0])).toEqual(['Mögliche Duplikate']);
  });

  it('includes documents still in the inbox', async () => {
    await archived(app, { name: 'brief.txt', content: letter(), folder: 'private/haus' });
    await inInbox(app, { name: 'brief-neu.txt', content: letter('Punkt 20: Neu formuliert, mit anderem Inhalt für diesen Punkt.') });

    await app.services.consistency.run();

    expect((await duplicateInsights()).map((i) => i.title)).toEqual([expect.stringMatching(/^Ähnlicher Inhalt/)]);
  });

  it('does not report different texts or a pair the user marked as different', async () => {
    const first = await archived(app, { name: 'a.txt', content: letter(), folder: 'private/haus' });
    await archived(app, {
      name: 'b.txt',
      content: SENTENCES.map((s) => s.replaceAll('Punkt', 'Posten').replaceAll('Kowalski', 'Meier'))
        .join(' ')
        .replaceAll(/\d+/g, (n) => `${Number(n) + 900}`),
      folder: 'private/haus',
    });
    const similar = await archived(app, { name: 'c.txt', content: letter('Punkt 20: Etwas ganz anderes.'), folder: 'private/haus' });
    const relation = app.services.graph.link({ sourceId: similar, targetId: first, relationType: 'duplicate_of' }, { status: 'proposed', method: 'analysis' })!;
    app.services.graph.decideRelation(relation.id, { status: 'rejected' });

    await app.services.consistency.run();

    expect(await duplicateInsights()).toHaveLength(0);
  });

  it('closes the hint when the similar document is trashed', async () => {
    await archived(app, { name: 'brief.txt', content: letter(), folder: 'private/haus' });
    const draft = await archived(app, {
      name: 'entwurf.txt',
      content: letter('Punkt 20: Entwurf, noch nicht abgestimmt mit dem Kunden.'),
      folder: 'private/haus',
    });
    await app.services.consistency.run();
    expect(await duplicateInsights()).toHaveLength(1);

    await app.ok('documents:trash', { id: draft, confirmed: true });
    await app.services.consistency.run();

    expect((await duplicateInsights()).filter((i) => i.status === 'open')).toHaveLength(0);
  });

  it('gives documents without a signature one in a job that continues after the last id', async () => {
    const ids = [
      await archived(app, { name: 'a.txt', content: letter(), folder: 'private/haus' }),
      await archived(app, { name: 'b.txt', content: letter('Punkt 20: Anders.'), folder: 'private/haus' }),
    ];
    expect(signatureCount()).toBe(2);
    app.services.ctx.database.sqlite.exec('DELETE FROM document_minhash; DELETE FROM document_lsh_bands');

    const job = app.services.jobs.enqueue(NEAR_DUPLICATE_BACKFILL_JOB, { label: 'test' });
    await app.services.jobs.whenIdle();

    expect(app.services.jobs.get(job.id).status).toBe('succeeded');
    expect(signatureCount()).toBe(2);
    expect(app.services.documents.nearDuplicates.areSimilar(ids[0]!, ids[1]!)).toBe(true);
  });

  it('lets a near-duplicate take no second answer slot', async () => {
    const original = await archived(app, { name: 'angebot.md', content: letter(), folder: 'private/haus' });
    const draft = await archived(app, { name: 'angebot-entwurf.md', content: letter('Punkt 20: Entwurf mit offenem Preis.'), folder: 'private/haus' });
    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Dachdecker Kowalski Ziegel Rechnung' }));
    app.llm.on('KnowledgeAnswer', () => ({
      answer: 'Antwort.',
      facts: [],
      uncertainties: [],
      contradictions: [],
      missingInformation: [],
      usedSourceIds: ['S1', 'S2'],
      confidence: 0.8,
    }));

    const res = await app.ok('chat:send', { text: 'Was berechnet der Dachdecker Kowalski für die Ziegel?' });

    const ids = res.assistantMessage.sources.map((s) => s.id);
    expect(ids.filter((id) => [original, draft].includes(id))).toHaveLength(1);
  });
});

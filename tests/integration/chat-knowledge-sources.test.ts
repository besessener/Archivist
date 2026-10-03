import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionInput } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

const answer = { answer: 'Antwort.', facts: [], uncertainties: [], contradictions: [], missingInformation: [], usedSourceIds: ['S1'], confidence: 0.8 };
const classification = (title: string, summary: string) => ({
  docType: 'Protokoll',
  title,
  summary,
  mainTopic: 'Infrastruktur',
  project: null,
  persons: [],
  dates: [],
  tags: [],
  location: { categoryPath: 'Arbeit/protokolle', fileName: null, newMainCategory: false, rationale: 'test', confidence: 0.8 },
  decisions: [],
  openItems: [],
  confidence: 0.8,
  rationale: 'test',
});

/** Imports a text file and archives it (classification answered by the fake LLM). */
async function archiveText(name: string, content: string, title: string, summary: string) {
  app.llm.on('DocumentClassification', () => classification(title, summary));
  const file = app.file(name, content);
  const imported = await app.ok('documents:import', { paths: [file] });
  await app.services.jobs.whenIdle();
  const documentId = imported.imported[0]!.id;
  const plan = await app.ok('documents:previewArchive', { items: [{ documentId, mode: 'copy' }] });
  const res = await app.ok('documents:archive', {
    items: [{ documentId, mode: 'copy' }],
    confirmed: true,
    approveNewCategories: plan.newCategories,
    confirmMove: false,
  });
  expect(res.success).toBe(1);
  await app.services.documents.indexDocument(documentId);
  return documentId;
}

const knowledgeInput = () => app.llm.calls.find((c) => c.schema === 'KnowledgeAnswer')?.input ?? '';

describe('Knowledge answers get the matched passage (#157)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.llm.on('KnowledgeAnswer', () => answer);
  });

  it('sends the chunk that contains the decisive sentence, not only summary and a few words', async () => {
    const filler = 'Unter Punkt Verschiedenes wurde über Parkplätze, Kaffeemaschinen und Urlaubsplanung gesprochen. '.repeat(4);
    const decisive = 'Beschluss: Die Plattform zieht bis Ende März vollständig in die Region Frankfurt um, Budget 40.000 Euro, verantwortlich ist Jana.';
    await archiveText('protokoll.txt', `${filler}\n\n${decisive}`, 'Protokoll Jour Fixe', 'Protokoll des Jour Fixe mit mehreren Themen.');
    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Plattform Region Frankfurt' }));

    await app.ok('chat:send', { text: 'Wohin zieht die Plattform um?' });

    const input = knowledgeInput();
    expect(input).toContain('Textstelle:');
    expect(input).toContain('Budget 40.000 Euro, verantwortlich ist Jana');
    expect(input).toContain('Zusammenfassung: Protokoll des Jour Fixe');
  });
});

describe('Knowledge questions search more than one wording (#164)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.llm.on('KnowledgeAnswer', () => answer);
  });

  it('an alternative wording from the intent finds what the first query misses', async () => {
    const note = await app.services.notes.create({
      title: 'Rechenzentrum',
      content: 'Der Cloud-Umzug des Rechenzentrums ist beschlossen und startet im April.',
    });
    app.llm.on('ChatIntent', () => ({
      intent: 'knowledge_question',
      confidence: 0.9,
      rationale: 'test',
      query: 'AWS Migration',
      alternativeQueries: ['Cloud-Umzug Rechenzentrum', 'cloud move data center'],
    }));

    const r = await app.ok('chat:send', { text: 'Was gilt für die AWS Migration?' });

    expect(knowledgeInput()).toContain('Der Cloud-Umzug des Rechenzentrums ist beschlossen');
    expect(r.assistantMessage.sources.map((s) => s.id)).toContain(note.id);
  });

  it('asks the LLM for alternative wordings in both languages', async () => {
    app.llm.on('ChatIntent', () => ({ intent: 'smalltalk', confidence: 0.9, rationale: 'test' }));
    await app.ok('chat:send', { text: 'Hallo' });
    const call = app.llm.calls.find((c) => c.schema === 'ChatIntent')!;
    expect(call.instructions).toMatch(/alternativeQueries/);
    expect(call.instructions).toMatch(/Englisch/);
  });

  it('applies a time range as a filter when something remains in it', async () => {
    const old = app.services.eventRecords.create({ title: 'Zaun gestrichen', occurredAt: '2019-05-01', sourceIds: [] });
    const recent = app.services.eventRecords.create({ title: 'Zaun repariert', occurredAt: '2026-05-01', sourceIds: [] });
    await app.services.eventRecords.reindex(old.id);
    await app.services.eventRecords.reindex(recent.id);
    app.llm.on('ChatIntent', () => ({
      intent: 'knowledge_question',
      confidence: 0.9,
      rationale: 'test',
      query: 'Zaun',
      timeRange: { from: '2026-01-01', to: '2026-12-31' },
    }));

    const r = await app.ok('chat:send', { text: 'Was war 2026 mit dem Zaun?' });

    expect(knowledgeInput()).toContain('Zaun repariert');
    expect(knowledgeInput()).not.toContain('Zaun gestrichen');
    expect(r.assistantMessage.uncertainties.join(' ')).not.toMatch(/Zeitraum/);
  });

  it('keeps the hits outside the time range with a hint when nothing lies in it', async () => {
    const old = app.services.eventRecords.create({ title: 'Zaun gestrichen', occurredAt: '2019-05-01', sourceIds: [] });
    await app.services.eventRecords.reindex(old.id);
    app.llm.on('ChatIntent', () => ({
      intent: 'knowledge_question',
      confidence: 0.9,
      rationale: 'test',
      query: 'Zaun',
      timeRange: { from: '2026-01-01', to: null },
    }));

    const r = await app.ok('chat:send', { text: 'Was war 2026 mit dem Zaun?' });

    expect(knowledgeInput()).toContain('Zaun gestrichen');
    expect(r.assistantMessage.uncertainties.join(' ')).toMatch(/Im genannten Zeitraum .* nichts gefunden/);
  });
});

describe('Decision sources are part of the answer (#165)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.llm.on('KnowledgeAnswer', () => answer);
  });

  it('adds the documents a retrieved decision was taken from, with the matching passage', async () => {
    const filler = 'Zunächst ging es um die Kantine und den Betriebsausflug im Sommer. '.repeat(15);
    const docId = await archiveText(
      'protokoll-fuhrpark.txt',
      `${filler}\n\nTOP 3: Der Fuhrpark wird umgestellt – die Dienstwagen werden E-Fahrzeuge, weil die Leasingverträge im Juli auslaufen.`,
      'Protokoll Geschäftsleitung Juni',
      'Protokoll der Sitzung der Geschäftsleitung.',
    );
    const d = app.services.decisions.create(
      DecisionInput.parse({
        title: 'Elektroautos für den Fuhrpark',
        decisionText: 'Der Fuhrpark wird auf Elektroautos umgestellt.',
        topic: 'Fuhrpark',
        decidedAt: '2026-06-12',
        participants: ['Jana'],
        sourceIds: [docId],
      }),
    );
    await app.services.decisions.reindex(d.id);
    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Elektroautos' }));

    const r = await app.ok('chat:send', { text: 'Welches Dokument belegt die Entscheidung zu den Elektroautos?' });

    const input = knowledgeInput();
    expect(input).toContain('Belegt durch: Dokument „Protokoll Geschäftsleitung Juni“');
    expect(input).toContain('Quelle der Entscheidung „Elektroautos für den Fuhrpark“');
    expect(input).toContain('weil die Leasingverträge im Juli auslaufen');
    expect(r.assistantMessage.sources.map((s) => s.id)).toEqual(expect.arrayContaining([d.id]));
  });
});

describe('Unbacked answers do not look verified (#166)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
    await app.services.notes.create({ title: 'Zaun', content: 'Der Zaun am Garten soll irgendwann erneuert werden.' });
    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Zaun' }));
  });

  it('an answer without a single validly cited fact is shown as unbacked, with low confidence and uncited sources marked', async () => {
    app.llm.on('KnowledgeAnswer', () => ({
      ...answer,
      answer: 'Sie haben am 12.05.2019 entschieden, den Zaun auf 2 Meter zu erhöhen.',
      facts: [{ statement: 'Zaun wird 2 Meter hoch', sourceIds: ['S9'] }],
      usedSourceIds: [],
      confidence: 0.95,
    }));

    const m = (await app.ok('chat:send', { text: 'Was haben wir zum Zaun entschieden?' })).assistantMessage;

    expect(m.content).toMatch(
      /^Die gefundenen Quellen belegen keine Antwort auf deine Frage\.\n\n\*\*Nicht belegt \(Einschätzung des Modells\)\*\*\nSie haben am 12\.05\.2019/,
    );
    expect(m.confidence).toBeLessThanOrEqual(0.3);
    expect(m.sources.length).toBeGreaterThan(0);
    expect(m.sources.every((s) => s.title.endsWith('(gefunden, nicht zitiert)'))).toBe(true);
    expect(m.uncertainties).toContain('Die angezeigten Quellen wurden gefunden, aber in der Antwort nicht zitiert.');
  });

  it('a backed answer is shown as it is, with its cited source', async () => {
    app.llm.on('KnowledgeAnswer', () => ({
      ...answer,
      answer: 'Der Zaun soll erneuert werden.',
      facts: [{ statement: 'Der Zaun soll erneuert werden', sourceIds: ['S1'] }],
      confidence: 0.8,
    }));

    const m = (await app.ok('chat:send', { text: 'Was ist mit dem Zaun?' })).assistantMessage;

    expect(m.content).toMatch(/^Der Zaun soll erneuert werden\./);
    expect(m.confidence).toBe(0.8);
    expect(m.sources.map((s) => s.title)).toEqual(['1. Zaun']);
  });
});

describe('Sources carry the document date, not the archive date (#168)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.llm.on('KnowledgeAnswer', () => answer);
    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Heizungswartung' }));
  });

  it('labels the header with the document date and the archive date separately', async () => {
    app.llm.on('DocumentClassification', () => ({ ...classification('Wartungsvertrag', 'Vertrag zur Heizungswartung.'), documentDate: '2025-08-14' }));
    const file = app.file('vertrag.txt', 'Berlin, 14.08.2025. Vertrag über die jährliche Heizungswartung.');
    const imported = await app.ok('documents:import', { paths: [file] });
    await app.services.jobs.whenIdle();
    const documentId = imported.imported[0]!.id;
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId, mode: 'copy' }] });
    await app.ok('documents:archive', { items: [{ documentId, mode: 'copy' }], confirmed: true, approveNewCategories: plan.newCategories, confirmMove: false });
    await app.services.documents.indexDocument(documentId);

    const m = (await app.ok('chat:send', { text: 'Wann haben wir die Heizungswartung vereinbart?' })).assistantMessage;

    const today = new Date().toISOString().slice(0, 4);
    expect(knowledgeInput()).toMatch(new RegExp(`\\[S1\\] \\(document, Dokumentdatum 2025-08-14, archiviert am ${today}-\\d\\d-\\d\\d\\)`));
    expect(m.sources[0]).toMatchObject({ id: documentId, date: '2025-08-14', dateKind: 'document' });
    expect((await app.ok('documents:get', { id: documentId })).documentDate).toBe('2025-08-14');
  });

  it('says that the date is unknown when the document has none', async () => {
    const documentId = await archiveText('notiz.txt', 'Heizungswartung: der Techniker kommt einmal im Jahr.', 'Notiz Heizung', 'Notiz zur Heizungswartung.');

    const m = (await app.ok('chat:send', { text: 'Was gilt für die Heizungswartung?' })).assistantMessage;

    expect(knowledgeInput()).toMatch(/\[S1\] \(document, Dokumentdatum unbekannt, archiviert am \d{4}-\d\d-\d\d\)/);
    expect(m.sources[0]).toMatchObject({ id: documentId, dateKind: 'archived' });
  });
});

describe('Decision dates (#168)', () => {
  beforeEach(async () => {
    app = await createTestApp({ privacy: 'auto' });
  });

  it('rejects a decision date in the future', async () => {
    const res = await app.call(
      'decisions:create',
      DecisionInput.parse({ decisionText: 'Wir kündigen den Vertrag.', decidedAt: '2999-01-01', topic: 'Vertrag', participants: ['Anna'] }),
    );
    expect(res.ok).toBe(false);
  });

  it('an undated decision is not called older than a dated one by its capture date', async () => {
    const undated = app.services.decisions.create(
      DecisionInput.parse({ decisionText: 'Wir nutzen Anbieter A.', topic: 'Strom', participants: ['Anna'], unknownFields: ['decidedAt'] }),
    );
    app.services.decisions.create(
      DecisionInput.parse({ decisionText: 'Wir nutzen Anbieter B.', topic: 'Strom', participants: ['Anna'], decidedAt: '2020-01-01' }),
    );
    await app.services.consistency.run();
    const insights = await app.ok('insights:list', {});
    expect(insights.filter((i) => i.kind === 'possibly_superseded' && i.affected.some((a) => a.id === undated.id))).toHaveLength(0);
  });
});

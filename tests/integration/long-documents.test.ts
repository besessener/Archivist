import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ llm: { maxInputChars: 2000 } });
});
afterEach(async () => {
  await app.cleanup();
});

const FILLER = 'Dieser Absatz beschreibt den Ablauf der Sitzung ohne jede Festlegung und füllt nur Platz.\n';
const DECISION = 'Beschluss: Die Fassade wird im Herbst gestrichen.';
const filler = (lines: number) => FILLER.repeat(lines);

/** Imports a document; the fake classification answers a decision only for the part that contains its sentence. */
async function analyze(text: string) {
  app.llm.on('DocumentClassification', (_schema, input) =>
    classification({
      title: 'Langes Protokoll',
      summary: 'x',
      categoryPath: 'private/haus',
      decisions: input.includes(DECISION) ? [{ title: 'Fassade', decisionText: DECISION, kind: 'decided', evidence: DECISION, participants: [] }] : [],
    }),
  );
  const imported = await app.ok('documents:import', { paths: [app.file('in/protokoll.txt', text)] });
  await app.services.jobs.whenIdle();
  return app.ok('documents:get', { id: imported.imported[0]!.id });
}

const classificationCalls = () => app.llm.calls.filter((call) => call.schema === 'DocumentClassification');

describe('Long documents are read in parts (#190)', () => {
  it('finds a decision far behind the first part and reports that the whole text was read', async () => {
    const text = `${filler(60)}${DECISION}\n${filler(10)}`.trim();

    const doc = await analyze(text);

    expect(classificationCalls().length).toBeGreaterThan(1);
    expect(classificationCalls().every((call) => call.input.length <= 2000)).toBe(true);
    expect(doc.proposal?.possibleDecisions.map((d) => d.decisionText)).toEqual([DECISION]);
    expect(doc.proposal?.coverage).toMatchObject({ textChars: text.length, llmChars: text.length, extractionTruncated: false });
    expect(doc.proposal?.coverage?.llmParts).toBe(classificationCalls().length);
  });

  it('logs every part as its own transmission for the document', async () => {
    const doc = await analyze(`${filler(60)}${DECISION}\n`);

    const parts = (await app.ok('llm:transmissions', {})).filter((t) => t.purpose.startsWith('Dokumentklassifikation'));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((t) => t.documentIds.includes(doc.id) && /Teil \d+ von \d+/.test(t.purpose))).toBe(true);
  });

  it('masks secrets in every part before it leaves the machine', async () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';

    await analyze(`${filler(30)}Zugang: ${secret}\n${filler(30)}`);

    expect(classificationCalls().length).toBeGreaterThan(1);
    expect(classificationCalls().some((call) => call.input.includes(secret))).toBe(false);
    expect((await app.ok('llm:transmissions', {})).some((t) => t.redactions > 0)).toBe(true);
  });

  it('says how much was read when the text is longer than the parts allowed', async () => {
    const text = filler(400).trim();

    const doc = await analyze(text);

    const { coverage } = doc.proposal!;
    expect(coverage!.textChars).toBe(text.length);
    expect(coverage!.llmParts).toBe(classificationCalls().length);
    expect(coverage!.llmChars).toBeLessThan(text.length);
    expect(coverage!.llmChars).toBeGreaterThan(2000);
  });

  it('keeps what earlier parts found when a later part fails', async () => {
    let calls = 0;
    app.llm.on('DocumentClassification', () => {
      calls += 1;
      if (calls > 1) throw new Error('Endpunkt nicht erreichbar');
      return classification({ title: 'Protokoll', summary: 'x', categoryPath: 'private/haus', mainTopic: 'Haus' });
    });
    const imported = await app.ok('documents:import', { paths: [app.file('in/lang.txt', filler(60))] });
    await app.services.jobs.whenIdle();

    const doc = await app.ok('documents:get', { id: imported.imported[0]!.id });

    expect(doc.proposal?.analyzedBy).toBe('llm');
    expect(doc.proposal?.coverage?.llmParts).toBe(1);
    expect(doc.proposal!.coverage!.llmChars).toBeLessThan(doc.proposal!.coverage!.textChars);
  });

  it('sends nothing for a document the privacy mode keeps local, and still reports the coverage', async () => {
    app.services.settings.update({ privacy: { llmMode: 'local_only' } });

    const doc = await analyze(filler(60));

    expect(classificationCalls()).toHaveLength(0);
    expect(doc.proposal?.coverage).toMatchObject({ llmChars: 0, llmParts: 0 });
  });

  it('reports when the extraction itself stopped at its limit', async () => {
    app.services.settings.update({ privacy: { llmMode: 'local_only' } });

    const doc = await analyze(filler(5000));

    expect(doc.proposal?.coverage?.extractionTruncated).toBe(true);
    expect(doc.proposal?.coverage?.textChars).toBe(400_000);
  });
});

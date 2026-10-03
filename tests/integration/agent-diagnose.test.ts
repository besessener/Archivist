import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticTools } from '../../packages/core/src/agent/tools/diagnostics';
import { chunks, jobs } from '../../packages/core/src/db/schema';
import { emptyToolContext } from '../helpers/agent';
import { toolCaller, toolDepsOf } from '../helpers/agent-tools';
import { createTestApp, type TestApp, type TestAppOptions } from '../helpers/harness';

let app: TestApp;

async function diagnose(options: TestAppOptions & { embeddingModel?: string } = {}): Promise<string> {
  const { embeddingModel = 'test-embedding', ...appOptions } = options;
  app = await createTestApp({ privacy: 'auto', ...appOptions });
  if (appOptions.configured !== false) app.services.settings.update({ llm: { embeddingModel } });
  app.llm.embed = () => [[1, 0, 0]];
  return runDiagnose();
}

const runDiagnose = async () => (await toolCaller(diagnosticTools(toolDepsOf(app)), emptyToolContext())('diagnose', {})).content;

const addChunks = (model: string | null, amount: number) =>
  app.services.database.db
    .insert(chunks)
    .values(
      Array.from({ length: amount }, (_, n) => ({ id: `${model}-${n}`, entityType: 'document', entityId: 'e1', idx: n, text: 'text', embeddingModel: model })),
    )
    .run();

const addFailedJob = (id: string, { label, error, finishedAt }: { label: string; error: string; finishedAt: string }) =>
  app.services.database.db
    .insert(jobs)
    .values({ id, type: 'document.analyze', label, status: 'failed', attempts: 3, error, createdAt: finishedAt, finishedAt })
    .run();

afterEach(async () => {
  await app.cleanup();
});

describe('diagnose: state of the installation', () => {
  it('reports versions, sizes, row counts, models and the privacy mode', async () => {
    const out = await diagnose();
    expect(out).toMatch(/Umgebung: Archivist unbekannt, Electron nicht vorhanden, Node \d+\./);
    expect(out).toMatch(/Datenordner: [\d.]+ MB; freier Speicher: [\d.]+ GB/);
    expect(out).toMatch(/Datenbank: [\d.]+ MB/);
    expect(out).toContain('Dokumente 0');
    expect(out).toContain('Übertragungsprotokoll');
    expect(out).toContain('LLM-Modell: test-model (llm.example.test); Embedding-Modell: test-embedding');
    expect(out).toContain('Datenschutzmodus: automatisch');
    expect(out).toContain('Keine fehlgeschlagenen Aufträge.');
  });

  it('shows which embedding models the chunks use, so chunks still on the local hash stand out', async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    app.llm.embed = () => [[1, 0, 0]];
    addChunks('local-hash-v1', 3);
    addChunks('test-embedding', 2);
    addChunks(null, 1);
    const out = await runDiagnose();
    expect(out).toContain('  - local-hash-v1: 3 Textabschnitte (lokal)');
    expect(out).toContain('  - test-embedding: 2 Textabschnitte');
    expect(out).toContain('  - ohne Vektor: 1 Textabschnitte');
    expect(out).toContain('4 Textabschnitte stammen nicht vom eingestellten Modell „test-embedding“.');
    expect(out).toContain('Textabschnitte 6');
  });

  it('says so when no embedding model is set', async () => {
    const out = await diagnose({ embeddingModel: '' });
    expect(out).toContain('Kein Embedding-Modell eingestellt: Die Suche arbeitet lexikalisch');
    expect(out).toContain('Embedding-Endpunkt: nicht geprüft – Es ist kein Embedding-Modell eingestellt.');
    expect(app.llm.embeddingRequests).toEqual([]);
  });

  it('lists the newest failed jobs, five at most, with sanitised errors', async () => {
    app = await createTestApp({ privacy: 'auto' });
    for (let n = 1; n <= 6; n += 1)
      addFailedJob(`j${n}`, {
        label: `Analyse ${n}`,
        error: n === 6 ? 'Zugriff mit password=hunter2hunter2 abgelehnt' : `Fehler ${n}`,
        finishedAt: `2026-03-0${n}T10:00:00.000Z`,
      });
    const out = await runDiagnose();
    expect(out).toContain('Analyse 6');
    expect(out).toContain('Analyse 2');
    expect(out).not.toContain('Analyse 1');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('<<<DOKUMENTINHALT quelle="Aufträge"');
  });

  it('withholds failed jobs that name an excluded file', async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.services.settings.update({ privacy: { neverAnalyzeDirs: ['/home/me/Privat'] } });
    addFailedJob('j1', { label: 'Analyse steuer.pdf', error: 'Datei /home/me/Privat/steuer.pdf nicht lesbar', finishedAt: '2026-03-01T10:00:00.000Z' });
    const out = await runDiagnose();
    expect(out).toContain('document.analyze (3 Versuche): [nicht freigegeben]');
    expect(out).not.toMatch(/steuer|Privat/);
  });
});

describe('diagnose: timing of the embedding endpoint', () => {
  it('asks in mode „automatisch“ with a fixed probe that is masked and in the transmission log', async () => {
    const out = await diagnose();
    expect(app.llm.embeddingRequests).toEqual([['Verbindungstest']]);
    expect(out).toMatch(/Embedding-Endpunkt: antwortete nach \d+ ms \(unter dem Suchlimit\)/);
    expect(out).toContain('höchstens 2500 ms');
    const [entry] = app.services.llm.listTransmissions(5);
    expect(entry).toMatchObject({
      purpose: 'Diagnose: Embedding-Endpunkt',
      model: 'test-embedding',
      documentIds: [],
      preview: 'Verbindungstest',
      success: true,
    });
  });

  it('reports a failing endpoint with its time instead of failing the diagnosis', async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    const out = await runDiagnose();
    expect(out).toMatch(/Embedding-Endpunkt: Anfrage nach \d+ ms fehlgeschlagen/);
    expect(app.services.llm.listTransmissions(5)[0]).toMatchObject({ purpose: 'Diagnose: Embedding-Endpunkt', success: false });
  });

  it.each([
    ['confirm', 'vorher fragen'],
    ['local_only', 'nur lokal'],
  ] as const)('sends nothing in mode %s', async (mode, label) => {
    const out = await diagnose({ privacy: mode });
    expect(out).toContain(`Embedding-Endpunkt: nicht geprüft – Der Datenschutzmodus „${label}“ erlaubt keine ungefragte Anfrage.`);
    expect(app.llm.embeddingRequests).toEqual([]);
    expect(app.services.llm.listTransmissions(5)).toEqual([]);
  });

  it('sends nothing without a configured LLM', async () => {
    const out = await diagnose({ configured: false });
    expect(out).toContain('nicht geprüft – Das LLM ist nicht konfiguriert.');
    expect(app.llm.embeddingRequests).toEqual([]);
  });

  it('never puts a document or its exclusion into the probe', async () => {
    app = await createTestApp({ privacy: 'auto' });
    app.services.settings.update({
      llm: { embeddingModel: 'test-embedding' },
      privacy: { neverAnalyzeDirs: ['/home/me/Privat'], neverAnalyzeExtensions: ['pdf'] },
    });
    app.llm.embed = () => [[1, 0, 0]];
    await runDiagnose();
    expect(app.llm.embeddingRequests).toEqual([['Verbindungstest']]);
    expect(app.services.llm.listTransmissions(5).map((entry) => entry.documentIds)).toEqual([[]]);
  });
});

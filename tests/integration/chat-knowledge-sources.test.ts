import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  location: { categoryPath: 'work/protokolle', fileName: null, newMainCategory: false, rationale: 'test', confidence: 0.8 },
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

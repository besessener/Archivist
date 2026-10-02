import { scriptedTurns } from './fake-llm';
import { createTestApp, type TestApp, type TestAppOptions } from './harness';

export { scriptedTurns };

/** Test app with the agent mode switched on (OpenAI-compatible fake endpoint unless `baseUrl` says otherwise). */
export async function agentApp(options: TestAppOptions & { baseUrl?: string; model?: string } = {}): Promise<TestApp> {
  const app = await createTestApp({ privacy: 'auto', ...options, agent: true });
  if (options.baseUrl || options.model)
    app.services.settings.update({ llm: { ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.model ? { model: options.model } : {}) } });
  return app;
}

interface TextFile {
  name: string;
  content: string;
}

/** Imports a text file and archives it (copy) into `folder`. */
export async function archived(
  app: TestApp,
  file: TextFile & { folder: string; topic?: string | null; docType?: string; persons?: string[]; documentDate?: string | null },
): Promise<string> {
  const { name, folder, ...meta } = file;
  app.llm.on('DocumentClassification', () => ({
    docType: meta.docType ?? 'Notiz',
    title: name.replace(/\.\w+$/, ''),
    summary: `Zusammenfassung ${name}`,
    mainTopic: meta.topic ?? null,
    project: null,
    persons: meta.persons ?? [],
    dates: [],
    documentDate: meta.documentDate ?? null,
    tags: [],
    location: { categoryPath: folder, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
  const id = await imported(app, file);
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: folder, topic: meta.topic ?? null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

/** Imports a text file and leaves it analyzed in the inbox. */
export async function inInbox(app: TestApp, file: TextFile & { folder?: string }): Promise<string> {
  const { name, folder = 'private/eingang' } = file;
  app.llm.on('DocumentClassification', () => ({
    docType: 'Rechnung',
    title: name.replace(/\.\w+$/, ''),
    summary: `Zusammenfassung ${name}`,
    mainTopic: null,
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: folder, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
  return imported(app, file);
}

async function imported(app: TestApp, file: TextFile): Promise<string> {
  const result = await app.ok('documents:import', { paths: [app.file(`in/${Math.random().toString(36).slice(2)}/${file.name}`, file.content)] });
  await app.services.jobs.whenIdle();
  return result.imported[0]!.id;
}

export const folderOf = (app: TestApp, id: string) => {
  const relativePath = app.services.documents.getRow(id).archiveRelPath ?? '';
  return relativePath.split('/').slice(0, -1).join('/');
};

/** All texts the agent sent to the model (tool results included) – for privacy and secret checks. */
export const sentText = (app: TestApp) => JSON.stringify(app.llm.agentRequests);

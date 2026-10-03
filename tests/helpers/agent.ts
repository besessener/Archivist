import { RefStore, type ToolContext } from '../../packages/core/src/agent/registry';
import { scriptedTurns } from './fake-llm';
import { createTestApp, type TestApp, type TestAppOptions } from './harness';
import { classification } from './document-classifications';

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
  app.llm.on('DocumentClassification', () =>
    classification({
      title: name.replace(/\.\w+$/, ''),
      summary: `Zusammenfassung ${name}`,
      categoryPath: folder,
      docType: meta.docType ?? 'Notiz',
      mainTopic: meta.topic ?? null,
      persons: meta.persons ?? [],
      documentDate: meta.documentDate ?? null,
    }),
  );
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
  const { name, folder = 'Privat/eingang' } = file;
  app.llm.on('DocumentClassification', () =>
    classification({ title: name.replace(/\.\w+$/, ''), summary: `Zusammenfassung ${name}`, categoryPath: folder, docType: 'Rechnung' }),
  );
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

/** Outputs of the tool calls in the latest agent request (Responses API input), in call order. */
export const toolOutputs = (app: TestApp) =>
  ((app.llm.agentRequests.at(-1)?.input as Array<{ type?: string; output?: string }>) ?? [])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => i.output ?? '');

/** Output of the last tool call the model got back. */
export const lastToolOutput = (app: TestApp) => toolOutputs(app).at(-1) ?? '';

/** A fresh context for calling agent tools directly, outside of a run. */
export const emptyToolContext = (): ToolContext => ({
  runId: 'r1',
  conversationId: null,
  trigger: 'chat',
  mode: 'auto',
  refs: new RefStore(),
  shared: new Set(),
  signal: new AbortController().signal,
  userText: '',
  lastAnswer: null,
  files: [],
  applied: [],
  changes: [],
  changedCount: 0,
  tainted: null,
  actionIds: [],
});

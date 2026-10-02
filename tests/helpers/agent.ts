import { RefStore, type ToolContext } from '../../packages/core/src/agent/registry';
import { createTestApp, scriptedTurns, type AgentTurn, type TestApp, type TestAppOptions } from './harness';

export { scriptedTurns, type AgentTurn };

/** Test app with the agent mode switched on (OpenAI-compatible fake endpoint unless `baseUrl` says otherwise). */
export async function agentApp(opts: TestAppOptions & { baseUrl?: string; model?: string } = {}): Promise<TestApp> {
  const app = await createTestApp({ privacy: 'auto', ...opts, agent: true });
  if (opts.baseUrl || opts.model)
    app.services.settings.update({ llm: { ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.model ? { model: opts.model } : {}) } });
  return app;
}

/** Imports a text file and archives it (copy) into `folder`. */
export async function archived(
  app: TestApp,
  name: string,
  content: string,
  folder: string,
  meta: { topic?: string | null; docType?: string; persons?: string[]; documentDate?: string | null } = {},
): Promise<string> {
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
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${Math.random().toString(36).slice(2)}/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: folder, topic: meta.topic ?? null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

/** Imports a text file and leaves it analyzed in the inbox. */
export async function inInbox(app: TestApp, name: string, content: string, folder = 'private/eingang'): Promise<string> {
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
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${Math.random().toString(36).slice(2)}/${name}`, content)] });
  await app.services.jobs.whenIdle();
  return imp.imported[0]!.id;
}

export const folderOf = (app: TestApp, id: string) => {
  const rel = app.services.documents.getRow(id).archiveRelPath ?? '';
  return rel.split('/').slice(0, -1).join('/');
};

/** All texts the agent sent to the model (tool results included) – for privacy and secret checks. */
export const sentText = (app: TestApp) => JSON.stringify(app.llm.agentRequests);

/** The tool result for the n-th call as the model saw it in the following request (Responses API format). */
export function toolOutputs(app: TestApp): string[] {
  const last = app.llm.agentRequests.at(-1);
  const input = (last?.input as Array<{ type?: string; output?: string }> | undefined) ?? [];
  return input.filter((i) => i.type === 'function_call_output').map((i) => i.output ?? '');
}

/** A tool context for calling tools directly. */
export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'test-run',
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
    actionIds: [],
    changedCount: 0,
    tainted: null,
    ...overrides,
  };
}

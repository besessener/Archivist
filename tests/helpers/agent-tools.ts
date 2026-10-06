import { eq } from 'drizzle-orm';
import type { AgentTool, ToolContext, ToolOutput } from '../../packages/core/src/agent/registry';
import type { ToolDeps } from '../../packages/core/src/agent/tools/common';
import { documents } from '../../packages/core/src/db/schema';
import { classification } from './document-classifications';
import type { TestApp } from './harness';

/** The tool dependencies of a test app: the same services the chat uses. */
export function toolDepsOf(app: TestApp): ToolDeps {
  const s = app.services;
  return {
    paths: s.paths,
    settings: s.settings,
    docs: s.documents,
    search: s.search,
    graph: s.graph,
    privacy: s.privacy,
    decisions: s.decisions,
    openItems: s.openItems,
    reminders: s.reminders,
    events: s.eventRecords,
    notes: s.notes,
    timeline: s.timeline,
    insights: s.insights,
    actions: s.actions,
    archive: s.archive,
    categories: s.categories,
    scanner: s.scanner,
    jobs: s.jobs,
    audit: s.audit,
    undo: s.undo,
    persons: s.persons,
    notifications: s.notifications,
    openItemDuplicates: s.openItemDuplicates,
    noteEventDuplicates: s.noteEventDuplicates,
    contradictions: s.contradictions,
    memory: {} as never,
    fileJobs: s.agentFileJobs,
    links: s.links,
    subjects: s.subjects,
    cases: s.cases,
    linkThresholds: s.linkThresholds,
    capture: s.capture,
    answers: s.answers,
    logs: s.logReader,
    diagnostics: s.diagnostics,
    enqueueConsistency: () => undefined,
    logger: s.ctx.logger,
  };
}

/** Calls a tool with its arguments parsed by its own schema. */
export function toolCaller(tools: AgentTool[], ctx: ToolContext): (name: string, args: unknown) => Promise<ToolOutput> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return (name, args) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(tool.schema.parse(args), ctx);
  };
}

export interface ArchivedFile {
  name: string;
  content: string | Buffer;
  loc?: string;
  date?: string | null;
  docType?: string;
  persons?: string[];
  title?: string;
}

/** Imports a file and archives it (copy) into `loc`, with a scripted classification. */
export async function archiveFile(app: TestApp, file: ArchivedFile): Promise<string> {
  const loc = file.loc ?? 'Privat/finanzen';
  app.llm.on('DocumentClassification', () =>
    classification({
      title: file.title ?? file.name.replace(/\.\w+$/, ''),
      summary: `Zusammenfassung ${file.name}`,
      categoryPath: loc,
      docType: file.docType ?? 'Rechnung',
      persons: file.persons ?? [],
      documentDate: file.date ?? null,
    }),
  );
  const imported = await app.ok('documents:import', { paths: [app.file(`in/${Math.random().toString(36).slice(2)}/${file.name}`, file.content)] });
  await app.services.jobs.whenIdle();
  const id = imported.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic: null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

/** Replaces the text the archive has of a document (what OCR or the parser would have found). */
export function setExtractedText(app: TestApp, id: string, text: string): void {
  app.services.database.db.update(documents).set({ extractedText: text }).where(eq(documents.id, id)).run();
}

let imageCount = 0;

/** A valid, never repeated image (PNG or JPEG): the archive treats it like a scanned receipt whose text OCR would have found. */
export async function uniqueImage(format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  imageCount += 1;
  const image = sharp({ create: { width: 2, height: 2, channels: 3, background: { r: imageCount, g: 20, b: 30 } } });
  return format === 'png' ? image.png().toBuffer() : image.jpeg().toBuffer();
}

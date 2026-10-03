import path from 'node:path';
import { z } from 'zod';
import { FOLDER_CREATE_UNDO, type FolderCreateUndoData } from './tool-undo';
import type { ArchiveResult } from '@archivist/shared';
import { sanitizeCategoryPath } from '../../util/paths';
import { folderOf } from '../../services/archive-structure';
import { fillPattern } from '../../services/rename-pattern';
import type { ArchiveConsent, FileOp, FileOpResult } from '../file-jobs';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import { affectedCount, normalizeFolder, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from './common';
import { scanTools } from './files-scan';

interface FileJob {
  op: FileOp;
  items: Parameters<ToolDeps['fileJobs']['run']>[0]['items'];
  label: string;
  consent?: ArchiveConsent;
}

/** Moves and renames go through the file jobs: larger amounts as a job of their own, in chunks either way (#304). */
export function runFileJob({ deps, ctx }: ToolScope, job: FileJob) {
  return deps.fileJobs.run({
    op: job.op,
    items: job.items,
    signal: ctx.signal,
    label: job.label,
    inJob: Boolean(ctx.job),
    report: ctx.job?.report,
    consent: job.consent,
  });
}

function summarize(result: ArchiveResult & Partial<Pick<FileOpResult, 'stopped' | 'jobId' | 'resumes'>>): string {
  const parts = [`${result.success} erfolgreich`];
  if (result.skipped) parts.push(`${result.skipped} übersprungen`);
  if (result.conflicts) parts.push(`${result.conflicts} Konflikte`);
  if (result.failed) parts.push(`${result.failed} fehlgeschlagen`);
  if (result.stopped && result.resumes) parts.push(`${result.stopped} folgen nach dem nächsten Start (der Auftrag wird fortgesetzt)`);
  else if (result.stopped) parts.push(`${result.stopped} wegen Abbruch nicht mehr bearbeitet`);
  return `${parts.join(', ')}${result.jobId ? ' (als eigener Auftrag ausgeführt)' : ''}`;
}

const nothingSucceeded = (result: ArchiveResult) => result.success === 0 && result.failed + result.conflicts > 0;

function details(result: ArchiveResult, ctx: ToolContext): string {
  return result.items
    .filter((i) => i.outcome !== 'success')
    .slice(0, 30)
    .map((i) => `- ${ctx.refs.doc(i.documentId)}: ${i.outcome} – ${i.message}`)
    .join('\n');
}

export function fileTools(deps: ToolDeps): AgentTool[] {
  const { archive, categories } = deps;
  /** Target folder as the archive knows it (upper/lower case of existing folders, #244). */
  const canonical = (folder: string) => categories.canonical(folder);
  const newMain = (folder: string) => {
    try {
      return categories.needsApproval(canonical(folder));
    } catch {
      return null;
    }
  };

  return [
    defineTool({
      name: 'move_documents',
      description:
        'Archivierte Dokumente (D…/S…) in einen Ordner des Archivs verschieben; Unterordner werden angelegt. Eine NEUE Hauptkategorie (erste Ebene) fragt immer nach. Nichts wird überschrieben (gleichnamige Dateien bekommen einen freien Namen). Dokumente im Eingang mit archive_inbox ablegen.',
      schema: z.object({ documents: list, folder: z.string().min(1).describe('Zielordner relativ zum Archiv, z. B. "work/presentations"') }),
      risk: (a) => (newMain(a.folder) ? 'critical' : 'write'),
      count: (a, ctx) => affectedCount(ctx, a.documents),
      label: (a) => `Verschiebe ${a.documents.length === 1 && !a.documents[0]!.toUpperCase().startsWith('S') ? 'ein Dokument' : 'Dokumente'} nach ${a.folder}`,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs({ deps, ctx }, a.documents);
        if (!docs.length) return { content: `Keine Dokumente angegeben.${unknownNote(unknown)}`, isError: true };
        const target = canonical(a.folder);
        const main = categories.needsApproval(target);
        // only reached after the user confirmed (critical) – then the new main category is created with that confirmation
        if (main) categories.create(main, { confirmed: true });
        const inbox = docs.filter((d) => d.status !== 'archived');
        const movable = docs.filter((d) => d.status === 'archived' && d.archiveRelPath && normalizeFolder(folderOf(d)).toLowerCase() !== target.toLowerCase());
        const already = docs.length - inbox.length - movable.length;
        if (!movable.length)
          return {
            content: `Nichts zu verschieben: ${already} liegen bereits in ${target}${inbox.length ? `, ${inbox.length} sind noch im Eingang (archive_inbox)` : ''}.${unknownNote(unknown)}`,
            summary: 'nichts zu tun',
          };
        const result = await runFileJob(
          { deps, ctx },
          {
            op: 'relocate',
            items: movable.map((d) => ({ documentId: d.id, categoryPath: target })),
            label: `Agent: ${movable.length} Dateien nach ${target} verschieben`,
          },
        );
        return {
          content: `Verschoben nach ${target}: ${summarize(result)}.${already ? ` ${already} lagen bereits dort.` : ''}${inbox.length ? ` ${inbox.length} sind noch im Eingang (nicht verschoben).` : ''}\n${details(result, ctx)}${unknownNote(unknown)}`,
          summary: `${result.success} verschoben`,
          isError: nothingSucceeded(result),
          change: result.success ? `${result.success} Datei(en) nach ${target} verschoben` : undefined,
          changed: result.success,
        };
      },
    }),
    defineTool({
      name: 'propose_structure',
      description:
        'Eine neue Ordnerstruktur als PLAN vorschlagen: je Gruppe Dokumente (D…/S…) und Zielordner. Der Plan erscheint als eine Vorschlagskarte und wird erst nach Bestätigung durch den Benutzer ausgeführt (ganz oder teilweise je Gruppe). Für „Wie würdest du das ordnen?“ oder größere Umbauten statt vieler einzelner move_documents.',
      schema: z.object({
        groups: z
          .array(z.object({ documents: list, folder: z.string().min(1) }))
          .min(1)
          .max(50),
      }),
      // a plan is always a proposal: nothing moves before the user confirmed it
      risk: 'critical',
      count: (a, ctx) => a.groups.reduce((n, g) => n + affectedCount(ctx, g.documents), 0),
      label: (a) => `Neue Ordnerstruktur: ${a.groups.map((g) => g.folder).join(', ')}`,
      run: async (a, ctx) => {
        const items: Array<{ documentId: string; categoryPath: string }> = [];
        const unknownAll: string[] = [];
        for (const g of a.groups) {
          let target: string;
          try {
            target = canonical(sanitizeCategoryPath(g.folder));
          } catch (error) {
            return { content: `Ungültiger Zielordner „${g.folder}“: ${(error as Error).message}`, isError: true };
          }
          const main = categories.needsApproval(target);
          if (main) categories.create(main, { confirmed: true });
          const { docs, unknown } = resolveDocs({ deps, ctx }, g.documents);
          unknownAll.push(...unknown);
          for (const d of docs)
            if (d.status === 'archived' && d.archiveRelPath && folderOf(d).toLowerCase() !== target.toLowerCase())
              items.push({ documentId: d.id, categoryPath: target });
        }
        if (!items.length) return { content: `Nach diesem Plan ist nichts zu verschieben.${unknownNote(unknownAll)}`, summary: 'nichts zu tun' };
        const result = await runFileJob({ deps, ctx }, { op: 'relocate', items, label: `Agent: Ordnerstruktur nach Plan (${items.length} Dateien)` });
        return {
          content: `Plan umgesetzt: ${summarize(result)}.\n${details(result, ctx)}${unknownNote(unknownAll)}`,
          summary: `${result.success} verschoben`,
          isError: nothingSucceeded(result),
          change: result.success ? `Ordnerstruktur nach Plan: ${result.success} Datei(en) verschoben` : undefined,
          changed: result.success,
        };
      },
    }),
    defineTool({
      name: 'rename_documents',
      description:
        'Archivierte Dateien umbenennen: einzeln (name) oder nach Schema (pattern mit {datum}, {jahr}, {monat}, {typ}, {absender}, {titel}, {thema}, {projekt}, {original}). preview=true (Standard) zeigt nur die neuen Namen und Konflikte; erst danach mit preview=false ausführen. Keine Überschreibungen, keine Hash- oder UUID-Namen.',
      schema: z.object({ documents: list, pattern: optText, name: optText, preview: z.boolean().default(true) }),
      risk: (a) => (a.preview ? 'read' : 'write'),
      count: (a, ctx) => affectedCount(ctx, a.documents),
      label: (a) => (a.preview ? 'Plane neue Dateinamen' : 'Benenne Dateien um'),
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs({ deps, ctx }, a.documents);
        if (!docs.length) return { content: `Keine Dokumente angegeben.${unknownNote(unknown)}`, isError: true };
        if (!a.pattern && !a.name) return { content: 'Gib name (einzeln) oder pattern (Schema) an.', isError: true };
        if (a.name && docs.length > 1) return { content: 'Ein fester Name passt nur für ein Dokument – für mehrere ein pattern verwenden.', isError: true };
        const items = docs.map((d) => ({ documentId: d.id, fileName: a.name ?? fillPattern(a.pattern!, d) }));
        const empty = items.filter((i) => !i.fileName.trim());
        if (empty.length) return { content: `Das Schema ergibt für ${empty.length} Dokument(e) einen leeren Namen.`, isError: true };
        const plan = await archive.previewRename(items);
        const line = (p: (typeof plan)[number]) => {
          const d = docs.find((x) => x.id === p.documentId)!;
          const shareable = deps.privacy.mayShareDocument(d);
          const to = p.to ? path.posix.basename(p.to) : '–';
          return `- ${ctx.refs.doc(d.id)}: ${shareable ? `${path.posix.basename(p.from ?? '')} → ${to}` : `[nicht freigegeben] → ${to}`}${p.unchanged ? ' (unverändert)' : ''}${p.conflicts.length ? ` ⚠ ${p.conflicts.join(' ')}` : ''}`;
        };
        const conflicts = plan.filter((p) => p.conflicts.length).length;
        if (a.preview)
          return {
            content: `Vorschau (noch nichts umbenannt), ${plan.length} Datei(en), ${conflicts} mit Konflikt:\n${plan.slice(0, 80).map(line).join('\n')}${unknownNote(unknown)}`,
            summary: `${plan.length} geplant, ${conflicts} Konflikte`,
          };
        const result = await runFileJob({ deps, ctx }, { op: 'rename', items, label: `Agent: ${items.length} Dateien umbenennen` });
        return {
          content: `Umbenannt: ${summarize(result)}.\n${details(result, ctx)}`,
          summary: `${result.success} umbenannt`,
          change: result.success ? `${result.success} Datei(en) umbenannt` : undefined,
          changed: result.success,
          isError: nothingSucceeded(result),
        };
      },
    }),
    defineTool({
      name: 'create_folder',
      description: 'Einen Ordner im Archiv anlegen (Zwischenebenen inklusive). Eine neue Hauptkategorie fragt immer nach.',
      schema: z.object({ path: z.string().min(1) }),
      risk: (a) => (newMain(a.path) ? 'critical' : 'write'),
      label: (a) => `Lege den Ordner ${a.path} an`,
      run: async (a) => {
        const target = canonical(a.path);
        const existed = categories.list().some((c) => c.path === target);
        if (existed) return { content: `Der Ordner ${target} existiert bereits.`, summary: 'gab es schon' };
        const before = new Set(categories.list().map((x) => x.path));
        const category = categories.create(target, { confirmed: true });
        const added = categories
          .list()
          .map((x) => x.path)
          .filter((p) => !before.has(p));
        deps.audit.log({
          action: 'category.create',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          entityIds: [category.id],
          after: { path: category.path },
          undo: { type: FOLDER_CREATE_UNDO, data: { paths: added } satisfies FolderCreateUndoData },
        });
        return { content: `Ordner ${category.path} angelegt.`, summary: 'angelegt', change: `Ordner ${category.path} angelegt` };
      },
    }),
    defineTool({
      name: 'rename_folder',
      description:
        'Einen Ordner umbenennen oder mit einem anderen zusammenlegen: Alle Dokumente aus „from“ (inklusive Unterordnern, deren Struktur erhalten bleibt) werden nach „to“ verschoben. Eine neue Hauptkategorie fragt immer nach.',
      schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
      risk: (a) => (newMain(a.to) ? 'critical' : 'write'),
      count: (a) => {
        const from = normalizeFolder(a.from).toLowerCase();
        return deps.docs.list({ status: 'archived', limit: 50_000 }).filter((d) => {
          const f = folderOf(d).toLowerCase();
          return f === from || f.startsWith(`${from}/`);
        }).length;
      },
      label: (a) => `Lege den Ordner ${a.from} nach ${a.to} um`,
      run: async (a, ctx) => {
        const from = normalizeFolder(a.from);
        let to: string;
        try {
          to = canonical(sanitizeCategoryPath(a.to));
        } catch (error) {
          return { content: `Ungültiger Zielordner: ${(error as Error).message}`, isError: true };
        }
        const docs = deps.docs.list({ status: 'archived', limit: 50_000 }).filter((d) => {
          const f = folderOf(d).toLowerCase();
          return d.archiveRelPath && (f === from.toLowerCase() || f.startsWith(`${from.toLowerCase()}/`));
        });
        if (!docs.length) return { content: `Im Ordner ${from} liegen keine archivierten Dokumente.`, summary: 'leer' };
        const main = categories.needsApproval(to);
        if (main) categories.create(main, { confirmed: true });
        const items = docs.map((d) => ({ documentId: d.id, categoryPath: `${to}${folderOf(d).slice(from.length)}` }));
        const result = await runFileJob({ deps, ctx }, { op: 'relocate', items, label: `Agent: Ordner ${from} nach ${to} umlegen` });
        const removed = result.success ? await archive.removeEmptyFolders() : [];
        return {
          content: `${from} → ${to}: ${summarize(result)}.${removed.length ? ` Leere Ordner entfernt: ${removed.join(', ')}.` : ''}\n${details(result, ctx)}`,
          summary: `${result.success} verschoben`,
          change: result.success ? `Ordner ${from} nach ${to} umgelegt (${result.success} Dateien)` : undefined,
          changed: result.success,
        };
      },
    }),
    defineTool({
      name: 'remove_empty_folders',
      description: 'Leere Ordner des Archivs entfernen (Hauptkategorien bleiben).',
      schema: z.object({}),
      risk: 'write',
      label: () => 'Entferne leere Ordner',
      run: async () => {
        const removed = await archive.removeEmptyFolders();
        return {
          content: removed.length ? `Entfernt: ${removed.join(', ')}` : 'Es gab keine leeren Ordner.',
          summary: `${removed.length} entfernt`,
          change: removed.length ? `${removed.length} leere Ordner entfernt` : undefined,
        };
      },
    }),
    defineTool({
      name: 'archive_inbox',
      description:
        'Dokumente aus dem Eingang archivieren (in Serie), mit den vorhandenen Archivierungsarten: copy (Kopie ins Archiv, Original bleibt), index_only (nur indexieren), move (Original wird ins Archiv verschoben – ändert Dateien außerhalb des Archivs und fragt deshalb immer nach). folder optional, sonst der Vorschlag der Analyse.',
      schema: z.object({
        documents: list,
        mode: z.enum(['copy', 'move', 'index_only']).default('copy'),
        folder: optText,
        topic: optText,
        project: optText,
      }),
      risk: (a) => (a.mode === 'move' || (a.folder && newMain(a.folder)) ? 'critical' : 'write'),
      count: (a, ctx) => affectedCount(ctx, a.documents),
      label: (a) => `Archiviere ${a.documents.length === 1 ? 'ein Dokument' : 'Dokumente'} aus dem Eingang${a.folder ? ` nach ${a.folder}` : ''}`,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs({ deps, ctx }, a.documents);
        const open = docs.filter((d) => ['staged', 'proposed', 'failed'].includes(d.status));
        if (!open.length) return { content: `Keine Dokumente im Eingang darunter.${unknownNote(unknown)}`, isError: true };
        const folder = a.folder ? canonical(a.folder) : undefined;
        const main = folder ? categories.needsApproval(folder) : null;
        const result = await runFileJob(
          { deps, ctx },
          {
            op: 'archive',
            items: open.map((d) => ({
              documentId: d.id,
              mode: a.mode,
              ...(folder ? { categoryPath: folder } : {}),
              ...(a.topic !== null ? { topic: a.topic } : {}),
              ...(a.project !== null ? { project: a.project } : {}),
            })),
            label: `Agent: ${open.length} Dokument(e) aus dem Eingang archivieren`,
            consent: { approveNewCategories: main ? [main] : [], confirmMove: a.mode === 'move' },
          },
        );
        return {
          content: `Archiviert: ${summarize(result)}.\n${details(result, ctx)}${unknownNote(unknown)}`,
          summary: `${result.success} archiviert`,
          change: result.success ? `${result.success} Dokument(e) archiviert${folder ? ` (${folder})` : ''}` : undefined,
          changed: result.success,
          isError: nothingSucceeded(result),
        };
      },
    }),
    ...scanTools(deps),
  ];
}

import path from 'node:path';
import { z } from 'zod';
import { FOLDER_CREATE_UNDO, SCAN_EXCLUSION_UNDO, type FolderCreateUndoData, type ScanExclusionUndoData } from './tool-undo';
import type { ArchiveResult } from '@archivist/shared';
import { sanitizeCategoryPath } from '../../util/paths';
import { truncate } from '../../util/text';
import { folderOf } from '../../services/archive-structure';
import { fillPattern } from '../../services/rename-pattern';
import type { ArchiveConsent, FileOp, FileOpResult } from '../file-jobs';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import { docLine, normFolder, resolveDocs, unknownNote, type ToolDeps } from './common';

/** Moves and renames go through the file jobs: larger amounts as a job of their own, in chunks either way (#304). */
function bulk(deps: ToolDeps, ctx: ToolContext, op: FileOp, items: Parameters<ToolDeps['fileJobs']['run']>[1], label: string, consent?: ArchiveConsent) {
  return deps.fileJobs.run(op, items, { signal: ctx.signal, label, inJob: Boolean(ctx.job), report: ctx.job?.report, consent });
}

function summarize(res: ArchiveResult & Partial<Pick<FileOpResult, 'stopped' | 'jobId' | 'resumes'>>): string {
  const parts = [`${res.success} erfolgreich`];
  if (res.skipped) parts.push(`${res.skipped} übersprungen`);
  if (res.conflicts) parts.push(`${res.conflicts} Konflikte`);
  if (res.failed) parts.push(`${res.failed} fehlgeschlagen`);
  if (res.stopped && res.resumes) parts.push(`${res.stopped} folgen nach dem nächsten Start (der Auftrag wird fortgesetzt)`);
  else if (res.stopped) parts.push(`${res.stopped} wegen Abbruch nicht mehr bearbeitet`);
  return `${parts.join(', ')}${res.jobId ? ' (als eigener Auftrag ausgeführt)' : ''}`;
}

function details(res: ArchiveResult, ctx: ToolContext): string {
  return res.items
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
  const count = (refs: readonly string[], ctx: ToolContext) => ctx.refs.resolveMany(refs).ids.length || refs.length;

  return [
    defineTool({
      name: 'move_documents',
      description:
        'Archivierte Dokumente (D…/S…) in einen Ordner des Archivs verschieben; Unterordner werden angelegt. Eine NEUE Hauptkategorie (erste Ebene) fragt immer nach. Nichts wird überschrieben (gleichnamige Dateien bekommen einen freien Namen). Dokumente im Eingang mit archive_inbox ablegen.',
      schema: z.object({ documents: list, folder: z.string().min(1).describe('Zielordner relativ zum Archiv, z. B. "work/presentations"') }),
      risk: (a) => (newMain(a.folder) ? 'critical' : 'write'),
      count: (a, ctx) => count(a.documents, ctx),
      label: (a) => `Verschiebe ${a.documents.length === 1 && !a.documents[0]!.toUpperCase().startsWith('S') ? 'ein Dokument' : 'Dokumente'} nach ${a.folder}`,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
        if (!docs.length) return { content: `Keine Dokumente angegeben.${unknownNote(unknown)}`, isError: true };
        const target = canonical(a.folder);
        const main = categories.needsApproval(target);
        // only reached after the user confirmed (critical) – then the new main category is created with that confirmation
        if (main) categories.create(main, true);
        const inbox = docs.filter((d) => d.status !== 'archived');
        const movable = docs.filter((d) => d.status === 'archived' && d.archiveRelPath && normFolder(folderOf(d)).toLowerCase() !== target.toLowerCase());
        const already = docs.length - inbox.length - movable.length;
        if (!movable.length)
          return {
            content: `Nichts zu verschieben: ${already} liegen bereits in ${target}${inbox.length ? `, ${inbox.length} sind noch im Eingang (archive_inbox)` : ''}.${unknownNote(unknown)}`,
            summary: 'nichts zu tun',
          };
        const res = await bulk(
          deps,
          ctx,
          'relocate',
          movable.map((d) => ({ documentId: d.id, categoryPath: target })),
          `Agent: ${movable.length} Dateien nach ${target} verschieben`,
        );
        return {
          content: `Verschoben nach ${target}: ${summarize(res)}.${already ? ` ${already} lagen bereits dort.` : ''}${inbox.length ? ` ${inbox.length} sind noch im Eingang (nicht verschoben).` : ''}\n${details(res, ctx)}${unknownNote(unknown)}`,
          summary: `${res.success} verschoben`,
          isError: res.success === 0 && res.failed + res.conflicts > 0,
          change: res.success ? `${res.success} Datei(en) nach ${target} verschoben` : undefined,
          changed: res.success,
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
      count: (a, ctx) => a.groups.reduce((n, g) => n + count(g.documents, ctx), 0),
      label: (a) => `Neue Ordnerstruktur: ${a.groups.map((g) => g.folder).join(', ')}`,
      run: async (a, ctx) => {
        const items: Array<{ documentId: string; categoryPath: string }> = [];
        const unknownAll: string[] = [];
        for (const g of a.groups) {
          let target: string;
          try {
            target = canonical(sanitizeCategoryPath(g.folder));
          } catch (err) {
            return { content: `Ungültiger Zielordner „${g.folder}“: ${(err as Error).message}`, isError: true };
          }
          const main = categories.needsApproval(target);
          if (main) categories.create(main, true);
          const { docs, unknown } = resolveDocs(deps, ctx, g.documents);
          unknownAll.push(...unknown);
          for (const d of docs)
            if (d.status === 'archived' && d.archiveRelPath && folderOf(d).toLowerCase() !== target.toLowerCase())
              items.push({ documentId: d.id, categoryPath: target });
        }
        if (!items.length) return { content: `Nach diesem Plan ist nichts zu verschieben.${unknownNote(unknownAll)}`, summary: 'nichts zu tun' };
        const res = await bulk(deps, ctx, 'relocate', items, `Agent: Ordnerstruktur nach Plan (${items.length} Dateien)`);
        return {
          content: `Plan umgesetzt: ${summarize(res)}.\n${details(res, ctx)}${unknownNote(unknownAll)}`,
          summary: `${res.success} verschoben`,
          isError: res.success === 0 && res.failed + res.conflicts > 0,
          change: res.success ? `Ordnerstruktur nach Plan: ${res.success} Datei(en) verschoben` : undefined,
          changed: res.success,
        };
      },
    }),
    defineTool({
      name: 'rename_documents',
      description:
        'Archivierte Dateien umbenennen: einzeln (name) oder nach Schema (pattern mit {datum}, {jahr}, {monat}, {typ}, {absender}, {titel}, {thema}, {projekt}, {original}). preview=true (Standard) zeigt nur die neuen Namen und Konflikte; erst danach mit preview=false ausführen. Keine Überschreibungen, keine Hash- oder UUID-Namen.',
      schema: z.object({ documents: list, pattern: optText, name: optText, preview: z.boolean().default(true) }),
      risk: (a) => (a.preview ? 'read' : 'write'),
      count: (a, ctx) => count(a.documents, ctx),
      label: (a) => (a.preview ? 'Plane neue Dateinamen' : 'Benenne Dateien um'),
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
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
        const res = await bulk(deps, ctx, 'rename', items, `Agent: ${items.length} Dateien umbenennen`);
        return {
          content: `Umbenannt: ${summarize(res)}.\n${details(res, ctx)}`,
          summary: `${res.success} umbenannt`,
          change: res.success ? `${res.success} Datei(en) umbenannt` : undefined,
          changed: res.success,
          isError: res.success === 0 && res.failed + res.conflicts > 0,
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
        const c = categories.create(target, true);
        const added = categories
          .list()
          .map((x) => x.path)
          .filter((p) => !before.has(p));
        deps.audit.log({
          action: 'category.create',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          entityIds: [c.id],
          after: { path: c.path },
          undo: { type: FOLDER_CREATE_UNDO, data: { paths: added } satisfies FolderCreateUndoData },
        });
        return { content: `Ordner ${c.path} angelegt.`, summary: 'angelegt', change: `Ordner ${c.path} angelegt` };
      },
    }),
    defineTool({
      name: 'rename_folder',
      description:
        'Einen Ordner umbenennen oder mit einem anderen zusammenlegen: Alle Dokumente aus „from“ (inklusive Unterordnern, deren Struktur erhalten bleibt) werden nach „to“ verschoben. Eine neue Hauptkategorie fragt immer nach.',
      schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
      risk: (a) => (newMain(a.to) ? 'critical' : 'write'),
      count: (a) => {
        const from = normFolder(a.from).toLowerCase();
        return deps.docs.list({ status: 'archived', limit: 50_000 }).filter((d) => {
          const f = folderOf(d).toLowerCase();
          return f === from || f.startsWith(`${from}/`);
        }).length;
      },
      label: (a) => `Lege den Ordner ${a.from} nach ${a.to} um`,
      run: async (a, ctx) => {
        const from = normFolder(a.from);
        let to: string;
        try {
          to = canonical(sanitizeCategoryPath(a.to));
        } catch (err) {
          return { content: `Ungültiger Zielordner: ${(err as Error).message}`, isError: true };
        }
        const docs = deps.docs.list({ status: 'archived', limit: 50_000 }).filter((d) => {
          const f = folderOf(d).toLowerCase();
          return d.archiveRelPath && (f === from.toLowerCase() || f.startsWith(`${from.toLowerCase()}/`));
        });
        if (!docs.length) return { content: `Im Ordner ${from} liegen keine archivierten Dokumente.`, summary: 'leer' };
        const main = categories.needsApproval(to);
        if (main) categories.create(main, true);
        const items = docs.map((d) => ({ documentId: d.id, categoryPath: `${to}${folderOf(d).slice(from.length)}` }));
        const res = await bulk(deps, ctx, 'relocate', items, `Agent: Ordner ${from} nach ${to} umlegen`);
        const removed = res.success ? await archive.removeEmptyFolders() : [];
        return {
          content: `${from} → ${to}: ${summarize(res)}.${removed.length ? ` Leere Ordner entfernt: ${removed.join(', ')}.` : ''}\n${details(res, ctx)}`,
          summary: `${res.success} verschoben`,
          change: res.success ? `Ordner ${from} nach ${to} umgelegt (${res.success} Dateien)` : undefined,
          changed: res.success,
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
      count: (a, ctx) => count(a.documents, ctx),
      label: (a) => `Archiviere ${a.documents.length === 1 ? 'ein Dokument' : 'Dokumente'} aus dem Eingang${a.folder ? ` nach ${a.folder}` : ''}`,
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
        const open = docs.filter((d) => ['staged', 'proposed', 'failed'].includes(d.status));
        if (!open.length) return { content: `Keine Dokumente im Eingang darunter.${unknownNote(unknown)}`, isError: true };
        const folder = a.folder ? canonical(a.folder) : undefined;
        const main = folder ? categories.needsApproval(folder) : null;
        const res = await bulk(
          deps,
          ctx,
          'archive',
          open.map((d) => ({
            documentId: d.id,
            mode: a.mode,
            ...(folder ? { categoryPath: folder } : {}),
            ...(a.topic !== null ? { topic: a.topic } : {}),
            ...(a.project !== null ? { project: a.project } : {}),
          })),
          `Agent: ${open.length} Dokument(e) aus dem Eingang archivieren`,
          { approveNewCategories: main ? [main] : [], confirmMove: a.mode === 'move' },
        );
        return {
          content: `Archiviert: ${summarize(res)}.\n${details(res, ctx)}${unknownNote(unknown)}`,
          summary: `${res.success} archiviert`,
          change: res.success ? `${res.success} Dokument(e) archiviert${folder ? ` (${folder})` : ''}` : undefined,
          changed: res.success,
          isError: res.success === 0 && res.failed + res.conflicts > 0,
        };
      },
    }),
    defineTool({
      name: 'exclude_from_scan',
      description:
        'Eine Datei oder ein Verzeichnis von künftigen Scans ausschließen (remove=true hebt den Ausschluss auf). Nur innerhalb der freigegebenen Scan-Ordner, absoluter Pfad.',
      schema: z.object({ path: z.string().min(1), kind: z.enum(['file', 'dir']).default('dir'), remove: z.boolean().default(false) }),
      risk: 'write',
      label: (a) => (a.remove ? `Hebe den Scan-Ausschluss für ${truncate(a.path, 60)} auf` : `Schließe ${truncate(a.path, 60)} vom Scan aus`),
      run: async (a) => {
        // paths stay inside the folders the user released for scanning (#301)
        const roots = deps.scanner.listDirectories().map((r) => r.path);
        if (!roots.some((r) => deps.privacy.paths.same(r, a.path) || deps.privacy.paths.inside(r, a.path)))
          return { content: `„${a.path}“ liegt in keinem freigegebenen Scan-Ordner (${roots.join(', ') || 'keine eingerichtet'}).`, isError: true };
        if (a.remove) {
          const ex = deps.scanner.listExclusions().find((e) => deps.privacy.paths.same(e.path, a.path));
          if (!ex) return { content: `Für „${a.path}“ gibt es keinen Ausschluss.`, summary: 'nicht vorhanden' };
          deps.scanner.removeExclusion(ex.id);
          deps.audit.log({
            action: 'scan.include',
            actor: 'agent',
            trigger: 'agent',
            confirmed: true,
            paths: [ex.path],
            undo: { type: SCAN_EXCLUSION_UNDO, data: { kind: ex.kind, path: ex.path, excluded: false } satisfies ScanExclusionUndoData },
          });
          return { content: `Ausschluss für ${ex.path} aufgehoben.`, summary: 'aufgehoben', change: `Scan-Ausschluss für ${ex.path} aufgehoben` };
        }
        const ex = deps.scanner.exclude(a.kind, a.path);
        deps.audit.log({
          action: 'scan.exclude',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          paths: [ex.path],
          undo: { type: SCAN_EXCLUSION_UNDO, data: { kind: ex.kind, path: ex.path, excluded: true } satisfies ScanExclusionUndoData },
        });
        return { content: `${ex.path} wird künftig nicht mehr gescannt.`, summary: 'ausgeschlossen', change: `${ex.path} vom Scan ausgeschlossen` };
      },
    }),
    defineTool({
      name: 'start_scan',
      description: 'Die Dokumentensuche in den eingerichteten Ordnern starten (läuft als Hintergrundauftrag; neue Dateien landen im Eingang).',
      schema: z.object({}),
      risk: 'write',
      label: () => 'Starte die Dokumentensuche',
      run: async () => {
        if (!deps.settings.get().scan.enabled) return { content: 'Die Dokumentensuche ist in den Einstellungen ausgeschaltet.', isError: true };
        const job = deps.scanner.startScan(undefined, 'agent');
        return { content: `Suche gestartet (Auftrag ${job.id}).`, summary: 'gestartet' };
      },
    }),
    defineTool({
      name: 'reanalyze',
      description:
        'Analyse bzw. OCR für ausgewählte Dokumente erneut ausführen (als Hintergrundauftrag). Dokumente im Eingang werden neu analysiert; archivierte und nur indexierte werden neu gelesen (Text und OCR, Suchindex) – ihre Zuordnungen bleiben.',
      schema: z.object({ documents: list }),
      risk: 'write',
      count: (a, ctx) => count(a.documents, ctx),
      label: () => 'Analysiere Dokumente erneut',
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
        if (!docs.length) return { content: `Keine Dokumente angegeben.${unknownNote(unknown)}`, isError: true };
        const archived = docs.filter((d) => d.status === 'archived' || d.status === 'indexed_only');
        const skipped = docs.filter((d) => d.status === 'quarantined');
        const inbox = docs.filter((d) => !archived.includes(d) && !skipped.includes(d));
        const allowLlm = deps.privacy.mode() !== 'local_only';
        for (const d of inbox) deps.docs.enqueueAnalysis(d.id, allowLlm && deps.privacy.evaluateDocument(d).allowed);
        const rereadJob = archived.length ? deps.docs.enqueueReread(archived.map((d) => d.id)) : null;
        const lines = [
          inbox.length ? `${inbox.length} Dokument(e) im Eingang werden neu analysiert.` : null,
          rereadJob ? `${archived.length} archivierte(s) Dokument(e) werden neu gelesen (Auftrag ${rereadJob}); Zuordnungen bleiben.` : null,
          skipped.length ? `Nicht analysiert (in Quarantäne): ${skipped.map((d) => ctx.refs.doc(d.id)).join(', ')}` : null,
          ...docs.slice(0, 30).map((d) => `- ${docLine(d, ctx, deps.privacy)}`),
        ];
        return {
          content: `${lines.filter(Boolean).join('\n')}${unknownNote(unknown)}`,
          summary: `${inbox.length + archived.length} gestartet`,
          change: `${inbox.length + archived.length} Dokument(e) zur erneuten Analyse gegeben`,
          changed: inbox.length + archived.length,
        };
      },
    }),
  ];
}

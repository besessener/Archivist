import { z } from 'zod';
import { truncate } from '../../util/text';
import { defineTool, list, type AgentTool, type ToolOutput } from '../registry';
import { affectedCount, docLine, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from './common';
import { SCAN_EXCLUSION_UNDO, type ScanExclusionUndoData } from './tool-undo';

function logScanExclusion(deps: ToolDeps, change: { action: 'scan.include' | 'scan.exclude'; undo: ScanExclusionUndoData }): void {
  deps.audit.log({
    action: change.action,
    actor: 'agent',
    trigger: 'agent',
    confirmed: true,
    paths: [change.undo.path],
    undo: { type: SCAN_EXCLUSION_UNDO, data: change.undo },
  });
}

function liftScanExclusion(deps: ToolDeps, path: string): ToolOutput {
  const exclusion = deps.scanner.listExclusions().find((e) => deps.privacy.paths.same(e.path, path));
  if (!exclusion) return { content: `Für „${path}“ gibt es keinen Ausschluss.`, summary: 'nicht vorhanden' };
  deps.scanner.removeExclusion(exclusion.id);
  logScanExclusion(deps, { action: 'scan.include', undo: { kind: exclusion.kind, path: exclusion.path, excluded: false } });
  return { content: `Ausschluss für ${exclusion.path} aufgehoben.`, summary: 'aufgehoben', change: `Scan-Ausschluss für ${exclusion.path} aufgehoben` };
}

function excludeFromScan(deps: ToolDeps, target: { kind: 'file' | 'dir'; path: string }): ToolOutput {
  const existing = deps.scanner.listExclusions().find((e) => deps.privacy.paths.same(e.path, target.path));
  if (existing) return { content: `${existing.path} ist bereits vom Scan ausgeschlossen.`, summary: 'bereits ausgeschlossen' };
  const exclusion = deps.scanner.exclude(target.kind, target.path);
  logScanExclusion(deps, { action: 'scan.exclude', undo: { kind: exclusion.kind, path: exclusion.path, excluded: true } });
  return { content: `${exclusion.path} wird künftig nicht mehr gescannt.`, summary: 'ausgeschlossen', change: `${exclusion.path} vom Scan ausgeschlossen` };
}

async function reanalyze(scope: ToolScope, refs: readonly string[]): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs, unknown } = resolveDocs(scope, refs);
  if (!docs.length) return { content: `Keine Dokumente angegeben.${unknownNote(unknown)}`, isError: true };
  const archived = docs.filter((d) => d.status === 'archived' || d.status === 'indexed_only');
  const skipped = docs.filter((d) => d.status === 'quarantined');
  const inbox = docs.filter((d) => !archived.includes(d) && !skipped.includes(d));
  const allowLlm = deps.privacy.mode() !== 'local_only';
  for (const d of inbox) deps.docs.enqueueAnalysis(d.id, { allowLlm: allowLlm && deps.privacy.evaluateDocument(d).allowed });
  const rereadJob = archived.length ? deps.docs.enqueueReread(archived.map((d) => d.id)) : null;
  const lines = [
    inbox.length ? `${inbox.length} Dokument(e) im Eingang werden neu analysiert.` : null,
    rereadJob ? `${archived.length} archivierte(s) Dokument(e) werden neu gelesen (Auftrag ${rereadJob}); Zuordnungen bleiben.` : null,
    skipped.length ? `Nicht analysiert (in Quarantäne): ${skipped.map((d) => ctx.refs.doc(d.id)).join(', ')}` : null,
    ...docs.slice(0, 30).map((d) => `- ${docLine(scope, d)}`),
  ];
  return {
    content: `${lines.filter(Boolean).join('\n')}${unknownNote(unknown)}`,
    summary: `${inbox.length + archived.length} gestartet`,
    change: `${inbox.length + archived.length} Dokument(e) zur erneuten Analyse gegeben`,
    changed: inbox.length + archived.length,
  };
}

/** Scan exclusions, starting the scan and analysing documents again. */
export function scanTools(deps: ToolDeps): AgentTool[] {
  return [
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
        return a.remove ? liftScanExclusion(deps, a.path) : excludeFromScan(deps, a);
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
      count: (a, ctx) => affectedCount(ctx, a.documents),
      label: () => 'Analysiere Dokumente erneut',
      run: (a, ctx) => reanalyze({ deps, ctx }, a.documents),
    }),
  ];
}

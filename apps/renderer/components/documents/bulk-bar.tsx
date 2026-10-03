'use client';

import { useState } from 'react';
import { FolderInput, PenLine, RefreshCw, Tags, X } from 'lucide-react';
import { Field, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ArchiveResultRecord, DocRecord } from '@/lib/types';
import { parseList } from '@/lib/utils';
import { CaseSelect } from '@/components/knowledge/case-dialog';
import { RenameDialog } from './rename-dialog';
import { ReprocessDialog } from './reprocess-dialog';

type Result = { kind: 'assign'; updated: number } | { kind: 'reprocess' } | { kind: 'move' | 'rename'; result: ArchiveResultRecord };

function AssignDialog({ docs, onClose, onDone }: { docs: DocRecord[]; onClose: () => void; onDone: (r: Result) => void }) {
  const [topic, setTopic] = useState('');
  const [clearTopic, setClearTopic] = useState(false);
  const [project, setProject] = useState('');
  const [clearProject, setClearProject] = useState(false);
  const [addTags, setAddTags] = useState('');
  const [removeTags, setRemoveTags] = useState('');
  const [caseId, setCaseId] = useState('');
  const { run, busy } = useRun();
  // a topic/project is added (#287): the main one where none is set, otherwise a further one
  const patch = {
    ...(clearTopic ? { topic: null } : topic.trim() ? { addTopic: topic.trim() } : {}),
    ...(clearProject ? { project: null } : project.trim() ? { addProject: project.trim() } : {}),
    ...(caseId ? { caseId } : {}),
    ...(parseList(addTags).length ? { addTags: parseList(addTags) } : {}),
    ...(parseList(removeTags).length ? { removeTags: parseList(removeTags) } : {}),
  };
  const empty = Object.keys(patch).length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="bulk-assign-dialog">
        <DialogHeader>
          <DialogTitle>{plural(docs.length, ['Dokument', 'Dokumente'])} zuordnen</DialogTitle>
          <DialogDescription>
            Leere Felder bleiben unverändert. Ein Thema oder Projekt wird ergänzt: Hat ein Dokument noch keins, wird es das Hauptthema, sonst ein weiteres. Die
            Änderung ist ein einziger Schritt im Änderungsprotokoll und lässt sich dort rückgängig machen.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Field label="Thema ergänzen" htmlFor="bulk-topic">
              <Input id="bulk-topic" value={topic} disabled={clearTopic} onChange={(e) => setTopic(e.target.value)} data-testid="bulk-topic" />
            </Field>
            <CheckboxField label="Thema entfernen" checked={clearTopic} onCheckedChange={(v) => setClearTopic(v === true)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Field label="Projekt ergänzen" htmlFor="bulk-project">
              <Input id="bulk-project" value={project} disabled={clearProject} onChange={(e) => setProject(e.target.value)} data-testid="bulk-project" />
            </Field>
            <CheckboxField label="Projekt entfernen" checked={clearProject} onCheckedChange={(v) => setClearProject(v === true)} />
          </div>
          <Field label="Schlagwörter hinzufügen" htmlFor="bulk-add-tags" hint="Mit Komma trennen.">
            <Input id="bulk-add-tags" value={addTags} onChange={(e) => setAddTags(e.target.value)} data-testid="bulk-add-tags" />
          </Field>
          <Field label="Schlagwörter entfernen" htmlFor="bulk-remove-tags" hint="Mit Komma trennen.">
            <Input id="bulk-remove-tags" value={removeTags} onChange={(e) => setRemoveTags(e.target.value)} />
          </Field>
          <Field label="Vorgang" htmlFor="bulk-case" className="sm:col-span-2">
            <CaseSelect id="bulk-case" value={caseId} onChange={setCaseId} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={empty || busy}
            data-testid="bulk-assign-save"
            onClick={async () => {
              const out = await run(() => call('documents:bulkUpdate', { ids: docs.map((d) => d.id), ...patch, confirmed: true }), {
                errorTitle: 'Zuordnen fehlgeschlagen',
              });
              if (out) onDone({ kind: 'assign', updated: out.updated });
            }}
          >
            Zuordnen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveDialog({ docs, onClose, onDone }: { docs: DocRecord[]; onClose: () => void; onDone: (r: Result) => void }) {
  const [folder, setFolder] = useState('');
  const categories = useQuery('categories:list', {});
  const { run, busy } = useRun();
  const movable = docs.filter((d) => d.status === 'archived');
  const skipped = docs.length - movable.length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="bulk-move-dialog">
        <DialogHeader>
          <DialogTitle>{plural(movable.length, ['Dokument', 'Dokumente'])} verschieben</DialogTitle>
          <DialogDescription>
            Die Dateien werden innerhalb des Archivs in den gewählten Ordner verschoben. Jede Verschiebung lässt sich rückgängig machen.
          </DialogDescription>
        </DialogHeader>
        {skipped > 0 && (
          <Notice tone="warning">
            {plural(skipped, ['Dokument ist', 'Dokumente sind'])} nur indexiert und {skipped === 1 ? 'wird' : 'werden'} nicht verschoben.
          </Notice>
        )}
        <Field label="Zielordner im Archiv" htmlFor="bulk-folder" hint="z. B. finanzen/energie – ein neuer Ordner wird angelegt.">
          <Input id="bulk-folder" list="bulk-folder-options" value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="bulk-folder" />
          <datalist id="bulk-folder-options">
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.path} />
            ))}
          </datalist>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={!folder.trim() || movable.length === 0 || busy}
            data-testid="bulk-move-save"
            onClick={async () => {
              const out = await run(() => call('documents:relocate', { ids: movable.map((d) => d.id), categoryPath: folder.trim(), confirmed: true }), {
                errorTitle: 'Verschieben fehlgeschlagen',
              });
              if (out) onDone({ kind: 'move', result: out });
            }}
          >
            Verschieben
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultNote({ result, onDismiss }: { result: Result; onDismiss: () => void }) {
  const r = result.kind === 'move' || result.kind === 'rename' ? result.result : null;
  const problems = r ? r.items.filter((i) => i.outcome !== 'success') : [];
  return (
    <Notice
      tone={problems.length > 0 ? 'warning' : 'info'}
      title={
        result.kind === 'assign'
          ? `${plural(result.updated, ['Dokument', 'Dokumente'])} zugeordnet`
          : result.kind === 'reprocess'
            ? 'Neuverarbeitung gestartet'
            : result.kind === 'rename'
              ? 'Umbenennen abgeschlossen'
              : 'Verschieben abgeschlossen'
      }
      role="status"
      data-testid="bulk-result"
      className="relative"
    >
      {r && (
        <p>
          {r.success} {result.kind === 'rename' ? 'umbenannt' : 'verschoben'} · {r.skipped} übersprungen · {r.failed} fehlgeschlagen · {r.conflicts} Konflikte
        </p>
      )}
      {problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {problems.slice(0, 20).map((p) => (
            <li key={p.documentId}>{p.message}</li>
          ))}
        </ul>
      )}
      {result.kind === 'reprocess' && <p>Den Fortschritt siehst du bei den Aufgaben. Neue Metadaten erscheinen als Vorschlag im jeweiligen Dokument.</p>}
      {result.kind === 'assign' && <p>Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll.</p>}
      <Button size="icon-sm" variant="ghost" className="absolute right-1 top-1" aria-label="Hinweis schließen" onClick={onDismiss}>
        <X aria-hidden />
      </Button>
    </Notice>
  );
}

/** Bulk actions for a multi-selection of documents (#291, #304). */
export function BulkBar({ docs, onClear, onDone }: { docs: DocRecord[]; onClear: () => void; onDone: () => void }) {
  const [dialog, setDialog] = useState<'assign' | 'move' | 'rename' | 'reprocess' | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const finish = (r: Result) => {
    setDialog(null);
    setResult(r);
    onDone();
  };
  return (
    <div className="mb-3 flex flex-col gap-2">
      {docs.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2"
          role="region"
          aria-label="Mehrfachauswahl"
          data-testid="bulk-bar"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {plural(docs.length, ['Dokument', 'Dokumente'])} ausgewählt
          </span>
          <Button size="sm" variant="outline" onClick={() => setDialog('assign')} data-testid="bulk-assign">
            <Tags aria-hidden /> Zuordnen
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('move')} data-testid="bulk-move">
            <FolderInput aria-hidden /> Verschieben
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('rename')} data-testid="bulk-rename">
            <PenLine aria-hidden /> Umbenennen
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('reprocess')} data-testid="bulk-reprocess">
            <RefreshCw aria-hidden /> Neu verarbeiten
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} data-testid="bulk-clear">
            Auswahl aufheben
          </Button>
        </div>
      )}
      {result && <ResultNote result={result} onDismiss={() => setResult(null)} />}
      {dialog === 'assign' && <AssignDialog docs={docs} onClose={() => setDialog(null)} onDone={finish} />}
      {dialog === 'move' && <MoveDialog docs={docs} onClose={() => setDialog(null)} onDone={finish} />}
      {dialog === 'reprocess' && (
        <ReprocessDialog ids={docs.map((d) => d.id)} onClose={() => setDialog(null)} onStarted={() => finish({ kind: 'reprocess' })} />
      )}
      {dialog === 'rename' && <RenameDialog docs={docs} onClose={() => setDialog(null)} onDone={(r) => finish({ kind: 'rename', result: r })} />}
    </div>
  );
}

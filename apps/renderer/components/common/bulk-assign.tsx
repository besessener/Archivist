'use client';

import { useState } from 'react';
import { Tags, X } from 'lucide-react';
import { Field, Notice } from '@/components/common/states';
import { CaseSelect } from '@/components/knowledge/case-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useRun } from '@/lib/use-run';

/**
 * Bulk assignment for the multi-selection of a list (#291): topic, project, tag and case for all selected entries at once
 * – ONE undo step. A topic or project is added (#287): the main one where none is set, otherwise a further one.
 */
function BulkAssignDialog({ ids, noun, onClose, onDone }: { ids: string[]; noun: [string, string]; onClose: () => void; onDone: (n: number) => void }) {
  const [topic, setTopic] = useState('');
  const [project, setProject] = useState('');
  const [tag, setTag] = useState('');
  const [caseId, setCaseId] = useState('');
  const { run, busy } = useRun();
  const empty = !topic.trim() && !project.trim() && !tag.trim() && !caseId;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="entries-assign-dialog">
        <DialogHeader>
          <DialogTitle>{plural(ids.length, noun[0], noun[1])} zuordnen</DialogTitle>
          <DialogDescription>
            Leere Felder bleiben unverändert. Ein Thema oder Projekt wird ergänzt: Hat ein Eintrag noch keins, wird es sein Hauptthema, sonst ein weiteres.
            Alles ist ein einziger Schritt im Änderungsprotokoll und lässt sich dort rückgängig machen.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Thema" htmlFor="entries-assign-topic">
            <Input id="entries-assign-topic" value={topic} onChange={(e) => setTopic(e.target.value)} data-testid="entries-assign-topic" />
          </Field>
          <Field label="Projekt" htmlFor="entries-assign-project">
            <Input id="entries-assign-project" value={project} onChange={(e) => setProject(e.target.value)} data-testid="entries-assign-project" />
          </Field>
          <Field label="Tag" htmlFor="entries-assign-tag">
            <Input id="entries-assign-tag" value={tag} onChange={(e) => setTag(e.target.value)} data-testid="entries-assign-tag" />
          </Field>
          <Field label="Vorgang" htmlFor="entries-assign-case">
            <CaseSelect id="entries-assign-case" value={caseId} onChange={setCaseId} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={empty || busy}
            data-testid="entries-assign-save"
            onClick={async () => {
              const out = await run(
                () =>
                  call('entries:bulkAssign', {
                    ids,
                    ...(topic.trim() ? { topic: topic.trim() } : {}),
                    ...(project.trim() ? { project: project.trim() } : {}),
                    ...(tag.trim() ? { tag: tag.trim() } : {}),
                    ...(caseId ? { caseId } : {}),
                  }),
                { errorTitle: 'Zuordnen fehlgeschlagen' },
              );
              if (out) onDone(out.updated);
            }}
          >
            Zuordnen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The bar above a list while entries are selected (#291): how many, „Zuordnen“, „Auswahl aufheben“, the result. */
export function BulkAssignBar({ ids, noun, onClear, onDone }: { ids: string[]; noun: [string, string]; onClear: () => void; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="mb-3 flex flex-col gap-2">
      {ids.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2"
          role="region"
          aria-label="Mehrfachauswahl"
          data-testid="entries-bulk-bar"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {plural(ids.length, noun[0], noun[1])} ausgewählt
          </span>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="entries-bulk-assign">
            <Tags aria-hidden /> Zuordnen
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} data-testid="entries-bulk-clear">
            Auswahl aufheben
          </Button>
        </div>
      )}
      {done !== null && (
        <Notice tone="info" title={`${plural(done, noun[0], noun[1])} zugeordnet`} role="status" className="relative" data-testid="entries-bulk-result">
          <p>Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll.</p>
          <Button size="icon-sm" variant="ghost" className="absolute right-1 top-1" aria-label="Hinweis schließen" onClick={() => setDone(null)}>
            <X aria-hidden />
          </Button>
        </Notice>
      )}
      {open && (
        <BulkAssignDialog
          ids={ids}
          noun={noun}
          onClose={() => setOpen(false)}
          onDone={(n) => {
            setOpen(false);
            setDone(n);
            onClear();
            onDone?.();
          }}
        />
      )}
    </div>
  );
}

/** Selection of a list (#291): a set of ids with toggle and clear. */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return {
    selected,
    ids: [...selected],
    has: (id: string) => selected.has(id),
    toggle: (id: string, on: boolean) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    setAll: (ids: string[]) => setSelected(new Set(ids)),
    clear: () => setSelected(new Set()),
  };
}

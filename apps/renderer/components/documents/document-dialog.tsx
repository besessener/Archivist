'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Pencil } from 'lucide-react';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useExtraSubjects } from '@/components/common/extra-subjects';
import { ErrorNote, Loading } from '@/components/common/states';
import { RelatedEntries } from '@/components/knowledge/related';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { call } from '@/lib/ipc';
import { DOCUMENT_STATUS_LABELS, LLM_STATUS_LABELS } from '@/lib/labels';
import { formatBytes } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';
import { parseList } from '@/lib/utils';
import { DocumentEditFields, DocumentMeta, type MetadataForm } from './document-meta';
import { TrashDocumentButton } from './trash-document';

type Change = [label: string, before: string, after: string];

export function DocumentDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const query = useQuery('documents:get', id ? { id } : undefined, { scopes: ['documents'], enabled: !!id });
  const doc = query.data;
  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="document-dialog">
        {!doc && query.error && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
        {!doc && !query.error && <Loading />}
        {doc && (
          <DocumentDetail
            key={doc.id + doc.updatedAt}
            doc={doc}
            onChanged={() => {
              onChanged();
              void query.refetch();
            }}
            onTrashed={() => {
              onChanged();
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentDetail({ doc, onChanged, onTrashed }: { doc: DocRecord; onChanged: () => void; onTrashed: () => void }) {
  const { run, busy } = useRun();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [topic, setTopic] = useState(doc.topicName ?? '');
  const [project, setProject] = useState(doc.projectName ?? '');
  const [tags, setTags] = useState(doc.tags.join(', '));
  const [persons, setPersons] = useState(doc.persons.join(', '));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const extra = useExtraSubjects(doc.id);
  const form: MetadataForm = { title, setTitle, topic, setTopic, project, setProject, tags, setTags, persons, setPersons };

  useEffect(() => {
    setEditing(false);
  }, [doc.id]);

  const changes: Change[] = [
    ['Titel', doc.title, title.trim()],
    ['Thema', doc.topicName ?? '', topic.trim()],
    ['Projekt', doc.projectName ?? '', project.trim()],
    ['Schlagwörter', doc.tags.join(', '), parseList(tags).join(', ')],
    ['Personen', doc.persons.join(', '), parseList(persons).join(', ')],
  ];
  const changed = changes.filter(([, before, after]) => before !== after);
  const extraChanges: Change[] = [
    ['Weitere Themen', extra.initialTopics, parseList(extra.topics).join(', ')],
    ['Weitere Projekte', extra.initialProjects, parseList(extra.projects).join(', ')],
  ];
  const allChanged = [...changed, ...extraChanges.filter(([, before, after]) => before !== after)];

  const save = async () => {
    const saved = await run(
      async () => {
        if (changed.length)
          await call('documents:updateMetadata', {
            id: doc.id,
            title: title.trim(),
            topic: topic.trim() || null,
            project: project.trim() || null,
            tags: parseList(tags),
            persons: parseList(persons),
            confirmed: true,
          });
        await extra.save(doc.id);
        return true;
      },
      { success: 'Metadaten gespeichert.' },
    );
    if (!saved) return;
    setConfirmOpen(false);
    setEditing(false);
    onChanged();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="break-words">{doc.title}</DialogTitle>
        <DialogDescription>
          {doc.originalName} · {formatBytes(doc.size)} · {doc.docType ?? 'Dokument'}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary">{DOCUMENT_STATUS_LABELS[doc.status]}</Badge>
        <Badge variant="outline">{LLM_STATUS_LABELS[doc.llmStatus]}</Badge>
        <ConfidenceBadge value={doc.confidence} />
      </div>
      {doc.summary && <p className="text-sm">{doc.summary}</p>}

      {!editing ? <DocumentMeta doc={doc} extra={extra} /> : <DocumentEditFields form={form} extra={extra} />}
      {doc.textPreview && !editing && (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{doc.textPreview}</p>
      )}

      {(doc.status === 'archived' || doc.status === 'indexed_only') && <RelatedEntries id={doc.id} link={{ name: doc.title }} />}

      <DialogFooter className="sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="doc-open"
            onClick={() => void run(() => call('app:openPath', { documentId: doc.id }), { errorTitle: 'Datei konnte nicht geöffnet werden' })}
          >
            <ExternalLink aria-hidden /> Datei öffnen
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="doc-reveal"
            onClick={() => void run(() => call('app:revealPath', { documentId: doc.id }), { errorTitle: 'Ordner konnte nicht geöffnet werden' })}
          >
            <FolderOpen aria-hidden /> Im Ordner zeigen
          </Button>
          <TrashDocumentButton doc={doc} onTrashed={onTrashed} />
        </div>
        {!editing ? (
          <Button size="sm" onClick={() => setEditing(true)} data-testid="doc-edit">
            <Pencil aria-hidden /> Metadaten bearbeiten
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Abbrechen
            </Button>
            <Button size="sm" disabled={allChanged.length === 0 || !title.trim()} onClick={() => setConfirmOpen(true)} data-testid="doc-save">
              Speichern …
            </Button>
          </div>
        )}
      </DialogFooter>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Änderungen übernehmen?"
        description="Diese Angaben werden im Archiv geändert:"
        confirmLabel="Änderungen speichern"
        onConfirm={save}
      >
        <ul className="flex flex-col gap-1.5 text-sm">
          {allChanged.map(([label, before, after]) => (
            <li key={label}>
              <span className="font-medium">{label}: </span>
              <span className="text-muted-foreground line-through">{before || '–'}</span> → <span>{after || '–'}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

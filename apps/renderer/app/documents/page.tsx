'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, FolderOpen, Pencil, Search, X } from 'lucide-react';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { call } from '@/lib/ipc';
import { LLM_STATUS_LABELS } from '@/lib/labels';
import { formatBytes, formatDate, formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';
import type { DocumentStatus } from '@archivist/shared';
import { parseList } from '@/lib/utils';

const ARCHIVED: DocumentStatus[] = ['archived', 'indexed_only'];
const LIMIT = 1000;

function DocumentsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const topicId = params.get('topicId');
  const openId = params.get('id');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const q = useDebounced(search.trim(), 300);
  // filtered in the database: archived documents are no longer hidden behind newer inbox entries; the total tells
  // whether the list is complete (#222)
  const filter = { statuses: ARCHIVED, ...(q ? { query: q } : {}), ...(topicId ? { topicId } : {}) };
  const list = useQuery('documents:list', { ...filter, limit: LIMIT }, { scopes: ['documents'] });
  const total = useQuery('documents:count', filter, { scopes: ['documents'] });
  const topic = useQuery('knowledge:getEntity', topicId ? { id: topicId } : undefined, { enabled: !!topicId });

  const docs = list.data ?? [];
  const types = [...new Set(docs.map((d) => d.docType).filter((t): t is string => !!t))].sort();
  const shown = docs.filter((d) => !type || d.docType === type);

  return (
    <Page wide>
      <PageHeader title="Dokumente" description="Alle archivierten und indexierten Dokumente. Klicke auf eine Zeile für Einzelheiten." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Dokumente durchsuchen …"
            aria-label="Dokumente durchsuchen"
            className="pl-9"
            data-testid="documents-search"
          />
        </div>
        <div className="w-48">
          <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Dokumenttyp filtern" data-testid="documents-type-filter">
            <option value="">Alle Typen</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        {topicId && (
          <Badge variant="info" className="gap-2 py-1" data-testid="documents-topic-filter">
            Thema: {topic.data?.entity.name ?? '…'}
            <button
              type="button"
              aria-label="Themenfilter entfernen"
              className="rounded-full hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => router.push('/documents/')}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </Badge>
        )}
      </div>
      {(total.data ?? 0) > docs.length && (
        <p className="mb-4 text-sm text-muted-foreground" data-testid="documents-capped">
          Angezeigt werden die neuesten {docs.length.toLocaleString('de-DE')} von {total.data!.toLocaleString('de-DE')} Dokumenten. Grenze die Liste mit der
          Suche oder einem Thema ein, um ältere zu finden.
        </p>
      )}
      {list.error && !list.data && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {!list.data && list.loading && <Loading />}
      {list.data && shown.length === 0 && (
        <EmptyState title="Keine Dokumente gefunden" description="Archivierte Dokumente erscheinen hier, sobald du Inbox-Einträge archiviert hast." />
      )}
      {shown.length > 0 && (
        <div className="rounded-xl border bg-card">
          <Table data-testid="documents-table">
            <THead>
              <tr>
                <TH>Titel</TH>
                <TH>Typ</TH>
                <TH>Kategorie</TH>
                <TH>Thema</TH>
                <TH>Projekt</TH>
                <TH>Datum</TH>
                <TH>Pfad</TH>
              </tr>
            </THead>
            <TBody>
              {shown.map((d) => (
                <TR key={d.id} data-testid="document-row">
                  <TD className="max-w-xs">
                    <button
                      type="button"
                      className="text-left font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => router.push(`/documents/?id=${encodeURIComponent(d.id)}${topicId ? `&topicId=${encodeURIComponent(topicId)}` : ''}`)}
                    >
                      {d.title}
                    </button>
                  </TD>
                  <TD>{d.docType ?? '–'}</TD>
                  <TD>{d.categoryPath ?? '–'}</TD>
                  <TD>{d.topicName ?? '–'}</TD>
                  <TD>{d.projectName ?? '–'}</TD>
                  <TD className="whitespace-nowrap">
                    {d.documentDate ? (
                      formatDate(d.documentDate)
                    ) : (
                      <span className="text-muted-foreground" title="Dokumentdatum unbekannt – Datum der Archivierung">
                        {formatDate(d.archivedAt ?? d.createdAt)} (archiviert)
                      </span>
                    )}
                  </TD>
                  <TD className="max-w-xs break-all text-xs text-muted-foreground">{d.archivePath ?? d.archiveRelPath ?? '–'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      <DocumentDialog
        id={openId}
        onClose={() => router.push(topicId ? `/documents/?topicId=${encodeURIComponent(topicId)}` : '/documents/')}
        onChanged={() => void list.refetch()}
      />
    </Page>
  );
}

function DocumentDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const q = useQuery('documents:get', id ? { id } : undefined, { scopes: ['documents'], enabled: !!id });
  const doc = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="document-dialog">
        {!doc && q.error && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
        {!doc && !q.error && <Loading />}
        {doc && (
          <DocumentDetail
            key={doc.id + doc.updatedAt}
            doc={doc}
            onChanged={() => {
              onChanged();
              void q.refetch();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentDetail({ doc, onChanged }: { doc: DocRecord; onChanged: () => void }) {
  const { run, busy } = useRun();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [topic, setTopic] = useState(doc.topicName ?? '');
  const [project, setProject] = useState(doc.projectName ?? '');
  const [tags, setTags] = useState(doc.tags.join(', '));
  const [persons, setPersons] = useState(doc.persons.join(', '));
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
  }, [doc.id]);

  const changes: Array<[string, string, string]> = [
    ['Titel', doc.title, title.trim()],
    ['Thema', doc.topicName ?? '', topic.trim()],
    ['Projekt', doc.projectName ?? '', project.trim()],
    ['Schlagwörter', doc.tags.join(', '), parseList(tags).join(', ')],
    ['Personen', doc.persons.join(', '), parseList(persons).join(', ')],
  ];
  const changed = changes.filter(([, a, b]) => a !== b);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="break-words">{doc.title}</DialogTitle>
        <DialogDescription>
          {doc.originalName} · {formatBytes(doc.size)} · {doc.docType ?? 'Dokument'}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary">{doc.status === 'indexed_only' ? 'Nur indexiert' : doc.status === 'archived' ? 'Archiviert' : doc.status}</Badge>
        <Badge variant="outline">{LLM_STATUS_LABELS[doc.llmStatus]}</Badge>
        <ConfidenceBadge value={doc.confidence} />
      </div>
      {doc.summary && <p className="text-sm">{doc.summary}</p>}

      {!editing ? (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]" data-testid="document-meta">
          <dt className="text-muted-foreground">Kategorie</dt>
          <dd>{doc.categoryPath ?? '–'}</dd>
          <dt className="text-muted-foreground">Thema</dt>
          <dd>{doc.topicName ?? '–'}</dd>
          <dt className="text-muted-foreground">Projekt</dt>
          <dd>{doc.projectName ?? '–'}</dd>
          <dt className="text-muted-foreground">Personen</dt>
          <dd>{doc.persons.length ? doc.persons.join(', ') : '–'}</dd>
          <dt className="text-muted-foreground">Schlagwörter</dt>
          <dd>{doc.tags.length ? doc.tags.join(', ') : '–'}</dd>
          <dt className="text-muted-foreground">Dokumentdatum</dt>
          <dd>{formatDate(doc.documentDate, 'unbekannt')}</dd>
          <dt className="text-muted-foreground">Datumsangaben</dt>
          <dd>{doc.dates.length ? doc.dates.map((d) => formatDate(d, d)).join(', ') : '–'}</dd>
          <dt className="text-muted-foreground">Archiviert am</dt>
          <dd>{formatDateTime(doc.archivedAt)}</dd>
          <dt className="text-muted-foreground">Pfad</dt>
          <dd className="break-all text-xs">{doc.archivePath ?? '–'}</dd>
          <dt className="text-muted-foreground">Prüfsumme</dt>
          <dd className="break-all font-mono text-xs">{doc.sha256}</dd>
        </dl>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="document-edit">
          <Field label="Titel" htmlFor="doc-title" className="sm:col-span-2">
            <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="doc-edit-title" />
          </Field>
          <Field label="Thema" htmlFor="doc-topic">
            <Input id="doc-topic" value={topic} onChange={(e) => setTopic(e.target.value)} data-testid="doc-edit-topic" />
          </Field>
          <Field label="Projekt" htmlFor="doc-project">
            <Input id="doc-project" value={project} onChange={(e) => setProject(e.target.value)} data-testid="doc-edit-project" />
          </Field>
          <Field label="Schlagwörter" htmlFor="doc-tags" hint="Mit Komma trennen.">
            <Input id="doc-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <Field label="Personen" htmlFor="doc-persons" hint="Mit Komma trennen.">
            <Input id="doc-persons" value={persons} onChange={(e) => setPersons(e.target.value)} />
          </Field>
        </div>
      )}
      {doc.textPreview && !editing && (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{doc.textPreview}</p>
      )}

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
            <Button size="sm" disabled={changed.length === 0 || !title.trim()} onClick={() => setConfirmOpen(true)} data-testid="doc-save">
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
        onConfirm={async () => {
          const out = await run(
            () =>
              call('documents:updateMetadata', {
                id: doc.id,
                title: title.trim(),
                topic: topic.trim() || null,
                project: project.trim() || null,
                tags: parseList(tags),
                persons: parseList(persons),
                confirmed: true,
              }),
            { success: 'Metadaten gespeichert.' },
          );
          if (out) {
            setConfirmOpen(false);
            setEditing(false);
            onChanged();
          }
        }}
      >
        <ul className="flex flex-col gap-1.5 text-sm">
          {changed.map(([label, before, after]) => (
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

export default function DocumentsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DocumentsInner />
    </Suspense>
  );
}

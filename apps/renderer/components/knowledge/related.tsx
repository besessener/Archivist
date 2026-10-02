'use client';

import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, FolderKanban, Link2, X } from 'lucide-react';
import { RELATION_METHOD_LABELS, RELATION_PROVENANCE_LABELS, RelationType, relationProvenance, type GraphRelation } from '@archivist/shared';
import { EntityChip, EntityIcon } from '@/components/common/entity-chip';
import { ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { RELATION_TYPE_LABELS } from '@/lib/labels';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { cn } from '@/lib/utils';
import { CaseAssignDialog } from './case-dialog';

/**
 * Who stands behind a relation and why (#270): „automatisch“, „von dir bestätigt“ or „manuell“, how it came about and its
 * evidence (the passage, the message …). A field mirror is never shown as confirmed by the user unless the user did so (#189).
 */
export function RelationProvenance({ relation }: { relation: Pick<GraphRelation, 'origin' | 'method' | 'resolvedByUser' | 'status' | 'evidence'> }) {
  const kind = relationProvenance(relation);
  const label = kind === 'auto' && relation.origin === 'agent' ? 'vom Agenten' : RELATION_PROVENANCE_LABELS[kind];
  return (
    <>
      <Badge variant="outline" data-testid="relation-provenance" data-provenance={kind}>
        {label}
      </Badge>
      {relation.method && relation.method !== 'manual' && (
        <span className="text-xs text-muted-foreground" data-testid="relation-method">
          {RELATION_METHOD_LABELS[relation.method]}
        </span>
      )}
      {relation.evidence && (
        <p className="basis-full text-xs text-muted-foreground" data-testid="relation-evidence">
          Beleg: „{relation.evidence}“
        </p>
      )}
    </>
  );
}

const RELATED_PAGE = 10;

/**
 * Related entries (#276): direct relations and connections over shared topics, projects, persons, tags and cases –
 * strongest first, each with its reason („gleiches Projekt … + gleiche Person …“). Proposals can be confirmed or rejected
 * right here (undoable). With `link`, the section brings its own „Verknüpfen“ button (#277).
 */
export function RelatedEntries({ id, link }: { id: string; link?: { name: string } }) {
  const [page, setPage] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState(false);
  const q = useQuery('knowledge:related', { id, limit: RELATED_PAGE, offset: page * RELATED_PAGE }, { scopes: ['knowledge'] });
  const { run, busy } = useRun();
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / RELATED_PAGE));
  const decide = async (relationId: string, status: 'confirmed' | 'rejected') => {
    const out = await run(() => call('knowledge:resolveRelation', { relationId, status, confirmed: true }), {
      success: status === 'confirmed' ? 'Bestätigt. Rückgängig im Änderungsprotokoll.' : 'Abgelehnt – wird nicht wieder vorgeschlagen.',
    });
    if (out) void q.refetch();
  };
  return (
    <section data-testid="related-entries">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Verwandte Einträge{q.data ? ` (${total})` : ''}</h3>
        {link && (
          <span className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setCaseOpen(true)} data-testid="related-case">
              <FolderKanban aria-hidden /> Zu Vorgang hinzufügen
            </Button>
            <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)} data-testid="related-link">
              <Link2 aria-hidden /> Verknüpfen
            </Button>
          </span>
        )}
      </div>
      {q.error && !q.data && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {!q.data && q.loading && <Loading />}
      {q.data && total === 0 && <p className="text-sm text-muted-foreground">Keine verwandten Einträge gefunden.</p>}
      {q.data && q.data.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {q.data.items.map((r) => (
            <li key={r.entity.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5" data-testid="related-entry">
              <EntityChip type={r.entity.type} id={r.entity.id} label={r.entity.name} detail={r.entity.description} />
              {r.relation?.status === 'proposed' && (
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(r.relation!.id, 'confirmed')} data-testid="related-confirm">
                    <Check aria-hidden /> Bestätigen
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(r.relation!.id, 'rejected')} data-testid="related-reject">
                    <X aria-hidden /> Ablehnen
                  </Button>
                </span>
              )}
              <p className="basis-full text-xs text-muted-foreground" data-testid="related-reason">
                {r.reason}
              </p>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Seite {page + 1} von {pages}
          </span>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Vorherige Seite">
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Nächste Seite"
            data-testid="related-next"
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
      {link && <CaseAssignDialog entryIds={[id]} open={caseOpen} onOpenChange={setCaseOpen} onDone={() => void q.refetch()} />}
      {link && (
        <LinkDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          sourceId={id}
          sourceName={link.name}
          onLinked={() => {
            setLinkOpen(false);
            void q.refetch();
          }}
        />
      )}
    </section>
  );
}

/**
 * Link proposals for the entry (#283, #313): similar entries and mentioned topics/projects, with the reason – the same
 * function as the agent's `suggest_links`. „Verknüpfen“ confirms the link (undoable); ignoring has no consequences.
 */
export function LinkSuggestions({ id }: { id: string }) {
  const q = useQuery('links:suggestions', { id, limit: 3 }, { scopes: ['knowledge'] });
  const { run, busy } = useRun();
  if (!q.data?.length) return null;
  return (
    <section data-testid="link-suggestions">
      <h3 className="mb-2 text-sm font-semibold">Vorschläge zum Verknüpfen</h3>
      <ul className="flex flex-col gap-2">
        {q.data.map((c) => (
          <li key={c.id} className="flex items-start gap-2 rounded-lg border border-dashed p-2.5" data-testid="link-suggestion">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <EntityChip type={c.type} id={c.id} label={c.name} />
              <p className="text-xs text-muted-foreground">{c.reason}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Mit „${c.name}“ verknüpfen`}
              data-testid="link-suggestion-accept"
              onClick={async () => {
                const out = await run(
                  () =>
                    call('knowledge:link', {
                      sourceId: id,
                      targetId: c.id,
                      relationType: c.method === 'mention' ? 'relates_to' : 'related_to',
                      method: c.method,
                      evidence: c.reason,
                      confirmed: true,
                    }),
                  { success: 'Verknüpft.', errorTitle: 'Verknüpfen fehlgeschlagen' },
                );
                if (out) void q.refetch();
              }}
            >
              <Link2 aria-hidden /> Verknüpfen
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Links the entry with another one the user picks (#277). */
export function LinkDialog({
  open,
  onOpenChange,
  sourceId,
  sourceName,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceId: string;
  sourceName: string;
  onLinked: () => void;
}) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null);
  const [relationType, setRelationType] = useState<RelationType>('relates_to');
  const query = useDebounced(search.trim(), 250);
  const results = useQuery('search:global', query ? { query, limit: 20 } : undefined, { enabled: open && query.length > 0 });
  const { run, busy } = useRun();
  const options = (results.data ?? []).filter((r) => r.id !== sourceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="link-dialog">
        <DialogHeader>
          <DialogTitle>Verknüpfen</DialogTitle>
          <DialogDescription>Verknüpfe „{sourceName}“ mit einem anderen Eintrag. Die Verknüpfung gilt als von dir bestätigt.</DialogDescription>
        </DialogHeader>
        <Field label="Eintrag suchen" htmlFor="link-search">
          <Input id="link-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, Titel …" data-testid="link-search" />
        </Field>
        {query && results.loading && !results.data && <Loading />}
        {query && results.data && options.length === 0 && <p className="text-sm text-muted-foreground">Nichts gefunden.</p>}
        {options.length > 0 && (
          <div role="radiogroup" aria-label="Ziel der Verknüpfung" className="flex max-h-60 flex-col gap-1 overflow-y-auto">
            {options.map((r) => {
              const checked = target?.id === r.id;
              return (
                <label
                  key={`${r.type}-${r.id}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm focus-within:outline-2 focus-within:outline-ring hover:bg-accent',
                    checked && 'border-primary bg-primary/8',
                  )}
                >
                  <input
                    type="radio"
                    name="link-target"
                    className="sr-only"
                    checked={checked}
                    onChange={() => setTarget({ id: r.id, title: r.title })}
                    data-testid="link-result"
                  />
                  <EntityIcon type={r.type} className="size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="text-xs text-muted-foreground">{ENTITY_TYPE_LABELS[r.type]}</span>
                  {checked && <span className="text-xs font-medium">ausgewählt</span>}
                </label>
              );
            })}
          </div>
        )}
        <Field label="Art der Beziehung" htmlFor="link-type">
          <Select id="link-type" value={relationType} onChange={(e) => setRelationType(e.target.value as RelationType)} data-testid="link-type">
            {RelationType.options
              .filter((t) => t !== 'duplicate_of')
              .map((t) => (
                <option key={t} value={t}>
                  {RELATION_TYPE_LABELS[t]}
                </option>
              ))}
          </Select>
        </Field>
        {target && (
          <p className="text-sm">
            „{sourceName}“ <strong>{RELATION_TYPE_LABELS[relationType]}</strong> „{target.title}“
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={!target || busy}
            data-testid="link-save"
            onClick={async () => {
              if (!target) return;
              const out = await run(() => call('knowledge:link', { sourceId, targetId: target.id, relationType, confirmed: true }), {
                success: 'Verknüpft.',
                errorTitle: 'Verknüpfen fehlgeschlagen',
              });
              if (out) {
                setSearch('');
                setTarget(null);
                onLinked();
              }
            }}
          >
            <Link2 aria-hidden /> Verknüpfen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

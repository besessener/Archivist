'use client';

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { RelationType } from '@archivist/shared';
import { EntityChip, EntityIcon } from '@/components/common/entity-chip';
import { ErrorNote, Field, Loading } from '@/components/common/states';
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

/** Related entries with the reason why (#276), depth 1. */
export function RelatedEntries({ id }: { id: string }) {
  const q = useQuery('knowledge:related', { id, depth: 1 }, { scopes: ['knowledge'] });
  return (
    <section data-testid="related-entries">
      <h3 className="mb-2 text-sm font-semibold">Verwandte Einträge{q.data ? ` (${q.data.length})` : ''}</h3>
      {q.error && !q.data && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {!q.data && q.loading && <Loading />}
      {q.data && q.data.length === 0 && <p className="text-sm text-muted-foreground">Keine verwandten Einträge gefunden.</p>}
      {q.data && q.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {q.data.map((r) => (
            <li key={`${r.entity.id}-${r.relation.id}`} className="flex flex-col gap-1 rounded-lg border p-2.5" data-testid="related-entry">
              <EntityChip type={r.entity.type} id={r.entity.id} label={r.entity.name} detail={r.entity.description} />
              {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
              {r.via && <p className="text-[11px] text-muted-foreground">über „{r.via.name}“</p>}
            </li>
          ))}
        </ul>
      )}
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

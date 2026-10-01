'use client';

import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { ArchiveDialog, defaultEdit, toArchiveItem } from '@/components/common/archive-dialog';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { ARCHIVE_MODE_SHORT } from '@/lib/labels';
import { formatPercent, plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import type { ArchiveItemRequest, ArchiveMode, ScanProposalGroup } from '@archivist/shared';

function Group({ group, onArchive }: { group: ScanProposalGroup; onArchive: (ids: string[], mode: ArchiveMode, group: ScanProposalGroup) => void }) {
  const docs = useQuery('documents:list', { limit: 1000 }, { scopes: ['documents'] });
  const byId = useMemo(() => new Map((docs.data ?? []).map((d) => [d.id, d])), [docs.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set(group.documentIds));
  const [mode, setMode] = useState<ArchiveMode>('copy');
  const target = group.project ?? group.topic;

  return (
    <li className="rounded-xl border bg-card p-4" data-testid="scan-proposal">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{group.label}</h3>
          <p className="text-sm text-muted-foreground">
            {plural(group.documentIds.length, 'Dokument gehört', 'Dokumente gehören')} vermutlich {target ? <>zu <strong>{target}</strong></> : 'zusammen'}.
          </p>
        </div>
        <Badge variant={group.confidence >= 0.8 ? 'success' : 'warning'}>Sicherheit {formatPercent(group.confidence)}</Badge>
      </div>
      <ul className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto" data-testid="scan-proposal-files">
        {group.documentIds.map((id) => {
          const d = byId.get(id);
          return (
            <li key={id}>
              <CheckboxField
                checked={selected.has(id)}
                onCheckedChange={(v) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (v === true) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
                label={
                  <span>
                    {d?.title ?? id}
                    {d && <span className="block text-xs text-muted-foreground">{d.originalName}</span>}
                  </span>
                }
                data-testid="scan-proposal-checkbox"
              />
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select value={mode} onChange={(e) => setMode(e.target.value as ArchiveMode)} aria-label="Aktion" data-testid="scan-proposal-mode">
            {(Object.keys(ARCHIVE_MODE_SHORT) as ArchiveMode[]).map((m) => (
              <option key={m} value={m}>
                {ARCHIVE_MODE_SHORT[m]}
              </option>
            ))}
          </Select>
        </div>
        <Button disabled={selected.size === 0} onClick={() => onArchive([...selected], mode, group)} data-testid="scan-proposal-archive">
          Ausgewählte archivieren … ({selected.size})
        </Button>
      </div>
    </li>
  );
}

export function ScanProposals() {
  const { data, loading, error, refetch } = useQuery('scanner:proposals', {}, { scopes: ['scanner', 'documents'] });
  const docs = useQuery('documents:list', { limit: 1000 }, { scopes: ['documents'] });
  const [items, setItems] = useState<ArchiveItemRequest[] | null>(null);

  function openArchive(ids: string[], mode: ArchiveMode, group: ScanProposalGroup) {
    const list: ArchiveItemRequest[] = [];
    for (const id of ids) {
      const d = docs.data?.find((x) => x.id === id);
      if (!d) continue;
      const edit = defaultEdit(d);
      list.push(
        toArchiveItem(d, {
          ...edit,
          mode,
          topic: group.topic ?? edit.topic,
          project: group.project ?? edit.project,
        }),
      );
    }
    if (list.length > 0) setItems(list);
  }

  return (
    <section aria-labelledby="scan-proposals" className="flex flex-col gap-3">
      <h2 id="scan-proposals" className="text-base font-semibold">
        Zuordnungsvorschläge
      </h2>
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && (
        <EmptyState icon={<Layers />} title="Keine Vorschläge" description="Wenn mehrere gefundene Dokumente zusammengehören, schlägt Archivist hier eine gemeinsame Ablage vor." />
      )}
      <ul className="flex flex-col gap-3">
        {(data ?? []).map((g) => (
          <Group key={g.key} group={g} onArchive={openArchive} />
        ))}
      </ul>
      <ArchiveDialog
        open={items !== null}
        onOpenChange={(o) => !o && setItems(null)}
        items={items ?? []}
        onDone={() => {
          void refetch();
        }}
      />
    </section>
  );
}

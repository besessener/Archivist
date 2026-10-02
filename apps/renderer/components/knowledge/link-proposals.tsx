'use client';

import { useEffect, useState } from 'react';
import { Check, CheckCheck, ChevronLeft, ChevronRight, Link2, X } from 'lucide-react';
import type { LinkProposalPage } from '@archivist/shared';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EntityChip } from '@/components/common/entity-chip';
import { ErrorNote, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { RELATION_TYPE_LABELS } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { RelationProvenance } from './related';

const PAGE = 20;
type GroupBy = 'method' | 'entry';
type Group = LinkProposalPage['groups'][number];

/**
 * All open link proposals in one place (#280): grouped by method or entry, each with its evidence; confirm, reject or
 * confirm a whole group – every decision is undoable in the change log. Paged, with the total.
 */
export function LinkProposals() {
  const [groupBy, setGroupBy] = useState<GroupBy>('method');
  const [page, setPage] = useState(0);
  const q = useQuery('links:proposals', { groupBy, limit: PAGE, offset: page * PAGE }, { scopes: ['knowledge'] });
  const { run, busy } = useRun();
  const [confirmGroup, setConfirmGroup] = useState<Group | null>(null);
  const data = q.data;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // the last page emptied by decisions: go back one page
  useEffect(() => {
    if (data && data.items.length === 0 && page > 0) setPage((p) => Math.max(0, p - 1));
  }, [data, page]);

  const decide = async (relationIds: string[], decision: 'confirmed' | 'rejected') => {
    const out = await run(() => call('links:decide', { relationIds, decision, confirmed: true }), {
      success: decision === 'confirmed' ? 'Verknüpfung bestätigt. Rückgängig im Änderungsprotokoll.' : 'Abgelehnt – wird nicht wieder vorgeschlagen.',
    });
    if (out) void q.refetch();
  };

  if (q.error && !data) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  if (!data) return q.loading ? <Loading /> : null;
  if (total === 0 && page === 0) return null;

  const byGroup = new Map<string, LinkProposalPage['items']>();
  for (const item of data.items) byGroup.set(item.groupKey, [...(byGroup.get(item.groupKey) ?? []), item]);
  const groupOf = new Map(data.groups.map((g) => [g.key, g]));

  return (
    <section id="link-proposals" aria-labelledby="link-proposals-title" className="mb-8 scroll-mt-4" data-testid="link-proposals">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="link-proposals-title" className="flex items-center gap-2 text-sm font-semibold">
          <Link2 className="size-4" aria-hidden /> Verknüpfungsvorschläge{' '}
          <Badge variant="secondary" data-testid="link-proposals-total">
            {total}
          </Badge>
        </h2>
        <div className="w-44">
          <Select
            value={groupBy}
            aria-label="Vorschläge gruppieren"
            data-testid="link-proposals-group-by"
            onChange={(e) => {
              setGroupBy(e.target.value as GroupBy);
              setPage(0);
            }}
          >
            <option value="method">Nach Methode</option>
            <option value="entry">Nach Eintrag</option>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {[...byGroup.entries()].map(([key, items]) => {
          const g = groupOf.get(key);
          return (
            <div key={key} className="rounded-xl border bg-card p-3" data-testid="link-proposal-group">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  {g?.label ?? key} <span className="text-muted-foreground">({g?.count ?? items.length})</span>
                </h3>
                {g && g.count > 1 && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmGroup(g)} data-testid="link-proposals-confirm-all">
                    <CheckCheck aria-hidden /> Alle bestätigen
                  </Button>
                )}
              </div>
              <ul className="flex flex-col gap-2">
                {items.map((p) => (
                  <li key={p.relation.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5" data-testid="link-proposal">
                    <EntityChip type={p.source.type} id={p.source.id} label={p.source.name} />
                    <span className="text-xs text-muted-foreground">{RELATION_TYPE_LABELS[p.relation.relationType]}</span>
                    <EntityChip type={p.target.type} id={p.target.id} label={p.target.name} />
                    <ConfidenceBadge value={p.relation.confidence} />
                    <span className="ml-auto flex gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void decide([p.relation.id], 'confirmed')}
                        data-testid="link-proposal-confirm"
                      >
                        <Check aria-hidden /> Bestätigen
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void decide([p.relation.id], 'rejected')}
                        data-testid="link-proposal-reject"
                      >
                        <X aria-hidden /> Ablehnen
                      </Button>
                    </span>
                    <RelationProvenance relation={p.relation} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground" data-testid="link-proposals-page">
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
            data-testid="link-proposals-next"
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmGroup !== null}
        onOpenChange={(o) => !o && setConfirmGroup(null)}
        title="Alle Vorschläge der Gruppe bestätigen?"
        description={confirmGroup ? `${confirmGroup.label}: ${plural(confirmGroup.count, 'Vorschlag', 'Vorschläge')}` : undefined}
        confirmLabel="Alle bestätigen"
        confirmTestId="link-proposals-confirm-all-ok"
        onConfirm={async () => {
          if (!confirmGroup) return;
          const out = await run(() => call('links:decideGroup', { groupBy, key: confirmGroup.key, decision: 'confirmed', confirmed: true }), {
            success: 'Bestätigt. Ein Schritt rückgängig im Änderungsprotokoll.',
          });
          if (out) {
            setConfirmGroup(null);
            setPage(0);
            void q.refetch();
          }
        }}
      >
        <p className="text-sm text-muted-foreground">Alle offenen Vorschläge dieser Gruppe werden bestätigt – auch die auf anderen Seiten.</p>
      </ConfirmDialog>
    </section>
  );
}

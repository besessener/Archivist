'use client';

import { CircleCheck, RotateCcw } from 'lucide-react';
import { EntityChip } from '@/components/common/entity-chip';
import { ErrorNote, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatDate } from '@/lib/format';
import type { OpenItemStatus } from '@archivist/shared';
import { OPEN_ITEM_STATUS_LABELS } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

/** A case („Vorgang“, #286) with status, open items and entries newest first; proposed members are decided in „Verwandte Einträge“. */
export function CaseView({ id }: { id: string }) {
  const query = useQuery('cases:detail', { id }, { scopes: ['knowledge', 'openItems', 'events', 'decisions', 'documents'] });
  const { run, busy } = useRun();
  if (query.error && !query.data) return <ErrorNote error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Loading />;
  const { case: c, entries, openItems } = query.data;
  const closed = c.status === 'closed';
  return (
    <section className="flex flex-col gap-4" data-testid="case-view">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={closed ? 'secondary' : 'info'} data-testid="case-status">
          {closed ? 'Abgeschlossen' : 'Offen'}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {entries.length} {entries.length === 1 ? 'Eintrag' : 'Einträge'}, {openItems.length} offen
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          data-testid="case-toggle-status"
          onClick={async () => {
            const out = await run(() => call('cases:setStatus', { id, status: closed ? 'open' : 'closed' }), {
              success: closed ? 'Vorgang wieder geöffnet.' : 'Vorgang abgeschlossen. Rückgängig im Änderungsprotokoll.',
            });
            if (out) void query.refetch();
          }}
        >
          {closed ? <RotateCcw aria-hidden /> : <CircleCheck aria-hidden />} {closed ? 'Wieder öffnen' : 'Abschließen'}
        </Button>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Offene Punkte</h3>
        {openItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine offenen Punkte in diesem Vorgang.</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="case-open-items">
            {openItems.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <EntityChip type={e.type} id={e.id} label={e.name} />
                {e.status && e.status in OPEN_ITEM_STATUS_LABELS && <Badge variant="outline">{OPEN_ITEM_STATUS_LABELS[e.status as OpenItemStatus]}</Badge>}
                {e.date && <span className="text-xs text-muted-foreground">fällig {formatDate(e.date)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Verlauf</h3>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Noch leer. Füge Einträge über „Zu Vorgang hinzufügen“ in ihrer Detailansicht hinzu, per Mehrfachauswahl in den Listen oder im Chat („Leg das in den
            Vorgang …“).
          </p>
        ) : (
          <ol className="relative flex flex-col gap-2 border-l pl-4" data-testid="case-timeline">
            {entries.map((e) => (
              <li key={e.id} className="relative flex flex-wrap items-center gap-2" data-testid="case-entry" data-proposed={e.proposed}>
                <span className="absolute top-1.5 -left-[1.28rem] size-2 rounded-full bg-muted-foreground" aria-hidden />
                <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(e.date)}</span>
                <EntityChip type={e.type} id={e.id} label={e.name} />
                {e.proposed && <Badge variant="outline">vorgeschlagen</Badge>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

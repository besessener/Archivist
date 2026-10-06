'use client';

import { useState } from 'react';
import { Gauge } from 'lucide-react';
import type { LinkageMetrics as Metrics } from '@archivist/shared';
import { EntityChip } from '@/components/common/entity-chip';
import { ErrorNote, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDate, formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { GROUP_HEADING } from '@/components/common/page-header';
import { cn } from '@/lib/utils';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)} %`);
const share = (s: Metrics['current']) => (s.entries ? s.orphans / s.entries : 0);
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

function Tile({ label, value, hint, onClick, testId }: { label: string; value: string; hint: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-start gap-0.5 rounded-xl border bg-card shadow-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

/** Share of orphaned entries over the archive checks: one line, hover shows the point; the table below is the text view. */
function Trend({ history }: { history: Metrics['history'] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (history.length < 2) return <p className="mt-3 text-xs text-muted-foreground">Der Verlauf erscheint nach der zweiten Archivprüfung.</p>;
  const W = 600;
  const H = 120;
  const PAD = 8;
  const values = history.map(share);
  const max = Math.max(0.05, ...values);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (history.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const point = hover === null ? null : history[hover]!;
  return (
    <figure className="mt-3">
      <figcaption className="mb-1 text-xs text-muted-foreground">Anteil verwaister Einträge je Archivprüfung (höchstens {pct(max)})</figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-28 w-full overflow-visible"
          role="img"
          aria-label={`Verlauf: von ${pct(values[0]!)} auf ${pct(values.at(-1)!)}`}
          onMouseLeave={() => setHover(null)}
        >
          <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="stroke-border" strokeWidth={1} />
          <path d={path} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD} y2={H - PAD} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={x(hover)} cy={y(values[hover]!)} r={4} className="fill-primary stroke-card" strokeWidth={2} />
            </>
          )}
          {history.map((h, i) => (
            <rect
              key={h.at}
              x={x(i) - (W - 2 * PAD) / (history.length - 1) / 2}
              y={0}
              width={(W - 2 * PAD) / (history.length - 1)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {point && (
          <div
            className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1 text-xs shadow-sm"
            style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translateX(${hover! > history.length / 2 ? '-105%' : '5%'})` }}
          >
            <div className="font-medium">{formatDateTime(point.at, point.at)}</div>
            <div>
              {pct(share(point))} verwaist ({point.orphans} von {point.entries})
            </div>
            <div>{point.openProposals} offene Vorschläge</div>
          </div>
        )}
      </div>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Als Tabelle</summary>
        <table className="mt-1 w-full text-left tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="font-normal">Prüfung</th>
              <th className="font-normal">Einträge</th>
              <th className="font-normal">verwaist</th>
              <th className="font-normal">offene Vorschläge</th>
              <th className="font-normal">Bestätigungsquote</th>
            </tr>
          </thead>
          <tbody>
            {history
              .slice(-30)
              .toReversed()
              .map((h) => (
                <tr key={h.at}>
                  <td>{formatDate(h.at)}</td>
                  <td>{h.entries}</td>
                  <td>
                    {h.orphans} ({pct(share(h))})
                  </td>
                  <td>{h.openProposals}</td>
                  <td>{pct(h.confirmationRate)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function OrphanList({ onClose }: { onClose: () => void }) {
  const query = useQuery('links:unlinked', { limit: 100, offset: 0 }, { scopes: ['knowledge'] });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="orphan-list">
        <DialogHeader>
          <DialogTitle>Einträge ohne Verknüpfung</DialogTitle>
          <DialogDescription>
            {query.data ? `${query.data.total} Einträge haben weder eine bestätigte noch eine vorgeschlagene Verknüpfung` : 'Lade …'}
            {query.data && query.data.total > query.data.items.length ? ` – hier die ältesten ${query.data.items.length}.` : '.'} Öffne einen, um ihn unter
            „Verwandte Einträge“ zu verknüpfen.
          </DialogDescription>
        </DialogHeader>
        {query.error && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
        {query.data && (
          <div className="flex max-h-80 flex-wrap gap-1.5 overflow-y-auto">
            {query.data.items.map((e) => (
              <EntityChip key={e.id} type={e.type} id={e.id} label={e.name} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** How well the archive is linked (#292), with the history of the archive checks; every figure leads to its list. */
export function LinkageMetrics() {
  const query = useQuery('links:metrics', {}, { scopes: ['knowledge', 'insights'] });
  const [orphans, setOrphans] = useState(false);
  const [methods, setMethods] = useState(false);
  if (query.error && !query.data) return <ErrorNote error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return query.loading ? <Loading /> : null;
  const { current, history } = query.data;
  if (current.entries === 0) return null;
  const decided = query.data.methods.filter((m) => m.rate !== null);
  return (
    <section aria-labelledby="linkage-title" className="mb-8" data-testid="linkage-metrics">
      <h2 id="linkage-title" className={cn(GROUP_HEADING, 'mb-2')}>
        <Gauge className="size-4" aria-hidden /> Verknüpfungsgrad
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          label="Verwaiste Einträge"
          value={pct(share(current))}
          hint={`${current.orphans} von ${current.entries} Einträgen`}
          onClick={() => setOrphans(true)}
          testId="linkage-orphans"
        />
        <Tile
          label="Offene Vorschläge"
          value={String(current.openProposals)}
          hint="warten auf deine Prüfung"
          onClick={() => scrollTo('link-proposals')}
          testId="linkage-proposals"
        />
        <Tile
          label="Bestätigungsquote"
          value={pct(current.confirmationRate)}
          hint={decided.length ? 'deiner Entscheidungen – je Methode' : 'noch keine Entscheidungen'}
          onClick={() => setMethods((v) => !v)}
          testId="linkage-rate"
        />
      </div>
      {methods && (
        <table className="mt-3 mb-2 w-full text-left text-sm tabular-nums" data-testid="linkage-methods">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="font-normal">Methode</th>
              <th className="font-normal">bestätigt</th>
              <th className="font-normal">abgelehnt</th>
              <th className="font-normal">offen</th>
              <th className="font-normal">Quote</th>
            </tr>
          </thead>
          <tbody>
            {query.data.methods.map((m) => (
              <tr key={m.method}>
                <td>{m.label}</td>
                <td>{m.confirmed}</td>
                <td>{m.rejected}</td>
                <td>
                  {m.open > 0 ? (
                    <Button variant="link" size="sm" className="h-auto p-0" onClick={() => scrollTo('link-proposals')}>
                      {m.open}
                    </Button>
                  ) : (
                    0
                  )}
                </td>
                <td>{pct(m.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Trend history={history} />
      {orphans && <OrphanList onClose={() => setOrphans(false)} />}
    </section>
  );
}

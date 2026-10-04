'use client';

import { useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { IpcOutput } from '@archivist/shared';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorNote } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { formatDate, formatDateTime } from '@/lib/format';
import type { QueryState } from '@/lib/use-query';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

type Contradiction = IpcOutput<'contradictions:list'>[number];
type Decision = IpcOutput<'decisions:list'>[number];
type Resolution = 'acknowledged' | 'resolved' | 'false_positive';

export function ContradictionsSection({
  contradictions,
  onResolve,
}: {
  contradictions: QueryState<Contradiction[]>;
  onResolve: (contradiction: Contradiction) => void;
}) {
  const open = (contradictions.data ?? []).filter((contradiction) => contradiction.status === 'detected' || contradiction.status === 'acknowledged');
  return (
    <section aria-labelledby="contradictions" data-testid="contradictions">
      <h2 id="contradictions" className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ShieldAlert className="size-4 text-warning" aria-hidden /> Widersprüche <Badge variant="secondary">{open.length}</Badge>
      </h2>
      {contradictions.error && !contradictions.data && <ErrorNote error={contradictions.error} onRetry={() => void contradictions.refetch()} />}
      {contradictions.data && open.length === 0 && <p className="text-sm text-muted-foreground">Keine offenen Widersprüche gefunden.</p>}
      <ul className="flex flex-col gap-3">
        {open.map((contradiction) => (
          <ContradictionCard key={contradiction.id} contradiction={contradiction} onResolve={() => onResolve(contradiction)} />
        ))}
      </ul>
    </section>
  );
}

function ContradictionCard({ contradiction, onResolve }: { contradiction: Contradiction; onResolve: () => void }) {
  return (
    <li className="rounded-xl border border-warning/50 bg-card p-4" data-testid="contradiction-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold">{contradiction.title}</h3>
        <div className="flex gap-1.5">
          {contradiction.status === 'acknowledged' && <Badge variant="info">Zur Kenntnis genommen</Badge>}
          <ConfidenceBadge value={contradiction.confidence} />
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{contradiction.description}</p>
      {contradiction.excerpts.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {contradiction.excerpts.map((excerpt, index) => (
            <li key={`${excerpt.entityId}-${index}`} className="rounded-md border-l-2 border-warning bg-muted/50 px-3 py-1.5 text-sm italic">
              „{excerpt.text}“
            </li>
          ))}
        </ul>
      )}
      {contradiction.timestamps.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Zeitpunkte: {contradiction.timestamps.map((time) => formatDateTime(time, time)).join(' · ')}</p>
      )}
      <Button size="sm" className="mt-3" onClick={onResolve} data-testid="contradiction-resolve">
        Auflösen …
      </Button>
    </li>
  );
}

export function ResolveContradictionDialog({
  contradiction,
  onClose,
  onDone,
}: {
  contradiction: Contradiction | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { run } = useRun();
  const [resolution, setResolution] = useState<Resolution>('resolved');
  const [supersedeChoice, setSupersedeChoice] = useState<{ contradictionId: string; checked: boolean }>();
  const decisions = useQuery(
    'decisions:list',
    { ids: contradiction?.affectedEntityIds.slice(0, 100) ?? [], limit: 100 },
    { enabled: contradiction !== null && contradiction.affectedEntityIds.length > 0 },
  );
  const { older, newer, dated } = useMemo(() => decisionOrder(contradiction?.affectedEntityIds ?? [], decisions.data ?? []), [contradiction, decisions.data]);
  const canSupersede = !!older && !!newer && resolution === 'resolved';
  const supersede = supersedeChoice && supersedeChoice.contradictionId === contradiction?.id ? supersedeChoice.checked : dated;

  const resolve = async () => {
    if (!contradiction) return;
    const resolved = await run(
      () =>
        call('contradictions:resolve', {
          id: contradiction.id,
          resolution,
          confirmed: true,
          ...(canSupersede && supersede && older && newer ? { supersedeOldDecisionId: older.id, supersedeNewDecisionId: newer.id } : {}),
        }),
      { success: 'Widerspruch bearbeitet.' },
    );
    if (!resolved) return;
    onDone();
    onClose();
  };

  return (
    <ConfirmDialog
      open={contradiction !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Widerspruch auflösen"
      description={contradiction?.title}
      confirmLabel="Auflösen"
      confirmTestId="contradiction-resolve-confirm"
      onConfirm={resolve}
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">Wie soll der Widerspruch behandelt werden?</span>
          <Select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)} data-testid="contradiction-resolution">
            <option value="resolved">Geklärt / aufgelöst</option>
            <option value="acknowledged">Zur Kenntnis genommen (bleibt sichtbar)</option>
            <option value="false_positive">Kein echter Widerspruch</option>
          </Select>
        </label>
        {canSupersede && older && newer && (
          <div className="rounded-md border bg-muted/50 p-3">
            <CheckboxField
              checked={supersede}
              onCheckedChange={(checked) => contradiction && setSupersedeChoice({ contradictionId: contradiction.id, checked: checked === true })}
              label={
                <span>
                  Die neuere Entscheidung ersetzt die ältere:
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Neu: {newer.title || newer.decisionText} ({formatDate(newer.decidedAt, 'ohne Datum')})
                    <br />
                    Alt: {older.title || older.decisionText} ({formatDate(older.decidedAt, 'ohne Datum')})
                  </span>
                </span>
              }
              data-testid="contradiction-supersede"
            />
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** The server stores a pair as [older, newer] but cannot always tell (same day, undated); only decision dates on different days prove the order. */
function decisionOrder(affectedEntityIds: string[], decisions: Decision[]): { older?: Decision; newer?: Decision; dated: boolean } {
  const [first, second] = affectedEntityIds.map((id) => decisions.find((decision) => decision.id === id));
  const firstDay = first?.decidedAt?.slice(0, 10);
  const secondDay = second?.decidedAt?.slice(0, 10);
  if (!firstDay || !secondDay || firstDay === secondDay) return { older: first, newer: second, dated: false };
  return firstDay < secondDay ? { older: first, newer: second, dated: true } : { older: second, newer: first, dated: true };
}

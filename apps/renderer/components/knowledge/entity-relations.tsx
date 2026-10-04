'use client';

import { useState } from 'react';
import type { IpcOutput, RelationStatus } from '@archivist/shared';
import { Check, Unlink, X } from 'lucide-react';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EntityChip } from '@/components/common/entity-chip';
import { RelationProvenance } from '@/components/knowledge/related';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { RELATION_STATUS_LABELS, RELATION_TYPE_LABELS } from '@/lib/labels';
import { useRun } from '@/lib/use-run';

type EntityDetail = IpcOutput<'knowledge:getEntity'>;
type Relation = EntityDetail['relations'][number];
type PendingResolution = { relationId: string; status: RelationStatus; label: string };
type PendingUnlink = { relationId: string; label: string };

function statusVariant(status: RelationStatus) {
  return status === 'confirmed'
    ? ('success' as const)
    : status === 'rejected'
      ? ('danger' as const)
      : status === 'outdated'
        ? ('secondary' as const)
        : ('warning' as const);
}

export function EntityRelations({ detail, onChanged }: { detail: EntityDetail; onChanged: () => void }) {
  const { entity, relations } = detail;
  const { run } = useRun();
  const [pending, setPending] = useState<PendingResolution | null>(null);
  const [unlinking, setUnlinking] = useState<PendingUnlink | null>(null);
  const outgoing = relations.filter((relation) => relation.direction === 'out');
  const incoming = relations.filter((relation) => relation.direction === 'in');
  const renderRelation = (relation: Relation) => (
    <RelationRow key={relation.id} entityName={entity.name} relation={relation} onResolve={setPending} onUnlink={setUnlinking} />
  );

  const resolve = async () => {
    if (!pending) return;
    const ok = await run(() => call('knowledge:resolveRelation', { relationId: pending.relationId, status: pending.status, confirmed: true }), {
      success: 'Gespeichert.',
    });
    if (!ok) return;
    setPending(null);
    onChanged();
  };

  const unlink = async () => {
    if (!unlinking) return;
    const ok = await run(() => call('knowledge:unlink', { relationId: unlinking.relationId, confirmed: true }), {
      success: 'Verknüpfung entfernt. Rückgängig im Änderungsprotokoll.',
    });
    if (!ok) return;
    setUnlinking(null);
    onChanged();
  };

  return (
    <>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Verknüpfungen von hier ({outgoing.length})</h3>
        {outgoing.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine ausgehenden Verknüpfungen.</p>
        ) : (
          <ul className="flex flex-col gap-2">{outgoing.map(renderRelation)}</ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Verweise hierher ({incoming.length})</h3>
        {incoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine eingehenden Verknüpfungen.</p>
        ) : (
          <ul className="flex flex-col gap-2">{incoming.map(renderRelation)}</ul>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.status === 'confirmed' ? 'Verknüpfung bestätigen' : 'Verknüpfung ablehnen'}
        description={pending?.label}
        confirmLabel={pending?.status === 'confirmed' ? 'Bestätigen' : 'Ablehnen'}
        destructive={pending?.status === 'rejected'}
        onConfirm={resolve}
      >
        <p className="text-sm text-muted-foreground">
          Bestätigte Verknüpfungen fließen in Antworten und Zusammenhänge ein, abgelehnte werden nicht mehr vorgeschlagen.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => !open && setUnlinking(null)}
        title="Verknüpfung entfernen?"
        description={unlinking?.label}
        confirmLabel="Entfernen"
        destructive
        confirmTestId="relation-unlink-confirm"
        onConfirm={unlink}
      />
    </>
  );
}

function RelationRow({
  entityName,
  relation,
  onResolve,
  onUnlink,
}: {
  entityName: string;
  relation: Relation;
  onResolve: (pending: PendingResolution) => void;
  onUnlink: (pending: PendingUnlink) => void;
}) {
  const typeLabel = RELATION_TYPE_LABELS[relation.relationType];
  const [from, to] = relation.direction === 'out' ? [entityName, relation.other.name] : [relation.other.name, entityName];
  const statement = `„${from}“ ${typeLabel} „${to}“`;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5" data-testid="relation-row" data-status={relation.status}>
      <span className="text-xs text-muted-foreground">{typeLabel}</span>
      <EntityChip type={relation.other.type} id={relation.other.id} label={relation.other.name} detail={relation.other.description} />
      <Badge variant={statusVariant(relation.status)}>{RELATION_STATUS_LABELS[relation.status]}</Badge>
      <RelationProvenance relation={relation} />
      <ConfidenceBadge value={relation.confidence} />
      {relation.status === 'proposed' && (
        <span className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            data-testid="relation-confirm"
            onClick={() => onResolve({ relationId: relation.id, status: 'confirmed', label: `${statement} bestätigen` })}
          >
            <Check aria-hidden /> Bestätigen
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="relation-reject"
            onClick={() => onResolve({ relationId: relation.id, status: 'rejected', label: `Verknüpfung zu „${relation.other.name}“ ablehnen` })}
          >
            <X aria-hidden /> Ablehnen
          </Button>
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className={relation.status === 'proposed' ? undefined : 'ml-auto'}
        aria-label={`Verknüpfung zu „${relation.other.name}“ entfernen`}
        data-testid="relation-unlink"
        onClick={() => onUnlink({ relationId: relation.id, label: statement })}
      >
        <Unlink aria-hidden /> Entfernen
      </Button>
    </li>
  );
}

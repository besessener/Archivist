'use client';

import { useRouter } from 'next/navigation';
import { Expand, ExternalLink } from 'lucide-react';
import type { NeighborhoodGraph } from '@archivist/shared';
import { EntityIcon } from '@/components/common/entity-chip';
import { Button } from '@/components/ui/button';
import { RELATION_TYPE_LABELS } from '@/lib/labels';
import { ENTITY_TYPE_LABELS, ENTITY_TYPE_TONES, entityHref } from '@/lib/nav';
import { cn } from '@/lib/utils';
import type { Point } from './graph-layout';

export type GraphNodeRecord = NeighborhoodGraph['nodes'][number];
type GraphEdgeRecord = NeighborhoodGraph['edges'][number];

const shorten = (name: string) => (name.length > 22 ? `${name.slice(0, 21)}…` : name);

export function GraphEdge({
  edge,
  positions,
  nodeById,
  selected,
}: {
  edge: GraphEdgeRecord;
  positions: Map<string, Point>;
  nodeById: Map<string, GraphNodeRecord>;
  selected: string | null;
}) {
  const from = positions.get(edge.source);
  const to = positions.get(edge.target);
  if (!from || !to) return null;
  const active = selected && (edge.source === selected || edge.target === selected);
  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      className={cn(active ? 'stroke-primary' : 'stroke-muted-foreground/60')}
      strokeWidth={active ? 2 : 1.25}
      strokeDasharray={edge.status === 'proposed' ? '5 4' : undefined}
      data-testid="graph-edge"
      data-status={edge.status}
    >
      <title>
        {nodeById.get(edge.source)?.name} {RELATION_TYPE_LABELS[edge.relationType]} {nodeById.get(edge.target)?.name}
        {edge.status === 'proposed' ? ' (vorgeschlagen)' : ''}
      </title>
    </line>
  );
}

export function GraphNode({
  node,
  position,
  isCenter,
  isSelected,
  onSelect,
}: {
  node: GraphNodeRecord;
  position: Point | undefined;
  isCenter: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  if (!position) return null;
  const isGroup = node.count !== null;
  const radius = isCenter ? 18 : isGroup ? 16 : 13;
  return (
    <g
      transform={`translate(${position.x},${position.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${ENTITY_TYPE_LABELS[node.type]} ${isGroup ? `${node.count} weitere` : node.name}`}
      aria-pressed={isSelected}
      className="cursor-pointer focus-visible:outline-none"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      data-testid="graph-node"
      data-node-id={node.id}
      data-tone={ENTITY_TYPE_TONES[node.type]}
    >
      <circle
        r={radius}
        className={cn(isCenter ? 'fill-tone stroke-tone' : 'fill-card stroke-tone', isSelected && !isCenter && 'stroke-primary', isGroup && 'fill-muted')}
        strokeWidth={isSelected ? 3 : 1.5}
        strokeDasharray={isGroup ? '3 2' : undefined}
      />
      <foreignObject x={-8} y={-8} width={16} height={16} pointerEvents="none">
        <EntityIcon type={node.type} className={cn('size-4', isCenter && 'text-primary-foreground')} />
      </foreignObject>
      <text y={radius + 13} textAnchor="middle" className="fill-foreground text-[11px]">
        {isGroup ? `${node.count} ${ENTITY_TYPE_LABELS[node.type]}` : shorten(node.name)}
      </text>
      <title>{`${ENTITY_TYPE_LABELS[node.type]}: ${node.name}`}</title>
    </g>
  );
}

export function GraphLegend({ truncated }: { truncated: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg width="24" height="6" aria-hidden>
          <line x1="0" y1="3" x2="24" y2="3" className="stroke-muted-foreground" strokeWidth="1.5" />
        </svg>
        bestätigt
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="24" height="6" aria-hidden>
          <line x1="0" y1="3" x2="24" y2="3" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="5 4" />
        </svg>
        vorgeschlagen
      </span>
      <span>gestrichelter Kreis: zusammengefasste Einträge</span>
      {truncated && <span data-testid="graph-truncated">Nicht alle Einträge gezeigt – filtere oder erweitere gezielt.</span>}
    </div>
  );
}

export function GraphSelection({ node, canExpand, busy, onExpand }: { node: GraphNodeRecord; canExpand: boolean; busy: boolean; onExpand: () => void }) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-sm" data-testid="graph-selection">
      <EntityIcon type={node.type} className="size-4" />
      <span className="font-medium">{node.count !== null ? `${node.count} ${ENTITY_TYPE_LABELS[node.type]}` : node.name}</span>
      <span className="text-muted-foreground">{ENTITY_TYPE_LABELS[node.type]}</span>
      {node.count === null && (
        <span className="ml-auto flex gap-1.5">
          {canExpand && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onExpand} data-testid="graph-expand">
              <Expand aria-hidden /> Erweitern
            </Button>
          )}
          <Button size="sm" onClick={() => router.push(entityHref(node.type, node.id))} data-testid="graph-open">
            <ExternalLink aria-hidden /> Öffnen
          </Button>
        </span>
      )}
      {node.count !== null && (
        <span className="ml-auto text-xs text-muted-foreground">Zu viele, um sie einzeln zu zeigen – filtere nach Art oder öffne „Verwandte Einträge“.</span>
      )}
    </div>
  );
}

export function GraphTable({ edges, nodeById }: { edges: GraphEdgeRecord[]; nodeById: Map<string, GraphNodeRecord> }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">Als Tabelle</summary>
      <table className="mt-2 w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="font-normal">Von</th>
            <th className="font-normal">Beziehung</th>
            <th className="font-normal">Zu</th>
            <th className="font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => (
            <tr key={edge.id}>
              <td>{nodeById.get(edge.source)?.name}</td>
              <td>{RELATION_TYPE_LABELS[edge.relationType]}</td>
              <td>{nodeById.get(edge.target)?.name}</td>
              <td>{edge.status === 'proposed' ? 'vorgeschlagen' : 'bestätigt'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

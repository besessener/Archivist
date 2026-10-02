'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Expand, ExternalLink } from 'lucide-react';
import { RelationType, type EntityType, type NeighborhoodGraph } from '@archivist/shared';
import { EntityIcon } from '@/components/common/entity-chip';
import { ErrorNote, Field, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { RELATION_TYPE_LABELS } from '@/lib/labels';
import { ENTITY_TYPE_LABELS, entityHref } from '@/lib/nav';
import { useRun } from '@/lib/use-run';
import { cn } from '@/lib/utils';

type Node = NeighborhoodGraph['nodes'][number];
type Status = '' | 'confirmed' | 'proposed';

const W = 720;
const H = 440;
const KINDS: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event', 'case', 'topic', 'project', 'person', 'tag', 'category'];

/** Merges an expansion into the graph shown so far (nodes keep their first depth). */
function merge(a: NeighborhoodGraph, b: NeighborhoodGraph, depthOffset: number): NeighborhoodGraph {
  const nodes = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, depth: n.depth + depthOffset });
  const edges = new Map(a.edges.map((e) => [e.id, e]));
  for (const e of b.edges) edges.set(e.id, e);
  return { centerId: a.centerId, nodes: [...nodes.values()], edges: [...edges.values()], truncated: a.truncated || b.truncated };
}

/**
 * A small force layout, computed once per graph: nodes repel each other, edges pull their ends together, the centre
 * stays in the middle. Deterministic (start positions on rings by depth) – the same graph looks the same every time.
 */
function layout(g: NeighborhoodGraph): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const byDepth = new Map<number, Node[]>();
  for (const n of g.nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
  for (const [d, list] of byDepth)
    list.forEach((n, i) => {
      const a = (2 * Math.PI * i) / list.length + d * 0.7;
      pos.set(n.id, { x: W / 2 + Math.cos(a) * d * 120, y: H / 2 + Math.sin(a) * d * 90, vx: 0, vy: 0 });
    });
  const ids = g.nodes.map((n) => n.id);
  const k = Math.sqrt((W * H) / Math.max(ids.length, 1)) * 0.55;
  for (let step = 0; step < 220; step += 1) {
    const t = 1 - step / 220;
    for (let i = 0; i < ids.length; i += 1)
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = pos.get(ids[i]!)!;
        const b = pos.get(ids[j]!)!;
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const d2 = dx * dx + dy * dy;
        const f = (k * k) / d2;
        a.vx += dx * f * 0.05;
        a.vy += dy * f * 0.05;
        b.vx -= dx * f * 0.05;
        b.vy -= dy * f * 0.05;
      }
    for (const e of g.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - k) / d / 10;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const [id, p] of pos) {
      if (id === g.centerId) {
        p.x = W / 2;
        p.y = H / 2;
        p.vx = p.vy = 0;
        continue;
      }
      p.x = Math.min(W - 40, Math.max(40, p.x + Math.max(-12, Math.min(12, p.vx * t))));
      p.y = Math.min(H - 30, Math.max(24, p.y + Math.max(-12, Math.min(12, p.vy * t))));
      p.vx *= 0.5;
      p.vy *= 0.5;
    }
  }
  return new Map([...pos].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

const short = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);

/**
 * The surroundings of an entry as a graph (#288): 1–2 steps, filterable by relation type, kind of entry and status. A
 * click on a node selects it – „Öffnen“ goes to the entry, „Erweitern“ adds its own neighbours. Big hubs come as one
 * group node, the number of nodes is limited. Drawn locally as SVG, no library from the net; the table below lists the
 * same graph as text.
 */
export function GraphView({ id }: { id: string }) {
  const router = useRouter();
  const [depth, setDepth] = useState<1 | 2>(1);
  const [relationType, setRelationType] = useState<RelationType | ''>('');
  const [kind, setKind] = useState<EntityType | ''>('');
  const [status, setStatus] = useState<Status>('');
  const [graph, setGraph] = useState<NeighborhoodGraph | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { run, busy } = useRun();
  const filters = useMemo(
    () => ({
      ...(relationType ? { relationTypes: [relationType] } : {}),
      ...(kind ? { entityTypes: [kind] } : {}),
      ...(status ? { statuses: [status] } : {}),
    }),
    [relationType, kind, status],
  );

  useEffect(() => {
    let stale = false;
    setGraph(null);
    setSelected(null);
    setExpanded(new Set());
    call('knowledge:neighborhood', { id, depth, maxNodes: 60, ...filters }).then(
      (g) => !stale && setGraph(g),
      (err: unknown) => !stale && setError(err),
    );
    return () => {
      stale = true;
    };
  }, [id, depth, filters]);

  const pos = useMemo(() => (graph ? layout(graph) : new Map<string, { x: number; y: number }>()), [graph]);
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const sel = selected ? nodeById.get(selected) : undefined;

  const expand = async (node: Node) => {
    if (!graph) return;
    const more = await run(() => call('knowledge:neighborhood', { id: node.id, depth: 1, maxNodes: 30, ...filters }), {
      errorTitle: 'Erweitern fehlgeschlagen',
    });
    if (!more) return;
    setGraph(merge(graph, more, node.depth));
    setExpanded((s) => new Set(s).add(node.id));
  };

  if (error && !graph) return <ErrorNote error={error as Error} />;
  return (
    <section className="flex flex-col gap-3" data-testid="graph-view">
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Schritte" htmlFor="graph-depth">
          <Select id="graph-depth" value={String(depth)} onChange={(e) => setDepth(e.target.value === '2' ? 2 : 1)} data-testid="graph-depth">
            <option value="1">1 Schritt</option>
            <option value="2">2 Schritte</option>
          </Select>
        </Field>
        <Field label="Art der Beziehung" htmlFor="graph-relation">
          <Select id="graph-relation" value={relationType} onChange={(e) => setRelationType(e.target.value as RelationType | '')} data-testid="graph-relation">
            <option value="">Alle</option>
            {RelationType.options
              .filter((t) => t !== 'duplicate_of')
              .map((t) => (
                <option key={t} value={t}>
                  {RELATION_TYPE_LABELS[t]}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Art des Eintrags" htmlFor="graph-kind">
          <Select id="graph-kind" value={kind} onChange={(e) => setKind(e.target.value as EntityType | '')} data-testid="graph-kind">
            <option value="">Alle</option>
            {KINDS.map((t) => (
              <option key={t} value={t}>
                {ENTITY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" htmlFor="graph-status">
          <Select id="graph-status" value={status} onChange={(e) => setStatus(e.target.value as Status)} data-testid="graph-status">
            <option value="">Bestätigt und vorgeschlagen</option>
            <option value="confirmed">Nur bestätigt</option>
            <option value="proposed">Nur vorgeschlagen</option>
          </Select>
        </Field>
      </div>

      {!graph ? (
        <Loading />
      ) : (
        <>
          <div className="relative rounded-xl border bg-card">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full"
              role="group"
              aria-label={`Graph mit ${graph.nodes.length} Einträgen und ${graph.edges.length} Verknüpfungen`}
            >
              {graph.edges.map((e) => {
                const a = pos.get(e.source);
                const b = pos.get(e.target);
                if (!a || !b) return null;
                const active = selected && (e.source === selected || e.target === selected);
                return (
                  <line
                    key={e.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={cn(active ? 'stroke-primary' : 'stroke-muted-foreground/60')}
                    strokeWidth={active ? 2 : 1.25}
                    strokeDasharray={e.status === 'proposed' ? '5 4' : undefined}
                    data-testid="graph-edge"
                    data-status={e.status}
                  >
                    <title>
                      {nodeById.get(e.source)?.name} {RELATION_TYPE_LABELS[e.relationType]} {nodeById.get(e.target)?.name}
                      {e.status === 'proposed' ? ' (vorgeschlagen)' : ''}
                    </title>
                  </line>
                );
              })}
              {graph.nodes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const isCenter = n.id === graph.centerId;
                const isGroup = n.count !== null;
                const r = isCenter ? 18 : isGroup ? 16 : 13;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${ENTITY_TYPE_LABELS[n.type]} ${isGroup ? `${n.count} weitere` : n.name}`}
                    aria-pressed={selected === n.id}
                    className="cursor-pointer focus-visible:outline-none"
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(n.id);
                      }
                    }}
                    data-testid="graph-node"
                    data-node-id={n.id}
                  >
                    <circle
                      r={r}
                      className={cn(
                        isCenter ? 'fill-primary stroke-primary' : 'fill-card stroke-muted-foreground',
                        selected === n.id && !isCenter && 'stroke-primary',
                        isGroup && 'fill-muted',
                      )}
                      strokeWidth={selected === n.id ? 3 : 1.5}
                      strokeDasharray={isGroup ? '3 2' : undefined}
                    />
                    <foreignObject x={-8} y={-8} width={16} height={16} pointerEvents="none">
                      <EntityIcon type={n.type} className={cn('size-4', isCenter ? 'text-primary-foreground' : 'text-muted-foreground')} />
                    </foreignObject>
                    <text y={r + 13} textAnchor="middle" className="fill-foreground text-[11px]">
                      {isGroup ? `${n.count} ${ENTITY_TYPE_LABELS[n.type]}` : short(n.name)}
                    </text>
                    <title>{`${ENTITY_TYPE_LABELS[n.type]}: ${n.name}`}</title>
                  </g>
                );
              })}
            </svg>
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
              {graph.truncated && <span data-testid="graph-truncated">Nicht alle Einträge gezeigt – filtere oder erweitere gezielt.</span>}
            </div>
          </div>

          {sel && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-sm" data-testid="graph-selection">
              <EntityIcon type={sel.type} className="size-4 text-primary" />
              <span className="font-medium">{sel.count !== null ? `${sel.count} ${ENTITY_TYPE_LABELS[sel.type]}` : sel.name}</span>
              <span className="text-muted-foreground">{ENTITY_TYPE_LABELS[sel.type]}</span>
              {sel.count === null && (
                <span className="ml-auto flex gap-1.5">
                  {sel.id !== graph.centerId && !expanded.has(sel.id) && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void expand(sel)} data-testid="graph-expand">
                      <Expand aria-hidden /> Erweitern
                    </Button>
                  )}
                  <Button size="sm" onClick={() => router.push(entityHref(sel.type, sel.id))} data-testid="graph-open">
                    <ExternalLink aria-hidden /> Öffnen
                  </Button>
                </span>
              )}
              {sel.count !== null && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Zu viele, um sie einzeln zu zeigen – filtere nach Art oder öffne „Verwandte Einträge“.
                </span>
              )}
            </div>
          )}

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
                {graph.edges.map((e) => (
                  <tr key={e.id}>
                    <td>{nodeById.get(e.source)?.name}</td>
                    <td>{RELATION_TYPE_LABELS[e.relationType]}</td>
                    <td>{nodeById.get(e.target)?.name}</td>
                    <td>{e.status === 'proposed' ? 'vorgeschlagen' : 'bestätigt'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { RelationType, type EntityType, type NeighborhoodGraph } from '@archivist/shared';
import { ErrorNote, Field, Loading } from '@/components/common/states';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { RELATION_TYPE_LABELS } from '@/lib/labels';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useRun } from '@/lib/use-run';
import { GraphEdge, GraphLegend, GraphNode, GraphSelection, GraphTable, type GraphNodeRecord } from './graph-parts';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph, mergeGraphs, type Point } from './graph-layout';

type Status = '' | 'confirmed' | 'proposed';

const KINDS: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event', 'case', 'topic', 'project', 'person', 'tag', 'category'];

/** The surroundings of an entry as a local SVG graph (#288), filterable, with expandable nodes and the same graph as a table. */
export function GraphView({ id }: { id: string }) {
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
      (loaded) => !stale && setGraph(loaded),
      (err: unknown) => !stale && setError(err),
    );
    return () => {
      stale = true;
    };
  }, [id, depth, filters]);

  const positions = useMemo(() => (graph ? layoutGraph(graph) : new Map<string, Point>()), [graph]);
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.id, node])), [graph]);
  const selectedNode = selected ? nodeById.get(selected) : undefined;

  const expand = async (node: GraphNodeRecord) => {
    if (!graph) return;
    const more = await run(() => call('knowledge:neighborhood', { id: node.id, depth: 1, maxNodes: 30, ...filters }), {
      errorTitle: 'Erweitern fehlgeschlagen',
    });
    if (!more) return;
    setGraph(mergeGraphs(graph, more, node.depth));
    setExpanded((ids) => new Set(ids).add(node.id));
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
              viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
              className="h-auto w-full"
              role="group"
              aria-label={`Graph mit ${graph.nodes.length} Einträgen und ${graph.edges.length} Verknüpfungen`}
            >
              {graph.edges.map((edge) => (
                <GraphEdge key={edge.id} edge={edge} positions={positions} nodeById={nodeById} selected={selected} />
              ))}
              {graph.nodes.map((node) => (
                <GraphNode
                  key={node.id}
                  node={node}
                  position={positions.get(node.id)}
                  isCenter={node.id === graph.centerId}
                  isSelected={selected === node.id}
                  onSelect={() => setSelected(node.id)}
                />
              ))}
            </svg>
            <GraphLegend truncated={graph.truncated} />
          </div>

          {selectedNode && (
            <GraphSelection
              node={selectedNode}
              canExpand={selectedNode.id !== graph.centerId && !expanded.has(selectedNode.id)}
              busy={busy}
              onExpand={() => void expand(selectedNode)}
            />
          )}

          <GraphTable edges={graph.edges} nodeById={nodeById} />
        </>
      )}
    </section>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { RelationType, type EntityType, type NeighborhoodGraph } from '@archivist/shared';
import { ErrorNote, Field, Loading } from '@/components/common/states';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { RELATION_TYPE_LABELS } from '@/lib/labels';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useRun } from '@/lib/use-run';
import { GraphSelection, GraphTable, type GraphNodeRecord } from './graph-parts';
import { GraphCanvas } from './graph-canvas';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph, mergeGraphs, type GraphLayout } from './graph-layout';
import { cn } from '@/lib/utils';

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
  const [fullscreen, setFullscreen] = useState(false);
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

  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setFullscreen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [fullscreen]);

  const layout = useMemo<GraphLayout>(
    () => (graph ? layoutGraph(graph) : { positions: new Map(), frame: { width: GRAPH_WIDTH, height: GRAPH_HEIGHT } }),
    [graph],
  );
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.id, node])), [graph]);
  const selectedNode = selected ? nodeById.get(selected) : undefined;

  const expand = async (node: GraphNodeRecord) => {
    if (!graph) return;
    const more = await run(() => call('knowledge:neighborhood', { id: node.id, depth: 1, maxNodes: 30, ...filters }), {
      errorTitle: 'Erweitern fehlgeschlagen',
    });
    if (!more) return;
    setGraph(mergeGraphs({ shown: graph, expansion: more, depthOffset: node.depth }));
    setExpanded((ids) => new Set(ids).add(node.id));
  };

  if (error && !graph) return <ErrorNote error={error as Error} />;
  return (
    <section
      className={cn('flex flex-col gap-3', fullscreen && 'fixed inset-0 z-50 overflow-auto bg-background p-4')}
      data-testid="graph-view"
      data-fullscreen={fullscreen}
    >
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
          <GraphCanvas
            graph={graph}
            layout={layout}
            nodeById={nodeById}
            selected={selected}
            fullscreen={fullscreen}
            onSelect={setSelected}
            onToggleFullscreen={() => setFullscreen((on) => !on)}
          />

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

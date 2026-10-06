import type { NeighborhoodGraph } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph, layoutSize } from '../../apps/renderer/components/knowledge/graph-layout';

type GraphNode = NeighborhoodGraph['nodes'][number];
type GraphEdge = NeighborhoodGraph['edges'][number];

const node = (id: string, depth: number) => ({ id, name: id, type: 'task', depth }) as GraphNode;
const edge = (source: string, target: string) =>
  ({ id: `${source}-${target}`, source, target, relationType: 'relates_to', status: 'confirmed' }) as unknown as GraphEdge;

/** A centre with 8 neighbours that are densely linked among each other, each with leaves – the two-step view from the bug report. */
function denseGraph(): NeighborhoodGraph {
  const neighbours = Array.from({ length: 8 }, (_, i) => `n${i}`);
  const leaves = neighbours.flatMap((id) => [`${id}a`, `${id}b`]);
  const nodes = [node('c', 0), ...neighbours.map((id) => node(id, 1)), ...leaves.map((id) => node(id, 2))];
  const edges = [
    ...neighbours.map((id) => edge('c', id)),
    ...neighbours.flatMap((a) => neighbours.filter((b) => a < b).map((b) => edge(a, b))),
    ...leaves.map((id) => edge(id.slice(0, 2), id)),
  ];
  return { centerId: 'c', nodes, edges, truncated: false };
}

describe('layoutGraph', () => {
  it('keeps nodes of a densely linked two-step graph apart so labels do not overlap', () => {
    const graph = denseGraph();
    const positions = [...layoutGraph(graph).values()];
    for (let i = 0; i < positions.length; i += 1)
      for (let j = i + 1; j < positions.length; j += 1) {
        const apart = Math.abs(positions[i]!.x - positions[j]!.x) >= 140 || Math.abs(positions[i]!.y - positions[j]!.y) >= 56;
        expect(apart).toBe(true);
      }
  });

  it('is deterministic and keeps the centre in the middle', () => {
    const graph = denseGraph();
    const growth = layoutSize(graph.nodes.length).width / GRAPH_WIDTH;
    const positions = layoutGraph(graph);
    expect(positions).toEqual(layoutGraph(graph));
    expect(positions.get('c')).toEqual({ x: GRAPH_WIDTH * 0.5 * growth, y: GRAPH_HEIGHT * 0.5 * growth });
  });
});

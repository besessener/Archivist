import type { NeighborhoodGraph } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph } from '../../apps/renderer/components/knowledge/graph-layout';
import { countCrossings, type Link } from '../../apps/renderer/components/knowledge/graph-geometry';

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

/**
 * A person with goals that each share a note with the next goal, and two documents sharing two tags – planar, but the
 * former layout drew it as a tangle. Listed in reverse so the node order gives the layout no hint.
 */
function planarGraph(): NeighborhoodGraph {
  const goals = Array.from({ length: 6 }, (_, i) => `goal${i}`);
  const notes = goals.flatMap((goal, i) => [{ id: `${goal}-own`, goals: [goal] }, ...(i < 5 ? [{ id: `${goal}-shared`, goals: [goal, goals[i + 1]!] }] : [])]);
  const tags = Array.from({ length: 8 }, (_, i) => ({ id: `tag${i}`, docs: i < 3 ? ['request'] : i < 5 ? ['request', 'approval'] : ['approval'] }));
  const nodes = [
    node('person', 0),
    ...[...goals, 'request', 'approval'].map((id) => node(id, 1)),
    ...[...notes.map((note) => note.id), ...tags.map((tag) => tag.id)].reverse().map((id) => node(id, 2)),
  ];
  const edges = [
    ...[...goals, 'request', 'approval'].map((id) => edge('person', id)),
    ...notes.flatMap((note) => note.goals.map((goal) => edge(goal, note.id))),
    ...tags.flatMap((tag) => tag.docs.map((doc) => edge(doc, tag.id))),
  ];
  return { centerId: 'person', nodes, edges, truncated: false };
}

function crossingsOf(graph: NeighborhoodGraph): number {
  const positions = layoutGraph(graph).positions;
  const index = new Map(graph.nodes.map((entry, i) => [entry.id, i]));
  const links = graph.edges.map((entry): Link => [index.get(entry.source)!, index.get(entry.target)!]);
  return countCrossings(
    graph.nodes.map((entry) => positions.get(entry.id)!),
    links,
  );
}

describe('layoutGraph', () => {
  it('keeps nodes of a densely linked two-step graph apart so labels do not overlap', () => {
    const graph = denseGraph();
    const positions = [...layoutGraph(graph).positions.values()];
    for (let i = 0; i < positions.length; i += 1)
      for (let j = i + 1; j < positions.length; j += 1) {
        const apart = Math.abs(positions[i]!.x - positions[j]!.x) >= 140 || Math.abs(positions[i]!.y - positions[j]!.y) >= 56;
        expect(apart).toBe(true);
      }
  });

  it('draws a graph that can be drawn without crossings without any', () => {
    expect(crossingsOf(planarGraph())).toBe(0);
  });

  it('keeps crossings of a dense graph well below a ring layout', () => {
    // the 9 fully linked nodes alone force 36 crossings; the former force layout drew 102
    expect(crossingsOf(denseGraph())).toBeLessThanOrEqual(90);
  });

  it('is deterministic', () => {
    expect(layoutGraph(denseGraph())).toEqual(layoutGraph(denseGraph()));
  });

  it('fits all nodes with their labels into a frame of the base aspect ratio that starts at 0,0', () => {
    const { positions, frame } = layoutGraph(denseGraph());
    expect(frame.width / frame.height).toBeCloseTo(GRAPH_WIDTH / GRAPH_HEIGHT);
    expect(frame.width).toBeGreaterThan(GRAPH_WIDTH);
    for (const { x, y } of positions.values()) {
      expect(x).toBeGreaterThanOrEqual(75);
      expect(x).toBeLessThanOrEqual(frame.width - 75);
      expect(y).toBeGreaterThanOrEqual(30);
      expect(y).toBeLessThanOrEqual(frame.height - 45);
    }
  });

  it('keeps the base frame for a small graph and centres the drawing in it', () => {
    const graph: NeighborhoodGraph = {
      centerId: 'c',
      nodes: [node('c', 0), node('a', 1), node('b', 1)],
      edges: [edge('c', 'a'), edge('c', 'b')],
      truncated: false,
    };
    const { positions, frame } = layoutGraph(graph);
    expect(frame).toEqual({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT });
    const xs = [...positions.values()].map((point) => point.x);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(GRAPH_WIDTH);
    // the long axis lies horizontal
    const ys = [...positions.values()].map((point) => point.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys));
  });

  it('places nodes without edges, ignores edges to unknown nodes and handles an empty graph', () => {
    const graph: NeighborhoodGraph = {
      centerId: 'c',
      nodes: [node('c', 0), node('a', 1), node('loose', 1)],
      edges: [edge('c', 'a'), edge('a', 'c'), edge('a', 'a'), edge('c', 'gone')],
      truncated: false,
    };
    const { positions } = layoutGraph(graph);
    expect([...positions.keys()]).toEqual(['c', 'a', 'loose']);
    for (const point of positions.values()) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(layoutGraph({ centerId: 'c', nodes: [], edges: [], truncated: false })).toEqual({
      positions: new Map(),
      frame: { width: GRAPH_WIDTH, height: GRAPH_HEIGHT },
    });
  });
});

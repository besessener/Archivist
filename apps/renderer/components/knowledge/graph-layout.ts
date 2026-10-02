import type { NeighborhoodGraph } from '@archivist/shared';

type Node = NeighborhoodGraph['nodes'][number];
type Body = { x: number; y: number; vx: number; vy: number };
/** The bodies in node order (the order the forces are summed in) and the ideal edge length. */
type Layout = { bodies: Map<string, Body>; ids: string[]; spacing: number };
export type Point = { x: number; y: number };

export const GRAPH_WIDTH = 720;
export const GRAPH_HEIGHT = 440;
const STEPS = 220;

/** Merges an expansion into the graph shown so far (nodes keep their first depth). */
export function mergeGraphs({
  shown,
  expansion,
  depthOffset,
}: {
  shown: NeighborhoodGraph;
  expansion: NeighborhoodGraph;
  depthOffset: number;
}): NeighborhoodGraph {
  const nodes = new Map(shown.nodes.map((node) => [node.id, node]));
  for (const node of expansion.nodes) if (!nodes.has(node.id)) nodes.set(node.id, { ...node, depth: node.depth + depthOffset });
  const edges = new Map(shown.edges.map((edge) => [edge.id, edge]));
  for (const edge of expansion.edges) edges.set(edge.id, edge);
  return { centerId: shown.centerId, nodes: [...nodes.values()], edges: [...edges.values()], truncated: shown.truncated || expansion.truncated };
}

/** Deterministic start positions: one ring per depth, so the same graph always looks the same. */
function placeOnRings(nodes: Node[]): Map<string, Body> {
  const bodies = new Map<string, Body>();
  const byDepth = new Map<number, Node[]>();
  for (const node of nodes) byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node]);
  for (const [depth, list] of byDepth)
    list.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / list.length + depth * 0.7;
      bodies.set(node.id, { x: GRAPH_WIDTH / 2 + Math.cos(angle) * depth * 120, y: GRAPH_HEIGHT / 2 + Math.sin(angle) * depth * 90, vx: 0, vy: 0 });
    });
  return bodies;
}

function repel({ bodies, ids, spacing }: Layout) {
  for (let i = 0; i < ids.length; i += 1)
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = bodies.get(ids[i]!)!;
      const b = bodies.get(ids[j]!)!;
      const dx = a.x - b.x || 0.01;
      const dy = a.y - b.y || 0.01;
      const force = (spacing * spacing) / (dx * dx + dy * dy);
      a.vx += dx * force * 0.05;
      a.vy += dy * force * 0.05;
      b.vx -= dx * force * 0.05;
      b.vy -= dy * force * 0.05;
    }
}

function attract({ bodies, spacing }: Layout, edges: NeighborhoodGraph['edges']) {
  for (const edge of edges) {
    const a = bodies.get(edge.source);
    const b = bodies.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (distance - spacing) / distance / 10;
    a.vx += dx * force;
    a.vy += dy * force;
    b.vx -= dx * force;
    b.vy -= dy * force;
  }
}

function move(body: Body, temperature: number) {
  body.x = Math.min(GRAPH_WIDTH - 40, Math.max(40, body.x + Math.max(-12, Math.min(12, body.vx * temperature))));
  body.y = Math.min(GRAPH_HEIGHT - 30, Math.max(24, body.y + Math.max(-12, Math.min(12, body.vy * temperature))));
  body.vx *= 0.5;
  body.vy *= 0.5;
}

function pinToCenter(body: Body) {
  body.x = GRAPH_WIDTH / 2;
  body.y = GRAPH_HEIGHT / 2;
  body.vx = body.vy = 0;
}

/** A small force layout: nodes repel each other, edges pull their ends together, the centre stays in the middle. */
export function layoutGraph(graph: NeighborhoodGraph): Map<string, Point> {
  const bodies = placeOnRings(graph.nodes);
  const ids = graph.nodes.map((node) => node.id);
  const layout: Layout = { bodies, ids, spacing: Math.sqrt((GRAPH_WIDTH * GRAPH_HEIGHT) / Math.max(ids.length, 1)) * 0.55 };
  for (let step = 0; step < STEPS; step += 1) {
    repel(layout);
    attract(layout, graph.edges);
    for (const [id, body] of bodies) {
      if (id === graph.centerId) pinToCenter(body);
      else move(body, 1 - step / STEPS);
    }
  }
  return new Map([...bodies].map(([id, body]) => [id, { x: body.x, y: body.y }]));
}

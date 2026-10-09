import type { NeighborhoodGraph } from '@archivist/shared';
import { untangle } from './graph-crossings';
import type { Link, Point } from './graph-geometry';
import { radialStart } from './graph-radial';
import { hopDistances, majorize } from './graph-stress';

export type { Point } from './graph-geometry';
export type Size = { width: number; height: number };
/** Node positions plus the frame they fit in; the frame starts at 0,0. */
export type GraphLayout = { positions: Map<string, Point>; frame: Size };

export const GRAPH_WIDTH = 720;
export const GRAPH_HEIGHT = 440;
/** Ideal length of an edge: room for a node with its label on both ends. */
const UNIT = 170;
/** Space a node needs on screen: icon plus label. */
const NODE_BOX = { width: 150, height: 64 };
const SEPARATION_PASSES = 40;
/** Room around the outermost nodes: half a label to the sides, the label below the icon. */
const MARGIN = { side: NODE_BOX.width / 2 + 5, top: 30, bottom: 45 };

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

/** The edges as distinct links between node indices, without loops or ends outside the graph. */
function toLinks(graph: NeighborhoodGraph, indexOf: Map<string, number>): Link[] {
  const links = new Map<string, Link>();
  for (const edge of graph.edges) {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    links.set(`${Math.min(a, b)}-${Math.max(a, b)}`, [Math.min(a, b), Math.max(a, b)]);
  }
  return [...links.values()];
}

/** Angle of the drawing's long axis: the principal axis of the positions' scatter matrix. */
function principalAxisAngle(positions: Point[]): number {
  const meanX = positions.reduce((sum, point) => sum + point.x, 0) / positions.length;
  const meanY = positions.reduce((sum, point) => sum + point.y, 0) / positions.length;
  let scatterX = 0;
  let scatterY = 0;
  let scatterXY = 0;
  for (const point of positions) {
    scatterX += (point.x - meanX) ** 2;
    scatterY += (point.y - meanY) ** 2;
    scatterXY += (point.x - meanX) * (point.y - meanY);
  }
  return Math.atan2(2 * scatterXY, scatterX - scatterY) / 2;
}

/** Turns the drawing around the pinned node so its long axis lies horizontal, matching the wide frame. */
function orient(positions: Point[], pinned: number): Point[] {
  const origin = positions[pinned]!;
  const angle = -principalAxisAngle(positions);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return positions.map(({ x, y }) => ({
    x: origin.x + (x - origin.x) * cos - (y - origin.y) * sin,
    y: origin.y + (x - origin.x) * sin + (y - origin.y) * cos,
  }));
}

/** Moves two overlapping boxes apart along the axis of the smaller overlap; a pinned node does not move. */
function pushApart({ positions, pair: [node, other], pinned }: { positions: Point[]; pair: Link; pinned: number }) {
  const first = positions[node]!;
  const second = positions[other]!;
  const overlapX = NODE_BOX.width - Math.abs(first.x - second.x);
  const overlapY = NODE_BOX.height - Math.abs(first.y - second.y);
  if (overlapX <= 0 || overlapY <= 0) return;
  const horizontal = overlapX / NODE_BOX.width < overlapY / NODE_BOX.height;
  const overlap = horizontal ? overlapX : overlapY;
  const direction = (horizontal ? first.x - second.x : first.y - second.y) >= 0 ? 1 : -1;
  // when one of them is pinned, the other moves the whole way alone
  const shareEach = node === pinned || other === pinned ? 1 : 0.5;
  const shift = shareEach * overlap * direction;
  const move = (moved: number, by: number) => {
    if (moved === pinned) return;
    const point = positions[moved]!;
    positions[moved] = horizontal ? { x: point.x + by, y: point.y } : { x: point.x, y: point.y + by };
  };
  move(node, shift);
  move(other, -shift);
}

/** Pushes apart nodes whose boxes overlap, so labels stay readable; the pinned node stays put. */
function separate(positions: Point[], pinned: number): Point[] {
  const result = positions.map((point) => ({ ...point }));
  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1)
    for (let node = 0; node < result.length; node += 1)
      for (let other = node + 1; other < result.length; other += 1) pushApart({ positions: result, pair: [node, other], pinned });
  return result;
}

/** The smallest box around all positions. */
function bounds(positions: Point[]): { left: number; right: number; top: number; bottom: number } {
  return positions.reduce(
    (box, { x, y }) => ({ left: Math.min(box.left, x), right: Math.max(box.right, x), top: Math.min(box.top, y), bottom: Math.max(box.bottom, y) }),
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  );
}

/** The smallest frame in the base aspect ratio, at least the base size, around all nodes; positions move so it starts at 0,0. */
function frame(positions: Point[]): { positions: Point[]; frame: Size } {
  const box = bounds(positions);
  const left = box.left - MARGIN.side;
  const right = box.right + MARGIN.side;
  const top = box.top - MARGIN.top;
  const bottom = box.bottom + MARGIN.bottom;
  const growth = Math.max(1, (right - left) / GRAPH_WIDTH, (bottom - top) / GRAPH_HEIGHT);
  const size = { width: GRAPH_WIDTH * growth, height: GRAPH_HEIGHT * growth };
  const shift = { x: (size.width - (right - left)) / 2 - left, y: (size.height - (bottom - top)) / 2 - top };
  return { positions: positions.map(({ x, y }) => ({ x: x + shift.x, y: y + shift.y })), frame: size };
}

/** Deterministic stress layout from a radial tree around the centre, then crossings removed and overlapping labels pushed apart. */
export function layoutGraph(graph: NeighborhoodGraph): GraphLayout {
  if (graph.nodes.length === 0) return { positions: new Map(), frame: { width: GRAPH_WIDTH, height: GRAPH_HEIGHT } };
  const indexOf = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const links = toLinks(graph, indexOf);
  const pinned = indexOf.get(graph.centerId) ?? 0;
  const start = radialStart({ nodeCount: graph.nodes.length, links, root: pinned, unit: UNIT });
  const settled = majorize({ positions: start, distances: hopDistances(graph.nodes.length, links), pinned, unit: UNIT });
  const untangled = untangle({ positions: settled, links, pinned, unit: UNIT });
  const framed = frame(separate(orient(untangled, pinned), pinned));
  return { positions: new Map(graph.nodes.map((node, index) => [node.id, framed.positions[index]!])), frame: framed.frame };
}

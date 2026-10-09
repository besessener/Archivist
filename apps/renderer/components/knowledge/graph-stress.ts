import { neighbourLists, type Link, type Point } from './graph-geometry';

const MAJORIZATION_ROUNDS = 300;
/** Below this largest move per round (in units of the ideal edge length) the layout counts as settled. */
const SETTLED_MOVE_IN_UNITS = 0.0005;
/** How far apart, per index step, two nodes on the same spot are nudged so they get a direction. */
const COINCIDENT_NUDGE = 1e-3;

/** Hop counts from one node by breadth-first search; unreachable nodes stay at -1. */
function hopsFrom(start: number, neighbours: number[][]): number[] {
  const hops = neighbours.map(() => -1);
  hops[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    for (const next of neighbours[node]!)
      if (hops[next] === -1) {
        hops[next] = hops[node]! + 1;
        queue.push(next);
      }
  }
  return hops;
}

/** Graph-theoretic distance of every node pair; pairs in different components get one more than the longest path. */
export function hopDistances(nodeCount: number, links: Link[]): number[][] {
  const neighbours = neighbourLists(nodeCount, links);
  const hops = neighbours.map((_, node) => hopsFrom(node, neighbours));
  // a loop, not Math.max(...): spreading nodeCount² values as arguments overflows the call stack
  const longest = hops.reduce((most, row) => row.reduce((rowMost, hop) => Math.max(rowMost, hop), most), 1);
  const unreachable = longest + 1;
  return hops.map((row) => row.map((hop) => (hop === -1 ? unreachable : hop)));
}

type Majorization = { xs: Float64Array; ys: Float64Array; ideals: Float64Array; weights: Float64Array; pinned: number };

/** Weighted mean of where every other node wants this one: at its ideal distance, in the current direction. */
function targetPosition({ xs, ys, ideals, weights }: Majorization, node: number): Point {
  const count = xs.length;
  let weightedX = 0;
  let weightedY = 0;
  let weightSum = 0;
  for (let other = 0; other < count; other += 1) {
    if (other === node) continue;
    const pair = node * count + other;
    // identical positions have no direction; nudge apart along a fixed, index-dependent axis
    const dx = xs[node]! - xs[other]! || (node - other) * COINCIDENT_NUDGE;
    const dy = ys[node]! - ys[other]!;
    const stretch = ideals[pair]! / Math.sqrt(dx * dx + dy * dy);
    weightedX += weights[pair]! * (xs[other]! + dx * stretch);
    weightedY += weights[pair]! * (ys[other]! + dy * stretch);
    weightSum += weights[pair]!;
  }
  return { x: weightedX / weightSum, y: weightedY / weightSum };
}

/** One Gauss-Seidel round of stress majorization; returns the largest move. */
function majorizeRound(state: Majorization): number {
  const { xs, ys, pinned } = state;
  let largestMove = 0;
  for (let node = 0; node < xs.length; node += 1) {
    if (node === pinned) continue;
    const target = targetPosition(state, node);
    largestMove = Math.max(largestMove, Math.abs(target.x - xs[node]!) + Math.abs(target.y - ys[node]!));
    xs[node] = target.x;
    ys[node] = target.y;
  }
  return largestMove;
}

/** Stress majorization: moves nodes until their distances match the hop distances times the unit length; the pinned node stays put. */
export function majorize({ positions, distances, pinned, unit }: { positions: Point[]; distances: number[][]; pinned: number; unit: number }): Point[] {
  const ideals = Float64Array.from(distances.flat(), (hops) => hops * unit);
  const state: Majorization = {
    xs: Float64Array.from(positions, (point) => point.x),
    ys: Float64Array.from(positions, (point) => point.y),
    ideals,
    weights: ideals.map((ideal) => (ideal === 0 ? 0 : 1 / (ideal * ideal))),
    pinned,
  };
  for (let round = 0; round < MAJORIZATION_ROUNDS; round += 1) if (majorizeRound(state) < SETTLED_MOVE_IN_UNITS * unit) break;
  return positions.map((_, node) => ({ x: state.xs[node]!, y: state.ys[node]! }));
}

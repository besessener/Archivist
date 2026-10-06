import { neighbourLists, type Link, type Point } from './graph-geometry';

const MAJORIZATION_ROUNDS = 300;
/** Below this largest move per round (in units of the ideal edge length) the layout counts as settled. */
const SETTLED = 0.0005;

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
  const unreachable = Math.max(1, ...hops.flat()) + 1;
  return hops.map((row) => row.map((hop) => (hop === -1 ? unreachable : hop)));
}

type Majorization = { xs: Float64Array; ys: Float64Array; ideals: Float64Array; weights: Float64Array; pinned: number };

/** One Gauss-Seidel round of stress majorization; returns the largest move. */
function majorizeRound({ xs, ys, ideals, weights, pinned }: Majorization): number {
  const count = xs.length;
  let largestMove = 0;
  for (let i = 0; i < count; i += 1) {
    if (i === pinned) continue;
    let x = 0;
    let y = 0;
    let total = 0;
    for (let j = 0; j < count; j += 1) {
      if (j === i) continue;
      const pair = i * count + j;
      // identical positions have no direction; nudge apart along a fixed, index-dependent axis
      const dx = xs[i]! - xs[j]! || (i - j) * 1e-3;
      const dy = ys[i]! - ys[j]!;
      const scale = ideals[pair]! / Math.sqrt(dx * dx + dy * dy);
      x += weights[pair]! * (xs[j]! + dx * scale);
      y += weights[pair]! * (ys[j]! + dy * scale);
      total += weights[pair]!;
    }
    largestMove = Math.max(largestMove, Math.abs(x / total - xs[i]!) + Math.abs(y / total - ys[i]!));
    xs[i] = x / total;
    ys[i] = y / total;
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
  for (let round = 0; round < MAJORIZATION_ROUNDS; round += 1) if (majorizeRound(state) < SETTLED * unit) break;
  return positions.map((_, node) => ({ x: state.xs[node]!, y: state.ys[node]! }));
}

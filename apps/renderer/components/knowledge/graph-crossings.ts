import { distanceBetween, linksCross, type Link, type Point } from './graph-geometry';

/** How many nearby nodes each node tries to swap places with. */
const SWAP_CANDIDATES = 10;
const MAX_PASSES = 8;
/** A crossing weighs as much as this many ideal edge lengths of extra line, so a swap does not trade one crossing for a long detour. */
const CROSSING_WEIGHT = 2;

type Drawing = { positions: Point[]; links: Link[]; incident: number[][]; unit: number };

/** Crossings that involve at least one of the given links, plus their length in units; each crossing pair counts once. */
function localCost({ positions, links, unit }: Drawing, involved: Set<number>): number {
  let crossings = 0;
  let length = 0;
  for (const index of involved) {
    const link = links[index]!;
    length += distanceBetween(positions[link[0]]!, positions[link[1]]!) / unit;
    for (let other = 0; other < links.length; other += 1)
      if (linksCross(positions, link, links[other]!) && !(other <= index && involved.has(other))) crossings += 1;
  }
  return crossings * CROSSING_WEIGHT + length;
}

function swap(positions: Point[], a: number, b: number) {
  [positions[a], positions[b]] = [positions[b]!, positions[a]!];
}

/** Swaps the two nodes if that lowers the local cost; returns whether it did. */
function trySwap(drawing: Drawing, a: number, b: number): boolean {
  const involved = new Set([...drawing.incident[a]!, ...drawing.incident[b]!]);
  if (involved.size === 0) return false;
  const before = localCost(drawing, involved);
  swap(drawing.positions, a, b);
  if (localCost(drawing, involved) < before - 1e-9) return true;
  swap(drawing.positions, a, b);
  return false;
}

function isCrossed({ positions, links, incident }: Drawing, node: number): boolean {
  return incident[node]!.some((index) => links.some((other) => linksCross(positions, links[index]!, other)));
}

function nearest(positions: Point[], node: number, movable: number[]): number[] {
  return movable
    .filter((other) => other !== node)
    .map((other) => ({ other, distance: distanceBetween(positions[node]!, positions[other]!) }))
    .sort((left, right) => left.distance - right.distance || left.other - right.other)
    .slice(0, SWAP_CANDIDATES)
    .map(({ other }) => other);
}

/** Lets every crossed node try its nearby swaps once; returns whether any swap helped. */
function swapPass(drawing: Drawing, movable: number[]): boolean {
  let improved = false;
  for (const node of movable) {
    if (!isCrossed(drawing, node)) continue;
    for (const other of nearest(drawing.positions, node, movable)) if (trySwap(drawing, node, other)) improved = true;
  }
  return improved;
}

/**
 * Removes edge crossings by letting nearby nodes swap places while that makes the drawing cheaper (crossings first, then line length).
 * Swapping keeps the set of occupied spots, so the spacing of the layout stays intact. The pinned node never moves.
 */
export function untangle({ positions, links, pinned, unit }: { positions: Point[]; links: Link[]; pinned: number; unit: number }): Point[] {
  const incident: number[][] = positions.map(() => []);
  for (const [index, [a, b]] of links.entries()) {
    incident[a]!.push(index);
    incident[b]!.push(index);
  }
  const drawing: Drawing = { positions: positions.map((point) => ({ ...point })), links, incident, unit };
  const movable = positions.map((_, node) => node).filter((node) => node !== pinned);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) if (!swapPass(drawing, movable)) break;
  return drawing.positions;
}

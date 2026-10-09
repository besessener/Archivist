import { distanceBetween, linksCrossIn, type Link, type Point } from './graph-geometry';

/** How many nearby nodes each node tries to swap places with. */
const SWAP_CANDIDATES = 10;
const MAX_PASSES = 8;
/** Line length (in ideal edge lengths) a swap must save at least to count as shorter, so rounding noise cannot flip nodes back and forth. */
const MIN_IMPROVEMENT = 1e-9;

type Drawing = { positions: Point[]; links: Link[]; incident: number[][]; unit: number; linksCross: (first: Link, second: Link) => boolean };
/** Crossings and line length (in ideal edge lengths) of some links. */
type Cost = { crossings: number; length: number };

/** Crossings that involve at least one of the given links, plus their length; each crossing pair counts once. */
function localCost({ positions, links, unit, linksCross }: Drawing, involved: Set<number>): Cost {
  let crossings = 0;
  let length = 0;
  for (const index of involved) {
    const link = links[index]!;
    length += distanceBetween(positions[link[0]]!, positions[link[1]]!) / unit;
    for (let other = 0; other < links.length; other += 1) {
      if (!linksCross(link, links[other]!)) continue;
      const countedAlready = involved.has(other) && other <= index;
      if (!countedAlready) crossings += 1;
    }
  }
  return { crossings, length };
}

/** Fewer crossings always win; line length only breaks ties. */
function isCheaper(after: Cost, before: Cost): boolean {
  if (after.crossings !== before.crossings) return after.crossings < before.crossings;
  return after.length < before.length - MIN_IMPROVEMENT;
}

function swap(positions: Point[], [node, other]: [number, number]) {
  [positions[node], positions[other]] = [positions[other]!, positions[node]!];
}

/** Swaps the two nodes if that makes the drawing cheaper; returns whether it did. */
function trySwap({ drawing, node, other }: { drawing: Drawing; node: number; other: number }): boolean {
  const involved = new Set([...drawing.incident[node]!, ...drawing.incident[other]!]);
  if (involved.size === 0) return false;
  const before = localCost(drawing, involved);
  swap(drawing.positions, [node, other]);
  if (isCheaper(localCost(drawing, involved), before)) return true;
  swap(drawing.positions, [node, other]);
  return false;
}

function isCrossed({ links, incident, linksCross }: Drawing, node: number): boolean {
  return incident[node]!.some((index) => links.some((other) => linksCross(links[index]!, other)));
}

function nearest({ positions, node, movable }: { positions: Point[]; node: number; movable: number[] }): number[] {
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
    for (const other of nearest({ positions: drawing.positions, node, movable })) if (trySwap({ drawing, node, other })) improved = true;
  }
  return improved;
}

/** Removes edge crossings by swapping nearby nodes (fewer crossings first, then shorter lines), which keeps the spacing; the pinned node stays. */
export function untangle({ positions, links, pinned, unit }: { positions: Point[]; links: Link[]; pinned: number; unit: number }): Point[] {
  const incident: number[][] = positions.map(() => []);
  for (const [index, [node, other]] of links.entries()) {
    incident[node]!.push(index);
    incident[other]!.push(index);
  }
  const copy = positions.map((point) => ({ ...point }));
  const drawing: Drawing = { positions: copy, links, incident, unit, linksCross: linksCrossIn(copy) };
  const movable = positions.map((_, node) => node).filter((node) => node !== pinned);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) if (!swapPass(drawing, movable)) break;
  return drawing.positions;
}

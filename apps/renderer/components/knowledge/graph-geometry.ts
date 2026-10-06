export type Point = { x: number; y: number };
/** An edge between two node indices. */
export type Link = [number, number];

/** The neighbours of every node. */
export function neighbourLists(nodeCount: number, links: Link[]): number[][] {
  const neighbours: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const [a, b] of links) {
    neighbours[a]!.push(b);
    neighbours[b]!.push(a);
  }
  return neighbours;
}

export function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Sign of the turn from → via → to: positive counter-clockwise, negative clockwise, 0 collinear. */
function turn(from: Point, via: Point, to: Point): number {
  return Math.sign((via.x - from.x) * (to.y - from.y) - (via.y - from.y) * (to.x - from.x));
}

/** Whether segment a–b crosses segment c–d in their interiors; touching or collinear segments do not count. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}

/** Whether two links cross; links that share a node meet there and never count as crossing. */
export function linksCross(positions: Point[], first: Link, second: Link): boolean {
  if (first[0] === second[0] || first[0] === second[1] || first[1] === second[0] || first[1] === second[1]) return false;
  return segmentsCross(positions[first[0]]!, positions[first[1]]!, positions[second[0]]!, positions[second[1]]!);
}

/** The number of crossing link pairs in a drawing. */
export function countCrossings(positions: Point[], links: Link[]): number {
  let crossings = 0;
  for (let i = 0; i < links.length; i += 1) for (let j = i + 1; j < links.length; j += 1) if (linksCross(positions, links[i]!, links[j]!)) crossings += 1;
  return crossings;
}

export type Point = { x: number; y: number };
/** An edge between two node indices. */
export type Link = [number, number];

/** The neighbours of every node. */
export function neighbourLists(nodeCount: number, links: Link[]): number[][] {
  const neighbours: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const [node, other] of links) {
    neighbours[node]!.push(other);
    neighbours[other]!.push(node);
  }
  return neighbours;
}

export function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Which side of the line from → to a point lies on: positive counter-clockwise, negative clockwise, 0 on the line. */
function sideOf(from: Point, to: Point): (point: Point) => number {
  return (point) => Math.sign((to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x));
}

/** Whether two links share a node, so they meet there instead of crossing. */
function shareNode(first: Link, second: Link): boolean {
  return first[0] === second[0] || first[0] === second[1] || first[1] === second[0] || first[1] === second[1];
}

/** A test whether two links cross in their interiors in this drawing; touching, collinear or node-sharing links do not count. */
export function linksCrossIn(positions: Point[]): (first: Link, second: Link) => boolean {
  return (first, second) => {
    if (shareNode(first, second)) return false;
    const start = positions[first[0]]!;
    const end = positions[first[1]]!;
    const otherStart = positions[second[0]]!;
    const otherEnd = positions[second[1]]!;
    const sideOfFirst = sideOf(start, end);
    const sideOfSecond = sideOf(otherStart, otherEnd);
    // each link's ends lie on opposite sides of the other link
    return sideOfFirst(otherStart) * sideOfFirst(otherEnd) < 0 && sideOfSecond(start) * sideOfSecond(end) < 0;
  };
}

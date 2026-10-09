import { linksCrossIn, type Link, type Point } from '../../apps/renderer/components/knowledge/graph-geometry';

/** The number of crossing link pairs in a drawing. */
export function countCrossings(positions: Point[], links: Link[]): number {
  const linksCross = linksCrossIn(positions);
  let crossings = 0;
  for (let i = 0; i < links.length; i += 1) for (let j = i + 1; j < links.length; j += 1) if (linksCross(links[i]!, links[j]!)) crossings += 1;
  return crossings;
}

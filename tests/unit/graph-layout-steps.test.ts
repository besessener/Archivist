import { describe, expect, it } from 'vitest';
import { untangle } from '../../apps/renderer/components/knowledge/graph-crossings';
import { countCrossings, distanceBetween, linksCross, segmentsCross, type Link } from '../../apps/renderer/components/knowledge/graph-geometry';
import { radialStart } from '../../apps/renderer/components/knowledge/graph-radial';
import { hopDistances, majorize } from '../../apps/renderer/components/knowledge/graph-stress';

const at = (x: number, y: number) => ({ x, y });

describe('graph geometry', () => {
  it('counts segments that cross in their interiors, not ones that touch, meet or run in parallel', () => {
    expect(segmentsCross(at(0, 0), at(2, 2), at(0, 2), at(2, 0))).toBe(true);
    expect(segmentsCross(at(0, 0), at(2, 2), at(1, 1), at(3, 0))).toBe(false);
    expect(segmentsCross(at(0, 0), at(1, 0), at(0, 1), at(1, 1))).toBe(false);
    expect(segmentsCross(at(0, 0), at(2, 0), at(1, 0), at(3, 0))).toBe(false);
    expect(segmentsCross(at(0, 0), at(1, 1), at(2, 0), at(3, -1))).toBe(false);
  });

  it('never counts links that share a node', () => {
    const positions = [at(0, 0), at(2, 2), at(2, 0)];
    expect(linksCross(positions, [0, 1], [0, 2])).toBe(false);
    expect(
      countCrossings(
        [at(0, 0), at(2, 2), at(0, 2), at(2, 0)],
        [
          [0, 1],
          [2, 3],
          [0, 2],
        ],
      ),
    ).toBe(1);
  });
});

describe('layout steps', () => {
  it('measures distances in steps, with one more than the longest path for separate parts', () => {
    expect(
      hopDistances(4, [
        [0, 1],
        [1, 2],
      ]),
    ).toEqual([
      [0, 1, 2, 3],
      [1, 0, 1, 3],
      [2, 1, 0, 3],
      [3, 3, 3, 0],
    ]);
  });

  it('starts every branch in its own wedge, one ring per step', () => {
    const positions = radialStart({
      nodeCount: 4,
      links: [
        [0, 1],
        [0, 2],
        [1, 3],
      ],
      root: 0,
      unit: 100,
    });
    expect(distanceBetween(positions[0]!, at(0, 0))).toBe(0);
    expect(distanceBetween(positions[0]!, positions[1]!)).toBeCloseTo(100);
    expect(distanceBetween(positions[0]!, positions[3]!)).toBeCloseTo(200);
    expect(distanceBetween(positions[1]!, positions[3]!)).toBeLessThan(distanceBetween(positions[2]!, positions[3]!));
  });

  it('stretches a path to its ideal edge lengths and keeps the pinned node in place', () => {
    const positions = majorize({
      positions: [at(0, 0), at(10, 5), at(20, -5)],
      distances: hopDistances(3, [
        [0, 1],
        [1, 2],
      ]),
      pinned: 0,
      unit: 100,
    });
    expect(positions[0]).toEqual(at(0, 0));
    // majorization stops once moves are tiny, a few units short of the exact lengths
    expect(distanceBetween(positions[0]!, positions[1]!)).toBeCloseTo(100, -1);
    expect(distanceBetween(positions[0]!, positions[2]!)).toBeCloseTo(200, -1);
  });

  it('separates nodes that start on the same spot', () => {
    const positions = majorize({
      positions: [at(0, 0), at(5, 5), at(5, 5)],
      distances: hopDistances(3, [
        [0, 1],
        [0, 2],
      ]),
      pinned: 0,
      unit: 100,
    });
    expect(distanceBetween(positions[1]!, positions[2]!)).toBeGreaterThan(100);
  });

  it('untangles a crossed square by swapping two corners and never moves the pinned node', () => {
    // the cycle 0-1-2-3 drawn as a bow tie
    const links: Link[] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ];
    const bowTie = [at(0, 0), at(100, 100), at(100, 0), at(0, 100)];
    expect(countCrossings(bowTie, links)).toBe(1);
    const untangled = untangle({ positions: bowTie, links, pinned: 0, unit: 100 });
    expect(countCrossings(untangled, links)).toBe(0);
    expect(untangled[0]).toEqual(at(0, 0));
    expect(new Set(untangled.map(({ x, y }) => `${x},${y}`))).toEqual(new Set(bowTie.map(({ x, y }) => `${x},${y}`)));
  });
});

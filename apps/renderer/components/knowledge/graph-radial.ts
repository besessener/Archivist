import { neighbourLists, type Link, type Point } from './graph-geometry';

/** Rounds of reordering siblings towards their other neighbours. */
const ORDERING_ROUNDS = 3;

type Tree = { root: number; children: number[][]; depth: number[]; leaves: number[] };
type Placement = { positions: Point[]; angles: number[] };

/** The breadth-first tree from the root; nodes it does not reach hang directly below the root. */
function spanningTree(root: number, neighbours: number[][]): Tree {
  const depth = neighbours.map(() => -1);
  const children: number[][] = neighbours.map(() => []);
  depth[root] = 0;
  const queue = [root];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    for (const next of neighbours[node]!)
      if (depth[next] === -1) {
        depth[next] = depth[node]! + 1;
        children[node]!.push(next);
        queue.push(next);
      }
  }
  for (const [node, value] of depth.entries())
    if (value === -1) {
      depth[node] = 1;
      children[root]!.push(node);
      queue.push(node);
    }
  const leaves = depth.map(() => 0);
  for (const node of [...queue].reverse())
    leaves[node] = Math.max(
      1,
      children[node]!.reduce((sum, child) => sum + leaves[child]!, 0),
    );
  return { root, children, depth, leaves };
}

/** Each subtree in a wedge as wide as its share of leaves, one ring per depth. */
function placeRadially(tree: Tree, unit: number): Placement {
  const positions: Point[] = tree.depth.map(() => ({ x: 0, y: 0 }));
  const angles = tree.depth.map(() => 0);
  const place = (node: number, from: number, width: number) => {
    angles[node] = from + width / 2;
    positions[node] = { x: Math.cos(angles[node]) * tree.depth[node]! * unit, y: Math.sin(angles[node]) * tree.depth[node]! * unit };
    let start = from;
    for (const child of tree.children[node]!) {
      const share = (width * tree.leaves[child]!) / tree.leaves[node]!;
      place(child, start, share);
      start += share;
    }
  };
  place(tree.root, 0, 2 * Math.PI);
  return { positions, angles };
}

/** The direction of a node's neighbours other than its parent, as an angle close to the parent's; its own angle if it has none. */
function siblingKey({ node, parent, neighbours, placement }: { node: number; parent: number; neighbours: number[][]; placement: Placement }): number {
  let x = 0;
  let y = 0;
  for (const other of neighbours[node]!) {
    const { x: otherX, y: otherY } = placement.positions[other]!;
    const length = Math.hypot(otherX, otherY);
    if (other === parent || length === 0) continue;
    x += otherX / length;
    y += otherY / length;
  }
  const angle = x === 0 && y === 0 ? placement.angles[node]! : Math.atan2(y, x);
  const reference = placement.angles[parent]!;
  return reference + Math.atan2(Math.sin(angle - reference), Math.cos(angle - reference));
}

/** Barycentre heuristic: siblings move towards the side where their other neighbours are, so cross links do not cut through branches. */
function orderSiblings({ tree, neighbours, placement }: { tree: Tree; neighbours: number[][]; placement: Placement }) {
  for (const [parent, children] of tree.children.entries()) {
    const keys = new Map(children.map((node) => [node, siblingKey({ node, parent, neighbours, placement })]));
    children.sort((a, b) => keys.get(a)! - keys.get(b)!);
  }
}

/** Deterministic start: a radial tree around the root whose siblings are ordered towards their cross links, so branches start untangled. */
export function radialStart({ nodeCount, links, root, unit }: { nodeCount: number; links: Link[]; root: number; unit: number }): Point[] {
  const neighbours = neighbourLists(nodeCount, links);
  const tree = spanningTree(root, neighbours);
  let placement = placeRadially(tree, unit);
  for (let round = 0; round < ORDERING_ROUNDS; round += 1) {
    orderSiblings({ tree, neighbours, placement });
    placement = placeRadially(tree, unit);
  }
  return placement.positions;
}

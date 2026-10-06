import type { Point, Size } from './graph-layout';

/** The visible part of the graph in graph coordinates (the SVG viewBox). */
export type ViewBox = { x: number; y: number; width: number; height: number };
type ScreenRect = { left: number; top: number; width: number; height: number };

/** The view that shows the whole layout frame. */
export function fitView(frame: Size): ViewBox {
  return { x: 0, y: 0, ...frame };
}

/** Screen pixels per graph unit; the SVG keeps its aspect ratio, so the smaller axis wins. */
export function screenScale({ view, rect }: { view: ViewBox; rect: ScreenRect }): number {
  return Math.min(rect.width / view.width, rect.height / view.height);
}

/** The graph point under a screen position, accounting for the letterboxing of the SVG. */
export function toGraphPoint({ view, rect, client }: { view: ViewBox; rect: ScreenRect; client: Point }): Point {
  const scale = screenScale({ view, rect });
  const offsetX = (rect.width - view.width * scale) / 2;
  const offsetY = (rect.height - view.height * scale) / 2;
  return { x: view.x + (client.x - rect.left - offsetX) / scale, y: view.y + (client.y - rect.top - offsetY) / scale };
}

/** Zooms by `factor` (> 1 closer), between 8x in and 2x out of the `fit` frame, and keeps the `focus` point where it is on screen. */
export function zoomView({ view, factor, focus, fit }: { view: ViewBox; factor: number; focus: Point; fit: ViewBox }): ViewBox {
  const width = Math.min(fit.width * 2, Math.max(fit.width / 8, view.width / factor));
  const applied = view.width / width;
  return {
    x: focus.x - (focus.x - view.x) / applied,
    y: focus.y - (focus.y - view.y) / applied,
    width,
    height: view.height / applied,
  };
}

/** Moves the picture by a distance in graph units (the content follows the pointer). */
export function panView({ view, delta }: { view: ViewBox; delta: Point }): ViewBox {
  return { ...view, x: view.x - delta.x, y: view.y - delta.y };
}

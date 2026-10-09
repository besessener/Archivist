import type { Point, Size } from './graph-layout';

/** The visible part of the graph in graph coordinates (the SVG viewBox). */
export type ViewBox = { x: number; y: number; width: number; height: number };
type ScreenRect = { left: number; top: number; width: number; height: number };
/** What a wheel turn over the graph does. */
export type WheelGesture = 'zoom' | 'pan' | 'page-scroll';

/** Strongest magnification, relative to the view of the whole frame. */
const MAX_ZOOM_IN = 8;
/** Widest view, as a multiple of the whole frame. */
const MAX_ZOOM_OUT = 2;
/** Zoom factor per pixel of wheel movement. */
const ZOOM_PER_WHEEL_PIXEL = 1.0015;

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

/** Zooms by `factor` (> 1 closer), within the zoom limits around the `fit` frame, and keeps the `focus` point where it is on screen. */
export function zoomView({ view, factor, focus, fit }: { view: ViewBox; factor: number; focus: Point; fit: ViewBox }): ViewBox {
  const width = Math.min(fit.width * MAX_ZOOM_OUT, Math.max(fit.width / MAX_ZOOM_IN, view.width / factor));
  const clampedFactor = view.width / width;
  return {
    x: focus.x - (focus.x - view.x) / clampedFactor,
    y: focus.y - (focus.y - view.y) / clampedFactor,
    width,
    height: view.height / clampedFactor,
  };
}

/** Moves the picture by a distance in graph units (the content follows the pointer). */
export function panView({ view, delta }: { view: ViewBox; delta: Point }): ViewBox {
  return { ...view, x: view.x - delta.x, y: view.y - delta.y };
}

/** Ctrl+wheel and touchpad pinch (Chromium reports it as a wheel with Ctrl) zoom; a plain wheel pans in fullscreen, else it scrolls the page. */
export function wheelGesture({ ctrlKey, fullscreen }: { ctrlKey: boolean; fullscreen: boolean }): WheelGesture {
  if (ctrlKey) return 'zoom';
  return fullscreen ? 'pan' : 'page-scroll';
}

/** The zoom factor for a vertical wheel movement in pixels: up zooms in, down zooms out by the same amount. */
export function wheelZoomFactor(deltaY: number): number {
  return ZOOM_PER_WHEEL_PIXEL ** -deltaY;
}

/** Moves the view along with the wheel (or two-finger scroll) by its screen distance, at `scale` screen pixels per graph unit. */
export function wheelPan({ view, wheel, scale }: { view: ViewBox; wheel: { deltaX: number; deltaY: number }; scale: number }): ViewBox {
  return panView({ view, delta: { x: -wheel.deltaX / scale, y: -wheel.deltaY / scale } });
}

import { describe, expect, it } from 'vitest';
import { fitView, panView, screenScale, toGraphPoint, zoomView } from '../../apps/renderer/components/knowledge/graph-viewport';

const FULL_VIEW = fitView(0);
const rect = { left: 10, top: 20, width: 720, height: 440 };

describe('graph viewport', () => {
  it('maps a screen position to the graph point, also when the SVG is letterboxed', () => {
    expect(toGraphPoint({ view: FULL_VIEW, rect, client: { x: 10 + 360, y: 20 + 220 } })).toEqual({ x: 360, y: 220 });
    const wide = { left: 0, top: 0, width: 1440, height: 440 };
    expect(screenScale({ view: FULL_VIEW, rect: wide })).toBe(1);
    expect(toGraphPoint({ view: FULL_VIEW, rect: wide, client: { x: 720, y: 0 } })).toEqual({ x: 360, y: 0 });
  });

  it('zooms around the focus point so it stays put on screen', () => {
    const focus = { x: 180, y: 110 };
    const zoomed = zoomView({ view: FULL_VIEW, factor: 2, focus, fit: FULL_VIEW });
    expect(zoomed.width).toBe(360);
    expect(zoomed.height).toBe(220);
    expect((focus.x - zoomed.x) / zoomed.width).toBeCloseTo(0.25);
    expect((focus.y - zoomed.y) / zoomed.height).toBeCloseTo(0.25);
  });

  it('limits how far you can zoom in and out', () => {
    const focus = { x: 0, y: 0 };
    expect(zoomView({ view: FULL_VIEW, factor: 1000, focus, fit: FULL_VIEW }).width).toBe(90);
    expect(zoomView({ view: FULL_VIEW, factor: 0.001, focus, fit: FULL_VIEW }).width).toBe(1440);
  });

  it('gives a graph with many nodes a larger frame than a small one', () => {
    expect(fitView(25)).toEqual({ x: 0, y: 0, width: 720, height: 440 });
    expect(fitView(100)).toEqual({ x: 0, y: 0, width: 1440, height: 880 });
    expect(zoomView({ view: fitView(100), factor: 1000, focus: { x: 0, y: 0 }, fit: fitView(100) }).width).toBe(180);
  });

  it('pans the content along with the pointer', () => {
    expect(panView({ view: FULL_VIEW, delta: { x: 30, y: -10 } })).toEqual({ ...FULL_VIEW, x: -30, y: 10 });
  });
});

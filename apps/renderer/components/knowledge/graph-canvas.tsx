'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react';
import type { NeighborhoodGraph } from '@archivist/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { GraphEdge, GraphLegend, GraphNode, type GraphNodeRecord } from './graph-parts';
import type { GraphLayout, Point } from './graph-layout';
import { fitView, panView, screenScale, toGraphPoint, wheelGesture, wheelPan, wheelZoomFactor, zoomView, type ViewBox } from './graph-viewport';

const BUTTON_STEP = 1.4;

type Props = {
  graph: NeighborhoodGraph;
  layout: GraphLayout;
  nodeById: Map<string, GraphNodeRecord>;
  selected: string | null;
  fullscreen: boolean;
  onSelect: (id: string) => void;
  onToggleFullscreen: () => void;
};

/** The SVG with Ctrl+wheel or pinch zoom, drag to pan and a fullscreen toggle; the view resets when the layout frame changes. */
export function GraphCanvas({ graph, layout, nodeById, selected, fullscreen, onSelect, onToggleFullscreen }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ last: Point } | null>(null);
  const { positions, frame } = layout;
  const fit = fitView(frame);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const [view, setView] = useState<ViewBox>(fit);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => setView(fitRef.current), [frame.width, frame.height]);

  const zoomAtCenter = (factor: number) => {
    const current = viewRef.current;
    setView(zoomView({ view: current, factor, focus: { x: current.x + current.width / 2, y: current.y + current.height / 2 }, fit: fitRef.current }));
  };

  // React registers wheel listeners as passive, so they cannot stop the page from scrolling or zooming; a native one can.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      const gesture = wheelGesture({ ctrlKey: event.ctrlKey, fullscreen });
      if (gesture === 'page-scroll') return;
      event.preventDefault();
      const current = viewRef.current;
      const rect = svg.getBoundingClientRect();
      if (gesture === 'pan') {
        setView(wheelPan({ view: current, wheel: event, scale: screenScale({ view: current, rect }) }));
        return;
      }
      const focus = toGraphPoint({ view: current, rect, client: { x: event.clientX, y: event.clientY } });
      setView(zoomView({ view: current, factor: wheelZoomFactor(event.deltaY), focus, fit: fitRef.current }));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [fullscreen]);

  const startPan = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if ((event.target as Element).closest('[data-testid="graph-node"]')) return;
    drag.current = { last: { x: event.clientX, y: event.clientY } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pan = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const scale = screenScale({ view: viewRef.current, rect: event.currentTarget.getBoundingClientRect() });
    const delta = { x: (event.clientX - drag.current.last.x) / scale, y: (event.clientY - drag.current.last.y) / scale };
    drag.current.last = { x: event.clientX, y: event.clientY };
    setView(panView({ view: viewRef.current, delta }));
  };

  return (
    <div className={cn('relative flex flex-col rounded-xl border bg-card shadow-card', fullscreen && 'min-h-0 flex-1')}>
      <div className="absolute right-2 top-2 z-10 flex gap-1" data-testid="graph-controls">
        <Button size="icon" variant="outline" aria-label="Vergrößern" onClick={() => zoomAtCenter(BUTTON_STEP)} data-testid="graph-zoom-in">
          <Plus aria-hidden />
        </Button>
        <Button size="icon" variant="outline" aria-label="Verkleinern" onClick={() => zoomAtCenter(1 / BUTTON_STEP)} data-testid="graph-zoom-out">
          <Minus aria-hidden />
        </Button>
        <Button size="icon" variant="outline" aria-label="Ansicht zurücksetzen" onClick={() => setView(fit)} data-testid="graph-zoom-reset">
          <RotateCcw aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="outline"
          aria-label={fullscreen ? 'Vollbild beenden' : 'Vollbild'}
          aria-pressed={fullscreen}
          onClick={onToggleFullscreen}
          data-testid="graph-fullscreen"
        >
          {fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        className={cn('w-full cursor-grab touch-none active:cursor-grabbing', fullscreen ? 'min-h-0 flex-1' : 'h-auto')}
        role="group"
        aria-label={`Graph mit ${graph.nodes.length} Einträgen und ${graph.edges.length} Verknüpfungen`}
        onPointerDown={startPan}
        onPointerMove={pan}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        data-testid="graph-svg"
        data-view={`${view.x},${view.y},${view.width}`}
      >
        {graph.edges.map((edge) => (
          <GraphEdge key={edge.id} edge={edge} positions={positions} nodeById={nodeById} selected={selected} />
        ))}
        {graph.nodes.map((node) => (
          <GraphNode
            key={node.id}
            node={node}
            position={positions.get(node.id)}
            isCenter={node.id === graph.centerId}
            isSelected={selected === node.id}
            onSelect={() => onSelect(node.id)}
          />
        ))}
      </svg>
      <GraphLegend truncated={graph.truncated} />
    </div>
  );
}

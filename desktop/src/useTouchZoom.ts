import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export function useTouchZoom(viewport: RefObject<HTMLElement | null>, paper: RefObject<HTMLElement | null>, zoom: number, onZoom: (zoom: number) => void, enabled = true, min = .25, max = 4) {
  const latest = useRef({ zoom, onZoom, min, max }); latest.current = { zoom, onZoom, min, max };
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  useLayoutEffect(() => {
    const area = viewport.current, content = paper.current, point = anchor.current;
    if (!area || !content || !point) return;
    const rect = content.getBoundingClientRect();
    area.scrollLeft += rect.left + point.x * zoom - point.clientX;
    area.scrollTop += rect.top + point.y * zoom - point.clientY;
    anchor.current = null;
  }, [zoom, viewport, paper]);
  useEffect(() => {
    const area = viewport.current;
    if (!area || !enabled) return;
    let pinch: { distance: number; zoom: number; x: number; y: number } | null = null;
    let frame = 0;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !paper.current) { pinch = null; return; }
      const rect = paper.current.getBoundingClientRect(), x = (event.touches[0].clientX + event.touches[1].clientX) / 2, y = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      pinch = { distance: Math.max(1, distance(event.touches)), zoom: latest.current.zoom, x: (x - rect.left) / latest.current.zoom, y: (y - rect.top) / latest.current.zoom };
    };
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const next = Math.max(latest.current.min, Math.min(latest.current.max, pinch.zoom * distance(event.touches) / pinch.distance));
      const point = { x: pinch.x, y: pinch.y, clientX: (event.touches[0].clientX + event.touches[1].clientX) / 2, clientY: (event.touches[0].clientY + event.touches[1].clientY) / 2 };
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        if (Math.abs(next - latest.current.zoom) < .0001) {
          // At the zoom limit, two fingers can still pan without a stale anchor.
          const rect = paper.current?.getBoundingClientRect();
          if (rect) { area.scrollLeft += rect.left + point.x * next - point.clientX; area.scrollTop += rect.top + point.y * next - point.clientY; }
          anchor.current = null;
        } else { anchor.current = point; latest.current.onZoom(next); }
      });
    };
    const end = () => { pinch = null; };
    const double = (event: MouseEvent) => {
      if (!paper.current || (event.target instanceof Element && event.target.closest('button,a,input,summary'))) return;
      const rect = paper.current.getBoundingClientRect(), current = latest.current;
      anchor.current = { x: (event.clientX - rect.left) / current.zoom, y: (event.clientY - rect.top) / current.zoom, clientX: event.clientX, clientY: event.clientY };
      current.onZoom(current.zoom > current.min * 1.8 ? current.min : Math.min(current.max, current.min * 2.5));
    };
    area.addEventListener('touchstart', start, { passive: true }); area.addEventListener('touchmove', move, { passive: false });
    area.addEventListener('touchend', end); area.addEventListener('touchcancel', end); area.addEventListener('dblclick', double);
    return () => { cancelAnimationFrame(frame); anchor.current = null; area.removeEventListener('touchstart', start); area.removeEventListener('touchmove', move); area.removeEventListener('touchend', end); area.removeEventListener('touchcancel', end); area.removeEventListener('dblclick', double); };
  }, [enabled, viewport, paper]);
}

import { useEffect, useRef } from 'react';
import './touchExperience.css';

/** Follow an intentional edge swipe without stealing vertical scroll or document gestures. */
export function useEdgeDrawer(enabled: boolean, open: boolean, onChange: (open: boolean) => void) {
  const latest = useRef({ open, onChange });
  latest.current = { open, onChange };
  useEffect(() => {
    if (!enabled) return;
    const drawer = document.getElementById('primary-navigation');
    if (!drawer) return;
    let drag: { x: number; y: number; at: number; start: boolean; width: number; offset: number; active: boolean } | null = null;
    let suppressClickUntil = 0;
    let frame = 0;
    const clear = () => {
      drawer.removeAttribute('data-dragging'); drawer.style.removeProperty('--drawer-offset');
      document.documentElement.style.removeProperty('--drawer-progress');
      document.documentElement.removeAttribute('data-drawer-dragging');
    };
    const start = (event: TouchEvent) => {
      cancelAnimationFrame(frame);
      clear();
      if (event.touches.length !== 1) { drag = null; clear(); return; }
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('input,textarea,select,[contenteditable=true],[data-touch-document]')) return;
      if (document.querySelector('[aria-modal=true]:not(#primary-navigation)')) return;
      const touch = event.touches[0]; const isOpen = latest.current.open;
      const edge = Math.max(26, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0);
      if (!isOpen && touch.clientX > edge) return;
      if (isOpen && !drawer.contains(target) && !target.closest('.navigation-scrim')) return;
      drag = { x: touch.clientX, y: touch.clientY, at: performance.now(), start: isOpen, width: drawer.offsetWidth, offset: 0, active: false };
    };
    const move = (event: TouchEvent) => {
      if (!drag) return;
      if (event.touches.length !== 1) { drag = null; clear(); return; }
      const dx = event.touches[0].clientX - drag.x, dy = event.touches[0].clientY - drag.y;
      if (!drag.active) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        if ((!drag.start && dx < 0) || (drag.start && dx > 0)) { drag = null; return; }
        drag.active = true;
      }
      event.preventDefault();
      drag.offset = Math.max(-drag.width, Math.min(0, (drag.start ? 0 : -drag.width) + dx));
      drawer.dataset.dragging = 'true';
      document.documentElement.dataset.drawerDragging = 'true';
      drawer.style.setProperty('--drawer-offset', `${drag.offset}px`);
      document.documentElement.style.setProperty('--drawer-progress', String(1 + drag.offset / drag.width));
    };
    const finish = (event: TouchEvent) => {
      if (!drag) return;
      const ended = drag; drag = null;
      if (!ended.active) return;
      const travelled = ended.offset - (ended.start ? 0 : -ended.width);
      const velocity = travelled / Math.max(1, performance.now() - ended.at);
      const next = event.type === 'touchcancel' ? ended.start : Math.abs(velocity) > .45 && Math.abs(travelled) > 24 ? velocity > 0 : ended.offset > -ended.width / 2;
      suppressClickUntil = performance.now() + 350;
      latest.current.onChange(next);
      // Let React commit the final open/closed state before restoring the spring.
      frame = requestAnimationFrame(clear);
    };
    const click = (event: MouseEvent) => { if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); } };
    const cancel = () => { cancelAnimationFrame(frame); drag = null; clear(); };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', finish); window.addEventListener('touchcancel', finish);
    window.addEventListener('click', click, true); window.addEventListener('resize', cancel);
    return () => { cancel(); window.removeEventListener('touchstart', start); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', finish); window.removeEventListener('touchcancel', finish); window.removeEventListener('click', click, true); window.removeEventListener('resize', cancel); };
  }, [enabled]);
}

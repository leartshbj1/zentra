import { useLayoutEffect, useRef } from 'react';
import { clampDrawer, createSpringMotion, drawerIntent, projectedDrawerOpen, recentVelocity, type MotionSample } from './springMotion';
import './touchExperience.css';

/** Follow an intentional edge swipe without stealing vertical scroll or document gestures. */
export function useEdgeDrawer(enabled: boolean, open: boolean, onChange: (open: boolean) => void) {
  const latest = useRef({ open, onChange });
  latest.current = { open, onChange };
  const synchronize = useRef<((next: boolean) => void) | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    const drawer = document.getElementById('primary-navigation');
    if (!drawer) return;
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    type Drag = { kind: 'touch' | 'pointer'; id: number; x: number; y: number; start: boolean; position: number; velocity: number; samples: MotionSample[]; active: boolean; capture: Element | null };
    let drag: Drag | null = null;
    let width = drawer.offsetWidth;
    let destination = latest.current.open;
    let suppressClickUntil = 0;
    let clearFrame = 0;
    const clear = () => {
      drawer.removeAttribute('data-dragging'); drawer.removeAttribute('data-settling');
      drawer.style.removeProperty('--drawer-offset'); root.style.removeProperty('--drawer-progress');
      root.removeAttribute('data-drawer-dragging'); root.removeAttribute('data-drawer-settling');
    };
    const motion = createSpringMotion(destination ? 0 : -width, position => {
      drawer.style.setProperty('--drawer-offset', `${clampDrawer(position, width)}px`);
      root.style.setProperty('--drawer-progress', String(width > 0 ? 1 + clampDrawer(position, width) / width : 0));
    }, () => {
      // The callback can commit React state in this same event. Clear after that commit.
      cancelAnimationFrame(clearFrame); clearFrame = requestAnimationFrame(clear);
    }, { now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: frame => cancelAnimationFrame(frame), reduced: () => reduced.matches });
    const presentation = () => {
      const transform = getComputedStyle(drawer).transform;
      try { return clampDrawer(new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).m41, width); }
      catch { return clampDrawer(drawer.getBoundingClientRect().left - drawer.offsetLeft, width); }
    };
    const settle = (next: boolean, velocity?: number) => {
      cancelAnimationFrame(clearFrame); destination = next;
      drawer.removeAttribute('data-dragging'); root.removeAttribute('data-drawer-dragging');
      drawer.dataset.settling = 'true'; root.dataset.drawerSettling = 'true';
      motion.to(next ? 0 : -width, velocity);
    };
    const releaseCapture = (ended: Drag) => {
      if (ended.kind === 'pointer' && ended.capture?.hasPointerCapture?.(ended.id)) ended.capture.releasePointerCapture(ended.id);
    };
    const finish = (canceled: boolean) => {
      if (!drag) return;
      const ended = drag; drag = null; releaseCapture(ended);
      if (!ended.active) { settle(destination, ended.velocity); return; }
      const velocity = canceled ? 0 : recentVelocity(ended.samples, performance.now());
      const next = canceled ? ended.start : projectedDrawerOpen(motion.state.position, velocity, width);
      suppressClickUntil = performance.now() + 350;
      settle(next, velocity);
      latest.current.onChange(next);
    };
    const begin = (kind: Drag['kind'], id: number, x: number, y: number, target: EventTarget | null) => {
      suppressClickUntil = 0;
      if (drag || !(target instanceof Element) || target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false]),[data-touch-document]')) return false;
      if (document.querySelector('[aria-modal=true]:not(#primary-navigation)')) return false;
      width = drawer.offsetWidth;
      if (width <= 0) return false;
      const position = presentation();
      const bounds = drawer.getBoundingClientRect();
      const onPresentedDrawer = position > -width + 1 && x >= Math.max(0, bounds.left) && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      const edge = Math.max(26, parseFloat(getComputedStyle(root).getPropertyValue('--safe-left')) || 0);
      if (!latest.current.open && x > edge && !onPresentedDrawer) return false;
      if (latest.current.open && !onPresentedDrawer && !target.closest('.navigation-scrim')) return false;
      cancelAnimationFrame(clearFrame);
      const velocity = motion.stop().velocity;
      motion.set(position);
      drag = { kind, id, x, y, start: latest.current.open, position, velocity, samples: [{ position: x, at: performance.now() }], active: false, capture: null };
      return true;
    };
    const move = (x: number, y: number, event: Event) => {
      if (!drag) return;
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.active) {
        const intent = drawerIntent(dx, dy, drag.position, width);
        if (intent === 'vertical' || intent === 'outward') { finish(true); return; }
        if (intent !== 'horizontal') return;
        drag.active = true;
      }
      if (event.cancelable) event.preventDefault();
      const at = performance.now();
      drag.samples.push({ position: x, at });
      while (drag.samples.length > 2 && drag.samples[1].at < at - 100) drag.samples.shift();
      drawer.removeAttribute('data-settling'); root.removeAttribute('data-drawer-settling');
      drawer.dataset.dragging = 'true'; root.dataset.drawerDragging = 'true';
      motion.set(clampDrawer(drag.position + dx, width));
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { finish(true); return; }
      const touch = event.touches[0]; begin('touch', touch.identifier, touch.clientX, touch.clientY, event.target);
    };
    const touchMove = (event: TouchEvent) => {
      if (drag?.kind !== 'touch') return;
      if (event.touches.length !== 1) { finish(true); return; }
      const touch = event.touches[0]; if (touch.identifier === drag.id) move(touch.clientX, touch.clientY, event);
    };
    const touchEnd = (event: TouchEvent) => { if (drag?.kind === 'touch') finish(event.type === 'touchcancel'); };
    const pointerStart = (event: PointerEvent) => {
      // Touch stays on its cancellable touch path, including older WebKit and document pinch.
      if (event.pointerType === 'touch' || !event.isPrimary || event.button !== 0) return;
      if (begin('pointer', event.pointerId, event.clientX, event.clientY, event.target) && event.target instanceof Element) {
        try { event.target.setPointerCapture(event.pointerId); if (drag) drag.capture = event.target; } catch { /* Window listeners still track an uncapturable target. */ }
      }
    };
    const pointerMove = (event: PointerEvent) => { if (drag?.kind === 'pointer' && drag.id === event.pointerId) move(event.clientX, event.clientY, event); };
    const pointerEnd = (event: PointerEvent) => { if (drag?.kind === 'pointer' && drag.id === event.pointerId) finish(event.type !== 'pointerup'); };
    const click = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressClickUntil) { suppressClickUntil = 0; event.preventDefault(); event.stopPropagation(); }
    };
    const resize = () => {
      if (drag) finish(true);
      const previousWidth = width;
      const position = motion.stop().position;
      width = drawer.offsetWidth;
      motion.set(previousWidth > 0 ? clampDrawer(position / previousWidth * width, width) : destination ? 0 : -width);
      settle(latest.current.open, 0);
    };
    const blur = () => { finish(true); };
    const preference = () => { if (reduced.matches && motion.running) motion.finish(); };
    synchronize.current = next => {
      if (next === destination) return;
      if (drag) { const ended = drag; drag = null; releaseCapture(ended); }
      settle(next);
    };
    window.addEventListener('touchstart', touchStart, { passive: true }); window.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('touchend', touchEnd); window.addEventListener('touchcancel', touchEnd);
    window.addEventListener('pointerdown', pointerStart); window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerEnd); window.addEventListener('pointercancel', pointerEnd); window.addEventListener('lostpointercapture', pointerEnd);
    window.addEventListener('click', click, true); window.addEventListener('resize', resize); window.addEventListener('blur', blur);
    reduced.addEventListener('change', preference);
    return () => {
      synchronize.current = null;
      if (drag) { const ended = drag; drag = null; releaseCapture(ended); }
      motion.stop(); cancelAnimationFrame(clearFrame); clear();
      window.removeEventListener('touchstart', touchStart); window.removeEventListener('touchmove', touchMove);
      window.removeEventListener('touchend', touchEnd); window.removeEventListener('touchcancel', touchEnd);
      window.removeEventListener('pointerdown', pointerStart); window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerEnd); window.removeEventListener('pointercancel', pointerEnd); window.removeEventListener('lostpointercapture', pointerEnd);
      window.removeEventListener('click', click, true); window.removeEventListener('resize', resize); window.removeEventListener('blur', blur);
      reduced.removeEventListener('change', preference);
    };
  }, [enabled]);
  useLayoutEffect(() => { synchronize.current?.(open); }, [enabled, open]);
}

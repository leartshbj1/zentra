import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createSpringMotion } from './springMotion';

/** One moving selection surface, measured from the real, scrollable menu. */
export function useNavigationSelection(ref: RefObject<HTMLElement | null>, selection: string, hidden: boolean) {
  const update = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const navigation = ref.current;
    if (!navigation || hidden) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const clock = { now: () => performance.now(), request: (callback: FrameRequestCallback) => requestAnimationFrame(callback), cancel: (frame: number) => cancelAnimationFrame(frame), reduced: () => reduced.matches };
    let initialized = false;
    let frame = 0;
    const controls = new Set<Element>();
    const rest = () => { if (!x.running && !y.running) delete navigation.dataset.selectionMoving; };
    const x = createSpringMotion(0, value => navigation.style.setProperty('--selection-x', `${value}px`), rest, clock, .24);
    const y = createSpringMotion(0, value => navigation.style.setProperty('--selection-y', `${value}px`), rest, clock, .24);
    const measure = () => {
      if (navigation.classList.contains('mobile-navigation')) document.documentElement.style.setProperty('--zentra-mobile-nav-height', `${navigation.getBoundingClientRect().height}px`);
      const active = navigation.querySelector<HTMLElement>('[aria-current]:not([aria-current="false"]), [aria-selected="true"]');
      if (!active || !active.getClientRects().length) {
        x.stop(); y.stop(); initialized = false;
        delete navigation.dataset.selectionReady; delete navigation.dataset.selectionMoving;
        return;
      }
      const bounds = navigation.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      const nextX = item.left - bounds.left + navigation.scrollLeft;
      const nextY = item.top - bounds.top + navigation.scrollTop;
      navigation.style.setProperty('--selection-height', `${item.height}px`);
      navigation.style.setProperty('--selection-width', `${item.width}px`);
      const indicator = navigation.querySelector<HTMLElement>('.sidebar__selection,.mobile-navigation__selection,.sales-tabs__selection,.section-navigation__selection');
      if (!initialized || !indicator || getComputedStyle(indicator).display === 'none') {
        x.set(nextX); y.set(nextY); initialized = true; delete navigation.dataset.selectionMoving;
      } else {
        navigation.dataset.selectionMoving = 'true';
        x.to(nextX); y.to(nextY);
        rest();
      }
      navigation.dataset.selectionReady = 'true';
    };
    update.current = measure;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    const observeControls = () => {
      const next = new Set(navigation.querySelectorAll('button,[aria-current],[role="tab"]'));
      for (const control of controls) if (!next.has(control)) { observer.unobserve(control); controls.delete(control); }
      for (const control of next) if (!controls.has(control)) { observer.observe(control); controls.add(control); }
    };
    // Reordering equal-sized shortcuts or replacing their selected state does not resize the menu.
    const changes = new MutationObserver(() => { observeControls(); schedule(); });
    changes.observe(navigation, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-current','aria-selected','class','hidden'] });
    observer.observe(navigation); observeControls();
    measure();
    const preference = () => { if (reduced.matches) { if (x.running) x.finish(); if (y.running) y.finish(); } };
    reduced.addEventListener('change', preference);
    navigation.addEventListener('scroll', schedule, true);
    return () => {
      update.current = null; observer.disconnect(); changes.disconnect(); controls.clear();
      x.stop(); y.stop(); cancelAnimationFrame(frame);
      reduced.removeEventListener('change', preference); navigation.removeEventListener('scroll', schedule, true);
      delete navigation.dataset.selectionReady; delete navigation.dataset.selectionMoving;
      if (navigation.classList.contains('mobile-navigation')) document.documentElement.style.removeProperty('--zentra-mobile-nav-height');
    };
  }, [ref, hidden]);
  useLayoutEffect(() => { update.current?.(); }, [selection, hidden]);
}

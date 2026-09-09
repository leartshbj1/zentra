import { useLayoutEffect, type RefObject } from 'react';

/** One moving selection surface, measured from the real, scrollable menu. */
export function useNavigationSelection(ref: RefObject<HTMLElement | null>, selection: string, hidden: boolean) {
  useLayoutEffect(() => {
    const navigation = ref.current;
    if (!navigation || hidden) return;
    const measure = () => {
      const active = navigation.querySelector<HTMLElement>('[aria-current]');
      if (!active) {
        delete navigation.dataset.selectionReady;
        return;
      }
      const frame = navigation.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      navigation.style.setProperty('--selection-y', `${item.top - frame.top + navigation.scrollTop}px`);
      navigation.style.setProperty('--selection-x', `${item.left - frame.left + navigation.scrollLeft}px`);
      navigation.style.setProperty('--selection-height', `${item.height}px`);
      navigation.style.setProperty('--selection-width', `${item.width}px`);
      navigation.dataset.selectionReady = 'true';
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(navigation);
    for (const child of navigation.children) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, selection, hidden]);
}

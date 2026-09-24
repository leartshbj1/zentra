import { useLayoutEffect, useRef } from 'react';

/** Animate navigation without remounting editors or moving keyboard focus. */
export function useScreenArrival(screen: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const surface = ref.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!surface?.animate || reduced.matches) return;
    const animation = surface.animate(
      [{ opacity: .72, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' },
    );
    const stop = () => { if (reduced.matches) animation.cancel(); };
    reduced.addEventListener('change', stop);
    return () => { animation.cancel(); reduced.removeEventListener('change', stop); };
  }, [screen]);
  return ref;
}

import { useLayoutEffect, useRef } from 'react';

/** Animate navigation without remounting editors or moving keyboard focus. */
export function useScreenArrival(screen: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const surface = ref.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!surface?.animate || reduced.matches) return;
    const animation = surface.animate(
      [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
      { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    const stop = () => { if (reduced.matches) animation.cancel(); };
    reduced.addEventListener('change', stop);
    return () => { animation.cancel(); reduced.removeEventListener('change', stop); };
  }, [screen]);
  return ref;
}

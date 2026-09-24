'use client';
import { useEffect } from 'react';

/** Open the relevant native disclosure when following a feature deep link. */
export function PageDisclosures() {
  useEffect(() => {
    const reveal = () => {
      let id: string;
      try {
        id = decodeURIComponent(location.hash.slice(1));
      } catch {
        return;
      }
      if (!id) return;
      const target = document.getElementById(id);
      const detail =
        target instanceof HTMLDetailsElement
          ? target
          : target?.closest('details');
      if (detail && detail.matches('[data-page-disclosure]')) {
        detail.open = true;
        requestAnimationFrame(() => target?.scrollIntoView({ block: 'start' }));
      }
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);
  return null;
}

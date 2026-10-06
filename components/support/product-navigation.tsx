'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export function SupportNavigationLinks({
  current,
  controls,
  label,
  links,
}: {
  current: string;
  controls: { previous: string; next: string };
  label: string;
  links: readonly { href: string; label: string }[];
}) {
  const frame = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const navigationId = useId();
  const [edges, setEdges] = useState({
    overflow: false,
    previous: false,
    next: false,
  });

  useEffect(() => {
    const container = frame.current,
      nav = navigation.current;
    if (!container || !nav) return;
    let animationFrame = 0,
      alive = true;
    const measure = () => {
      animationFrame = 0;
      // Compare against the whole frame so the controls cannot make themselves
      // necessary by shrinking a strip whose links would otherwise fit.
      const next = {
        overflow: nav.scrollWidth > container.clientWidth + 1,
        previous: nav.scrollLeft > 1,
        next: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1,
      };
      setEdges((previous) =>
        Object.keys(next).every(
          (key) =>
            next[key as keyof typeof next] ===
            previous[key as keyof typeof previous],
        )
          ? previous
          : next,
      );
    };
    const scheduleMeasure = () => {
      if (!animationFrame)
        animationFrame = window.requestAnimationFrame(measure);
    };
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleMeasure);
    resize?.observe(container);
    resize?.observe(nav);
    nav.querySelectorAll('a').forEach((link) => resize?.observe(link));
    const content = new MutationObserver(scheduleMeasure);
    content.observe(nav, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    nav.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure, { passive: true });
    void document.fonts.ready.then(() => {
      if (alive) scheduleMeasure();
    });
    scheduleMeasure();
    return () => {
      alive = false;
      window.cancelAnimationFrame(animationFrame);
      resize?.disconnect();
      content.disconnect();
      nav.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, []);

  const scroll = (direction: -1 | 1) => {
    const nav = navigation.current;
    if (!nav) return;
    nav.scrollBy({
      left: direction * Math.max(100, nav.clientWidth * 0.8),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  };

  return (
    <div
      className="sp-product-sections"
      ref={frame}
      data-overflow={edges.overflow}
    >
      <button
        type="button"
        className="sp-section-scroll"
        aria-label={controls.previous}
        aria-controls={navigationId}
        disabled={!edges.previous}
        onClick={() => scroll(-1)}
      >
        <ChevronLeft size={18} aria-hidden="true" />
      </button>
      <nav id={navigationId} ref={navigation} aria-label={label}>
        {links.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            aria-current={current === href ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <button
        type="button"
        className="sp-section-scroll"
        aria-label={controls.next}
        aria-controls={navigationId}
        disabled={!edges.next}
        onClick={() => scroll(1)}
      >
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

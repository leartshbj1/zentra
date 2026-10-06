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
      revealPending = false,
      alive = true;
    const revealCurrent = () => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      const viewport = nav.getBoundingClientRect();
      const selected = active.getBoundingClientRect();
      const offset =
        selected.left < viewport.left
          ? selected.left - viewport.left
          : selected.right > viewport.right
            ? selected.right - viewport.right
            : 0;
      if (Math.abs(offset) <= 1) return;
      // Change this strip only: scrollIntoView would also move the page and
      // an active link must never take focus away from the visitor.
      nav.scrollTo({
        left: Math.max(
          0,
          Math.min(nav.scrollWidth - nav.clientWidth, nav.scrollLeft + offset),
        ),
        behavior: 'auto',
      });
    };
    const measure = () => {
      animationFrame = 0;
      if (revealPending) {
        revealPending = false;
        revealCurrent();
      }
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
    const scheduleMeasure = (reveal = false) => {
      revealPending ||= reveal;
      if (!animationFrame)
        animationFrame = window.requestAnimationFrame(measure);
    };
    const onScroll = () => scheduleMeasure();
    const onResize = () => scheduleMeasure(true);
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(onResize);
    resize?.observe(container);
    resize?.observe(nav);
    nav.querySelectorAll('a').forEach((link) => resize?.observe(link));
    const content = new MutationObserver(onResize);
    content.observe(nav, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    nav.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    void document.fonts.ready.then(() => {
      if (alive) scheduleMeasure(true);
    });
    scheduleMeasure(true);
    return () => {
      alive = false;
      window.cancelAnimationFrame(animationFrame);
      resize?.disconnect();
      content.disconnect();
      nav.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [current]);

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

'use client';

import { useEffect, useRef } from 'react';

export function ScrollExperience() {
  const progressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const observed = new Set<Element>();
    let frame = 0;

    const reveal = (element: Element) => element.classList.add('is-visible');
    const observer = reduceMotion
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              reveal(entry.target);
              observer?.unobserve(entry.target);
            }
          },
          { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
        );

    const register = (scope: Document | Element = document) => {
      for (const element of scope.querySelectorAll('[data-reveal]')) {
        if (observed.has(element)) continue;
        observed.add(element);
        if (reduceMotion) reveal(element);
        else observer?.observe(element);
      }
    };

    const updateProgress = () => {
      frame = 0;
      const maximum =
        document.documentElement.scrollHeight - window.innerHeight;
      const progress =
        maximum > 0 ? Math.min(1, Math.max(0, window.scrollY / maximum)) : 0;
      if (progressRef.current)
        progressRef.current.style.transform = `scaleX(${progress})`;
    };

    const requestProgressUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateProgress);
    };

    root.classList.add('motion-ready');
    register();
    updateProgress();

    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[data-reveal]') && !observed.has(node)) {
            observed.add(node);
            if (reduceMotion) reveal(node);
            else observer?.observe(node);
          }
          register(node);
        }
      }
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', requestProgressUpdate, { passive: true });
    window.addEventListener('resize', requestProgressUpdate, { passive: true });

    return () => {
      root.classList.remove('motion-ready');
      mutationObserver.disconnect();
      observer?.disconnect();
      window.removeEventListener('scroll', requestProgressUpdate);
      window.removeEventListener('resize', requestProgressUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="scroll-progress print-hidden" aria-hidden="true">
      <span ref={progressRef} />
    </div>
  );
}

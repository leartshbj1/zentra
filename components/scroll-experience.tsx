'use client';

import { useEffect, useRef } from 'react';

export function ScrollExperience() {
  const progressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const reducedMotionQuery = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    );
    const finePointerQuery = window.matchMedia(
      '(hover: hover) and (pointer: fine)',
    );
    const reduceMotion = reducedMotionQuery.matches;
    const observed = new Set<Element>();
    const depthTargets = new Set<HTMLElement>();
    let frame = 0;
    let pointerFrame = 0;
    let pointerX = 0;
    let pointerY = 0;

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
      for (const element of scope.querySelectorAll<HTMLElement>(
        '[data-pointer-depth]',
      )) {
        depthTargets.add(element);
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
      root.classList.toggle('site-scrolled', window.scrollY > 14);
    };

    const requestProgressUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateProgress);
    };

    const updatePointerDepth = () => {
      pointerFrame = 0;
      for (const target of depthTargets) {
        if (!target.isConnected) {
          depthTargets.delete(target);
          continue;
        }
        const bounds = target.getBoundingClientRect();
        const inside =
          pointerX >= bounds.left &&
          pointerX <= bounds.right &&
          pointerY >= bounds.top &&
          pointerY <= bounds.bottom;
        const x = inside
          ? Math.max(
              -1,
              Math.min(1, ((pointerX - bounds.left) / bounds.width) * 2 - 1),
            )
          : 0;
        const y = inside
          ? Math.max(
              -1,
              Math.min(1, ((pointerY - bounds.top) / bounds.height) * 2 - 1),
            )
          : 0;
        target.style.setProperty('--pointer-x', x.toFixed(3));
        target.style.setProperty('--pointer-y', y.toFixed(3));
        target.style.setProperty(
          '--pointer-rotate-x',
          `${(-y * 1.7).toFixed(3)}deg`,
        );
        target.style.setProperty(
          '--pointer-rotate-y',
          `${(x * 2.15).toFixed(3)}deg`,
        );
        target.style.setProperty(
          '--pointer-light-x',
          `${(50 + x * 24).toFixed(2)}%`,
        );
        target.style.setProperty(
          '--pointer-light-y',
          `${(42 + y * 18).toFixed(2)}%`,
        );
      }
    };

    const requestPointerUpdate = (event: PointerEvent) => {
      if (reduceMotion || !finePointerQuery.matches) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (pointerFrame) return;
      pointerFrame = window.requestAnimationFrame(updatePointerDepth);
    };

    const resetPointerDepth = () => {
      for (const target of depthTargets) {
        target.style.setProperty('--pointer-x', '0');
        target.style.setProperty('--pointer-y', '0');
        target.style.setProperty('--pointer-rotate-x', '0deg');
        target.style.setProperty('--pointer-rotate-y', '0deg');
        target.style.setProperty('--pointer-light-x', '50%');
        target.style.setProperty('--pointer-light-y', '42%');
      }
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
          if (node.matches('[data-pointer-depth]')) {
            depthTargets.add(node as HTMLElement);
          }
          register(node);
        }
      }
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', requestProgressUpdate, { passive: true });
    window.addEventListener('resize', requestProgressUpdate, { passive: true });
    window.addEventListener('pointermove', requestPointerUpdate, {
      passive: true,
    });
    window.addEventListener('blur', resetPointerDepth);

    return () => {
      root.classList.remove('motion-ready');
      root.classList.remove('site-scrolled');
      mutationObserver.disconnect();
      observer?.disconnect();
      window.removeEventListener('scroll', requestProgressUpdate);
      window.removeEventListener('resize', requestProgressUpdate);
      window.removeEventListener('pointermove', requestPointerUpdate);
      window.removeEventListener('blur', resetPointerDepth);
      if (frame) window.cancelAnimationFrame(frame);
      if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
      resetPointerDepth();
    };
  }, []);

  return (
    <div className="scroll-progress print-hidden" aria-hidden="true">
      <span ref={progressRef} />
    </div>
  );
}

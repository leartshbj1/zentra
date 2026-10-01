'use client';

import { useEffect, useRef } from 'react';

/** A critically damped spring that keeps its position and velocity on reversal. */
export function useAppleMenuMotion(open: boolean) {
  const panel = useRef<HTMLDivElement>(null);
  const spring = useRef({ position: 0, velocity: 0, target: 0 });

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const state = spring.current;
    state.target = open ? 1 : 0;
    let frame = 0;
    let previous = performance.now();

    const paint = () => {
      const position = Math.max(0, Math.min(1, state.position));
      element.style.opacity = String(position);
      element.style.transform = preference.matches
        ? 'none'
        : `translateY(${(position - 1) * 14}px)`;
      element.style.clipPath = preference.matches
        ? 'none'
        : `inset(0 0 ${(1 - position) * 100}% 0)`;
    };

    const finish = () => {
      state.position = state.target;
      state.velocity = 0;
      paint();
      element.hidden = state.target === 0;
    };

    const tick = (now: number) => {
      // Bound long frames; integrate in small steps to remain stable after tab suspension.
      let remaining = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      while (remaining > 0) {
        const dt = Math.min(remaining, 1 / 120);
        const acceleration =
          420 * (state.target - state.position) - 41 * state.velocity;
        state.velocity += acceleration * dt;
        state.position += state.velocity * dt;
        remaining -= dt;
      }
      paint();
      if (
        Math.abs(state.target - state.position) < 0.001 &&
        Math.abs(state.velocity) < 0.01
      )
        finish();
      else frame = window.requestAnimationFrame(tick);
    };

    const motionChanged = () => {
      if (!preference.matches) return;
      window.cancelAnimationFrame(frame);
      finish();
    };

    element.hidden = false;
    if (
      preference.matches ||
      (state.position === state.target && state.velocity === 0)
    )
      finish();
    else frame = window.requestAnimationFrame(tick);
    preference.addEventListener('change', motionChanged);
    return () => {
      window.cancelAnimationFrame(frame);
      preference.removeEventListener('change', motionChanged);
    };
  }, [open]);
  return panel;
}

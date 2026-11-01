import { useReducedMotion } from 'motion/react';
import { releaseHistory } from './appReleaseNotes';

declare const __ZENTRA_PLATFORM__: string;

/** iPhone and iPad, including an iPad that reports itself as a Mac, and the iOS build itself. */
export const appleTouch = (typeof __ZENTRA_PLATFORM__ !== 'undefined' && __ZENTRA_PLATFORM__ === 'ios')
  || (typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)));

// Startup guard. When the iOS web view dies, the app reloads the page, so a page that kills it
// restarts in a loop (1.90.58, 1.90.62). Each start is noted here and cleared once the app has
// stayed open for a while. Two short-lived starts in a row turn the animations off for the rest
// of this version; a new version gets its chance again.
const bootKey = 'zentra.boot.v1';
const settledAfterMs = 20_000;
const strikesForCalm = 2;
const version = releaseHistory[0]?.version ?? '';
type BootRecord = { open: boolean; strikes: number; calmVersion?: string };

function readBoot(): BootRecord {
  try {
    const value = JSON.parse(localStorage.getItem(bootKey) ?? 'null') as Partial<BootRecord> | null;
    return { open: value?.open === true, strikes: Math.max(0, Number(value?.strikes) || 0), calmVersion: typeof value?.calmVersion === 'string' ? value.calmVersion : undefined };
  } catch { return { open: false, strikes: 0 }; }
}
function writeBoot(record: BootRecord) {
  try { localStorage.setItem(bootKey, JSON.stringify(record)); } catch { /* Without storage the guard simply stays off. */ }
}

const previous = typeof window === 'undefined' ? { open: false, strikes: 0 } : readBoot();
/** Number of starts in a row that ended before the app settled, this one excluded. */
export const unfinishedStarts = previous.open ? previous.strikes + 1 : 0;
/** Animations are off: the app did not survive its last starts in this version. */
export const calmStart = previous.calmVersion === version || unfinishedStarts >= strikesForCalm;

/** Called once at startup, before the first render. */
export function installStartupGuard() {
  if (typeof window === 'undefined') return;
  const calmVersion = calmStart ? version : undefined;
  writeBoot({ open: true, strikes: unfinishedStarts, calmVersion });
  if (calmStart) document.documentElement.dataset.calmStart = 'true';
  window.setTimeout(() => writeBoot({ open: false, strikes: 0, calmVersion }), settledAfterMs);
}

/** The brand intro (masked title, WebGL button) stays plain where it could cost the web view. */
export const plainIntro = appleTouch || calmStart;

/** Reduced motion for the React Bits controls: the system setting, or a calm start. */
export function useCalmMotion() {
  return useReducedMotion() || calmStart;
}

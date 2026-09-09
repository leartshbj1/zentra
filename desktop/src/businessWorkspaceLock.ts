import type { BusinessInstallationLock } from './businessCycleSession';

type Entry = { error: unknown; retry?: () => Promise<void> };
const locks = new Set<Entry>();
const subscribers = new Set<() => void>();
const roots = new Map<HTMLElement, boolean>();
let observer: MutationObserver | undefined;
let previousFocus: HTMLElement | null = null;
let snapshot: { locked: boolean; error?: unknown; retry?: () => Promise<void> } = { locked: false };
export const businessWorkspaceLocked = () => locks.size > 0;
export const businessLockSnapshot = () => snapshot;
export function subscribeBusinessLock(callback: () => void) {
  subscribers.add(callback);
  return () => { subscribers.delete(callback); };
}
function publish() {
  const failed = [...locks].find(entry => entry.retry);
  snapshot = { locked: locks.size > 0, error: failed?.error, retry: failed?.retry };
  subscribers.forEach(callback => callback());
}
function protectRoots() {
  document.querySelectorAll<HTMLElement>('.desktop-app').forEach(root => {
    if (!roots.has(root)) roots.set(root, root.inert);
    root.inert = true;
  });
}
const events = ['click', 'pointerdown', 'keydown', 'beforeinput', 'submit', 'drop', 'focusin'] as const;
function preventInteraction(event: Event) {
  if (event.target instanceof Element && event.target.closest('[data-business-install-overlay]')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
export function acquireBusinessWorkspaceLock(): BusinessInstallationLock {
  const entry: Entry = { error: undefined };
  if (!locks.size) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    protectRoots();
    observer = new MutationObserver(protectRoots);
    observer.observe(document.body, { childList: true, subtree: true });
    events.forEach(event => window.addEventListener(event, preventInteraction, true));
  }
  locks.add(entry);
  publish();
  return {
    failed(error, retry) { if (locks.has(entry)) { entry.error = error; entry.retry = retry; publish(); } },
    release() {
      if (!locks.delete(entry)) return;
      if (!locks.size) {
        observer?.disconnect();
        observer = undefined;
        roots.forEach((inert, root) => { root.inert = inert; });
        roots.clear();
        events.forEach(event => window.removeEventListener(event, preventInteraction, true));
        const focus = previousFocus;
        previousFocus = null;
        if (focus?.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true });
      }
      publish();
    },
  };
}

// Child screens register drafts and asynchronous file actions that root modals
// cannot observe. The release is idempotent and does not modify any draft.
const activities = new Set<symbol>();
export const businessActivityPending = () => activities.size > 0;
export function holdBusinessActivity() {
  const id = Symbol();
  activities.add(id);
  return () => { if (activities.delete(id)) window.dispatchEvent(new Event('zentra-business-cycle-wake')); };
}

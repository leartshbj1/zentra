// A connected account can require two native network requests, each bounded
// at 30 seconds. Leave room for local storage without waiting indefinitely.
export const APP_OPEN_TIMEOUT_MS = 75_000;
export const NATIVE_READY_EVENT = 'zentra:native-ready';
const READINESS_PROBE_DELAY_MS = 1_000;
const READINESS_PROBE_TIMEOUT_MS = 3_000;

function openingTimeout() {
  return new Error(
    'L’ouverture prend trop de temps. Réessayez. Si le problème persiste, fermez puis rouvrez l’application.',
  );
}

type StartupWindow = EventTarget & {
  __TAURI_INTERNALS__?: unknown;
  __ZENTRA_NATIVE_READY__?: boolean;
};

export function waitForNativeStartup(
  target: StartupWindow = window,
  probe: () => Promise<boolean> = () => invoke<boolean>('is_native_ready'),
): Promise<void> {
  // Browser fixtures have no native lifecycle. In Tauri, the native side sets
  // this flag only after managing LocalStore and finishing the document load.
  if (!target.__TAURI_INTERNALS__ || target.__ZENTRA_NATIVE_READY__ === true) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearTimeout(probeTimer);
      target.removeEventListener(NATIVE_READY_EVENT, ready);
    };
    const ready = () => {
      if (target.__ZENTRA_NATIVE_READY__ !== true) return;
      cleanup();
      resolve();
    };
    const scheduleProbe = () => {
      if (!finished) retryTimer = setTimeout(checkReadiness, READINESS_PROBE_DELAY_MS);
    };
    const checkReadiness = () => {
      if (finished) return;
      let active = true;
      // A page-load notification or an early IPC response can be missed.
      // Only this read-only readiness check is retried, within the total limit.
      probeTimer = setTimeout(() => {
        active = false;
        scheduleProbe();
      }, READINESS_PROBE_TIMEOUT_MS);
      const settle = (confirmed: boolean) => {
        if (!active || finished) return;
        active = false;
        clearTimeout(probeTimer);
        if (confirmed === true) {
          target.__ZENTRA_NATIVE_READY__ = true;
          target.dispatchEvent(new Event(NATIVE_READY_EVENT));
        } else {
          scheduleProbe();
        }
      };
      void Promise.resolve().then(probe).then(settle, () => settle(false));
    };
    const timer = setTimeout(() => { cleanup(); reject(openingTimeout()); }, APP_OPEN_TIMEOUT_MS);
    target.addEventListener(NATIVE_READY_EVENT, ready);
    scheduleProbe();
  });
}

export function withinAppOpeningDeadline<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(openingTimeout());
    }, APP_OPEN_TIMEOUT_MS);

    // Settling the wrapper also prevents a late response from changing the
    // result of an expired attempt. The native request itself is not cancelled.
    request.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
import { invoke } from '@tauri-apps/api/core';

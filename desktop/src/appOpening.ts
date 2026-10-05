// Leave room for native initialization and local storage recovery without
// waiting indefinitely. Ordinary opening no longer waits for the network.
export const APP_OPEN_TIMEOUT_MS = 75_000;
export const NATIVE_READY_EVENT = 'zentra:native-ready';
const READINESS_PROBE_DELAY_MS = 1_000;
const READINESS_PROBE_TIMEOUT_MS = 3_000;
export const STARTUP_RECOVERY_REFUSAL = 'ZT-STARTUP-RECOVERY-REQUIRED';
const recoveryFailures = new WeakSet<object>();

// Presentation admission follows App's existing opening attempt. Readers cannot
// grant it, and a captured permit cannot survive a newer attempt or an unmount.
declare const openingPermit: unique symbol;
export type AppOpeningPermit = Readonly<{ [openingPermit]: true }>;
const openingListeners = new Set<() => void>();
const browserContext = {};
let openingContext: unknown;
let openingGeneration = 0;
let openingPermitValue: AppOpeningPermit | null = null;
let openingRecoveryFailure: Error | null = null;
function currentOpeningContext(): unknown {
  return typeof window === 'undefined' ? browserContext : (window as StartupWindow).__TAURI_INTERNALS__ ?? window;
}
export function subscribeAppOpening(listener: () => void) {
  openingListeners.add(listener);
  return () => { openingListeners.delete(listener); };
}
export function getAppOpeningPermit(): AppOpeningPermit | null {
  return openingContext === currentOpeningContext() ? openingPermitValue : null;
}
export function isAppOpeningPermitCurrent(permit: AppOpeningPermit | null): boolean {
  return permit !== null && permit === getAppOpeningPermit();
}
function notifyOpeningReaders() { for (const listener of openingListeners) listener(); }

export function beginAppOpeningAttempt() {
  const context = currentOpeningContext();
  if (openingContext !== context) {
    openingContext = context;
    openingRecoveryFailure = null;
  }
  const generation = ++openingGeneration;
  openingPermitValue = null;
  let active = true;
  let nativeConfirmed = false;
  const ownsAttempt = () => active && generation === openingGeneration && context === currentOpeningContext();
  notifyOpeningReaders();
  return {
    async waitForNativeStartup() {
      if (openingRecoveryFailure) throw openingRecoveryFailure;
      try { await waitForNativeStartup(); }
      catch (reason) {
        // A genuine refusal remains closed for this native lifecycle, including
        // when StrictMode has already replaced the owning presentation attempt.
        if (context === currentOpeningContext() && isStartupRecoveryFailure(reason)) {
          openingRecoveryFailure = reason;
          openingPermitValue = null;
          notifyOpeningReaders();
        }
        throw reason;
      }
      if (ownsAttempt()) nativeConfirmed = true;
    },
    complete() {
      if (!ownsAttempt() || !nativeConfirmed || openingRecoveryFailure) return;
      openingPermitValue = Object.freeze({}) as AppOpeningPermit;
      notifyOpeningReaders();
    },
    fail(reason: unknown) {
      if (!ownsAttempt()) return;
      openingPermitValue = null;
      if (isStartupRecoveryFailure(reason)) openingRecoveryFailure = reason;
      notifyOpeningReaders();
    },
    cancel() {
      if (ownsAttempt()) {
        openingPermitValue = null;
        notifyOpeningReaders();
      }
      active = false;
    },
  };
}

// The mark is created only for the exact primitive refusal from this probe.
// An Error/object/cause carrying the same text is not an admitted startup state.
export function isStartupRecoveryFailure(reason: unknown): reason is Error {
  return typeof reason === 'object' && reason !== null && recoveryFailures.has(reason);
}

function startupRecoveryFailure() {
  const error = new Error(STARTUP_RECOVERY_REFUSAL);
  recoveryFailures.add(error);
  return error;
}

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
      void Promise.resolve().then(probe).then(settle, (reason: unknown) => {
        if (!active || finished) return;
        if (typeof reason === 'string' && reason === STARTUP_RECOVERY_REFUSAL) {
          active = false;
          cleanup();
          reject(startupRecoveryFailure());
        } else {
          settle(false);
        }
      });
    };
    const timer = setTimeout(() => { cleanup(); reject(openingTimeout()); }, APP_OPEN_TIMEOUT_MS);
    target.addEventListener(NATIVE_READY_EVENT, ready);
    checkReadiness();
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
import { diagnosticInvoke as invoke } from './diagnostics';

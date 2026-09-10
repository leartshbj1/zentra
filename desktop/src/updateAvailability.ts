import { desktopApi } from './bridge';
import type { SecureUpdateMetadata } from './types';

let available: SecureUpdateMetadata | null = null;
let inFlight: Promise<SecureUpdateMetadata | null> | null = null;
let lastAttempt = Number.NEGATIVE_INFINITY;
let pauses = 0;
const listeners = new Set<() => void>();
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

export const getAvailableUpdate = () => available;
export function subscribeToUpdates(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clearAvailableUpdate() {
  available = null;
  for (const listener of listeners) listener();
}
function publish(value: SecureUpdateMetadata | null) {
  available = value;
  for (const listener of listeners) listener();
  return value;
}
/** The updater panel owns native pending-update state until it closes. */
export function pauseBackgroundUpdateChecks() {
  pauses++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      pauses--;
    }
  };
}
export function checkUpdateAvailability(
  manual = false,
): Promise<SecureUpdateMetadata | null> {
  if (inFlight) return inFlight;
  if (
    !manual &&
    (pauses > 0 ||
      Date.now() - lastAttempt < 60_000 ||
      (typeof navigator !== 'undefined' && navigator.onLine === false))
  )
    return Promise.resolve(available);
  lastAttempt = Date.now();
  inFlight = (async () => {
    const policy = await desktopApi.getSecureUpdatePolicy();
    if (!policy.enabled) return publish(null);
    return publish(await desktopApi.checkSecureUpdate());
  })().finally(() => {
    inFlight = null;
  });
  // A failed/offline check preserves a previously confirmed update.
  return inFlight;
}

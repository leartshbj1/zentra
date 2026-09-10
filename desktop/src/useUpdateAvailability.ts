import { useEffect, useSyncExternalStore } from 'react';
import {
  checkUpdateAvailability,
  getAvailableUpdate,
  subscribeToUpdates,
  UPDATE_CHECK_INTERVAL_MS,
} from './updateAvailability';

export function useUpdateAvailability() {
  const available = useSyncExternalStore(
    subscribeToUpdates,
    getAvailableUpdate,
    () => null,
  );
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'hidden')
        void checkUpdateAvailability().catch(() => {
          /* Manual check explains failures; offline work remains available. */
        });
    };
    const first = window.setTimeout(check, 12_000);
    const interval = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      window.removeEventListener('online', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return available;
}

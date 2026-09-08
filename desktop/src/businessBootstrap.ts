import { useEffect } from 'react';
import { desktopApi } from './bridge';
import { startBusinessBootstrapScheduler } from './businessBootstrapScheduler';
import {
  BUSINESS_HISTORY_STATUS,
  BUSINESS_HISTORY_ERROR,
} from './businessHistoryState';
import { errorMessage } from './utils';

export function useBusinessBootstrapBackground() {
  useEffect(() => {
    const sender = startBusinessBootstrapScheduler({
      synchronize: desktopApi.syncBusinessBootstrap,
      isOnline: () => navigator.onLine !== false,
      onStatus: (status) =>
        window.dispatchEvent(
          new CustomEvent(BUSINESS_HISTORY_STATUS, { detail: status }),
        ),
      onError: (reason) =>
        window.dispatchEvent(
          new CustomEvent(BUSINESS_HISTORY_ERROR, {
            detail: errorMessage(
              reason,
              'L’envoi est interrompu. Vous pouvez reprendre la publication.',
            ),
          }),
        ),
    });
    const wake = () => sender.wake();
    const visible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('zentra-business-bootstrap-changed', wake);
    document.addEventListener('visibilitychange', visible);
    return () => {
      sender.stop();
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('zentra-business-bootstrap-changed', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
}

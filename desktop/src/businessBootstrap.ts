import { useEffect } from 'react';
import { desktopApi } from './bridge';
import { startBusinessBootstrapScheduler } from './businessBootstrapScheduler';

export function useBusinessBootstrapBackground() {
  useEffect(() => {
    const sender = startBusinessBootstrapScheduler({
      synchronize: desktopApi.syncBusinessBootstrap,
      isOnline: () => navigator.onLine !== false,
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

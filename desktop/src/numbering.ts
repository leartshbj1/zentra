import { useEffect } from 'react';
import { desktopApi } from './bridge';
import { BUSINESS_HISTORY_CHANGED, BUSINESS_HISTORY_STATUS } from './businessHistoryState';
import { startNumberingScheduler } from './numberingScheduler';
import { errorMessage } from './utils';

export const NUMBERING_STATUS = 'zentra-numbering-status';
export function useNumberingBackground() {
  useEffect(() => {
    const scheduler = startNumberingScheduler({
      replenish: desktopApi.replenishDocumentNumbers,
      isOnline: () => navigator.onLine !== false,
      onStatus: status => window.dispatchEvent(new CustomEvent(NUMBERING_STATUS, { detail: status })),
      onError: reason => window.dispatchEvent(new CustomEvent(NUMBERING_STATUS, {
        detail: { state: 'error', message: errorMessage(reason, 'La préparation des numéros reprendra automatiquement.') },
      })),
    });
    const wake = () => scheduler.wake();
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    const published = (event: Event) => {
      if ((event as CustomEvent).detail?.state === 'history_installed') wake();
    };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('zentra-project-documents-changed', wake);
    window.addEventListener(BUSINESS_HISTORY_CHANGED, wake);
    window.addEventListener(BUSINESS_HISTORY_STATUS, published);
    document.addEventListener('visibilitychange', visible);
    return () => {
      scheduler.stop();
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('zentra-project-documents-changed', wake);
      window.removeEventListener(BUSINESS_HISTORY_CHANGED, wake);
      window.removeEventListener(BUSINESS_HISTORY_STATUS, published);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
}

import { useEffect, useRef } from 'react';
import { desktopApi } from './bridge';
import { errorMessage } from './utils';

export type CloudBackup = {
  backup_id: string;
  installation_id: string;
  app_version: string;
  size_bytes: number;
  state: 'uploading' | 'complete' | 'deleting';
  created_at: string;
  completed_at: string | null;
};
export type CloudBackupState = {
  enabled: boolean;
  connected?: boolean;
  organization_id?: string | null;
  account_organization_id?: string;
  last_success_at?: string | null;
  last_error?: string | null;
  pending_id?: string | null;
  running?: boolean;
  error?: string;
  backups?: CloudBackup[];
};
export const CLOUD_BACKUP_CHANGED = 'zentra-cloud-backup-changed';
export function useCloudBackupBackground(onError?: (message: string) => void) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    let active = true,
      running = false;
    let lastError = '';
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (active) timer = setTimeout(() => void tick(), delay);
    };
    async function tick() {
      if (!active || running) return;
      if (navigator.onLine === false) {
        schedule(300_000);
        return;
      }
      running = true;
      try {
        await desktopApi.runCloudBackup(false);
        lastError = '';
      } catch (reason) {
        const message = errorMessage(
          reason,
          'L’envoi sera réessayé automatiquement.',
        );
        if (active && lastError !== message)
          onErrorRef.current?.(`Sauvegarde distante : ${message}`);
        lastError = message;
      } finally {
        running = false;
        if (active) {
          window.dispatchEvent(new Event(CLOUD_BACKUP_CHANGED));
          schedule(300_000);
        }
      }
    }
    const wake = () => schedule(3_000);
    const visible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', visible);
    schedule(15_000);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
}

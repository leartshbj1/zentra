import type { SecureUpdateEvent } from './types';

export type UpdateProgressPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'installed';

export type UpdateProgressState = {
  phase: UpdateProgressPhase;
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
};

export const initialUpdaterProgress: UpdateProgressState = {
  phase: 'idle',
  downloadedBytes: 0,
  contentLength: null,
  percent: null,
};

export const updaterSteps = [
  'Recherche',
  'Téléchargement',
  'Signature',
  'Installation',
] as const;

function positiveLength(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function boundedPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

export function reduceUpdaterProgress(
  current: UpdateProgressState,
  event: SecureUpdateEvent,
): UpdateProgressState {
  if (event.event === 'preparing') {
    return { ...initialUpdaterProgress, phase: 'preparing' };
  }
  if (event.event === 'started') {
    return {
      phase: 'downloading',
      downloadedBytes: 0,
      contentLength: positiveLength(event.data.contentLength),
      percent: 0,
    };
  }
  if (event.event === 'progress') {
    const downloadedBytes = Math.max(
      current.downloadedBytes,
      Number.isFinite(event.data.downloadedBytes)
        ? Math.max(0, event.data.downloadedBytes)
        : 0,
    );
    const contentLength =
      positiveLength(event.data.contentLength) ?? current.contentLength;
    const inferredPercent = contentLength
      ? (downloadedBytes / contentLength) * 100
      : null;
    const reportedPercent = boundedPercent(event.data.percent);
    const nextPercent = boundedPercent(reportedPercent ?? inferredPercent);
    return {
      phase: 'downloading',
      downloadedBytes,
      contentLength,
      percent:
        nextPercent === null
          ? current.percent
          : Math.max(current.percent ?? 0, nextPercent),
    };
  }
  if (event.event === 'verifying') {
    return { ...current, phase: 'verifying', percent: 100 };
  }
  return { ...current, phase: 'installed', percent: 100 };
}

export function activeUpdaterStep({
  checking,
  phase,
  updateAvailable,
}: {
  checking: boolean;
  phase: UpdateProgressPhase;
  updateAvailable: boolean;
}): number {
  if (phase === 'installed') return 3;
  if (phase === 'verifying') return 2;
  if (phase === 'preparing' || phase === 'downloading') return 1;
  if (checking) return 0;
  if (updateAvailable) return 1;
  return -1;
}

export function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 octet';
  const units = ['octets', 'Ko', 'Mo', 'Go'];
  const rank = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** rank;
  return `${value.toLocaleString('fr-CH', {
    maximumFractionDigits: rank ? 1 : 0,
  })} ${units[rank]}`;
}

export function formatUpdateDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString('fr-CH');
}

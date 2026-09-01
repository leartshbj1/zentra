import { describe, expect, it } from 'vitest';
import {
  activeUpdaterStep,
  formatUpdateBytes,
  formatUpdateDate,
  initialUpdaterProgress,
  reduceUpdaterProgress,
} from './appUpdaterLogic';

describe('maintenance intégrée', () => {
  it('suit le téléchargement sans faire régresser les octets ni le pourcentage', () => {
    const started = reduceUpdaterProgress(initialUpdaterProgress, {
      event: 'started',
      data: { contentLength: 1_000 },
    });
    const halfway = reduceUpdaterProgress(started, {
      event: 'progress',
      data: {
        downloadedBytes: 500,
        contentLength: 1_000,
        percent: null,
      },
    });
    const stale = reduceUpdaterProgress(halfway, {
      event: 'progress',
      data: {
        downloadedBytes: 400,
        contentLength: 1_000,
        percent: 40,
      },
    });
    expect(halfway.percent).toBe(50);
    expect(stale.downloadedBytes).toBe(500);
    expect(stale.percent).toBe(50);
  });

  it('distingue vérification de signature et remise à Windows', () => {
    const verifying = reduceUpdaterProgress(initialUpdaterProgress, {
      event: 'verifying',
    });
    const installed = reduceUpdaterProgress(verifying, { event: 'installed' });
    expect(verifying.phase).toBe('verifying');
    expect(activeUpdaterStep({ checking: false, phase: verifying.phase, updateAvailable: true })).toBe(2);
    expect(installed.phase).toBe('installed');
    expect(activeUpdaterStep({ checking: false, phase: installed.phase, updateAvailable: false })).toBe(3);
    expect(activeUpdaterStep({ checking: false, phase: 'idle', updateAvailable: true })).toBe(1);
  });

  it('formate les tailles et refuse une date de manifeste invalide', () => {
    expect(formatUpdateBytes(1_572_864)).toBe('1,5 Mo');
    expect(formatUpdateDate('date-invalide')).toBeNull();
    expect(formatUpdateDate('2026-09-01T08:00:00Z')).not.toBeNull();
  });
});

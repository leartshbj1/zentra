import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_OPEN_TIMEOUT_MS } from './appOpening';
import type { CloudAccountState } from './bridge';
import {
  CLOUD_ACCESS_REVALIDATION_INTERVAL_MS,
  cloudAccountChangeNeedsFullRevalidation,
  createSingleFlightCloudAccessRevalidator,
  readRevalidatedCloudAccess,
} from './cloudAccessRevalidation';
import type { LicenseState } from './types';

const connectedAccount: CloudAccountState = {
  status: 'connected',
  organizationId: 'org-1',
  organizationName: 'Atelier Zentra',
  role: 'owner',
  sessionExpiresAt: '2026-10-02T10:00:00Z',
};

const ownerLicense: LicenseState = {
  enforcementConfigured: true,
  status: 'valid',
  readOnly: false,
  canRefresh: true,
  plan: 'zentra-monthly-50-chf',
  priceChfCents: 5_000,
  licenseId: 'lic-1',
  customerName: 'Atelier Zentra',
  accessRole: 'owner',
  validFrom: '2026-09-01',
  validUntil: '2026-10-02',
  verifiedAt: '2026-09-02T10:00:00Z',
  lastSeenDate: '2026-09-02',
  reason: '',
  installationId: '55af29dd-fdaa-4993-ae78-17f9ca220e51',
  tokenVersion: 2,
};

afterEach(() => { vi.useRealTimers(); });

describe('revalidation périodique du compte cloud', () => {
  it('utilise un intervalle raisonnable sans contrôle agressif', () => {
    expect(CLOUD_ACCESS_REVALIDATION_INTERVAL_MS).toBe(15 * 60 * 1_000);
  });

  it('ignore deux minutes de polls pending et revalide exactement à la transition connectée', () => {
    const pending: CloudAccountState = {
      status: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUri:
        'https://elyko.alb-leart1.chatgpt.site/appareil?code=ABCD-EFGH',
      authorizationExpiresAt: '2026-09-04T12:00:00Z',
      intervalSeconds: 3,
    };
    // Le poll minimal est de trois secondes : quarante réponses pending
    // reproduisent la fenêtre de deux minutes signalée sur macOS.
    const pendingPolls = Array.from({ length: 40 }, () => pending);
    const changes = [...pendingPolls, connectedAccount];

    expect(pendingPolls.some(cloudAccountChangeNeedsFullRevalidation)).toBe(
      false,
    );
    expect(changes.filter(cloudAccountChangeNeedsFullRevalidation)).toEqual([
      connectedAccount,
    ]);
  });

  it('renouvelle immédiatement la licence quand le rôle serveur change', async () => {
    const accountantLicense: LicenseState = {
      ...ownerLicense,
      accessRole: 'accountant',
    };
    const api = {
      getCloudAccountState: vi.fn().mockResolvedValue({
        ...connectedAccount,
        role: 'accountant' as const,
      }),
      getLicenseState: vi.fn().mockResolvedValue(ownerLicense),
      refreshLicense: vi.fn().mockResolvedValue(accountantLicense),
    };

    await expect(readRevalidatedCloudAccess(api)).resolves.toEqual({
      account: { ...connectedAccount, role: 'accountant' },
      license: accountantLicense,
    });
    expect(api.refreshLicense).toHaveBeenCalledWith(false);
  });

  it('relit l’état local bloqué si le renouvellement du nouveau rôle échoue', async () => {
    const invalidLicense: LicenseState = {
      ...ownerLicense,
      status: 'invalid',
      readOnly: true,
      reason: 'Activation non reconnue.',
    };
    const api = {
      getCloudAccountState: vi.fn().mockResolvedValue({
        ...connectedAccount,
        role: 'read_only' as const,
      }),
      getLicenseState: vi
        .fn()
        .mockResolvedValueOnce(ownerLicense)
        .mockResolvedValueOnce(invalidLicense),
      refreshLicense: vi.fn().mockRejectedValue(new Error('réseau coupé')),
    };

    const result = await readRevalidatedCloudAccess(api);
    expect(result.license).toEqual(invalidLicense);
    expect(api.getLicenseState).toHaveBeenCalledTimes(2);
  });

  it('réactive le bail après régularisation même si le rôle ne change pas', async () => {
    const inactiveLicense: LicenseState = {
      ...ownerLicense,
      status: 'inactive',
      readOnly: true,
      reason: 'Abonnement inactif.',
    };
    const api = {
      getCloudAccountState: vi.fn().mockResolvedValue(connectedAccount),
      getLicenseState: vi.fn().mockResolvedValue(inactiveLicense),
      refreshLicense: vi.fn().mockResolvedValue(ownerLicense),
    };

    await expect(readRevalidatedCloudAccess(api)).resolves.toEqual({
      account: connectedAccount,
      license: ownerLicense,
    });
    expect(api.refreshLicense).toHaveBeenCalledWith(false);
  });

  it('conserve le bail signé renvoyé par le cache lors d’une panne réseau', async () => {
    const api = {
      getCloudAccountState: vi.fn().mockResolvedValue(connectedAccount),
      getLicenseState: vi.fn().mockResolvedValue(ownerLicense),
      refreshLicense: vi.fn(),
    };

    await expect(readRevalidatedCloudAccess(api)).resolves.toEqual({
      account: connectedAccount,
      license: ownerLicense,
    });
    expect(api.refreshLicense).not.toHaveBeenCalled();
  });

  it('fusionne les contrôles concurrents puis autorise le cycle suivant', async () => {
    let release: ((value: CloudAccountState) => void) | undefined;
    const accountPromise = new Promise<CloudAccountState>((resolve) => {
      release = resolve;
    });
    const api = {
      getCloudAccountState: vi
        .fn()
        .mockReturnValueOnce(accountPromise)
        .mockResolvedValue(connectedAccount),
      getLicenseState: vi.fn().mockResolvedValue(ownerLicense),
      refreshLicense: vi.fn(),
    };
    const revalidate = createSingleFlightCloudAccessRevalidator(api);

    const first = revalidate();
    const concurrent = revalidate();
    expect(concurrent).toBe(first);
    expect(api.getCloudAccountState).toHaveBeenCalledTimes(0);

    await Promise.resolve();
    expect(api.getCloudAccountState).toHaveBeenCalledTimes(1);
    release?.(connectedAccount);
    await Promise.all([first, concurrent]);

    await revalidate();
    expect(api.getCloudAccountState).toHaveBeenCalledTimes(2);
  });

  it('autorise un nouvel essai après blocage et garde le nouveau contrôle partagé malgré une ancienne réponse', async () => {
    vi.useFakeTimers();
    let finishOld!: (value: CloudAccountState) => void;
    let finishNew!: (value: CloudAccountState) => void;
    const api = {
      getCloudAccountState: vi.fn()
        .mockReturnValueOnce(new Promise<CloudAccountState>((resolve) => { finishOld = resolve; }))
        .mockReturnValueOnce(new Promise<CloudAccountState>((resolve) => { finishNew = resolve; })),
      getLicenseState: vi.fn().mockResolvedValue(ownerLicense),
      refreshLicense: vi.fn(),
    };
    const revalidate = createSingleFlightCloudAccessRevalidator(api);
    const first = revalidate();
    const expired = expect(first).rejects.toThrow('L’ouverture prend trop de temps');
    await vi.advanceTimersByTimeAsync(APP_OPEN_TIMEOUT_MS);
    await expired;

    const retry = revalidate();
    await Promise.resolve();
    expect(api.getCloudAccountState).toHaveBeenCalledTimes(2);
    finishOld(connectedAccount);
    await vi.advanceTimersByTimeAsync(0);
    expect(revalidate()).toBe(retry);
    finishNew({ ...connectedAccount, role: 'read_only' });
    api.refreshLicense.mockResolvedValue({ ...ownerLicense, accessRole: 'read_only', readOnly: true });
    await expect(retry).resolves.toMatchObject({
      account: { role: 'read_only' },
      license: { accessRole: 'read_only', readOnly: true },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

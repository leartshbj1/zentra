import type { CloudAccountState } from './bridge';
import type { LicenseState } from './types';

export const CLOUD_ACCESS_REVALIDATION_INTERVAL_MS = 15 * 60 * 1_000;

export type CloudAccessSnapshot = {
  account: CloudAccountState;
  license: LicenseState;
};

export function cloudAccountChangeNeedsFullRevalidation(
  account: CloudAccountState,
): boolean {
  // Le panneau publie le même état pending à chaque poll court. Le backend
  // a déjà validé cet état et le garder ici évite de relire la licence et le
  // compte protégés jusqu'à une vraie transition.
  return account.status !== 'pending';
}

type CloudAccessApi = {
  getCloudAccountState: () => Promise<CloudAccountState>;
  getLicenseState: () => Promise<LicenseState>;
  refreshLicense: (automatic?: boolean) => Promise<LicenseState>;
};

export async function readRevalidatedCloudAccess(
  api: CloudAccessApi,
): Promise<CloudAccessSnapshot> {
  const account = await api.getCloudAccountState();
  let license = await api.getLicenseState();

  if (
    account.status === 'connected' &&
    account.role &&
    (license.accessRole !== account.role || license.status !== 'valid')
  ) {
    try {
      license = await api.refreshLicense(false);
    } catch {
      // Le serveur a déjà invalidé l'ancien rôle dans l'ancre locale. Relire
      // cet état empêche de conserver en mémoire une licence devenue obsolète.
      license = await api.getLicenseState();
    }
  }

  return { account, license };
}

export function createSingleFlightCloudAccessRevalidator(
  api: CloudAccessApi,
): () => Promise<CloudAccessSnapshot> {
  let pending: Promise<CloudAccessSnapshot> | null = null;

  return () => {
    if (pending) return pending;

    const request = Promise.resolve().then(() =>
      readRevalidatedCloudAccess(api),
    );
    pending = request;
    request.then(
      () => {
        if (pending === request) pending = null;
      },
      () => {
        if (pending === request) pending = null;
      },
    );
    return request;
  };
}

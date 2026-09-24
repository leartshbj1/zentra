import type { CloudAccountState } from './bridge';
import type { LicenseState } from './types';
import { withinAppOpeningDeadline } from './appOpening';

export const CLOUD_ACCESS_REVALIDATION_INTERVAL_MS = 15 * 60 * 1_000;

export type CloudAccessSnapshot = {
  account: CloudAccountState;
  license: LicenseState;
};

export function cloudAccountChangeNeedsLicenseRefresh(
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

/** Open using the protected local session and signed licence, without any network wait. */
export async function readLocalCloudAccess(
  api: Pick<CloudAccessApi, 'getLicenseState'> & {
    getCachedCloudAccountState: () => Promise<CloudAccountState>;
  },
): Promise<CloudAccessSnapshot> {
  // Reading the account first invalidates an expired session's local licence.
  const account = await api.getCachedCloudAccountState();
  return { account, license: await api.getLicenseState() };
}

export async function readRevalidatedCloudAccess(
  api: CloudAccessApi,
): Promise<CloudAccessSnapshot> {
  const account = await api.getCloudAccountState();
  return readCloudAccessForAccount(api, account);
}

/** The native account panel has already checked or approved this session.
 * Read its signed licence without repeating /me after the completed request. */
export async function readCloudAccessForAccount(
  api: Pick<CloudAccessApi, 'getLicenseState' | 'refreshLicense'>,
  account: CloudAccountState,
): Promise<CloudAccessSnapshot> {
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
) {
  let pending: Promise<CloudAccessSnapshot> | null = null;

  const revalidate = () => {
    if (pending) return pending;

    const request = withinAppOpeningDeadline(
      Promise.resolve().then(() => readRevalidatedCloudAccess(api)),
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
  // A newly approved account must never reuse a previous account's in-flight result.
  return Object.assign(revalidate, { invalidate: () => { pending = null; } });
}

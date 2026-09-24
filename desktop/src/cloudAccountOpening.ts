import type { CloudAccountState } from './bridge';

/** Show the protected local identity first; only a native verification is
 * propagated to the application as an account transition. */
export async function loadCloudAccountPanel(
  api: {
    getCachedCloudAccountState: () => Promise<CloudAccountState>;
    getCloudAccountState: () => Promise<CloudAccountState>;
  },
  observer: {
    local: (account: CloudAccountState) => void;
    verified: (account: CloudAccountState) => void;
    failed: (reason: unknown, hasLocal: boolean) => void;
  },
) {
  let hasLocal = false;
  try {
    const account = await api.getCachedCloudAccountState();
    hasLocal = true;
    observer.local(account);
  } catch {
    // A damaged/missing local record still gets an online recovery attempt.
  }
  try {
    observer.verified(await api.getCloudAccountState());
  } catch (reason) {
    observer.failed(reason, hasLocal);
  }
}

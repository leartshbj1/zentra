import type { CloudAccountState } from './bridge';

/** Share only an in-flight native check, never a completed authorization.
 * Account mutations invalidate both before and after their native operation. */
export function createCloudAccountReader(load: () => Promise<CloudAccountState>) {
  let pending: Promise<CloudAccountState> | null = null;
  const read = () => {
    if (pending) return pending;
    const request = Promise.resolve().then(load).finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  };
  const invalidate = () => { pending = null; };
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    invalidate();
    try { return await operation(); }
    finally { invalidate(); }
  };
  return { read, invalidate, mutate };
}

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

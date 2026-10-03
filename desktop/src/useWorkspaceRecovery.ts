import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from './types';
import { errorMessage } from './utils';
import { workspaceOriginFailure } from './workspaceOrigin';

type PendingRefresh = {
  promise: Promise<Workspace | null>;
  resolve: (workspace: Workspace | null) => void;
  reject: (reason: unknown) => void;
  retry: Promise<void> | null;
  read: () => Promise<Workspace>;
  validate?: (workspace: Workspace) => void;
};

/** Wait for a read-only recovery; never retain or replay the original mutation. */
export function useWorkspaceRecovery(load: () => Promise<Workspace>) {
  const pending = useRef<PendingRefresh | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [checkingCreation, setCheckingCreation] = useState(false);
  const waitForRefresh = useCallback((cause: unknown, checkCreation = false, validate?: (workspace: Workspace) => void, readOverride?: () => Promise<Workspace>) => {
    if (pending.current) return pending.current.promise;
    let resolve!: PendingRefresh['resolve'];
    let reject!: PendingRefresh['reject'];
    const promise = new Promise<Workspace | null>((complete, fail) => { resolve = complete; reject = fail; });
    // Retain the original guarded read. The hook may receive another loader
    // after an account change; it must never replace this action's identity.
    pending.current = { promise, resolve, reject, retry: null, validate, read: readOverride ?? load };
    setCheckingCreation(checkCreation);
    setReason(errorMessage(cause, 'Les données locales sont momentanément indisponibles.'));
    return promise;
  }, [load]);
  const retry = useCallback((): Promise<void> => {
    const request = pending.current;
    if (!request) return Promise.resolve();
    if (request.retry) return request.retry;
    request.retry = Promise.resolve()
      .then(request.read)
      .then((workspace) => {
        if (pending.current !== request) return;
        request.validate?.(workspace);
        pending.current = null;
        setReason(null);
        setCheckingCreation(false);
        request.resolve(workspace);
      })
      .catch((reason) => {
          if (pending.current !== request) return;
          const originFailure = workspaceOriginFailure(reason);
          if (!originFailure) throw reason;
          // The old workspace cannot be acknowledged with this foreign read.
          // End its wait without publishing the read or replaying any mutation.
          pending.current = null;
          setReason(null);
          setCheckingCreation(false);
          request.reject(originFailure);
          return;
      })
      .finally(() => {
        request.retry = null;
      });
    return request.retry;
  }, [load]);
  const isPending = useCallback(() => pending.current !== null, []);
  useEffect(() => () => {
    const request = pending.current;
    pending.current = null;
    request?.resolve(null);
  }, []);
  return { reason, checkingCreation, waitForRefresh, retry, isPending };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from './types';
import { errorMessage } from './utils';

type PendingRefresh = {
  promise: Promise<Workspace | null>;
  resolve: (workspace: Workspace | null) => void;
  retry: Promise<void> | null;
  validate?: (workspace: Workspace) => void;
};

/** Wait for a read-only recovery; never retain or replay the original mutation. */
export function useWorkspaceRecovery(load: () => Promise<Workspace>) {
  const pending = useRef<PendingRefresh | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [checkingCreation, setCheckingCreation] = useState(false);
  const waitForRefresh = useCallback((cause: unknown, checkCreation = false, validate?: (workspace: Workspace) => void) => {
    if (pending.current) return pending.current.promise;
    let resolve!: PendingRefresh['resolve'];
    const promise = new Promise<Workspace | null>((complete) => { resolve = complete; });
    pending.current = { promise, resolve, retry: null, validate };
    setCheckingCreation(checkCreation);
    setReason(errorMessage(cause, 'Les données locales sont momentanément indisponibles.'));
    return promise;
  }, []);
  const retry = useCallback((): Promise<void> => {
    const request = pending.current;
    if (!request) return Promise.resolve();
    if (request.retry) return request.retry;
    request.retry = Promise.resolve()
      .then(load)
      .then((workspace) => {
        if (pending.current !== request) return;
        request.validate?.(workspace);
        pending.current = null;
        setReason(null);
        request.resolve(workspace);
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

export type CompanyAccountChoice = 'auto' | 'open' | 'publish';
export type CompanyAccountResolution = {
  status: 'ready' | 'create' | 'choose_remote' | 'choose_local' | 'waiting';
  organizationId: string;
  remoteAvailable?: boolean;
  changed: boolean;
};

/** Coalesce StrictMode/remounts without retaining an account response as a cache. */
export function singleFlightCompanyResolver<T>(resolve: (org: string, choice: CompanyAccountChoice) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (org: string, choice: CompanyAccountChoice) => {
    const key = JSON.stringify([org, choice]);
    const running = pending.get(key);
    if (running) return running;
    const task = Promise.resolve().then(() => resolve(org, choice)).finally(() => { pending.delete(key); });
    pending.set(key, task);
    return task;
  };
}

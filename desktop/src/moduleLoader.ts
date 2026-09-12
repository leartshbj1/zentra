/** Share a local module load between mounts. Only a failed load can be retried. */
export function createModuleLoader<T>(importModule: () => Promise<T>) {
  let resolved: T | undefined;
  let pending: Promise<T> | undefined;
  return {
    peek: () => resolved,
    load() {
      if (pending) return pending;
      pending = Promise.resolve().then(importModule).then(
        module => { resolved = module; return module; },
        error => { pending = undefined; throw error; },
      );
      return pending;
    },
  };
}

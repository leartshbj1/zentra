import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAYROLL_MODEL_LOAD_TIMEOUT_MS, payrollLocalAi } from './payrollLocalAi';

class SilentWorker {
  static instances: SilentWorker[] = [];
  terminated = false;

  constructor() {
    SilentWorker.instances.push(this);
  }

  addEventListener() {}
  postMessage() {}
  terminate() { this.terminated = true; }
}

describe('chargement du modèle IA local', () => {
  afterEach(() => {
    payrollLocalAi.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    SilentWorker.instances = [];
  });

  it('interrompt et réinitialise un téléchargement qui ne répond jamais', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', SilentWorker);

    const loading = payrollLocalAi.load();
    const rejection = expect(loading).rejects.toThrow('dépassé 15 minutes');
    await vi.advanceTimersByTimeAsync(PAYROLL_MODEL_LOAD_TIMEOUT_MS);

    await rejection;
    expect(SilentWorker.instances).toHaveLength(1);
    expect(SilentWorker.instances[0].terminated).toBe(true);
  });
});

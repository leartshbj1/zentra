import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAYROLL_ENGINE_CHECK_TIMEOUT_MS,
  PAYROLL_MODEL_LOAD_TIMEOUT_MS,
  payrollLocalAi,
} from './payrollLocalAi';

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

  it('ne crée aucun worker avant une demande explicite', () => {
    vi.stubGlobal('Worker', SilentWorker);

    expect(SilentWorker.instances).toHaveLength(0);
  });

  it('arrête une vérification locale muette au lieu de bloquer l’interface', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', SilentWorker);

    const checking = payrollLocalAi.check();
    await vi.advanceTimersByTimeAsync(PAYROLL_ENGINE_CHECK_TIMEOUT_MS);

    await expect(checking).resolves.toBe('unavailable');
    expect(SilentWorker.instances).toHaveLength(1);
    expect(SilentWorker.instances[0].terminated).toBe(true);
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAYROLL_ANALYSIS_STALL_TIMEOUT_MS,
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

type ControlledWorkerListener = (event: {
  data?: Record<string, unknown>;
  message?: string;
}) => void;

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  terminated = false;
  posted: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, ControlledWorkerListener[]>();

  constructor() {
    ControlledWorker.instances.push(this);
  }

  addEventListener(type: string, listener: ControlledWorkerListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: Record<string, unknown>) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emitMessage(data: Record<string, unknown>) {
    this.listeners.get('message')?.forEach((listener) => listener({ data }));
  }

  emitError(message: string) {
    this.listeners.get('error')?.forEach((listener) => listener({ message }));
  }
}

describe('chargement du modèle IA local', () => {
  afterEach(() => {
    payrollLocalAi.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    SilentWorker.instances = [];
    ControlledWorker.instances = [];
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

  it('ignore les messages retardés d’un worker annulé après une reprise', async () => {
    vi.stubGlobal('Worker', ControlledWorker);

    const checking = payrollLocalAi.check();
    const previousWorker = ControlledWorker.instances[0];
    previousWorker.emitMessage({ type: 'check', mode: 'webgpu' });
    await expect(checking).resolves.toBe('webgpu');

    payrollLocalAi.cancel();
    const loading = payrollLocalAi.load();
    const activeWorker = ControlledWorker.instances[1];
    let outcome = 'pending';
    const observed = loading.then(
      () => { outcome = 'resolved'; },
      (reason: unknown) => {
        outcome = reason instanceof Error ? reason.message : String(reason);
      },
    );

    previousWorker.emitMessage({ type: 'load_error', error: 'ancienne panne' });
    previousWorker.emitError('ancienne erreur fatale');
    await Promise.resolve();
    expect(outcome).toBe('pending');
    expect(activeWorker.terminated).toBe(false);

    activeWorker.emitMessage({ type: 'ready', mode: 'wasm' });
    await observed;
    expect(outcome).toBe('resolved');
  });

  it('traite le delai d’analyse comme un delai sans progression', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', ControlledWorker);

    const analysis = payrollLocalAi.analyze({ imageUrls: ['data:image/png;base64,AA=='] });
    const worker = ControlledWorker.instances[0];
    const requestId = String(worker.posted[0]?.requestId ?? '');
    let outcome = 'pending';
    const observed = analysis.then(
      () => { outcome = 'resolved'; },
      (reason: unknown) => { outcome = reason instanceof Error ? reason.message : String(reason); },
    );

    await vi.advanceTimersByTimeAsync(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS - 1);
    worker.emitMessage({ type: 'analysis_stage', requestId, label: '32/384 jetons', percent: 58 });
    await vi.advanceTimersByTimeAsync(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    expect(worker.terminated).toBe(false);

    worker.emitMessage({
      type: 'analysis',
      requestId,
      primaryOutput: '{"employee":{"name":"Ada"},"lines":[]}',
      verifiedOutput: '',
      mode: 'wasm',
    });
    await observed;
    expect(outcome).toBe('resolved');
  });

  it('arrete une generation qui ne publie reellement plus aucun progres', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', ControlledWorker);

    const analysis = payrollLocalAi.analyze({ imageUrls: [] });
    const rejection = expect(analysis).rejects.toThrow('ne progresse plus depuis 15 minutes');
    await vi.advanceTimersByTimeAsync(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS);

    await rejection;
    expect(ControlledWorker.instances[0].terminated).toBe(true);
  });

  it('reconnait la progression generique du rechargement WASM pendant une analyse', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', ControlledWorker);

    const analysis = payrollLocalAi.analyze({ imageUrls: ['data:image/png;base64,AA=='] });
    const worker = ControlledWorker.instances[0];
    const requestId = String(worker.posted[0]?.requestId ?? '');
    let outcome = 'pending';
    const observed = analysis.then(
      () => { outcome = 'resolved'; },
      (reason: unknown) => { outcome = reason instanceof Error ? reason.message : String(reason); },
    );

    await vi.advanceTimersByTimeAsync(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS - 1);
    worker.emitMessage({ type: 'progress', progress: { file: 'decoder_model_merged_q4.onnx', progress: 48 } });
    await vi.advanceTimersByTimeAsync(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    expect(worker.terminated).toBe(false);

    worker.emitMessage({
      type: 'analysis', requestId,
      primaryOutput: '{"employee":{"name":"Ada"},"lines":[]}',
      verifiedOutput: '', mode: 'wasm',
    });
    await observed;
    expect(outcome).toBe('resolved');
  });

  it('retourne le runtime effectif choisi pendant le chargement', async () => {
    vi.stubGlobal('Worker', ControlledWorker);

    const loading = payrollLocalAi.load();
    ControlledWorker.instances[0].emitMessage({ type: 'ready', mode: 'wasm' });

    await expect(loading).resolves.toBe('wasm');
  });
});

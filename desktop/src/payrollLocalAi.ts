import { PAYROLL_AI_MODEL_ID, PAYROLL_AI_MODEL_REVISION } from './payrollAiModel';

type WorkerPayload = Record<string, unknown>;
const PAYROLL_ANALYSIS_TIMEOUT_MS = 15 * 60 * 1_000;
export const PAYROLL_MODEL_LOAD_TIMEOUT_MS = 15 * 60 * 1_000;
export const PAYROLL_ENGINE_CHECK_TIMEOUT_MS = 15 * 1_000;

export type PayrollAiProgress = {
  label: string;
  percent: number | null;
};

export type PayrollAiAnalysis = {
  rawOutput: string;
  primaryRawOutput: string;
  verifiedRawOutput: string;
  passes: number;
  modelId: string;
  modelVersion: string;
  mode: PayrollAiMode;
};

export type PayrollAiMode = 'webgpu' | 'wasm' | 'unavailable';

class PayrollLocalAi {
  private worker: Worker | null = null;
  private checkWaiters: Array<{
    resolve: (mode: PayrollAiMode) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private loadWaiters: Array<{
    resolve: () => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private analyses = new Map<string, {
    resolve: (value: PayrollAiAnalysis) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private progressListeners = new Set<(progress: PayrollAiProgress) => void>();

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./payrollAi.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.addEventListener('message', (event: MessageEvent<WorkerPayload>) => this.handleMessage(event.data));
    const failWorker = (error: Error) => {
      if (this.worker === worker) this.worker = null;
      worker.terminate();
      this.rejectAll(error);
    };
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || "Le moteur IA local s'est arrêté de façon inattendue.");
      failWorker(error);
    });
    worker.addEventListener('messageerror', () => {
      failWorker(new Error("Le moteur IA local a renvoyé un message illisible et a été redémarré."));
    });
    return worker;
  }

  private handleMessage(message: WorkerPayload) {
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'check') {
      const mode = message.mode === 'webgpu' || message.mode === 'wasm' ? message.mode : 'unavailable';
      this.checkWaiters.splice(0).forEach(({ resolve, timeout }) => {
        clearTimeout(timeout);
        resolve(mode);
      });
      return;
    }
    if (type === 'progress') {
      const progress = message.progress && typeof message.progress === 'object' ? message.progress as WorkerPayload : {};
      const rawPercent = typeof progress.progress === 'number' ? progress.progress : null;
      const label = typeof progress.file === 'string' ? `Téléchargement local · ${progress.file}` : typeof progress.status === 'string' ? progress.status : 'Préparation du modèle local';
      this.progressListeners.forEach((listener) => listener({ label, percent: rawPercent }));
      return;
    }
    if (type === 'analysis_stage') {
      const label = typeof message.label === 'string' ? message.label : 'Analyse locale en cours';
      const percent = typeof message.percent === 'number' ? Math.max(0, Math.min(100, message.percent)) : null;
      this.progressListeners.forEach((listener) => listener({ label, percent }));
      return;
    }
    if (type === 'ready') {
      this.loadWaiters.splice(0).forEach(({ resolve, timeout }) => {
        clearTimeout(timeout);
        resolve();
      });
      return;
    }
    if (type === 'load_error') {
      const error = new Error(typeof message.error === 'string' ? message.error : "Le pack IA local n'a pas pu être chargé.");
      this.loadWaiters.splice(0).forEach(({ reject, timeout }) => {
        clearTimeout(timeout);
        reject(error);
      });
      return;
    }
    if (type === 'analysis' || type === 'analysis_error') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = this.analyses.get(requestId);
      if (!pending) return;
      this.analyses.delete(requestId);
      clearTimeout(pending.timeout);
      if (type === 'analysis_error') {
        pending.reject(new Error(typeof message.error === 'string' ? message.error : "L'analyse locale a échoué."));
      } else {
        const primaryRawOutput = typeof message.primaryOutput === 'string' ? message.primaryOutput : '';
        const verifiedRawOutput = typeof message.verifiedOutput === 'string'
          ? message.verifiedOutput
          : primaryRawOutput ? '' : typeof message.output === 'string' ? message.output : '';
        const passes = primaryRawOutput.trim() && verifiedRawOutput.trim() ? 2 : 1;
        pending.resolve({
          rawOutput: verifiedRawOutput || primaryRawOutput,
          primaryRawOutput,
          verifiedRawOutput,
          passes,
          modelId: typeof message.modelId === 'string' && message.modelId.trim() ? message.modelId : PAYROLL_AI_MODEL_ID,
          modelVersion: typeof message.modelVersion === 'string' && message.modelVersion.trim() ? message.modelVersion : PAYROLL_AI_MODEL_REVISION,
          mode: message.mode === 'webgpu' || message.mode === 'wasm' ? message.mode : 'unavailable',
        });
      }
    }
  }

  private rejectAll(error: Error) {
    this.loadWaiters.splice(0).forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(error);
    });
    for (const pending of this.analyses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.analyses.clear();
    this.checkWaiters.splice(0).forEach(({ resolve, timeout }) => {
      clearTimeout(timeout);
      resolve('unavailable');
    });
  }

  onProgress(listener: (progress: PayrollAiProgress) => void) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  cancel() {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.rejectAll(new Error('Analyse locale annulée. Aucun brouillon IA incomplet n’a été enregistré.'));
  }

  check(): Promise<PayrollAiMode> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const worker = this.worker;
        this.worker = null;
        worker?.terminate();
        this.rejectAll(new Error('La vérification du moteur IA local a expiré.'));
      }, PAYROLL_ENGINE_CHECK_TIMEOUT_MS);
      const waiter = { resolve, timeout };
      this.checkWaiters.push(waiter);
      try {
        this.ensureWorker().postMessage({ type: 'check' });
      } catch {
        const worker = this.worker;
        this.worker = null;
        worker?.terminate();
        this.rejectAll(new Error('Le moteur IA local n’a pas pu démarrer.'));
      }
    });
  }

  load(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const worker = this.worker;
        this.worker = null;
        worker?.terminate();
        this.rejectAll(new Error("Le téléchargement ou le chargement du modèle local a dépassé 15 minutes. Le moteur a été redémarré; vérifiez la connexion puis réessayez."));
      }, PAYROLL_MODEL_LOAD_TIMEOUT_MS);
      const waiter = { resolve, reject, timeout };
      this.loadWaiters.push(waiter);
      try {
        this.ensureWorker().postMessage({ type: 'load' });
      } catch (reason) {
        clearTimeout(timeout);
        this.loadWaiters = this.loadWaiters.filter((candidate) => candidate !== waiter);
        reject(reason instanceof Error ? reason : new Error("Le chargement du modèle local n'a pas pu démarrer."));
      }
    });
  }

  analyze(input: { imageUrls?: string[]; extractedText?: string; pageStart?: number; pageEnd?: number }): Promise<PayrollAiAnalysis> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        if (!this.analyses.has(requestId)) return;
        const worker = this.worker;
        this.worker = null;
        worker?.terminate();
        this.rejectAll(new Error('L’analyse locale a dépassé 15 minutes et le moteur a été redémarré. Aucun brouillon incomplet n’a été enregistré; réduisez le nombre de pages ou relancez cette fiche.'));
      }, PAYROLL_ANALYSIS_TIMEOUT_MS);
      this.analyses.set(requestId, { resolve, reject, timeout });
      try {
        this.ensureWorker().postMessage({
          type: 'analyze',
          requestId,
          imageUrls: input.imageUrls?.slice(0, 3),
          extractedText: input.extractedText,
          pageStart: input.pageStart,
          pageEnd: input.pageEnd,
        });
      } catch (reason) {
        clearTimeout(timeout);
        this.analyses.delete(requestId);
        reject(reason instanceof Error ? reason : new Error("L'analyse locale n'a pas pu démarrer."));
      }
    });
  }
}

export const payrollLocalAi = new PayrollLocalAi();

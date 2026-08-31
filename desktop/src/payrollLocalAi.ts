type WorkerPayload = Record<string, unknown>;

export type PayrollAiProgress = {
  label: string;
  percent: number | null;
};

export type PayrollAiAnalysis = {
  rawOutput: string;
  modelId: string;
  modelVersion: string;
  mode: PayrollAiMode;
};

export type PayrollAiMode = 'webgpu' | 'wasm' | 'unavailable';

class PayrollLocalAi {
  private worker: Worker | null = null;
  private checkWaiters: Array<(mode: PayrollAiMode) => void> = [];
  private loadWaiters: Array<{ resolve: () => void; reject: (reason: Error) => void }> = [];
  private analyses = new Map<string, { resolve: (value: PayrollAiAnalysis) => void; reject: (reason: Error) => void }>();
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
      this.checkWaiters.splice(0).forEach((resolve) => resolve(mode));
      return;
    }
    if (type === 'progress') {
      const progress = message.progress && typeof message.progress === 'object' ? message.progress as WorkerPayload : {};
      const rawPercent = typeof progress.progress === 'number' ? progress.progress : null;
      const label = typeof progress.file === 'string' ? `Téléchargement local · ${progress.file}` : typeof progress.status === 'string' ? progress.status : 'Préparation du modèle local';
      this.progressListeners.forEach((listener) => listener({ label, percent: rawPercent }));
      return;
    }
    if (type === 'ready') {
      this.loadWaiters.splice(0).forEach(({ resolve }) => resolve());
      return;
    }
    if (type === 'load_error') {
      const error = new Error(typeof message.error === 'string' ? message.error : "Le pack IA local n'a pas pu être chargé.");
      this.loadWaiters.splice(0).forEach(({ reject }) => reject(error));
      return;
    }
    if (type === 'analysis' || type === 'analysis_error') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = this.analyses.get(requestId);
      if (!pending) return;
      this.analyses.delete(requestId);
      if (type === 'analysis_error') {
        pending.reject(new Error(typeof message.error === 'string' ? message.error : "L'analyse locale a échoué."));
      } else {
        pending.resolve({
          rawOutput: typeof message.output === 'string' ? message.output : '',
          modelId: typeof message.modelId === 'string' ? message.modelId : 'HuggingFaceTB/SmolVLM-500M-Instruct',
          modelVersion: typeof message.modelVersion === 'string' ? message.modelVersion : '',
          mode: message.mode === 'webgpu' || message.mode === 'wasm' ? message.mode : 'unavailable',
        });
      }
    }
  }

  private rejectAll(error: Error) {
    this.loadWaiters.splice(0).forEach(({ reject }) => reject(error));
    for (const pending of this.analyses.values()) pending.reject(error);
    this.analyses.clear();
    this.checkWaiters.splice(0).forEach((resolve) => resolve('unavailable'));
  }

  onProgress(listener: (progress: PayrollAiProgress) => void) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  check(): Promise<PayrollAiMode> {
    return new Promise((resolve) => {
      this.checkWaiters.push(resolve);
      this.ensureWorker().postMessage({ type: 'check' });
    });
  }

  load(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.loadWaiters.push({ resolve, reject });
      this.ensureWorker().postMessage({ type: 'load' });
    });
  }

  analyze(input: { imageUrls?: string[]; extractedText?: string }): Promise<PayrollAiAnalysis> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.analyses.set(requestId, { resolve, reject });
      this.ensureWorker().postMessage({ type: 'analyze', requestId, imageUrls: input.imageUrls?.slice(0, 3), extractedText: input.extractedText });
    });
  }
}

export const payrollLocalAi = new PayrollLocalAi();

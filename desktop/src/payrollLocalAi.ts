import type { AssistantFacts, AssistantMessage } from './assistantGuide';
import { PAYROLL_AI_MODEL_ID, PAYROLL_AI_MODEL_REVISION } from './payrollAiModel';
import type { EmployeeDocumentDraft } from './employeeDocumentDraft';
import { classifyDiagnosticError, recordDiagnostic } from './diagnostics';

type WorkerPayload = Record<string, unknown>;
type AssistantRequest = {
  resolve: (value: WorkerPayload) => void;
  reject: (reason: Error) => void;
  onChunk?: (text: string) => void;
  timeout: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  cancelled: boolean;
  worker: Worker | null;
};
export const PAYROLL_ANALYSIS_STALL_TIMEOUT_MS = 15 * 60 * 1_000;
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
  partialError?: string;
  employeeDraft?: EmployeeDocumentDraft;
  extractedText?: string;
};

export type PayrollAiMode = 'webgpu' | 'wasm' | 'unavailable';

class PayrollLocalAi {
  private worker: Worker | null = null;
  private cancelledErrors = new WeakSet<Error>();
  private assistantRequests = new Map<string, AssistantRequest>();
  isBusy() { return this.loadWaiters.length > 0 || this.analyses.size > 0 || this.assistantRequests.size > 0; }
  releaseIfIdle() { if (!this.isBusy()) { this.worker?.terminate(); this.worker = null; } }
  private assistantCancelledError() {
    const error = new Error('Analyse locale annulée. Aucun brouillon IA incomplet n’a été enregistré.');
    this.cancelledErrors.add(error);
    return error;
  }
  private retireCancelledAssistantWorkerIfUnused() {
    if (this.checkWaiters.length || this.loadWaiters.length || this.analyses.size ||
        [...this.assistantRequests.values()].some(pending => !pending.cancelled)) return;
    for (const [requestId, pending] of this.assistantRequests) {
      // Rejecting the caller does not stop physical generation. Keep its ID
      // busy until its terminal message, or until no foreign waiter needs
      // the same worker and that exact worker can safely be terminated.
      if (pending.worker !== null && this.worker === pending.worker) {
        this.worker = null;
        pending.worker.terminate();
      }
      clearTimeout(pending.timeout);
      pending.cleanup();
      this.assistantRequests.delete(requestId);
    }
  }
  private assistantRequest(type: string, input: WorkerPayload = {}, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<WorkerPayload> {
    if (signal?.aborted) return Promise.reject(this.assistantCancelledError());
    if (this.isBusy()) return Promise.reject(new Error('Qwen est déjà utilisé pour une lecture ou un téléchargement. Attendez la fin de cette opération.'));
    return new Promise((resolve,reject) => {
      const requestId = crypto.randomUUID();
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        const pending = this.assistantRequests.get(requestId);
        if (!pending || pending !== owned || pending.cancelled) return;
        pending.cancelled = true;
        pending.cleanup();
        pending.reject(this.assistantCancelledError());
        this.retireCancelledAssistantWorkerIfUnused();
      };
      const timeout = setTimeout(() => {
        const pending = this.assistantRequests.get(requestId);
        if (!pending) return;
        if (pending.cancelled) {
          this.retireCancelledAssistantWorkerIfUnused();
          return;
        }
        this.worker?.terminate(); this.worker = null;
        this.rejectAll(new Error('La réponse prend trop de temps sur cet appareil. Réessayez avec une question plus courte.'));
      }, type === 'assistant_chat' ? 180_000 : 30_000);
      const owned: AssistantRequest = {resolve,reject,timeout,onChunk,cleanup,cancelled:false,worker:null};
      this.assistantRequests.set(requestId, owned);
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) { abort(); return; }
      try {
        const requestWorker = this.ensureWorker();
        owned.worker = requestWorker;
        if (this.assistantRequests.get(requestId) !== owned) {
          if (this.worker === requestWorker && !this.isBusy() && this.checkWaiters.length === 0) {
            this.worker = null;
            requestWorker.terminate();
          }
          return;
        }
        if (owned.cancelled) { this.retireCancelledAssistantWorkerIfUnused(); return; }
        requestWorker.postMessage({type,requestId,...input});
      }
      catch (error) { clearTimeout(timeout);cleanup();this.assistantRequests.delete(requestId);reject(error); }
    });
  }
  async inspectModel() { return (await this.assistantRequest('assistant_cache')).cached === true; }
  async removeModel() { await this.assistantRequest('assistant_remove'); this.releaseIfIdle(); }
  async chat(input: { question: string; screen: string; facts: AssistantFacts; history: AssistantMessage[] }, onChunk: (text: string) => void, signal?: AbortSignal) {
    let started: number | undefined, id: string | undefined;
    try { started = performance.now(); id = recordDiagnostic({area:'app',operation:'assistant.local_chat',phase:'start'}); }
    catch { /* A journal failure must never block the local assistant. */ }
    const finish = (phase: 'success' | 'failure' | 'info', error?: unknown) => {
      try { recordDiagnostic({id,area:'app',operation:'assistant.local_chat',phase,durationMs:started === undefined ? undefined : performance.now()-started,errorCode:phase === 'failure' ? classifyDiagnosticError(error) : undefined}); }
      catch { /* Do not replace a worker result, rejection or cancellation. */ }
    };
    try {
      const result = await this.assistantRequest('assistant_chat', input, onChunk, signal);
      const response = {output: String(result.output ?? ''), truncated: result.truncated === true, source: result.source === 'guide' ? 'guide' as const : 'qwen' as const};
      finish('success');
      return response;
    } catch (error) {
      finish(this.cancelledErrors.has(error as Error) ? 'info' : 'failure', error);
      throw error;
    }
  }
  private checkWaiters: Array<{
    resolve: (mode: PayrollAiMode) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private loadWaiters: Array<{
    resolve: (mode: PayrollAiMode) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private analyses = new Map<string, {
    resolve: (value: PayrollAiAnalysis) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout> | null;
  }>();
  private progressListeners = new Set<(progress: PayrollAiProgress) => void>();

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./payrollAi.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.addEventListener('message', (event: MessageEvent<WorkerPayload>) => {
      // terminate() n'annule pas nécessairement un événement déjà placé dans
      // la file du thread principal. Un ancien Worker ne doit jamais pouvoir
      // résoudre ou rejeter les opérations de la génération qui l'a remplacé.
      if (this.worker !== worker) return;
      this.handleMessage(event.data);
    });
    const failWorker = (error: Error) => {
      if (this.worker !== worker) {
        worker.terminate();
        return;
      }
      this.worker = null;
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
    if (type.startsWith('assistant_')) {
      const requestId = String(message.requestId ?? '');
      const pending = this.assistantRequests.get(requestId);
      if (!pending) return;
      if (type === 'assistant_chunk') { if (!pending.cancelled) pending.onChunk?.(String(message.output ?? '')); return; }
      clearTimeout(pending.timeout);pending.cleanup();this.assistantRequests.delete(requestId);
      if (!pending.cancelled) {
        if (type === 'assistant_error') pending.reject(new Error(String(message.error || 'L’assistant local n’a pas pu répondre.')));
        else pending.resolve(message);
      }
      return;
    }
    if (type === 'check') {
      const mode = message.mode === 'webgpu' || message.mode === 'wasm' ? message.mode : 'unavailable';
      this.checkWaiters.splice(0).forEach(({ resolve, timeout }) => {
        clearTimeout(timeout);
        resolve(mode);
      });
      this.retireCancelledAssistantWorkerIfUnused();
      return;
    }
    if (type === 'progress') {
      const progress = message.progress && typeof message.progress === 'object' ? message.progress as WorkerPayload : {};
      const rawPercent = typeof progress.progress === 'number' ? progress.progress : null;
      const label = typeof progress.file === 'string' ? `Téléchargement local · ${progress.file}` : typeof progress.status === 'string' ? progress.status : 'Préparation du modèle local';
      this.progressListeners.forEach((listener) => listener({ label, percent: rawPercent }));
      // During WebGPU -> WASM fallback, model download/compilation emits
      // generic Qwen progress messages without a request id. It is
      // still authoritative activity from this single sequential Worker.
      for (const requestId of this.analyses.keys()) this.refreshAnalysisTimeout(requestId);
      return;
    }
    if (type === 'analysis_stage') {
      const label = typeof message.label === 'string' ? message.label : 'Analyse locale en cours';
      const percent = typeof message.percent === 'number' ? Math.max(0, Math.min(100, message.percent)) : null;
      this.progressListeners.forEach((listener) => listener({ label, percent }));
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      if (requestId) this.refreshAnalysisTimeout(requestId);
      return;
    }
    if (type === 'ready') {
      const mode: PayrollAiMode = message.mode === 'webgpu' || message.mode === 'wasm'
        ? message.mode
        : 'unavailable';
      this.loadWaiters.splice(0).forEach(({ resolve, timeout }) => {
        clearTimeout(timeout);
        resolve(mode);
      });
      this.retireCancelledAssistantWorkerIfUnused();
      return;
    }
    if (type === 'load_error') {
      const error = new Error(typeof message.error === 'string' ? message.error : "Le pack IA local n'a pas pu être chargé.");
      this.loadWaiters.splice(0).forEach(({ reject, timeout }) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.retireCancelledAssistantWorkerIfUnused();
      return;
    }
    if (type === 'analysis' || type === 'analysis_error') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = this.analyses.get(requestId);
      if (!pending) return;
      this.analyses.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
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
          partialError: typeof message.partialError === 'string' ? message.partialError : undefined,
          employeeDraft: message.employeeDraft as EmployeeDocumentDraft | undefined,
          extractedText: typeof message.extractedText === 'string' ? message.extractedText : undefined,
        });
      }
      this.retireCancelledAssistantWorkerIfUnused();
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.assistantRequests.values()) { clearTimeout(pending.timeout);pending.cleanup();pending.reject(error); }
    this.assistantRequests.clear();
    this.loadWaiters.splice(0).forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(error);
    });
    for (const pending of this.analyses.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
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

  private refreshAnalysisTimeout(requestId: string) {
    const pending = this.analyses.get(requestId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      if (!this.analyses.has(requestId)) return;
      const worker = this.worker;
      this.worker = null;
      worker?.terminate();
      this.rejectAll(new Error('L’analyse locale ne progresse plus depuis 15 minutes et le moteur a été redémarré. Aucun brouillon incomplet n’a été enregistré; réduisez le nombre de pages ou relancez cette fiche.'));
    }, PAYROLL_ANALYSIS_STALL_TIMEOUT_MS);
  }

  cancel() {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    const error = new Error('Analyse locale annulée. Aucun brouillon IA incomplet n’a été enregistré.');
    this.cancelledErrors.add(error);
    this.rejectAll(error);
  }

  private documentDiagnostic(operation: 'local_ai.engine_check' | 'local_ai.document_analysis') {
    let started: number | undefined, id: string | undefined, finished = false;
    try { started = performance.now(); id = recordDiagnostic({ area: 'app', operation, phase: 'start' }); }
    catch { /* A journal failure must not prevent local document processing. */ }
    return (phase: 'success' | 'failure' | 'info', error?: unknown) => {
      if (finished) return;
      finished = true;
      try {
        recordDiagnostic({ id, area: 'app', operation, phase,
          durationMs: started === undefined ? undefined : performance.now() - started,
          errorCode: phase === 'failure' ? classifyDiagnosticError(error) : undefined });
      } catch { /* Preserve the original result, rejection and cancellation. */ }
    };
  }

  check(): Promise<PayrollAiMode> {
    const finish = this.documentDiagnostic('local_ai.engine_check');
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const worker = this.worker;
        this.worker = null;
        worker?.terminate();
        this.rejectAll(new Error('La vérification du moteur IA local a expiré.'));
      }, PAYROLL_ENGINE_CHECK_TIMEOUT_MS);
      const waiter = { resolve: (mode: PayrollAiMode) => {
        // Unavailable is an existing non-throwing result, including cancellation
        // and check timeout. Do not turn it into a failure or invent its cause.
        finish(mode === 'unavailable' ? 'info' : 'success');
        resolve(mode);
      }, timeout };
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

  load(): Promise<PayrollAiMode> {
    if (this.isBusy()) return Promise.reject(new Error('Qwen est déjà utilisé. Attendez la fin de la réponse ou de la lecture en cours.'));
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
    const finish = this.documentDiagnostic('local_ai.document_analysis');
    if (this.isBusy()) {
      const error = new Error('Qwen est déjà utilisé. Attendez la fin de la réponse ou de la lecture en cours.');
      finish('failure', error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const fail = (error: Error) => {
        finish(this.cancelledErrors.has(error) ? 'info' : 'failure', error);
        reject(error);
      };
      this.analyses.set(requestId, { resolve: value => { finish('success'); resolve(value); }, reject: fail, timeout: null });
      this.refreshAnalysisTimeout(requestId);
      try {
        this.ensureWorker().postMessage({
          type: 'analyze',
          requestId,
          imageUrls: input.imageUrls?.slice(0, 3),
          extractedText: input.extractedText,
          pageStart: input.pageStart,
          pageEnd: input.pageEnd,
          assetBase: typeof document === 'undefined' ? undefined : new URL('./', document.baseURI).href,
        });
      } catch (reason) {
        const pending = this.analyses.get(requestId);
        if (pending?.timeout) clearTimeout(pending.timeout);
        this.analyses.delete(requestId);
        fail(reason instanceof Error ? reason : new Error("L'analyse locale n'a pas pu démarrer."));
      }
    });
  }
}

export const payrollLocalAi = new PayrollLocalAi();

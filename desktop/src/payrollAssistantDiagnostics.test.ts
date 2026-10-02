import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  failJournal: false,
  invoke: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: controls.invoke }));
vi.mock('./diagnostics', async original => {
  const actual = await original<typeof import('./diagnostics')>();
  return {
    ...actual,
    recordDiagnostic: (...args: Parameters<typeof actual.recordDiagnostic>) => {
      if (controls.failJournal) throw new Error('Synthetic journal failure');
      return actual.recordDiagnostic(...args);
    },
  };
});
import { diagnosticsApi, flushDiagnostics, recentDiagnosticEvents } from './diagnostics';
import { payrollLocalAi } from './payrollLocalAi';

class ChatWorker {
  static instances: ChatWorker[] = [];
  static postError: unknown;
  terminated = false;
  messages: Array<Record<string, unknown>> = [];
  listeners = new Map<string, Array<(event: { data?: Record<string, unknown>; message?: string }) => void>>();
  constructor() { ChatWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: { data?: Record<string, unknown>; message?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: Record<string, unknown>) {
    if (ChatWorker.postError !== undefined) throw ChatWorker.postError;
    this.messages.push(message);
  }
  terminate() { this.terminated = true; }
  emit(data: Record<string, unknown>) { this.listeners.get('message')?.forEach(listener => listener({ data })); }
}
const privateInput = {
  question: 'PRIVATE_QUESTION invoice@example.invalid PASSWORD=secret',
  screen: 'PRIVATE_SCREEN',
  facts: { employee: 'PRIVATE_EMPLOYEE', apiKey: 'PRIVATE_KEY' },
  history: [{ role: 'user' as const, content: 'PRIVATE_HISTORY' }],
};
const events = () => recentDiagnosticEvents().filter(event => event.operation.startsWith('assistant.'));

describe('journal du vrai chat local avec Worker synthétique', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    controls.failJournal = false;
    controls.invoke.mockClear();
    await diagnosticsApi.clear();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('Worker', ChatWorker);
    ChatWorker.instances = [];
    ChatWorker.postError = undefined;
  });
  afterEach(async () => {
    payrollLocalAi.cancel();
    await flushDiagnostics(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    controls.failJournal = false;
  });

  it('journalise la durée et le succès sans question, contexte, fragments ni réponse', async () => {
    const chunks: string[] = [];
    const response = payrollLocalAi.chat(privateInput, text => chunks.push(text));
    const worker = ChatWorker.instances[0], requestId = worker.messages[0].requestId;
    expect(worker.messages[0]).toMatchObject({ type: 'assistant_chat', ...privateInput });
    worker.emit({ type: 'assistant_chunk', requestId, output: 'PRIVATE_CHUNK' });
    worker.emit({ type: 'assistant_result', requestId, output: 'PRIVATE_OUTPUT', truncated: true, source: 'guide' });
    await expect(response).resolves.toEqual({ output: 'PRIVATE_OUTPUT', truncated: true, source: 'guide' });
    expect(chunks).toEqual(['PRIVATE_CHUNK']);
    expect(events().map(event => event.phase)).toEqual(['start', 'success']);
    expect(events()[1]).toMatchObject({ id: events()[0].id, durationMs: expect.any(Number) });
    expect(events()[1].durationMs).toBeGreaterThanOrEqual(0);
    await flushDiagnostics(true);
    expect(JSON.stringify({ events: events(), journal: controls.invoke.mock.calls })).not.toMatch(/PRIVATE_|secret|invoice@example|PASSWORD/);
  });

  it('conserve l’identité du rejet et ne journalise pas son texte', async () => {
    const original = new Error('PRIVATE_ERROR api-key=PRIVATE_KEY');
    ChatWorker.postError = original;
    await expect(payrollLocalAi.chat(privateInput, () => {})).rejects.toBe(original);
    expect(events().map(event => event.phase)).toEqual(['start', 'failure']);
    expect(events()[1]).toMatchObject({ id: events()[0].id, durationMs: expect.any(Number), errorCode: 'INTERNAL' });
    await flushDiagnostics(true);
    expect(JSON.stringify({ events: events(), journal: controls.invoke.mock.calls })).not.toMatch(/PRIVATE_|api-key/);
    expect(payrollLocalAi.isBusy()).toBe(false);
  });

  it('journalise le rejet envoyé par le Worker sans son message privé', async () => {
    const response = payrollLocalAi.chat(privateInput, () => {});
    const worker = ChatWorker.instances[0], requestId = worker.messages[0].requestId;
    worker.emit({ type: 'assistant_error', requestId, error: 'PRIVATE_WORKER_ERROR' });
    await expect(response).rejects.toThrow('PRIVATE_WORKER_ERROR');
    expect(events().map(event => event.phase)).toEqual(['start', 'failure']);
    expect(events()[1].errorCode).toBe('INTERNAL');
    await flushDiagnostics(true);
    expect(JSON.stringify({ events: events(), journal: controls.invoke.mock.calls })).not.toMatch(/PRIVATE_|secret/);
    expect(payrollLocalAi.isBusy()).toBe(false);
  });

  it('traite l’arrêt comme une information et ignore les réponses de l’ancien Worker', async () => {
    const oldChunks = vi.fn();
    const first = payrollLocalAi.chat(privateInput, oldChunks).catch(error => error);
    const oldWorker = ChatWorker.instances[0];
    payrollLocalAi.cancel();
    const cancelled = await first;
    expect(cancelled).toBeInstanceOf(Error);
    expect(cancelled.message).toBe('Analyse locale annulée. Aucun brouillon IA incomplet n’a été enregistré.');
    expect(events().map(event => event.phase)).toEqual(['start', 'info']);
    expect(events()[1]).toMatchObject({ id: events()[0].id, durationMs: expect.any(Number) });
    expect(events()[1].errorCode).toBeUndefined();
    expect(oldWorker.terminated).toBe(true);
    const chunks: string[] = [];
    const next = payrollLocalAi.chat(privateInput, text => chunks.push(text));
    const current = ChatWorker.instances[1], requestId = current.messages[0].requestId;
    oldWorker.emit({ type: 'assistant_chunk', requestId, output: 'PRIVATE_OLD_CHUNK' });
    oldWorker.emit({ type: 'assistant_result', requestId, output: 'PRIVATE_OLD_OUTPUT' });
    current.emit({ type: 'assistant_result', requestId, output: 'PRIVATE_NEW_OUTPUT' });
    await expect(next).resolves.toEqual({ output: 'PRIVATE_NEW_OUTPUT', truncated: false, source: 'qwen' });
    expect(oldChunks).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
    expect(events().map(event => event.phase)).toEqual(['start', 'info', 'start', 'success']);
    expect(payrollLocalAi.isBusy()).toBe(false);
  });

  it('conserve le délai existant et distingue une expiration d’un arrêt utilisateur', async () => {
    const request = payrollLocalAi.chat(privateInput, () => {});
    const rejection = expect(request).rejects.toThrow('La réponse prend trop de temps');
    await vi.advanceTimersByTimeAsync(180_000);
    await rejection;
    expect(ChatWorker.instances[0].terminated).toBe(true);
    expect(payrollLocalAi.isBusy()).toBe(false);
    expect(events().map(event => event.phase)).toEqual(['start', 'failure']);
  });

  it('préserve réponse, rejet original et arrêt quand le journal échoue', async () => {
    controls.failJournal = true;
    const response = payrollLocalAi.chat(privateInput, () => {});
    const worker = ChatWorker.instances[0], requestId = worker.messages[0].requestId;
    worker.emit({ type: 'assistant_result', requestId, output: 'PRIVATE_OUTPUT' });
    await expect(response).resolves.toEqual({ output: 'PRIVATE_OUTPUT', truncated: false, source: 'qwen' });
    const original = new Error('PRIVATE_ORIGINAL_ERROR');
    ChatWorker.postError = original;
    await expect(payrollLocalAi.chat(privateInput, () => {})).rejects.toBe(original);
    ChatWorker.postError = undefined;
    const stopped = payrollLocalAi.chat(privateInput, () => {}).catch(error => error);
    payrollLocalAi.cancel();
    expect((await stopped).message).toBe('Analyse locale annulée. Aucun brouillon IA incomplet n’a été enregistré.');
    expect(events()).toEqual([]);
    expect(payrollLocalAi.isBusy()).toBe(false);
  });
});

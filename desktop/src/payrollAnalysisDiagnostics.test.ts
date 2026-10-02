import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ failJournal: false, invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: controls.invoke }));
vi.mock('./diagnostics', async original => {
  const actual = await original<typeof import('./diagnostics')>();
  return { ...actual, recordDiagnostic: (...args: Parameters<typeof actual.recordDiagnostic>) => {
    if (controls.failJournal) throw new Error('Synthetic diagnostic failure');
    return actual.recordDiagnostic(...args);
  } };
});
import { diagnosticsApi, flushDiagnostics, recentDiagnosticEvents } from './diagnostics';
import { PAYROLL_ANALYSIS_STALL_TIMEOUT_MS, PAYROLL_ENGINE_CHECK_TIMEOUT_MS, payrollLocalAi } from './payrollLocalAi';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static postError: unknown;
  messages: Record<string, unknown>[] = [];
  terminated = false;
  listeners = new Map<string, Array<(event: { data?: Record<string, unknown>; message?: string }) => void>>();
  constructor() { ControlledWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: { data?: Record<string, unknown>; message?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: Record<string, unknown>) {
    if (ControlledWorker.postError !== undefined) throw ControlledWorker.postError;
    this.messages.push(message);
  }
  terminate() { this.terminated = true; }
  emit(data: Record<string, unknown>) { this.listeners.get('message')?.forEach(listener => listener({ data })); }
}
const input = { imageUrls: ['data:image/png;base64,PRIVATE_IMAGE'], extractedText: 'PRIVATE_EMPLOYEE PRIVATE_SECRET salary@example.invalid', pageStart: 2, pageEnd: 3 };
const events = (operation: string) => recentDiagnosticEvents().filter(event => event.operation === operation);
function pair(operation: string, phase: 'success' | 'failure' | 'info') {
  const found = events(operation);
  expect(found.map(event => event.phase)).toEqual(['start', phase]);
  expect(found[1]).toMatchObject({ id: found[0].id, area: 'app', durationMs: expect.any(Number) });
  expect(found[1].durationMs).toBeGreaterThanOrEqual(0);
  return found;
}
async function privateJournal() {
  await flushDiagnostics(true);
  expect(JSON.stringify({ events: recentDiagnosticEvents(), commands: controls.invoke.mock.calls }))
    .not.toMatch(/PRIVATE_|salary@example|data:image|primaryOutput|verifiedOutput|employeeDraft|pageStart|extractedText|imageUrls/);
}
beforeEach(async () => {
  vi.useFakeTimers(); controls.failJournal = false; controls.invoke.mockClear();
  payrollLocalAi.cancel(); await diagnosticsApi.clear();
  ControlledWorker.instances = []; ControlledWorker.postError = undefined;
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); vi.stubGlobal('Worker', ControlledWorker);
});
afterEach(async () => {
  payrollLocalAi.cancel(); await flushDiagnostics(true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); controls.failJournal = false;
});

describe('bounded private diagnostics for the real local document provider', () => {
  it.each(['webgpu', 'wasm'] as const)('records the existing engine check result %s once', async mode => {
    const result = payrollLocalAi.check(); ControlledWorker.instances[0].emit({ type: 'check', mode });
    await expect(result).resolves.toBe(mode); pair('local_ai.engine_check', 'success');
    expect(ControlledWorker.instances[0].messages).toEqual([{ type: 'check' }]); await privateJournal();
  });
  it('preserves the non-throwing unavailable check result', async () => {
    const result = payrollLocalAi.check(); ControlledWorker.instances[0].emit({ type: 'check', mode: 'unavailable' });
    await expect(result).resolves.toBe('unavailable'); pair('local_ai.engine_check', 'info'); await privateJournal();
  });
  it('keeps the existing check timeout and resets its Worker', async () => {
    const result = payrollLocalAi.check(); await vi.advanceTimersByTimeAsync(PAYROLL_ENGINE_CHECK_TIMEOUT_MS - 1);
    expect(ControlledWorker.instances[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toBe('unavailable');
    expect(ControlledWorker.instances[0].terminated).toBe(true); pair('local_ai.engine_check', 'info'); await privateJournal();
  });
  it('records analysis once without input, progress, extracted data or partial error', async () => {
    const result = payrollLocalAi.analyze(input), worker = ControlledWorker.instances[0], requestId = worker.messages[0].requestId;
    expect(worker.messages[0]).toMatchObject({ type: 'analyze', ...input });
    worker.emit({ type: 'analysis_stage', requestId, label: 'PRIVATE_STAGE', percent: 40 });
    worker.emit({ type: 'analysis', requestId, primaryOutput: 'PRIVATE_PRIMARY', verifiedOutput: 'PRIVATE_VERIFIED', partialError: 'PRIVATE_PARTIAL', extractedText: 'PRIVATE_EXTRACTED', employeeDraft: { name: 'PRIVATE_NAME' }, mode: 'wasm' });
    await expect(result).resolves.toMatchObject({ rawOutput: 'PRIVATE_VERIFIED', primaryRawOutput: 'PRIVATE_PRIMARY', verifiedRawOutput: 'PRIVATE_VERIFIED', partialError: 'PRIVATE_PARTIAL', passes: 2, mode: 'wasm' });
    pair('local_ai.document_analysis', 'success'); expect(payrollLocalAi.isBusy()).toBe(false); await privateJournal();
  });
  it('preserves a synchronous Worker rejection object and releases the admitted request', async () => {
    const original = new Error('network PRIVATE_SECRET'); ControlledWorker.postError = original;
    await expect(payrollLocalAi.analyze(input)).rejects.toBe(original);
    expect(pair('local_ai.document_analysis', 'failure')[1].errorCode).toBe('NETWORK');
    expect(payrollLocalAi.isBusy()).toBe(false); await privateJournal();
  });
  it('records the existing Worker error without its private message', async () => {
    const result = payrollLocalAi.analyze(input), worker = ControlledWorker.instances[0], requestId = worker.messages[0].requestId;
    const rejected = expect(result).rejects.toThrow('PRIVATE_WORKER_ERROR');
    worker.emit({ type: 'analysis_error', requestId, error: 'PRIVATE_WORKER_ERROR' }); await rejected;
    pair('local_ai.document_analysis', 'failure'); expect(payrollLocalAi.isBusy()).toBe(false); await privateJournal();
  });
  it('keeps stall timing and distinguishes a timeout from cancellation', async () => {
    const result = payrollLocalAi.analyze(input), rejected = expect(result).rejects.toThrow('15 minutes');
    await vi.advanceTimersByTimeAsync(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS - 1); expect(ControlledWorker.instances[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(ControlledWorker.instances[0].terminated).toBe(true); pair('local_ai.document_analysis', 'failure'); await privateJournal();
  });
  it('keeps cancellation informational and ignores an old Worker result', async () => {
    const first = payrollLocalAi.analyze(input).catch(reason => reason), old = ControlledWorker.instances[0];
    payrollLocalAi.cancel(); expect((await first).message).toContain('annulée'); pair('local_ai.document_analysis', 'info');
    const second = payrollLocalAi.analyze(input), current = ControlledWorker.instances[1], requestId = current.messages[0].requestId;
    old.emit({ type: 'analysis', requestId, output: 'PRIVATE_OLD' }); current.emit({ type: 'analysis', requestId, output: 'PRIVATE_NEW' });
    await expect(second).resolves.toMatchObject({ rawOutput: 'PRIVATE_NEW' });
    expect(events('local_ai.document_analysis').map(event => event.phase)).toEqual(['start', 'info', 'start', 'success']); await privateJournal();
  });
  it('refuses a second analysis without interrupting the admitted chat', async () => {
    const chat = payrollLocalAi.chat({ question: 'PRIVATE_QUESTION', screen: 'Paie', facts: {}, history: [] }, () => {});
    const worker = ControlledWorker.instances[0], requestId = worker.messages[0].requestId;
    await expect(payrollLocalAi.analyze(input)).rejects.toThrow('déjà utilisé'); pair('local_ai.document_analysis', 'failure');
    expect(worker.terminated).toBe(false); expect(worker.messages).toHaveLength(1);
    worker.emit({ type: 'assistant_result', requestId, output: 'PRIVATE_CHAT' }); await expect(chat).resolves.toMatchObject({ output: 'PRIVATE_CHAT' }); await privateJournal();
  });
  it('does not let a journal failure replace results, original errors or cancellation', async () => {
    controls.failJournal = true;
    const checked = payrollLocalAi.check(); ControlledWorker.instances[0].emit({ type: 'check', mode: 'webgpu' }); await expect(checked).resolves.toBe('webgpu');
    const result = payrollLocalAi.analyze(input), worker = ControlledWorker.instances[0], requestId = worker.messages[1].requestId;
    worker.emit({ type: 'analysis', requestId, output: 'PRIVATE_OUTPUT' }); await expect(result).resolves.toMatchObject({ rawOutput: 'PRIVATE_OUTPUT' });
    const original = new Error('PRIVATE_ORIGINAL'); ControlledWorker.postError = original;
    await expect(payrollLocalAi.analyze(input)).rejects.toBe(original); ControlledWorker.postError = undefined;
    const stopped = payrollLocalAi.analyze(input).catch(reason => reason); payrollLocalAi.cancel(); expect((await stopped).message).toContain('annulée');
    expect(events('local_ai.engine_check')).toEqual([]); expect(events('local_ai.document_analysis')).toEqual([]);
    expect(payrollLocalAi.isBusy()).toBe(false);
  });
});

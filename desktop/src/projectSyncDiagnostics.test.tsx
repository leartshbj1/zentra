import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ invoke: vi.fn(), callbacks: new Map<number, (event: unknown) => void>(), unregister: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, wake: vi.fn(), stop: vi.fn(), realtimeWake: vi.fn(), realtimeStop: vi.fn() }));
// Keep both core and event SDK real: the void-typed teardown returns a Promise.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) lifecycle.cleanups.push(cleanup); },
}));
vi.mock('./bridge', () => ({ desktopApi: {} }));
vi.mock('./utils', () => ({ errorMessage: () => 'synthetic sync failure' }));
vi.mock('./projectSyncScheduler', () => ({ startProjectSyncScheduler: () => ({ wake: lifecycle.wake, stop: lifecycle.stop, setRealtimeHealthy: vi.fn() }) }));
vi.mock('./companyRealtime', () => ({ startCompanyRealtime: () => ({ wake: lifecycle.realtimeWake, stop: lifecycle.realtimeStop }) }));
vi.mock('./companySync', () => ({ watchCompanyReceiveOpportunity: () => () => {} }));
function pending<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const settle = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };
const cleanup = () => { for (const stop of lifecycle.cleanups.splice(0)) stop(); };
async function mount() { (await import('./projectSync')).useProjectSyncBackground(vi.fn(), 'private-account-scope'); }
beforeEach(() => {
  vi.resetModules(); transport.invoke.mockReset(); transport.callbacks.clear(); transport.unregister.mockReset(); lifecycle.cleanups = [];
  lifecycle.wake.mockReset(); lifecycle.stop.mockReset(); lifecycle.realtimeWake.mockReset(); lifecycle.realtimeStop.mockReset();
  const windowTarget = new EventTarget(); Object.assign(windowTarget, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: transport.unregister },
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => command === 'append_diagnostic_events' ? Promise.resolve() : transport.invoke(command, args),
      transformCallback: (callback: (event: unknown) => void) => { transport.callbacks.set(71, callback); return 71; },
    },
  });
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('window', windowTarget); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); vi.stubGlobal('navigator', { onLine: true });
});
afterEach(async () => { cleanup(); await settle(); await (await import('./diagnostics')).flushDiagnostics(true); vi.unstubAllGlobals(); });
describe('project event SDK diagnostics', () => {
  it('records the original registration rejection before the best-effort catch', async () => {
    const original = new Error('403 token=private-secret alice@example.ch'); transport.invoke.mockRejectedValue(original);
    await mount(); await settle(); const d = await import('./diagnostics'), events = d.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([['company.event_listen', 'start'], ['company.event_listen', 'failure']]);
    expect(events[1].id).toBe(events[0].id); expect(events[1].errorCode).toBe('PERMISSION');
    expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/zentra-company-data-changed|private-secret|alice@example|private-account|token/);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('plugin:event|listen', { event: 'zentra-company-data-changed', target: { kind: 'Any' }, handler: 71 });
  });
  it('preserves event wakeups and records successful SDK teardown without payloads', async () => {
    transport.invoke.mockResolvedValue(42); await mount(); await settle();
    transport.callbacks.get(71)!({ payload: { email: 'alice@example.ch', document: 'private-document' } });
    expect(lifecycle.wake).toHaveBeenCalledOnce(); expect(lifecycle.realtimeWake).toHaveBeenCalledOnce();
    cleanup(); await settle(); transport.callbacks.get(71)!({ payload: 'private-document' });
    expect(lifecycle.wake).toHaveBeenCalledOnce(); expect(lifecycle.realtimeWake).toHaveBeenCalledOnce();
    expect(transport.unregister).toHaveBeenCalledExactlyOnceWith('zentra-company-data-changed', 42);
    expect(transport.invoke.mock.calls.at(-1)).toEqual(['plugin:event|unlisten', { event: 'zentra-company-data-changed', eventId: 42 }]);
    const events = (await import('./diagnostics')).recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([['company.event_listen', 'start'], ['company.event_listen', 'success'], ['company.event_unlisten', 'start'], ['company.event_unlisten', 'success']]);
    expect(JSON.stringify(events)).not.toMatch(/eventId|payload|private-document|alice@example|zentra-company-data-changed/);
  });
  it.each([false, true])('awaits a real SDK unlisten rejection, registration resolved after cleanup=%s', async late => {
    const registration = pending<number>(), removal = pending<void>(), original = new Error('network token=private-secret');
    transport.invoke.mockImplementation((command: string) => command === 'plugin:event|listen' ? registration.promise : removal.promise);
    await mount();
    if (late) cleanup(); registration.resolve(42); await settle(); if (!late) cleanup(); await settle();
    const d = await import('./diagnostics');
    expect(d.recentDiagnosticEvents().map(event => event.phase)).toEqual(['start', 'success', 'start']);
    removal.reject(original); await settle(); const events = d.recentDiagnosticEvents();
    expect(events.at(-1)).toMatchObject({ operation: 'company.event_unlisten', phase: 'failure', errorCode: 'NETWORK' });
    expect(events[3].id).toBe(events[2].id); expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[3].id}`);
    expect(transport.invoke.mock.calls.filter(call => call[0] === 'plugin:event|unlisten')).toHaveLength(1);
    expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(lifecycle.realtimeStop).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toMatch(/eventId|token|private-secret|private-account|zentra-company-data-changed/);
  });
});

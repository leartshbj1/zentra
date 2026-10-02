import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined), busy: false, failRecord: false,
  inspect: vi.fn<() => Promise<boolean>>(), load: vi.fn<() => Promise<string>>(), remove: vi.fn<() => Promise<void>>(),
  cancel: vi.fn(), unsubscribe: vi.fn(), progress: undefined as undefined | ((progress: { label: string; percent: number | null }) => void),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: controls.invoke }));
vi.mock('./payrollLocalAi', () => ({ payrollLocalAi: {
  isBusy: () => controls.busy, inspectModel: controls.inspect, load: controls.load, removeModel: controls.remove, cancel: controls.cancel,
  onProgress: (callback: typeof controls.progress) => { controls.progress = callback; return controls.unsubscribe; },
} }));
vi.mock('./diagnostics', async original => {
  const actual = await original<typeof import('./diagnostics')>();
  return { ...actual, recordDiagnostic: (...args: Parameters<typeof actual.recordDiagnostic>) => {
    if (controls.failRecord) throw new Error('synthetic journal accessor failure');
    return actual.recordDiagnostic(...args);
  } };
});

const preferenceKey = 'zentra.local-assistant.preference.v1';
const privateText = 'PRIVATE_customer@example.invalid password=PRIVATE_SECRET /private/model.bin';
let storage: Map<string, string>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const api = async () => ({ model: (await import('./localModelInstallation')).localModelInstallation, diagnostics: await import('./diagnostics') });
type Diagnostics = Awaited<ReturnType<typeof api>>['diagnostics'];
const events = (diagnostics: Diagnostics, operation?: string) => diagnostics.recentDiagnosticEvents().filter(event =>
  operation ? event.operation === operation : event.operation.startsWith('local_ai.'));
function pair(diagnostics: Diagnostics, operation: string, phase: 'success' | 'failure') {
  const found = events(diagnostics, operation);
  expect(found.map(event => event.phase)).toEqual(['start', phase]);
  expect(found[1].id).toBe(found[0].id);
  expect(found[1].area).toBe('app');
  expect(found[1].durationMs).toBeGreaterThanOrEqual(0);
  return found;
}
async function privateJournal(diagnostics: Diagnostics) {
  await diagnostics.flushDiagnostics(true);
  const journal = JSON.stringify({ recent: diagnostics.recentDiagnosticEvents(), native: controls.invoke.mock.calls });
  // Status digits can occur in UUIDs, timestamps and durations. The strict
  // event-key check below excludes a raw status field without random failures.
  expect(journal).not.toMatch(/PRIVATE_|customer@example|password|\/private\/|model\.bin|Préparation|Téléchargement|"enabled"|"later"|Qwen/);
  for (const event of diagnostics.recentDiagnosticEvents()) expect(Object.keys(event).sort()).toEqual(
    ['id', 'sessionId', 'timestamp', 'area', 'operation', 'phase', ...(event.durationMs === undefined ? [] : ['durationMs']), ...(event.errorCode === undefined ? [] : ['errorCode'])].sort());
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); storage = new Map();
  controls.busy = false; controls.failRecord = false; controls.progress = undefined;
  controls.invoke.mockReset().mockResolvedValue(undefined); controls.inspect.mockReset().mockResolvedValue(false); controls.load.mockReset().mockResolvedValue('webgpu'); controls.remove.mockReset().mockResolvedValue(undefined);
  controls.cancel.mockReset().mockImplementation(() => {}); controls.unsubscribe.mockReset().mockImplementation(() => {});
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  // The diagnostics mock wraps the real module, whose bounded memory survives resetModules.
  await (await import('./diagnostics')).diagnosticsApi.clear();
});
afterEach(async () => {
  const diagnostics = await import('./diagnostics'); await diagnostics.flushDiagnostics(true);
  vi.unstubAllGlobals(); vi.restoreAllMocks(); controls.failRecord = false;
});

describe('private diagnostics of the admitted local model operations', () => {
  it('accepts a valid diagnostic identifier containing digits from an HTTP status', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000429-0000-4000-8000-000000000001');
    const { model, diagnostics } = await api();
    await model.inspect();
    expect(events(diagnostics, 'local_ai.model_inspect')[0].id).toBe('00000429-0000-4000-8000-000000000001');
    await privateJournal(diagnostics);
  });

  it('records a single inspection, including the existing cached result', async () => {
    controls.inspect.mockResolvedValue(true);
    const { model, diagnostics } = await api();
    expect(model.getSnapshot()).toMatchObject({ phase: 'unknown', deferred: false });
    expect(events(diagnostics)).toEqual([]);
    await model.inspect();
    expect(controls.inspect).toHaveBeenCalledTimes(1); expect(model.getSnapshot().phase).toBe('installed');
    pair(diagnostics, 'local_ai.model_inspect', 'success');
    expect(storage.size).toBe(0); await privateJournal(diagnostics);
  });

  it('keeps the checking guard and does not admit a duplicate inspection', async () => {
    const held = deferred<boolean>(); controls.inspect.mockReturnValue(held.promise);
    const { model, diagnostics } = await api();
    const first = model.inspect(); await model.inspect();
    expect(controls.inspect).toHaveBeenCalledTimes(1); expect(model.getSnapshot().phase).toBe('checking');
    held.resolve(false); await first;
    expect(model.getSnapshot().phase).toBe('missing'); pair(diagnostics, 'local_ai.model_inspect', 'success');
  });

  it('retains the inspection rejection identity and its existing friendly message', async () => {
    const original = new Error(`network ${privateText}`); controls.inspect.mockRejectedValue(original);
    const { model, diagnostics } = await api(); await expect(model.inspect()).resolves.toBeUndefined();
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', error: 'Le téléchargement n’a pas abouti. Vérifiez votre connexion, puis réessayez.' });
    const found = pair(diagnostics, 'local_ai.model_inspect', 'failure'); expect(found[1].errorCode).toBe('NETWORK');
    expect(diagnostics.resolveErrorIncident(original).code).toBe(`ZT-${found[1].id}`); await privateJournal(diagnostics);
  });

  it('records one installation and preference write without tracing progress or duplicate requests', async () => {
    const held = deferred<string>(); controls.load.mockReturnValue(held.promise);
    const { model, diagnostics } = await api(); const first = model.install();
    expect(model.getSnapshot()).toMatchObject({ phase: 'installing', deferred: false });
    expect(storage.get(preferenceKey)).toBe('enabled');
    const count = events(diagnostics).length;
    controls.progress?.({ label: privateText, percent: 12 }); controls.progress?.({ label: privateText, percent: 97 });
    expect(model.getSnapshot()).toMatchObject({ label: privateText, percent: 97 }); expect(events(diagnostics)).toHaveLength(count);
    await model.install(); await model.inspect(); await model.remove();
    expect(controls.load).toHaveBeenCalledTimes(1); expect(controls.inspect).not.toHaveBeenCalled(); expect(controls.remove).not.toHaveBeenCalled();
    held.resolve('webgpu'); await first;
    expect(model.getSnapshot()).toMatchObject({ phase: 'installed', percent: 100 }); expect(controls.unsubscribe).toHaveBeenCalledTimes(1);
    pair(diagnostics, 'local_ai.model_load', 'success');
    const write = events(diagnostics, 'local_ai.preference_write'); expect(write.map(event => event.phase)).toEqual(['start', 'success']); expect(write[1].id).toBe(write[0].id);
    await privateJournal(diagnostics);
  });

  it('keeps a failed installation recoverable and preserves the provider error identity', async () => {
    const original = new Error(`disk ${privateText}`); controls.load.mockRejectedValueOnce(original).mockResolvedValueOnce('wasm');
    const { model, diagnostics } = await api(); await expect(model.install()).resolves.toBeUndefined();
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', error: 'Il manque de la place pour Qwen. Libérez de l’espace sur cet appareil, puis réessayez.' });
    const found = pair(diagnostics, 'local_ai.model_load', 'failure'); expect(found[1].errorCode).toBe('STORAGE');
    expect(diagnostics.resolveErrorIncident(original).code).toBe(`ZT-${found[1].id}`);
    await model.install(); expect(model.getSnapshot()).toMatchObject({ phase: 'installed', error: '' });
    expect(controls.load).toHaveBeenCalledTimes(2); expect(controls.unsubscribe).toHaveBeenCalledTimes(2);
    const loads = events(diagnostics, 'local_ai.model_load'); expect(loads.map(event => event.phase)).toEqual(['start', 'failure', 'start', 'success']); expect(loads[2].id).not.toBe(loads[0].id);
    await privateJournal(diagnostics);
  });

  it('keeps the removal admission guard and the successful session preference', async () => {
    const held = deferred<void>(); controls.remove.mockReturnValue(held.promise);
    const { model, diagnostics } = await api(); const first = model.remove();
    expect(model.getSnapshot().phase).toBe('removing'); await model.remove(); await model.inspect(); await model.install();
    expect(controls.remove).toHaveBeenCalledTimes(1); expect(controls.inspect).not.toHaveBeenCalled(); expect(controls.load).not.toHaveBeenCalled();
    held.resolve(); await first; expect(model.getSnapshot()).toMatchObject({ phase: 'missing', deferred: true }); expect(storage.get(preferenceKey)).toBe('later');
    pair(diagnostics, 'local_ai.model_remove', 'success');
    const write = events(diagnostics, 'local_ai.preference_write'); expect(write.map(event => event.phase)).toEqual(['start', 'success']); expect(write[1].id).toBe(write[0].id);
    await privateJournal(diagnostics);
  });

  it('retains a caught removal failure without writing a new preference', async () => {
    const original = new Error(`failure ${privateText}`); controls.remove.mockRejectedValue(original);
    const { model, diagnostics } = await api(); await expect(model.remove()).resolves.toBeUndefined();
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', error: original.message }); expect(storage.size).toBe(0);
    const found = pair(diagnostics, 'local_ai.model_remove', 'failure'); expect(diagnostics.resolveErrorIncident(original).code).toBe(`ZT-${found[1].id}`);
    expect(events(diagnostics, 'local_ai.preference_write')).toEqual([]); await privateJournal(diagnostics);
  });

  it('records only an admitted explicit cancellation and preserves generation-based UI suppression', async () => {
    const held = deferred<string>(); const stopped = new Error(`cancelled ${privateText}`);
    controls.load.mockReturnValueOnce(held.promise).mockResolvedValueOnce('webgpu'); controls.cancel.mockImplementation(() => held.reject(stopped));
    const { model, diagnostics } = await api(); model.cancel(); expect(events(diagnostics)).toEqual([]);
    const first = model.install(); model.cancel(); model.cancel(); await first;
    expect(controls.cancel).toHaveBeenCalledTimes(1); expect(model.getSnapshot()).toMatchObject({ phase: 'missing', percent: null, error: '' });
    expect(events(diagnostics, 'local_ai.model_cancel').map(event => event.phase)).toEqual(['info']); pair(diagnostics, 'local_ai.model_load', 'failure');
    expect(controls.unsubscribe).toHaveBeenCalledTimes(1); await model.install(); expect(model.getSnapshot().phase).toBe('installed'); expect(controls.load).toHaveBeenCalledTimes(2);
    await privateJournal(diagnostics);
  });

  it('records preference storage failure but keeps the current choice and later action usable', async () => {
    const original = new Error(`storage ${privateText}`); const write = vi.fn(() => { throw original; });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: write });
    const { model, diagnostics } = await api(); expect(model.later()).toBeUndefined();
    expect(model.getSnapshot()).toMatchObject({ phase: 'unknown', deferred: true, error: '' });
    expect(write).toHaveBeenCalledWith(preferenceKey, 'later');
    const found = events(diagnostics, 'local_ai.preference_write'); expect(found.map(event => event.phase)).toEqual(['start', 'failure']); expect(found[1]).toMatchObject({ id: found[0].id, errorCode: 'STORAGE' });
    expect(events(diagnostics, 'local_ai.model_later').map(event => event.phase)).toEqual(['info']); await privateJournal(diagnostics);
  });

  it('does not turn preference write failure into a failed installation or removal', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error(privateText); } });
    const { model, diagnostics } = await api(); await model.install(); expect(model.getSnapshot()).toMatchObject({ phase: 'installed', error: '', deferred: false });
    await model.remove(); expect(model.getSnapshot()).toMatchObject({ phase: 'missing', error: '', deferred: true });
    pair(diagnostics, 'local_ai.model_load', 'success'); pair(diagnostics, 'local_ai.model_remove', 'success');
    expect(events(diagnostics, 'local_ai.preference_write').map(event => event.phase)).toEqual(['start', 'failure', 'start', 'failure']); await privateJournal(diagnostics);
  });

  it('preserves boot preference read failure and provider-busy noops without inventing operations', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error(privateText); }, setItem: vi.fn() }); controls.busy = true;
    const { model, diagnostics } = await api(); expect(model.getSnapshot()).toMatchObject({ phase: 'unknown', deferred: false });
    await model.inspect(); await model.install(); await model.remove(); model.cancel();
    expect(controls.inspect).not.toHaveBeenCalled(); expect(controls.load).not.toHaveBeenCalled(); expect(controls.remove).not.toHaveBeenCalled(); expect(controls.cancel).not.toHaveBeenCalled();
    expect(events(diagnostics)).toEqual([]); await privateJournal(diagnostics);
  });

  it('keeps preference/session and admitted info actions intact if their logger fails', async () => {
    controls.failRecord = true;
    const held = deferred<string>(); controls.load.mockReturnValue(held.promise); controls.cancel.mockImplementation(() => held.reject(new Error('cancelled')));
    const { model, diagnostics } = await api();
    expect(() => model.later()).not.toThrow(); expect(storage.get(preferenceKey)).toBe('later'); expect(model.getSnapshot().deferred).toBe(true);
    const installing = model.install(); expect(storage.get(preferenceKey)).toBe('enabled'); expect(() => model.cancel()).not.toThrow(); await installing;
    expect(model.getSnapshot()).toMatchObject({ phase: 'missing', error: '', deferred: false }); expect(controls.cancel).toHaveBeenCalledTimes(1);
    expect(events(diagnostics, 'local_ai.preference_write')).toEqual([]); expect(events(diagnostics, 'local_ai.model_later')).toEqual([]); expect(events(diagnostics, 'local_ai.model_cancel')).toEqual([]);
  });
});

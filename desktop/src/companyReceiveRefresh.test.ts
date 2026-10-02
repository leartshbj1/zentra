import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeVolumeFixture } from '../tests/runtime-volume-fixture';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
vi.mock('react-dom', () => ({ flushSync: (run: () => void) => run() }));
vi.mock('./ui', () => ({ Button: () => null }));
vi.mock('./ErrorGuidance', () => ({ ErrorGuidance: () => null }));
import { desktopApi } from './bridge';
import { startProjectSyncScheduler } from './projectSyncScheduler';
import type { Workspace } from './types';

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  vi.stubGlobal('document', { activeElement: null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('decodes and presents a received company only once while retaining the changed signal', async () => {
  const received: Workspace[] = [];
  vi.stubGlobal('window', {
    dispatchEvent(event: Event) { if (event.type === 'zentra-company-workspace-received') received.push((event as CustomEvent<Workspace>).detail); },
    location: { reload: vi.fn() },
  });
  const local = { enabled: true, organizationId: 'company-one', revision: 1, pending: false, conflict: false };
  const raw = runtimeVolumeFixture(5);
  invoke.mockImplementation(async (command: string) => {
    if (command === 'get_company_sync_state') return local;
    if (command === 'sync_company_workspace') return { ...local, ready: true };
    if (command === 'apply_company_update') return { ...local, ready: false, revision: 2, changed: true };
    if (command === 'get_app_state') return { onboarding_completed: true, data_dir: '', app_version: 'test' };
    if (command === 'get_workspace') return raw;
    throw Error(`Unexpected command: ${command}`);
  });
  await import('./companySync');
  const refreshAgain = vi.fn(async () => { await desktopApi.loadWorkspace(); });
  const onStatus = vi.fn();
  const scheduler = startProjectSyncScheduler({
    local: async () => ({ pending: 0, syncing: false, documents: [] }),
    synchronize: desktopApi.syncProjectDocuments, isOnline: () => true,
    onStatus, onError: reason => { throw reason; }, onWorkspaceChanged: refreshAgain,
  });
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(received).toHaveLength(1);
    expect(received[0].invoices).toHaveLength(5);
    expect(invoke.mock.calls.filter(([command]) => command === 'get_workspace')).toHaveLength(1);
    expect(refreshAgain).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'business', changed: true, workspaceRefreshed: true }));
  } finally { scheduler.stop(); }
});

it('does not announce a delivered workspace when its reload failed after receiving data', async () => {
  const reload = vi.fn();
  const received = vi.fn();
  vi.stubGlobal('window', { dispatchEvent: received, location: { reload } });
  const local = { enabled: true, organizationId: 'company-one', revision: 1, pending: false, conflict: false };
  invoke.mockImplementation(async (command: string) => {
    if (command === 'get_company_sync_state') return local;
    if (command === 'sync_company_workspace') return { ...local, ready: true };
    if (command === 'apply_company_update') return { ...local, ready: false, revision: 2, changed: true };
    if (command === 'get_app_state') return { onboarding_completed: true, data_dir: '', app_version: 'test' };
    if (command === 'get_workspace') throw Error('Read interrupted');
    throw Error(`Unexpected command: ${command}`);
  });
  const onStatus = vi.fn();
  const onError = vi.fn();
  const scheduler = startProjectSyncScheduler({
    local: async () => ({ pending: 0, syncing: false, documents: [] }),
    synchronize: desktopApi.syncProjectDocuments, isOnline: () => true,
    onStatus, onError, onWorkspaceChanged: vi.fn(),
  });
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls.some(([status]) => status.workspaceRefreshed)).toBe(false);
    expect(received.mock.calls.some(([event]) => event.type === 'zentra-company-workspace-received')).toBe(false);
    const { companyReceiveAllowed } = await import('./companySync');
    expect(companyReceiveAllowed()).toBe(true);
  } finally { scheduler.stop(); }
});

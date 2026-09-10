import { beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import type { BusinessHistorySelection } from './businessCycleScheduler';

const selection: BusinessHistorySelection = {
  organization_id: 'org', installation_id: 'device', capture_generation: 'capture',
  generation: 'history', bootstrap_transfer_id: 'initial',
};
type Request = { request_id: string; selection: BusinessHistorySelection };
function channel() {
  return invokeMock.mock.calls[0][1].installationPermission as { onmessage: (request: Request) => void };
}

describe('native business installation permission channel', () => {
  beforeEach(() => { invokeMock.mockReset(); invokeMock.mockResolvedValue(undefined); });
  it('denies the final installation when the caller did not supply a UI guard', async () => {
    await desktopApi.syncBusinessCycle(selection, true);
    channel().onmessage({ request_id: 'permission', selection });
    expect(invokeMock).toHaveBeenLastCalledWith('respond_business_installation', { requestId: 'permission', allow: false });
  });
  it('forwards the current native request without granting permission automatically', async () => {
    const onRequest = vi.fn();
    await desktopApi.syncBusinessCycle(selection, true, { requestId: 'cycle-id', onRequest });
    const event = { request_id: 'permission-id', selection };
    channel().onmessage(event);
    expect(onRequest).toHaveBeenCalledExactlyOnceWith(event);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1].requestId).toBe('cycle-id');
    await desktopApi.respondBusinessInstallation(event.request_id, true);
    expect(invokeMock).toHaveBeenLastCalledWith('respond_business_installation', { requestId: 'permission-id', allow: true });
  });
  it('scopes cancellation to this invoke so another native operation keeps its lease', async () => {
    await desktopApi.pauseBusinessCycle('cycle-id');
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('pause_business_cycle', { requestId: 'cycle-id' });
  });
  it('binds an explicit resolution to its selected profile, exact proposal and scoped permission channel', async () => {
    const onRequest = vi.fn();
    await desktopApi.resolveBusinessConflict(selection, { transaction_id: 'transaction', resolution_id: 'proposal' }, 'cancel', { requestId: 'resolve-id', onRequest });
    expect(invokeMock.mock.calls[0][0]).toBe('resolve_business_conflict');
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ selection, transactionId: 'transaction', resolutionId: 'proposal', action: 'cancel', requestId: 'resolve-id' });
    channel().onmessage({ request_id: 'permission', selection });
    expect(onRequest).toHaveBeenCalledExactlyOnceWith({ request_id: 'permission', selection });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

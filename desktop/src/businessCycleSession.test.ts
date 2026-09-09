import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBusinessCyclePreference, startBusinessCycleSession, type BusinessInstallationRequest } from './businessCycleSession';
import type { BusinessCycleStatus, BusinessHistorySelection } from './businessCycleScheduler';

const selection: BusinessHistorySelection = {
  organization_id: 'org', installation_id: 'device', capture_generation: 'capture',
  generation: 'history', bootstrap_transfer_id: 'initial',
};
const status = (state: BusinessCycleStatus['state']): BusinessCycleStatus => ({ state, selection, workspace_changed: state === 'installed', detail: null, replication_active: false });
function fixture() {
  let finish!: (status: BusinessCycleStatus) => void;
  let fail!: (reason: unknown) => void;
  let request!: (request: BusinessInstallationRequest) => void;
  let canInstall = true, online = true, current = true, locked = false;
  const order: string[] = [];
  const release = vi.fn(() => { locked = false; order.push('release'); });
  const lockFailed = vi.fn();
  const acquire = vi.fn(() => { locked = true; order.push('lock'); return { release, failed: lockFailed }; });
  const synchronize = vi.fn((_selection, _install, permission) => {
    request = permission.onRequest;
    return new Promise<BusinessCycleStatus>((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const respond = vi.fn(async (_id: string, allow: boolean) => { order.push(`answer:${allow}:${locked}`); return true; });
  const refresh = vi.fn(async () => { order.push(`refresh:${locked}`); });
  const pause = vi.fn(async (_id: string) => {});
  const onStatus = vi.fn(), onError = vi.fn();
  const session = startBusinessCycleSession({
    selection, synchronize, respond, pause, acquire, refreshWorkspace: refresh, onStatus, onError,
    isOnline: () => online, canInstall: () => canInstall, isCurrent: () => current, createRequestId: () => 'invoke-1',
  });
  return {
    session, synchronize, respond, refresh, pause, acquire, release, lockFailed, onStatus, onError, order,
    locked: () => locked,
    edit: () => { canInstall = false; }, offline: () => { online = false; }, detach: () => { current = false; },
    ask: (other = selection) => request({ request_id: 'permission-1', selection: other }),
    finish: (value = status('installed')) => finish(value), fail: () => fail(new Error('Native reply lost after commit')),
  };
}
describe('business sync installation session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('rechecks a form opened while the native reception was being prepared', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.synchronize.mock.calls[0][1]).toBe(true);
    f.edit(); f.ask(); f.finish(status('awaiting_installation'));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith('permission-1', false);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    await f.session.stop();
  });
  it('locks synchronously before permission and releases only after native completion and refresh', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(300);
    f.ask();
    expect(f.locked()).toBe(true);
    expect(f.order).toEqual(['lock', 'answer:true:true']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.release).not.toHaveBeenCalled();
    f.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.order).toEqual(['lock', 'answer:true:true', 'refresh:true', 'release']);
    expect(f.onStatus).toHaveBeenCalledWith(status('installed'));
    await f.session.stop();
  });
  it('does not unlock on an expired answer, a duplicate request or an uncertain native outcome', async () => {
    const f = fixture();
    f.respond.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(300);
    f.ask(); f.ask();
    expect(f.respond.mock.calls.map(call => call[1])).toEqual([true, false]);
    expect(f.acquire).toHaveBeenCalledTimes(1);
    f.fail();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    await f.session.stop();
  });
  it('retains the editing barrier on a read failure and retries the read even when offline', async () => {
    const f = fixture();
    f.refresh.mockRejectedValueOnce(new Error('Database temporarily unreadable'));
    await vi.advanceTimersByTimeAsync(300);
    f.ask(); f.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.locked()).toBe(true);
    expect(f.lockFailed).toHaveBeenCalledTimes(1);
    f.offline();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.synchronize).toHaveBeenCalledTimes(1);
    expect(f.locked()).toBe(false);
    await f.session.stop();
  });
  it('pauses the exact native invoke and drains its refresh before resolving', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(300);
    f.ask();
    let drained = false;
    const stopping = f.session.stop().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.pause).toHaveBeenCalledExactlyOnceWith('invoke-1');
    expect(drained).toBe(false);
    f.ask(); expect(f.respond).toHaveBeenLastCalledWith('permission-1', false);
    f.finish(); await stopping;
    expect(f.locked()).toBe(false);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.onStatus).not.toHaveBeenCalled();
  });
  it('denies a different history and late events after the window detaches', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(300);
    f.ask({ ...selection, capture_generation: 'restored-copy' });
    f.detach(); f.ask();
    const stopping = f.session.stop();
    f.finish(status('awaiting_installation')); await stopping;
    f.ask();
    expect(f.respond.mock.calls.every(call => !call[1])).toBe(true);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.onStatus).not.toHaveBeenCalled();
  });
  it('keeps a manual pause locked after a read failure until retry succeeds', async () => {
    const f = fixture();
    f.refresh.mockRejectedValue(new Error('Read interrupted'));
    await vi.advanceTimersByTimeAsync(300);
    f.ask(); f.finish();
    await vi.advanceTimersByTimeAsync(1);
    await expect(f.session.stop()).rejects.toThrow('Read interrupted');
    expect(f.locked()).toBe(true);
    f.refresh.mockResolvedValue(undefined);
    await f.session.refresh();
    expect(f.locked()).toBe(false);
  });
  it('does not issue a generic pause when no native call is running', async () => {
    const f = fixture();
    await f.session.stop();
    expect(f.pause).not.toHaveBeenCalled();
  });
});

describe('explicit device preference', () => {
  it('requires all five native history identifiers and rejects unknown or damaged data', () => {
    expect(parseBusinessCyclePreference(JSON.stringify(selection))).toEqual(selection);
    for (const value of [null, '', '{', 'null', JSON.stringify({ organization_id: 'org' }), JSON.stringify({ ...selection, generation: '' }), JSON.stringify({ ...selection, unknown: true })])
      expect(parseBusinessCyclePreference(value)).toBeNull();
  });
});

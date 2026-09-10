import { describe, expect, it, vi } from 'vitest';
import { startBusinessResolutionSession, validateBusinessResolutionResult, type BusinessResolutionResult } from './businessResolutionSession';
import type { BusinessInstallationRequest } from './businessCycleSession';
const selection = { organization_id: 'org', installation_id: 'device', generation: 'history', capture_generation: 'before', bootstrap_transfer_id: 'initial' };
function fixture() {
  let current = true, locked = false, ask: (request: BusinessInstallationRequest) => void;
  let finish!: (result: BusinessResolutionResult) => void, fail!: (reason: unknown) => void;
  const result: BusinessResolutionResult = { transaction_id: 'transaction', resolution_id: 'resolution', state: 'resolution_installed',
    selection: { ...selection, capture_generation: 'after' }, installed: true, workspace_changed: true };
  const release = vi.fn(() => { locked = false; });
  const failed = vi.fn();
  const refresh = vi.fn(async () => { expect(locked).toBe(true); });
  const invoke = vi.fn(permission => { ask = permission.onRequest; return new Promise<BusinessResolutionResult>((yes, no) => { finish = yes; fail = no; }); });
  const respond = vi.fn(async (_id: string, allow: boolean) => { if (allow) expect(locked).toBe(true); return true; });
  const pause = vi.fn(async () => {});
  const options = { selection, invoke, respond, pause, refresh, isCurrent: () => current, canInstall: () => true,
    acquire: () => { locked = true; return { release, failed }; }, createRequestId: () => 'native-request' };
  return { options, result, release, failed, refresh, invoke, respond, pause, locked: () => locked,
    detach: () => { current = false; }, finish: () => finish(result), fail: () => fail(new Error('Réponse perdue')),
    ask: (id: string, selected = selection) => ask({ request_id: id, selection: selected }) };
}
describe('explicit conflict resolution lifecycle', () => {
  it('does not mistake an absent or contradictory outcome for an installation', () => {
    const { result } = fixture();
    expect(() => validateBusinessResolutionResult(result, result)).not.toThrow();
    for (const patch of [{ installed: false }, { cancelled: true }, { resolution_id: 'other' }, { workspace_changed: false }])
      expect(() => validateBusinessResolutionResult({ ...result, ...patch }, result)).toThrow('incohérente');
  });
  it('gates drafts before invoking, then grants both freeze and install under one barrier', async () => {
    const f = fixture();
    expect(() => startBusinessResolutionSession({ ...f.options, canInstall: () => false })).toThrow('Terminez');
    expect(f.invoke).not.toHaveBeenCalled();
    const s = startBusinessResolutionSession(f.options);
    f.ask('freeze'); f.ask('install'); f.ask('install');
    expect(f.respond.mock.calls.map(c => c[1])).toEqual([true, true, false]);
    expect(f.release).not.toHaveBeenCalled();
    f.finish(); expect(await s.done).toEqual(f.result);
    expect(f.refresh).toHaveBeenCalledTimes(1); expect(f.locked()).toBe(false);
  });
  it('denies another selection and late permission after a lost response', async () => {
    const f = fixture(), s = startBusinessResolutionSession(f.options);
    f.ask('foreign', { ...selection, organization_id: 'other' });
    expect(f.respond).toHaveBeenLastCalledWith('foreign', false);
    f.fail(); await expect(s.done).rejects.toThrow('Réponse perdue');
    f.ask('late'); expect(f.respond).toHaveBeenLastCalledWith('late', false);
    expect(f.refresh).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('retains a failed reload barrier and retries only the read after an acknowledged install', async () => {
    const f = fixture(); f.refresh.mockRejectedValueOnce(new Error('Lecture indisponible'));
    const s = startBusinessResolutionSession(f.options); f.finish();
    await expect(s.done).rejects.toThrow('Lecture indisponible');
    expect(f.locked()).toBe(true);
    await f.failed.mock.calls[0][1]();
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.refresh).toHaveBeenCalledTimes(2); expect(f.locked()).toBe(false);
  });
  it('pauses the exact request and drains it on account replacement without granting more permission', async () => {
    const f = fixture(), s = startBusinessResolutionSession(f.options);
    f.detach(); const stopped = s.stop(); f.ask('detached');
    expect(f.respond).toHaveBeenLastCalledWith('detached', false);
    expect(f.pause).toHaveBeenCalledWith('native-request'); expect(f.locked()).toBe(true);
    f.finish(); await stopped; expect(f.locked()).toBe(false);
  });
});

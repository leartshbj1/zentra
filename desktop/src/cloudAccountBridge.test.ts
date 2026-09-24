import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';

const account = { status: 'connected', organizationId: 'company-a', role: 'owner' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { invoke.mockReset(); vi.stubGlobal('window', { dispatchEvent: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());

it('shares concurrent app/panel checks, then freshly observes revocation', async () => {
  const response = deferred<typeof account>();
  invoke.mockReturnValueOnce(response.promise).mockResolvedValueOnce({ status: 'disconnected' });
  const app = desktopApi.getCloudAccountState();
  const panel = desktopApi.getCloudAccountState();
  expect(panel).toBe(app);
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  response.resolve(account);
  await expect(panel).resolves.toMatchObject(account);
  await expect(desktopApi.getCloudAccountState()).resolves.toMatchObject({ status: 'disconnected' });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(['start', 'disconnect', 'reset'] as const)('does not reuse checks from before or during %s', async operation => {
  const old = deferred<typeof account>();
  const during = deferred<typeof account>();
  const after = deferred<typeof account>();
  const mutation = deferred<unknown>();
  let read = 0;
  invoke.mockImplementation(command => command === 'get_cloud_account_state'
    ? [old, during, after][read++].promise : mutation.promise);
  const previous = desktopApi.getCloudAccountState();
  await Promise.resolve();
  const change = operation === 'start' ? desktopApi.startCloudAccountLink()
    : operation === 'reset' ? desktopApi.resetLocalApp('test') : desktopApi.disconnectCloudAccount();
  const intermediate = desktopApi.getCloudAccountState();
  expect(intermediate).not.toBe(previous);
  await Promise.resolve();
  mutation.resolve(operation === 'start' ? { status: 'pending' } : { reset: true });
  await change;
  const fresh = desktopApi.getCloudAccountState();
  await Promise.resolve();
  expect(fresh).not.toBe(intermediate);
  old.resolve(account); during.resolve(account);
  await Promise.all([previous, intermediate]);
  // Late cleanup from an older read must not evict the current flight.
  expect(desktopApi.getCloudAccountState()).toBe(fresh);
  after.resolve({ ...account, organizationId: 'company-b' });
  await expect(fresh).resolves.toMatchObject({ organizationId: 'company-b' });
  expect(read).toBe(3);
});

it('an approved company switch starts a fresh check without waiting for the old one', async () => {
  const old = deferred<typeof account>();
  invoke.mockImplementation(command => command === 'get_cloud_account_state' ? old.promise : Promise.resolve({ ...account, organizationId: 'company-b' }));
  const previous = desktopApi.getCloudAccountState();
  await Promise.resolve();
  await desktopApi.pollCloudAccountLink();
  invoke.mockResolvedValue({ ...account, organizationId: 'company-b' });
  await expect(desktopApi.getCloudAccountState()).resolves.toMatchObject({ organizationId: 'company-b' });
  old.resolve(account); await previous;
  expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
});

it('a failed read or account mutation can be retried immediately', async () => {
  invoke.mockRejectedValueOnce(Error('network'));
  await expect(desktopApi.getCloudAccountState()).rejects.toThrow('network');
  invoke.mockRejectedValueOnce(Error('logout failed'));
  await expect(desktopApi.disconnectCloudAccount()).rejects.toThrow('logout failed');
  invoke.mockResolvedValueOnce(account);
  await expect(desktopApi.getCloudAccountState()).resolves.toMatchObject(account);
  expect(invoke).toHaveBeenCalledTimes(3);
});

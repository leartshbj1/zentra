import { expect, it, vi } from 'vitest';
import { loadCloudAccountPanel } from './cloudAccountOpening';
import type { CloudAccountState } from './bridge';

const account: CloudAccountState = { status: 'connected', organizationId: 'company-a', role: 'owner' };
const observer = () => ({ local: vi.fn(), verified: vi.fn(), failed: vi.fn() });

it('shows the local account while Internet is pending, then applies a revoked session', async () => {
  let complete!: (account: CloudAccountState) => void;
  const api = {
    getCachedCloudAccountState: vi.fn().mockResolvedValue(account),
    getCloudAccountState: vi.fn(() => new Promise<CloudAccountState>(resolve => { complete = resolve; })),
  };
  const view = observer();
  const pending = loadCloudAccountPanel(api, view);
  await Promise.resolve();
  expect(view.local).toHaveBeenCalledWith(account);
  expect(view.verified).not.toHaveBeenCalled();
  complete({ status: 'disconnected' });
  await pending;
  expect(view.verified).toHaveBeenCalledWith({ status: 'disconnected' });
  expect(api.getCloudAccountState).toHaveBeenCalledTimes(1);
});

it('retains the local identity during a network failure without declaring it verified', async () => {
  const view = observer(), reason = Error('network');
  await loadCloudAccountPanel({
    getCachedCloudAccountState: async () => account,
    getCloudAccountState: async () => { throw reason; },
  }, view);
  expect(view.local).toHaveBeenCalledWith(account);
  expect(view.verified).not.toHaveBeenCalled();
  expect(view.failed).toHaveBeenCalledWith(reason, true);
});

it('recovers online when the protected local record cannot be read', async () => {
  const view = observer();
  await loadCloudAccountPanel({
    getCachedCloudAccountState: async () => { throw Error('local'); },
    getCloudAccountState: async () => account,
  }, view);
  expect(view.local).not.toHaveBeenCalled();
  expect(view.verified).toHaveBeenCalledWith(account);
  expect(view.failed).not.toHaveBeenCalled();
});

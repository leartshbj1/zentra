import { beforeEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({
  token: 'fixture-scheduler-secret',
  db: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: runtime.db,
  runtimeValue: () => runtime.token,
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
import { requireMailScheduler } from './mail-sync';
beforeEach(() => {
  runtime.token = 'fixture-scheduler-secret';
  vi.clearAllMocks();
});
it.each(['', 'Bearer wrong', 'Basic fixture-scheduler-secret'])(
  'rejects unauthorized header %j without touching stored data',
  async (authorization) => {
    await expect(
      requireMailScheduler(
        new Request('https://zentraapp.ch/api/support/mail-sync', {
          headers: { authorization },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(runtime.db).not.toHaveBeenCalled();
  },
);
it('accepts the scheduler credential and never accepts it in the URL', async () => {
  await expect(
    requireMailScheduler(
      new Request('https://zentraapp.ch/api/support/mail-sync', {
        headers: { authorization: 'Bearer fixture-scheduler-secret' },
      }),
    ),
  ).resolves.toBeUndefined();
  await expect(
    requireMailScheduler(
      new Request(
        'https://zentraapp.ch/api/support/mail-sync?token=fixture-scheduler-secret',
      ),
    ),
  ).rejects.toMatchObject({ status: 401 });
});
it('fails closed when no scheduler credential is configured', async () => {
  runtime.token = '';
  await expect(
    requireMailScheduler(
      new Request('https://zentraapp.ch/api/support/mail-sync', {
        headers: { authorization: 'Bearer fixture-scheduler-secret' },
      }),
    ),
  ).rejects.toMatchObject({ status: 401 });
});

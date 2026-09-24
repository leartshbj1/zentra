import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ first: vi.fn(), run: vi.fn(), prepare: vi.fn(), seat: vi.fn(), until: vi.fn() }));
vi.mock('./runtime', () => ({ database: () => ({ prepare: mocks.prepare }) }));
vi.mock('./team-seats', () => ({ requireMemberSeat: mocks.seat }));
vi.mock('./founder-access', () => ({ effectiveAccountUntil: mocks.until }));
import { requireDeviceSession } from './account';

const now = 1_790_200_000;
const row = { session_id:'session-a', organization_id:'org-a', user_id:'user-a', installation_id:'device-a', organization_name:'Atelier', subscription_id:'sub-a', role:'member', entitlement_valid_until:now+3600, last_seen_at:now };
const request = () => new Request('https://zentra.test/api/automation', {headers:{Authorization:`Bearer zds_${'a'.repeat(43)}`}});
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now*1000);
  mocks.prepare.mockReturnValue({bind:() => ({first:mocks.first,run:mocks.run})});
  mocks.first.mockResolvedValue({...row});
  mocks.until.mockResolvedValue(now+3600);
  mocks.seat.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({success:true});
});
afterEach(() => vi.restoreAllMocks());

it('checks membership and subscription freshly on every request without rewriting a recent timestamp', async () => {
  for(let i=0;i<3;i++) await expect(requireDeviceSession(request())).resolves.toMatchObject({organizationId:'org-a',role:'member'});
  expect(mocks.first).toHaveBeenCalledTimes(3);
  expect(mocks.until).toHaveBeenCalledTimes(3);
  expect(mocks.seat).toHaveBeenCalledTimes(3);
  expect(mocks.run).not.toHaveBeenCalled();
  const sql=mocks.prepare.mock.calls[0][0];
  for(const guard of ['session.last_seen_at','session.revoked_at IS NULL','session.expires_at>=?','activation.revoked_at IS NULL','member.revoked_at IS NULL']) expect(sql).toContain(guard);
});
it.each([now-301,0,undefined])('refreshes older or unavailable timestamps (%s)', async last_seen_at => {
  mocks.first.mockResolvedValue({...row,last_seen_at});
  await requireDeviceSession(request());
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenLastCalledWith('UPDATE device_sessions SET last_seen_at=? WHERE session_id=? AND last_seen_at<?');
});
it.each([now,now-300])('keeps the five-minute boundary (%s)', async last_seen_at => {
  mocks.first.mockResolvedValue({...row,last_seen_at});
  await requireDeviceSession(request());
  expect(mocks.run).not.toHaveBeenCalled();
});
it('never accepts a revoked session just because it was recently seen', async () => {
  await requireDeviceSession(request());
  mocks.first.mockResolvedValue(null);
  await expect(requireDeviceSession(request())).rejects.toMatchObject({status:401});
});
it('still rejects expired subscriptions, missing seats and insufficient roles', async () => {
  mocks.until.mockResolvedValue(now-1);
  await expect(requireDeviceSession(request())).rejects.toMatchObject({status:402});
  mocks.until.mockResolvedValue(now+3600);
  mocks.seat.mockRejectedValueOnce(new Error('seat revoked'));
  await expect(requireDeviceSession(request())).rejects.toThrow('seat revoked');
  await expect(requireDeviceSession(request(),['owner'])).rejects.toMatchObject({status:403});
  expect(mocks.run).not.toHaveBeenCalled();
});

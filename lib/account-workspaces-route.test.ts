import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({user:vi.fn(),discover:vi.fn(),enabled:vi.fn()}));
vi.mock('@/app/zentra-auth', () => ({getZentraUser:mock.user}));
vi.mock('@/lib/account-workspaces', async original => ({...await original<typeof import('./account-workspaces')>(),accountWorkspacesForUser:mock.discover,accountWorkspaceDiscoveryEnabled:mock.enabled}));
import { GET } from '../app/api/account/workspaces/route';
import { AccountWorkspaceDiscoveryError } from './account-workspaces';

const actor = '11111111-1111-4111-8111-111111111111';
const workspaces = [{organizationId:'ch-company',name:'Untranslated CH',edition:'ch_legacy',role:'owner'},{organizationId:'33333333-3333-4333-8333-333333333333',name:'Untranslated US',edition:'us_experimental',role:'read_only'}];
function request(headers: Record<string,string> = {}, query = '') { return new Request('https://zentra.test/api/account/workspaces'+query,{headers}); }
beforeEach(() => {vi.resetAllMocks();mock.user.mockResolvedValue({userId:actor});mock.discover.mockResolvedValue(workspaces);mock.enabled.mockResolvedValue(true);});
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});
  expect(response.headers.get('Cache-Control')).toContain('no-store');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}
it.each(['','Bearer device-CH','Basic arbitrary'])('rejects Authorization %j before authentication and discovery',async authorization => {
  await error(await GET(request({Authorization:authorization})),401,'browser_session_required');expect(mock.user).not.toHaveBeenCalled();expect(mock.discover).not.toHaveBeenCalled();
});
const crossOriginHeaders: Record<string,string>[] = [{Origin:'https://foreign.test'},{'Sec-Fetch-Site':'cross-site'}];
it.each(crossOriginHeaders)('rejects cross-origin GET before Auth and SQL (%j)',async headers => {
  await error(await GET(request(headers)),403,'forbidden');expect(mock.user).not.toHaveBeenCalled();expect(mock.discover).not.toHaveBeenCalled();
});
it('requires browser authentication before discovery',async () => {mock.user.mockResolvedValue(null);await error(await GET(request()),401,'unauthorized');expect(mock.discover).not.toHaveBeenCalled();});
it('uses the authenticated actor only and rechecks the same account with offered access disabled',async () => {
  const response=await GET(request({},'?userId=foreign&organizationId=foreign&country=US'));expect(response.status).toBe(200);expect(await response.json()).toEqual({workspaces});
  expect(mock.discover).toHaveBeenCalledExactlyOnceWith(actor);expect(mock.user).toHaveBeenCalledTimes(2);for(const call of mock.user.mock.calls)expect(call).toEqual([{offerAccess:false}]);
  expect(response.headers.get('Cache-Control')).toContain('no-store');expect(response.headers.get('Pragma')).toBe('no-cache');
});
it.each([null,{userId:'99999999-9999-4999-8999-999999999999'}])('never returns metadata after the browser session changed (%j)',async fresh => {
  mock.user.mockResolvedValueOnce({userId:actor}).mockResolvedValueOnce(fresh);await error(await GET(request()),401,'session_changed');expect(mock.discover).toHaveBeenCalledExactlyOnceWith(actor);
});
it('rechecks closed flags after Auth and keeps only CH descriptors',async () => {mock.enabled.mockResolvedValue(false);const response=await GET(request());expect(await response.json()).toEqual({workspaces:[workspaces[0]]});});
it('serializes only the four metadata fields even if an internal reader accidentally returns extras',async () => {
  mock.discover.mockResolvedValue([{...workspaces[0],subscriptionId:'private',authority:{evidence:{referenceId:'private'}},receipt:'private',ein:'private'}]);const response=await GET(request());expect(await response.json()).toEqual({workspaces:[workspaces[0]]});
});
it.each(['database','session','flags'] as const)('maps %s failures to stable no-store errors without upstream detail',async source => {
  const failure=new Error('secret SQL/provider detail');if(source==='database')mock.discover.mockRejectedValue(failure);if(source==='session')mock.user.mockResolvedValueOnce({userId:actor}).mockRejectedValueOnce(failure);if(source==='flags')mock.enabled.mockRejectedValue(failure);
  await error(await GET(request()),503,'service_unavailable');
});
it('does not turn a missing enabled schema into an empty successful list',async () => {mock.discover.mockRejectedValue(new AccountWorkspaceDiscoveryError());await error(await GET(request()),503,'service_unavailable');});

import { describe, expect, it, vi } from 'vitest';
import type { AccountWorkspace } from '../account-workspaces';
import { loadUsApprovalPage, type UsApprovalPagePorts } from './us-device-approval-page';
import { usApprovalCopy, usApprovalError } from './us-device-approval-copy';

const userId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const row: AccountWorkspace = { organizationId, name:'Fictitious US company', edition:'us_experimental', role:'owner' };
function fixture() {
  const enabled = vi.fn(async () => true), user = vi.fn(async () => ({ userId, email:'fictitious@example.test' })), discover = vi.fn(async () => [row]);
  return { enabled, user, discover };
}
describe('US device authorization page scope', () => {
  it('keeps the disabled rollout closed without Auth or workspace reads', async () => { const f=fixture(); f.enabled.mockResolvedValue(false); expect((await loadUsApprovalPage(f,{})).status).toBe('disabled'); expect(f.user).not.toHaveBeenCalled(); expect(f.discover).not.toHaveBeenCalled(); });
  it('preserves bounded code and language through explicit sign-in', async () => {
    const f: UsApprovalPagePorts={...fixture(),user:async()=>null}; const s=await loadUsApprovalPage(f,{code:'abcd-efgh',lang:'de'});
    expect(s).toEqual({ status:'unauthenticated',language:'de',initialCode:'abcd-efgh',returnTo:'/appareil/us?lang=de&code=abcd-efgh' });
  });
  it('displays US discovery only and strips private or unrecognized columns', async () => {
    const f=fixture(); f.discover.mockResolvedValue([{...row,secret:'never-display',ein:'private'} as AccountWorkspace,{...row,organizationId:'ch-id',edition:'ch_legacy'}]);
    const s=await loadUsApprovalPage(f,{lang:'en'}); expect(s.status).toBe('ready'); if(s.status!=='ready') throw new Error();
    expect(s.workspaces).toEqual([row]); expect(Object.isFrozen(s.workspaces)).toBe(true); expect(Object.isFrozen(s.workspaces[0])).toBe(true); expect(s.user).toEqual({userId,email:'fictitious@example.test'}); expect(f.user).toHaveBeenCalledTimes(2);
  });
  it('discards discovery if the signed-in user changes while loading', async () => { const f=fixture(); f.user.mockResolvedValueOnce({userId,email:'first@example.test'}).mockResolvedValueOnce({userId:organizationId,email:'other@example.test'}); const s=await loadUsApprovalPage(f,{}); expect(s.status).toBe('unauthenticated'); expect('workspaces' in s).toBe(false); });
  it('closes the page if rollout closes after a discovery read', async () => { const f=fixture(); f.enabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false); expect((await loadUsApprovalPage(f,{})).status).toBe('disabled'); });
  it.each(['duplicate','bad-id','bad-role','long-name','control-name'] as const)('rejects %s discovery metadata', async kind => {
    const f=fixture(); const invalid={...row,...(kind==='bad-id'?{organizationId:'bad'}:kind==='bad-role'?{role:'super-user'}:kind==='long-name'?{name:'x'.repeat(161)}:kind==='control-name'?{name:'secret\ncompany'}:{})} as AccountWorkspace;
    f.discover.mockResolvedValue(kind==='duplicate'?[row,row]:[invalid]); const s=await loadUsApprovalPage(f,{}); expect(s.status).toBe('unavailable'); expect('workspaces' in s).toBe(false);
  });
  it.each(['initial','fresh'] as const)('rejects malformed %s public identity', async moment=> { const f=fixture(); if(moment==='initial') f.user.mockResolvedValue({userId,email:'bad\nmail'}); else f.user.mockResolvedValueOnce({userId,email:'first@example.test'}).mockResolvedValueOnce({userId,email:'bad\nmail'}); expect((await loadUsApprovalPage(f,{})).status).toBe('unavailable'); });
  it('keeps an empty discovery ready and uses fresh public email', async()=>{const f=fixture();f.discover.mockResolvedValue([]); f.user.mockResolvedValueOnce({userId,email:'old@example.test'}).mockResolvedValueOnce({userId,email:'new@example.test'}); const s=await loadUsApprovalPage(f,{code:'x'.repeat(33),lang:'xx'}); expect(s).toEqual({status:'ready',language:'fr',initialCode:'',returnTo:'/appareil/us?lang=fr',user:{userId,email:'new@example.test'},workspaces:[]});});
  it.each(['fr','de','it','en'] as const)('has complete %s copy without exposing arbitrary server errors',language=>{ expect(Object.keys(usApprovalCopy[language])).toEqual(Object.keys(usApprovalCopy.fr)); expect(Object.values(usApprovalCopy[language]).every(value=>value.length>0)).toBe(true); expect(usApprovalError(language,'raw-database-password')).toBe(usApprovalCopy[language].retry); expect(usApprovalError(language,'session_changed')).toBe(usApprovalCopy[language].session); });
});

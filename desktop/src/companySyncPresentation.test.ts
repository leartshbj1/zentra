import { describe, expect, it } from 'vitest';
import { companySyncPresentation, validCompanySyncTime } from './companySyncPresentation';
const now=Date.parse('2026-09-25T10:00:00Z');
const base={enabled:true, organizationId:'company-a', revision:8, pending:false, conflict:false, lastSyncedAt:new Date(now-5000).toISOString()};
const present=(patch:Partial<typeof base>&{error?:string;ready?:boolean}={},organization='company-a',online=true)=>companySyncPresentation({...base,...patch},organization,online,now);
describe('truthful synchronization status',()=>{
  it('reports a stalled verification without calling it a successful data transfer',()=>{
    const stalled={...base,checkedAt:now-91_000,checkingSince:now-120_000};
    expect(companySyncPresentation(stalled,'company-a',true,now).kind).toBe('delayed');
    expect(companySyncPresentation({...stalled,pending:true},'company-a',true,now).kind).toBe('delayed');
    expect(companySyncPresentation({...stalled,checkedAt:now},'company-a',true,now).kind).toBe('current');
    expect(companySyncPresentation({...stalled,ready:true},'company-a',true,now).kind).toBe('waiting');
    expect(companySyncPresentation({...stalled,receiving:true},'company-a',true,now).kind).toBe('receiving');
    expect(companySyncPresentation({...stalled,error:'Service indisponible'},'company-a',true,now).kind).toBe('attention');
    expect(companySyncPresentation(stalled,'company-a',false,now).kind).toBe('offline');
  });
  it('allows the first check to finish and never trusts malformed or future times',()=>{
    const opening={...base,lastSyncedAt:undefined,checkingSince:now};
    expect(companySyncPresentation(opening,'company-a',true,now).kind).toBe('checking');
    expect(companySyncPresentation(opening,'company-a',true,now+91_000).kind).toBe('delayed');
    for(const invalid of [undefined,'invalid',NaN,0,-1,now+10_000])expect(validCompanySyncTime(invalid,now)).toBeUndefined();
    expect(validCompanySyncTime(base.lastSyncedAt,now)).toBe(now-5000);
  });
  it('never reports a different company, an old state, or no connection as up to date',()=>{
    expect(present({},'company-b').kind).toBe('checking');
    expect(present({lastSyncedAt:new Date(now-91000).toISOString()}).kind).toBe('checking');
    expect(present({lastSyncedAt:undefined}).kind).toBe('checking');
    expect(present({},'company-a',false).kind).toBe('offline');
  });
  it('gives conflicts and failures priority over the queue',()=>{
    expect(companySyncPresentation({...base,lastSyncedAt:'2026-08-01T00:00:00Z',checkedAt:now-60_000},'company-a',true,now).kind).toBe('current');
    expect(present({conflict:true,pending:true}).kind).toBe('attention');
    expect(present({error:'401',pending:true}).kind).toBe('attention');
    expect(present({pending:true}).kind).toBe('sending');
    expect(present({ready:true}).kind).toBe('waiting');
    expect(companySyncPresentation({...base, ready:true, receiving:true}, 'company-a', true, now).kind).toBe('receiving');
    expect(companySyncPresentation({...base, ready:true, settingsDraft:true}, 'company-a', true, now).detail).toBe('Enregistrez vos modifications, puis quittez les paramètres pour recevoir les nouveautés de votre équipe.');
    expect(present().kind).toBe('current');
  });
});

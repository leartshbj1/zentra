import { describe, expect, it } from 'vitest';
import { companySyncPresentation } from './companySyncPresentation';
const now=Date.parse('2026-09-25T10:00:00Z');
const base={enabled:true, organizationId:'company-a', revision:8, pending:false, conflict:false, lastSyncedAt:new Date(now-5000).toISOString()};
const present=(patch:Partial<typeof base>&{error?:string;ready?:boolean}={},organization='company-a',online=true)=>companySyncPresentation({...base,...patch},organization,online,now);
describe('truthful synchronization status',()=>{
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
    expect(present({ready:true}).kind).toBe('receiving');
    expect(present().kind).toBe('current');
  });
});

import { afterEach,describe,expect,it } from 'vitest';
import { createUsSupportTriageGrant,parseUsSupportTriagePolicy } from './us-support-triage-policy';
import { supportTriageFixture } from './us-support-triage-test-fixture';
const opened:Awaited<ReturnType<typeof supportTriageFixture>>[]=[];
afterEach(()=>{for(const f of opened.splice(0))f.sql.close();});
async function fixture(){const f=await supportTriageFixture();opened.push(f);return f;}
describe('explicit US Support triage server policy',()=>{
  it('creates only a catalogue/Price-matched company month grant',async()=>{
    const f=await fixture(), p=parseUsSupportTriagePolicy(JSON.stringify(f.policy)), g=createUsSupportTriageGrant(f.context(),p);
    expect(g).toMatchObject({organizationId:f.intent.organizationId,workspaceId:f.context().workspaceId,environment:'TEST',bucket:'support_message_classify',limit:10,threshold:0.9});
    expect(g.periodStart).toBeLessThanOrEqual(f.now()); expect(g.periodEnd).toBeGreaterThan(f.now()); expect(g.periodId).toMatch(/^\d{4}-\d{2}$/);
    expect(()=>createUsSupportTriageGrant(f.context(),{...p,entries:[]})).toThrowError(expect.objectContaining({code:'triage_budget_unavailable'}));
    expect(()=>createUsSupportTriageGrant(f.context(),{...p,entries:[{...p.entries[0],priceId:'price_Unknown'}]})).toThrow();
  });
  it('does not reset period for a different price or policy limit',async()=>{
    const f=await fixture(), a=f.grant(), b=f.grant(f.actor,{...f.policy,budgetPolicyVersion:'changed',entries:[{...f.policy.entries[0],limit:1}]});
    expect([b.organizationId,b.environment,b.bucket,b.periodId,b.periodStart,b.periodEnd]).toEqual([a.organizationId,a.environment,a.bucket,a.periodId,a.periodStart,a.periodEnd]);
  });
  it.each([{threshold:-1},{threshold:1.1},{threshold:NaN},{recipeVersion:'guessed'},{cadence:'invoice_month'},{extra:true},{entries:[{catalogVersion:'test',priceId:'price_Test',limit:0}]}])('rejects malformed explicit configuration %j',async patch=>{
    const f=await fixture();expect(()=>parseUsSupportTriagePolicy({...f.policy,...patch})).toThrowError(expect.objectContaining({code:'invalid_triage_policy',status:503}));
  });
  it('rejects duplicate entries, oversized JSON and missing configuration',async()=>{
    const f=await fixture(); for(const input of [undefined,'x'.repeat(65537),{...f.policy,entries:[f.policy.entries[0],f.policy.entries[0]]}]) expect(()=>parseUsSupportTriagePolicy(input)).toThrow();
  });
});

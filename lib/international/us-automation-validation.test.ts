import { describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import { validateUsAutomationActor, validateUsAutomationGrant, validateUsAutomationJob, validateUsAutomationResult, validateUsAutomationSettings, validateUsAutomationSettingsRequest, validateUsAutomationSource, validateUsAutomationUsage } from './us-automation-validation';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsAutomationGrant, UsAutomationJob } from './us-automation-contract';

const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const actor: FinancialAuthority = { organizationId: org, userId: 'TEST-person', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const grant: UsAutomationGrant = { schemaVersion: 1, organizationId: org, environment: 'TEST', bucket: 'supplier_invoice_extract', periodId: '2026-10', periodStart: Date.UTC(2026,9,1)/1000, periodEnd: Date.UTC(2026,10,1)/1000, limit: 2, subscriptionId: 'TEST-sub', authorityReference: 'TEST-proof', catalogVersion: 'TEST-catalog', priceId: 'price_TEST', budgetPolicyVersion: 'budget1', processingPolicyVersion: 'processing1', checkedAt: Date.UTC(2026,9,8,12)/1000 };
const source = { kind: 'document_import', sha256: 'a'.repeat(64), fileName: 'TEST.txt', mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp, documentText: 'Fictitious supplier invoice only.' };
const job: UsAutomationJob = { schemaVersion:1, organizationId:org,id,environment:'TEST',bucket:grant.bucket,source:source as UsAutomationJob['source'],recipeVersion:'extract1',requestId:id,createdBy:actor.userId,createdAt:actor.timestamp,grant,consentRevision:1,state:'held',leaseToken:id,leaseUntil:'2026-10-08T12:02:00.000Z',leaseGeneration:1,dispatchId:null,dispatchedAt:null,resultBody:null,resultSha256:null,proposalId:null };
const extraction = validateUsSupplierExtraction({ schemaVersion:1,kind:'unknown',confidence:1e-7,fields:{supplierName:'Fictitious'},evidence:{supplierName:'Fictitious'},fieldConfidence:{supplierName:1e-7},issues:[] });
const body = canonicalErpJson(extraction);
const active = { schemaVersion:1,requestId:id,expectedRevision:0,action:'activate',processingPolicyVersion:'processing1',consent:true };
const pause = { schemaVersion:1,requestId:id,expectedRevision:1,action:'pause',processingPolicyVersion:null,consent:false };

describe('US private analysis strict validation, fictitious objects only', () => {
  it('accepts copied financial actor, exact UTC calendar grant and held job', () => {
    expect(validateUsAutomationActor(actor)).toEqual(actor); expect(validateUsAutomationGrant(grant,org)).toEqual(grant); expect(validateUsAutomationJob(job,org)).toEqual(job);
    expect(Object.isFrozen(validateUsAutomationGrant(grant,org))).toBe(true);
  });
  it.each(['member','read_only','none'])('rejects nonfinancial role %s', role => expect(() => validateUsAutomationActor({...actor,role} as FinancialAuthority)).toThrow(expect.objectContaining({code:'automation_permission_required'})));
  it('requires entitlement and exact own fields without executing getters', () => {
    expect(() => validateUsAutomationActor({...actor,managementEntitled:false})).toThrow();
    const getter=vi.fn();expect(() => validateUsAutomationActor(Object.defineProperty({...actor},'userId',{get:getter,enumerable:true}))).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => validateUsAutomationActor({...actor,secret:'never'} as FinancialAuthority)).toThrow();
  });
  it.each(['2026-02-30T00:00:00Z','2026-10-08T12:00:00+00:00','2026-10-08T12:00:00.0Z'])('rejects noncanonical actor instant %s', timestamp => expect(() => validateUsAutomationActor({...actor,timestamp})).toThrow());
  it.each(['periodStart','periodEnd','checkedAt','limit'] as const)('rejects malformed budget %s', field => {
    for(const v of [-1,1.1,'1',null,Number.MAX_SAFE_INTEGER+1]) expect(() => validateUsAutomationGrant({...grant,[field]:v},org)).toThrow();
  });
  it.each(['organizationId','environment','bucket','subscriptionId','authorityReference','catalogVersion','priceId','budgetPolicyVersion','processingPolicyVersion'] as const)('rejects wrong scope/key %s', field => expect(() => validateUsAutomationGrant({...grant,[field]:'wrong /value'},org)).toThrow());
  it('handles leap-month UTC boundaries, never a fixed 30-day allowance', () => {
    const leap={...grant,periodId:'2028-02',periodStart:Date.UTC(2028,1,1)/1000,periodEnd:Date.UTC(2028,2,1)/1000,checkedAt:Date.UTC(2028,1,2)/1000}; expect(validateUsAutomationGrant(leap,org)).toEqual(leap);
    expect(() => validateUsAutomationGrant({...leap,periodEnd:leap.periodStart+30*86400},org)).toThrow(); expect(() => validateUsAutomationGrant({...grant,checkedAt:grant.periodEnd},org)).toThrow();
  });
  it('stores exact versioned activation and exact pause request fields', () => {
    expect(validateUsAutomationSettingsRequest(active)).toEqual(active);expect(validateUsAutomationSettingsRequest(pause)).toEqual(pause);
    expect(validateUsAutomationSettingsRequest({...pause,processingPolicyVersion:'processing2'})).toMatchObject({processingPolicyVersion:'processing2'});
    for(const v of [{...active,consent:false},{...pause,consent:true},{...pause,processingPolicyVersion:2},{...pause,unexpected:true}]) expect(() => validateUsAutomationSettingsRequest(v)).toThrow();
    const {processingPolicyVersion:_,...oldPause}=pause;expect(() => validateUsAutomationSettingsRequest(oldPause)).toThrow();
  });
  it('preserves consent during pause, but never invents an enabled default', () => {
    expect(validateUsAutomationSettings({schemaVersion:1,organizationId:org,revision:0,enabled:false,consent:null},org)).toMatchObject({enabled:false});
    const consent={processingPolicyVersion:'processing1',acceptedBy:actor.userId,acceptedAt:actor.timestamp};
    expect(validateUsAutomationSettings({schemaVersion:1,organizationId:org,revision:2,enabled:false,consent},org)).toMatchObject({consent});
    expect(() => validateUsAutomationSettings({schemaVersion:1,organizationId:org,revision:1,enabled:true,consent:null},org)).toThrow();
  });
  it('accepts literal text only and keeps source content unchanged', () => {
    expect(validateUsAutomationSource(source,org)).toEqual(source);
    expect(() => validateUsAutomationSource({...source,mediaType:'application/pdf'},org)).toThrow();
    expect(() => validateUsAutomationSource({...source,documentText:'é'.repeat(8193)},org)).toThrow();
  });
  it('retains exact canonical floating-confidence bytes, not JSONB reserialization', () => {
    expect(body).toContain('1e-7');expect(validateUsAutomationResult(body)).toBe(body);
    expect(() => validateUsAutomationResult(JSON.stringify(extraction,null,1))).toThrow();
    expect(() => validateUsAutomationResult(body.replace('1e-7','0.0000001'))).toThrow();
    expect(() => validateUsAutomationResult('{}')).toThrow();
  });
  it('does not coerce released or dispatched records into a reusable held lease', () => {
    expect(validateUsAutomationJob({...job,state:'released',leaseToken:null,leaseUntil:null},org)).toMatchObject({state:'released'});
    const dispatched={...job,state:'dispatched',dispatchId:id,dispatchedAt:actor.timestamp}; expect(validateUsAutomationJob(dispatched,org)).toMatchObject({state:'dispatched'});
    for(const bad of [{...job,state:'released'},{...job,state:'dispatched'},{...job,leaseGeneration:0},{...job,resultBody:body},{...job,environment:'PRODUCTION'}]) expect(() => validateUsAutomationJob(bad,org)).toThrow();
  });
  it('validates completed private result/proposal and rejects extra keys', () => {
    const completed={...job,state:'completed',dispatchId:id,dispatchedAt:actor.timestamp,resultBody:body,resultSha256:'b'.repeat(64),proposalId:id};expect(validateUsAutomationJob(completed,org)).toMatchObject({state:'completed'});
    expect(() => validateUsAutomationJob({...completed,proposalId:null},org)).toThrow();expect(() => validateUsAutomationJob({...job,token:'never'},org)).toThrow();
  });
  it('keeps consumed usage on a downgraded plan and derives remaining conservatively', () => {
    const usage={schemaVersion:1,organizationId:org,environment:'TEST',bucket:grant.bucket,periodId:grant.periodId,limit:2,held:1,consumed:3,remaining:0};expect(validateUsAutomationUsage(usage,grant)).toEqual(usage);
    expect(() => validateUsAutomationUsage({...usage,remaining:1},grant)).toThrow();expect(() => validateUsAutomationUsage({...usage,limit:10},grant)).toThrow();
  });
});

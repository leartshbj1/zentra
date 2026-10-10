import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mailboxImportFixture } from './us-support-mailbox-import-test-fixture';
import { d1UsSupportTriageStore } from './us-support-triage-d1';
import { createUsSupportTriageGrant, type UsSupportTriagePolicy } from './us-support-triage-policy';
import { US_SUPPORT_TRIAGE_MODEL, US_SUPPORT_TRIAGE_RECIPE_VERSION, type UsSupportTriageRequest, type UsSupportTriageSource, type UsSupportTriageDecision } from './us-support-triage-contract';

export const supportTriageSql = readFileSync(new URL('../../drizzle/0096_international_us_support_triage.sql',import.meta.url),'utf8');
/** Real0000..0096 SQLite with existing paid TEST/H1/H2a authority. Auth and
 * provider inputs are synthetic; this does not establish hosted accuracy. */
export async function supportTriageFixture(includeTriage = true) {
  const f = await mailboxImportFixture(); if (includeTriage) f.sql.exec(supportTriageSql);
  const policy: UsSupportTriagePolicy = {schemaVersion:1,cadence:'utc_calendar_month',budgetPolicyVersion:'support-triage-budget-test-v1',processingPolicyVersion:'support-triage-processing-test-v1',
    recipeVersion:US_SUPPORT_TRIAGE_RECIPE_VERSION,threshold:0.9,entries:[{catalogVersion:f.authority.offer.catalogVersion,priceId:f.authority.offer.priceId,limit:10}]};
  const request = (patch: Partial<UsSupportTriageRequest> = {}): UsSupportTriageRequest => ({schemaVersion:1,requestId:randomUUID(),connectionId:f.connection.connectionId,
    expectedMailboxRevision:1,uid:'123',expectedMessageVersion:'1700000000',processingPolicyVersion:policy.processingPolicyVersion,consent:true,...patch});
  const observedAt = f.now()-100;
  const source = (patch: Partial<UsSupportTriageSource> = {}): UsSupportTriageSource => ({provider:'infomaniak',mailboxId:f.connection.mailboxId,folderId:f.connection.folderId,uid:'123',
    messageVersion:'1700000000',receivedAt:observedAt,messageSha256:'b'.repeat(64),attachmentCount:0,bodyComplete:true,...patch});
  const decision = (patch: Partial<UsSupportTriageDecision> = {}): UsSupportTriageDecision => ({schemaVersion:1,category:'billing',priority:'normal',categoryConfidence:0.95,priorityConfidence:0.95,
    confidence:0.95,language:'en',languageConfidence:0.95,humanRequested:0,reviewReasons:[],needsReview:false,model:US_SUPPORT_TRIAGE_MODEL,recipeVersion:US_SUPPORT_TRIAGE_RECIPE_VERSION,...patch});
  const grant = (userId = f.actor, override: UsSupportTriagePolicy = policy) => createUsSupportTriageGrant(f.context(userId),override);
  return {...f,request,source,decision,policy,saasPolicy:f.policy,grant,triage:d1UsSupportTriageStore(f.database,{now:f.now})};
}
export const triageFixture = supportTriageFixture;

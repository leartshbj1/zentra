import { canonicalCreationJson, creationUuid, type WorkspaceCreationIntent } from './workspace-creation';
import { UsAuthorityError, type UsAuthorityAdmission } from './saas-authority';
import { d1UsAuthorityStore } from './saas-authority-d1';
import { assertUsTestPaidProof, assertUsTestSession, UsTestBillingError, validateUsTestPurchase, type UsTestPaidProof, type UsTestPurchase, type UsTestSession } from './us-saas-test-contract';

type PurchaseDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface PurchaseRow {
  purchase_id:string; creation_id:string; organization_id:string; actor_user_id:string; request_id:string;
  configuration_fingerprint:string; receipt_json:string; offer_json:string; seat_limit:number;
  provider_account_id:string; site_origin:string; integration_identifier:string; created_at:number; expires_at:number;
}
interface SessionRow { purchase_id:string; session_id:string; customer_id:string|null; subscription_id:string|null; created_at:number; expires_at:number }
class RevalidationFailure { constructor(readonly error:unknown) {} }
function guardRevalidation(check:()=>Promise<void>):()=>Promise<void> {
  return async()=>{try{await check();}catch(error){throw new RevalidationFailure(error);}};
}
function failure(error: unknown): never {
  if (error instanceof RevalidationFailure) throw error.error;
  if (error instanceof UsTestBillingError || error instanceof UsAuthorityError) throw error;
  throw new UsTestBillingError('service_unavailable', 503);
}
function purchaseFromRow(row: PurchaseRow): UsTestPurchase {
  try {
    return validateUsTestPurchase({ purchaseId:row.purchase_id,creationId:row.creation_id,organizationId:row.organization_id,actorUserId:row.actor_user_id,requestId:row.request_id,configurationFingerprint:row.configuration_fingerprint,receipt:JSON.parse(row.receipt_json),offer:JSON.parse(row.offer_json),seatLimit:row.seat_limit,providerAccountId:row.provider_account_id,siteOrigin:row.site_origin,integrationIdentifier:row.integration_identifier,createdAt:row.created_at,expiresAt:row.expires_at });
  } catch { throw new UsTestBillingError('service_unavailable', 503); }
}
function sessionFromRow(row: SessionRow): UsTestSession {
  if (!/^cs_test_[A-Za-z0-9_]+$/.test(row.session_id) || (row.customer_id !== null && !/^cus_[A-Za-z0-9_]+$/.test(row.customer_id)) || (row.subscription_id !== null && !/^sub_[A-Za-z0-9_]+$/.test(row.subscription_id)) || !Number.isSafeInteger(row.created_at) || row.created_at < 0 || !Number.isSafeInteger(row.expires_at) || row.expires_at <= row.created_at) throw new UsTestBillingError('service_unavailable', 503);
  creationUuid(row.purchase_id);
  return Object.freeze({ purchaseId:row.purchase_id,sessionId:row.session_id,customerId:row.customer_id,subscriptionId:row.subscription_id,createdAt:row.created_at,expiresAt:row.expires_at });
}
/** IDs and the provider expiry are allocated once. An identical browser retry may
 * have allocated unused candidate IDs/times; it resumes the saved provider key. */
function materialPurchase(purchase: UsTestPurchase): string {
  const { purchaseId: _id, createdAt: _created, expiresAt: _expires, integrationIdentifier: _identifier, ...material } = purchase;
  return canonicalCreationJson(material);
}
function sameBoundSession(saved:UsTestSession,observed:UsTestSession):boolean {
  return saved.purchaseId===observed.purchaseId && saved.sessionId===observed.sessionId && saved.createdAt===observed.createdAt && saved.expiresAt===observed.expiresAt
    && (saved.customerId===null || saved.customerId===observed.customerId) && (saved.subscriptionId===null || saved.subscriptionId===observed.subscriptionId);
}
export function d1UsTestPurchaseStore(database: PurchaseDatabase) {
  async function find(actorUserId: string, requestId: string): Promise<UsTestPurchase|null> {
    try {
      creationUuid(actorUserId); creationUuid(requestId);
      const row = await database.prepare('SELECT * FROM international_us_saas_test_purchases WHERE actor_user_id=? AND request_id=?').bind(actorUserId,requestId).first<PurchaseRow>();
      return row ? purchaseFromRow(row) : null;
    } catch (error) { return failure(error); }
  }
  async function session(purchaseId: string): Promise<UsTestSession|null> {
    try {
      creationUuid(purchaseId);
      const row = await database.prepare('SELECT * FROM international_us_saas_test_sessions WHERE purchase_id=?').bind(purchaseId).first<SessionRow>();
      return row ? sessionFromRow(row) : null;
    } catch (error) { return failure(error); }
  }
  async function notRevoked(organizationId: string): Promise<void> {
    const authority = await database.prepare('SELECT revoked_at FROM international_saas_authorities WHERE organization_id=?').bind(organizationId).first<{revoked_at:number|null}>();
    if (authority && authority.revoked_at !== null) throw new UsTestBillingError('subscription_required',402);
  }
  async function durable(purchase: UsTestPurchase): Promise<UsTestPurchase> {
    const saved = await find(purchase.actorUserId,purchase.requestId);
    if (!saved || canonicalCreationJson(saved) !== canonicalCreationJson(purchase)) throw new UsTestBillingError('purchase_conflict',409);
    return saved;
  }
  return {
    find,
    session,
    async bySession(sessionId: string): Promise<UsTestPurchase|null> {
      try {
        if (!/^cs_test_[A-Za-z0-9_]+$/.test(sessionId)) throw new UsTestBillingError('invalid_session',422);
        const row = await database.prepare(`SELECT p.* FROM international_us_saas_test_purchases p JOIN international_us_saas_test_sessions s ON s.purchase_id=p.purchase_id WHERE s.session_id=?`).bind(sessionId).first<PurchaseRow>();
        return row ? purchaseFromRow(row) : null;
      } catch (error) { return failure(error); }
    },
    async reserve(intent: WorkspaceCreationIntent, candidate: UsTestPurchase, revalidate: () => Promise<void>): Promise<UsTestPurchase> {
      revalidate=guardRevalidation(revalidate);
      try {
        candidate = validateUsTestPurchase(candidate,intent);
        await revalidate();
        await notRevoked(candidate.organizationId);
        let saved = await find(candidate.actorUserId,candidate.requestId);
        if (!saved) {
          await revalidate();
          try {
            await database.prepare(`INSERT INTO international_us_saas_test_purchases(purchase_id,creation_id,organization_id,actor_user_id,request_id,configuration_fingerprint,receipt_json,offer_json,seat_limit,provider_account_id,site_origin,integration_identifier,created_at,expires_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(candidate.purchaseId,candidate.creationId,candidate.organizationId,candidate.actorUserId,candidate.requestId,candidate.configurationFingerprint,canonicalCreationJson(candidate.receipt),canonicalCreationJson(candidate.offer),candidate.seatLimit,candidate.providerAccountId,candidate.siteOrigin,candidate.integrationIdentifier,candidate.createdAt,candidate.expiresAt).run();
          } catch {
            // D1 may have committed before a lost response, or an identical
            // caller may have won. Never retry by allocating another purchase.
            await revalidate();
            saved = await find(candidate.actorUserId,candidate.requestId);
            if (!saved) throw new UsTestBillingError('service_unavailable',503);
          }
          saved ??= await find(candidate.actorUserId,candidate.requestId);
        }
        if (!saved || materialPurchase(saved) !== materialPurchase(candidate)) throw new UsTestBillingError('purchase_conflict',409);
        await notRevoked(saved.organizationId);
        await revalidate();
        return saved;
      } catch (error) { return failure(error); }
    },
    async bind(purchase: UsTestPurchase, verifiedSession: UsTestSession, revalidate: () => Promise<void>): Promise<UsTestSession> {
      revalidate=guardRevalidation(revalidate);
      try {
        assertUsTestSession(verifiedSession);
        purchase = validateUsTestPurchase(purchase);
        if (verifiedSession.purchaseId !== purchase.purchaseId || verifiedSession.expiresAt !== purchase.expiresAt || verifiedSession.createdAt < purchase.createdAt || verifiedSession.createdAt >= purchase.expiresAt) throw new UsTestBillingError('session_mismatch',422);
        await revalidate(); await durable(purchase); await notRevoked(purchase.organizationId);
        let saved = await session(purchase.purchaseId);
        if (!saved) {
          await revalidate();
          try {
            await database.prepare(`INSERT INTO international_us_saas_test_sessions(purchase_id,session_id,customer_id,subscription_id,created_at,expires_at) VALUES(?,?,?,?,?,?)`).bind(purchase.purchaseId,verifiedSession.sessionId,verifiedSession.customerId,verifiedSession.subscriptionId,verifiedSession.createdAt,verifiedSession.expiresAt).run();
          } catch {
            await revalidate(); saved = await session(purchase.purchaseId);
            if (!saved) throw new UsTestBillingError('service_unavailable',503);
          }
          saved ??= await session(purchase.purchaseId);
        }
        if (!saved || !sameBoundSession(saved,verifiedSession)) throw new UsTestBillingError('session_conflict',409);
        await notRevoked(purchase.organizationId); await revalidate();
        return saved;
      } catch (error) { return failure(error); }
    },
    async admit(intent: WorkspaceCreationIntent, purchase: UsTestPurchase, boundSession: UsTestSession, proof: UsTestPaidProof, admission: UsAuthorityAdmission, revalidate: () => Promise<void>): Promise<WorkspaceCreationIntent> {
      revalidate=guardRevalidation(revalidate);
      try {
        assertUsTestPaidProof(proof);
        purchase = validateUsTestPurchase(purchase,intent);
        await revalidate(); await durable(purchase); await notRevoked(purchase.organizationId);
        const savedSession = await session(purchase.purchaseId);
        if (!savedSession || canonicalCreationJson(savedSession) !== canonicalCreationJson(boundSession)) throw new UsTestBillingError('session_conflict',409);
        // The existing authority sink still validates its branded admission and
        // commits owner/ready. Its optional proof INSERT shares that exact batch.
        return await d1UsAuthorityStore(database).admit(intent,admission,revalidate,{purchase,session:savedSession,proof});
      } catch (error) { return failure(error); }
    },
  };
}

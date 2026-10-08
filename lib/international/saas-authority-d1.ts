import { type AccountRole } from '../account-security';
import { canonicalCreationJson, creationUuid, type WorkspaceCreationIntent } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { assertUsAuthorityAdmission, parseUsSubscriptionAuthority, usWorkspaceAccess, usWorkspaceAutomationAuthority, UsAuthorityError, type UsAuthorityAdmission, type UsAuthorityRecord, type UsMembership, type UsSaasPolicy, type UsWorkspaceAutomationAuthority } from './saas-authority';
import { validateSubscriptionOffer, type SaasModule, type SaasSubscriptionOffer, type SubscriptionEnvironment } from './subscriptions';
import { snapshotPrivateJson } from './private-json';

type AuthorityDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface AuthorityRow {
  organization_id: string; creation_id: string; owner_user_id: string; subscription_id: string;
  environment: SubscriptionEnvironment; catalog_version: string; country: string; currency: string;
  offer_json: string; authority_json: string; seat_limit: number; revision: number; updated_at: number; revoked_at: number | null;
}
function fromRow(row: AuthorityRow): UsAuthorityRecord {
  try {
    const authority = parseUsSubscriptionAuthority(JSON.parse(row.authority_json));
    if (row.organization_id !== authority.organizationId || row.subscription_id !== authority.subscriptionId || row.environment !== authority.offer.environment || row.catalog_version !== authority.offer.catalogVersion || row.country !== 'US' || row.currency !== 'USD' || row.revision !== 1 || canonicalCreationJson(JSON.parse(row.offer_json)) !== canonicalCreationJson(authority.offer)) throw new Error('Stored authority mismatch');
    return { organizationId: row.organization_id, creationId: row.creation_id, ownerUserId: row.owner_user_id, authority, seatLimit: row.seat_limit, revision: 1, updatedAt: row.updated_at, revokedAt: row.revoked_at };
  } catch { throw new UsAuthorityError('service_unavailable', 503); }
}
function sameAdmission(record: UsAuthorityRecord, candidate: UsAuthorityAdmission): boolean {
  return record.organizationId === candidate.organizationId && record.creationId === candidate.creationId && record.ownerUserId === candidate.ownerUserId && record.seatLimit === candidate.seatLimit && record.revision === candidate.revision && canonicalCreationJson(record.authority) === canonicalCreationJson(candidate.authority);
}
export function d1UsAuthorityStore(database: AuthorityDatabase) {
  const creationStore = d1WorkspaceCreationStore(database);
  async function stored(organizationId: string): Promise<UsAuthorityRecord | null> {
    try { const row = await database.prepare('SELECT * FROM international_saas_authorities WHERE organization_id=?').bind(organizationId).first<AuthorityRow>(); return row ? fromRow(row) : null; }
    catch (error) { if (error instanceof UsAuthorityError) throw error; throw new UsAuthorityError('service_unavailable', 503); }
  }
  async function replay(intent: WorkspaceCreationIntent, candidate: UsAuthorityAdmission) {
    const current = await creationStore.find(candidate.ownerUserId, intent.requestId);
    const record = await stored(candidate.organizationId);
    if (!current || current.state !== 'ready') return null;
    if (!record || current.ownSubscriptionId !== candidate.authority.subscriptionId || !sameAdmission(record, candidate)) throw new UsAuthorityError('admission_conflict', 409);
    return current;
  }
  return {
    automationAuthority(organizationId: string, userId: string, policy: UsSaasPolicy): Promise<UsWorkspaceAutomationAuthority> {
      return d1UsWorkspaceAutomationAuthority(database, organizationId, userId, policy);
    },
    /** Only server-created branded admission DTOs can reach this internal sink. */
    async admit(intent: WorkspaceCreationIntent, candidate: UsAuthorityAdmission, revalidate: () => Promise<void>): Promise<WorkspaceCreationIntent> {
      assertUsAuthorityAdmission(candidate);
      if (candidate.organizationId !== intent.organizationId || candidate.creationId !== intent.creationId || candidate.ownerUserId !== intent.actorUserId || candidate.configurationFingerprint !== intent.fingerprint || !intent.receipt || intent.state === 'reserved') throw new UsAuthorityError('invalid_authority', 422);
      await revalidate();
      const durable = await creationStore.find(candidate.ownerUserId,intent.requestId);
      if (!durable || durable.creationId !== candidate.creationId || durable.organizationId !== candidate.organizationId || durable.fingerprint !== candidate.configurationFingerprint || durable.companyName !== intent.companyName || canonicalCreationJson(durable.configuration) !== canonicalCreationJson(intent.configuration) || canonicalCreationJson(durable.receipt) !== canonicalCreationJson(intent.receipt)) throw new UsAuthorityError('admission_conflict', 409);
      const existing = await replay(intent, candidate);
      if (existing) { await revalidate(); return existing; }
      const timestamp = new Date(candidate.updatedAt * 1000).toISOString();
      const membershipId = creationUuid(crypto.randomUUID());
      try {
        await revalidate();
        await database.batch([
          database.prepare(`INSERT INTO international_saas_authorities(organization_id,creation_id,owner_user_id,subscription_id,environment,catalog_version,country,currency,offer_json,authority_json,seat_limit,revision,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(candidate.organizationId,candidate.creationId,candidate.ownerUserId,candidate.authority.subscriptionId,candidate.authority.offer.environment,candidate.authority.offer.catalogVersion,'US','USD',canonicalCreationJson(candidate.authority.offer),canonicalCreationJson(candidate.authority),candidate.seatLimit,1,candidate.updatedAt),
          database.prepare(`INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,display_name,joined_at,revoked_at) VALUES(?,?,?,'owner',NULL,?,NULL)`).bind(membershipId,candidate.organizationId,candidate.ownerUserId,candidate.updatedAt),
          database.prepare(`UPDATE international_workspace_creation_intents SET state='ready',own_subscription_id=?,updated_at=? WHERE creation_id=? AND organization_id=? AND actor_user_id=? AND request_id=? AND configuration_fingerprint=? AND state='postgres_confirmed'`).bind(candidate.authority.subscriptionId,timestamp,intent.creationId,intent.organizationId,intent.actorUserId,intent.requestId,intent.fingerprint),
        ]);
      } catch {
        // Unique-key races or an uncertain commit may already have completed the
        // identical admission. A different contract is never accepted as replay.
        await revalidate();
        const completed = await replay(intent, candidate);
        if (completed) return completed;
        throw new UsAuthorityError('service_unavailable', 503);
      }
      await revalidate();
      const completed = await replay(intent, candidate);
      if (!completed) throw new UsAuthorityError('service_unavailable', 503);
      return completed;
    },
    async access(organizationId: string, userId: string, policy: UsSaasPolicy, module: SaasModule = 'gestion') {
      try {
        // Scope to the caller before parsing or revealing a company's authority.
        const member = await database.prepare(`SELECT m.membership_id,m.organization_id,m.user_id,m.role,m.joined_at,m.revoked_at,a.owner_user_id,i.request_id
          FROM international_workspace_members m JOIN international_saas_authorities a ON a.organization_id=m.organization_id
          JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id
          JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
          WHERE m.organization_id=? AND m.user_id=? AND m.revoked_at IS NULL AND i.state='ready' LIMIT 1`).bind(organizationId,userId).first<{membership_id:string;organization_id:string;user_id:string;role:AccountRole;joined_at:number;revoked_at:number|null;owner_user_id:string;request_id:string}>();
        if (!member) throw new UsAuthorityError('forbidden', 403);
        const intent = await creationStore.find(member.owner_user_id, member.request_id);
        const record = await stored(organizationId);
        if (!intent || !record || member.organization_id !== organizationId || member.user_id !== userId) throw new UsAuthorityError('service_unavailable', 503);
        const membership: UsMembership = { membershipId:member.membership_id, organizationId:member.organization_id, userId:member.user_id, role:member.role, joinedAt:member.joined_at, revokedAt:member.revoked_at };
        const access = usWorkspaceAccess(intent, record, membership, policy, module);
        // Revocation between the separate intent/authority reads must not return
        // a stale membership. No cached membership or subscription grant exists.
        const fresh = await database.prepare(`SELECT m.role,m.revoked_at AS member_revoked_at,a.revoked_at AS authority_revoked_at,owner.revoked_at AS owner_revoked_at,unixepoch() AS checked_at,
          json_extract(a.authority_json,'$.evidence.startsAt') AS starts_at,json_extract(a.authority_json,'$.evidence.endsAt') AS ends_at
          FROM international_workspace_members m JOIN international_saas_authorities a ON a.organization_id=m.organization_id
          JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner'
          WHERE m.organization_id=? AND m.user_id=?`).bind(organizationId,userId).first<{role:AccountRole;member_revoked_at:number|null;authority_revoked_at:number|null;owner_revoked_at:number|null;checked_at:number;starts_at:number;ends_at:number}>();
        if (!fresh || fresh.role !== access.role || fresh.member_revoked_at !== null || fresh.owner_revoked_at !== null) throw new UsAuthorityError('forbidden', 403);
        if (![fresh.checked_at,fresh.starts_at,fresh.ends_at].every(Number.isSafeInteger)) throw new UsAuthorityError('service_unavailable', 503);
        const checkedAt = Math.max(policy.now, fresh.checked_at);
        if (fresh.authority_revoked_at !== null || fresh.starts_at > checkedAt || fresh.ends_at <= checkedAt) throw new UsAuthorityError('subscription_required', 402);
        return access;
      } catch (error) { if (error instanceof UsAuthorityError) throw error; throw new UsAuthorityError('service_unavailable', 503); }
    },
  };
}

/** Scope before reading private provenance, then re-read the EXISTING US rights
 * after that provenance was constructed. No CH tables, grant cache or writes. */
export async function d1UsWorkspaceAutomationAuthority(database: AuthorityDatabase, organizationId: string, userId: string, policy: UsSaasPolicy): Promise<UsWorkspaceAutomationAuthority> {
  try {
    policy = snapshotPrivateJson(policy) as UsSaasPolicy;
    const source = await database.prepare(`SELECT a.*,m.membership_id,m.user_id,m.role,m.joined_at,m.revoked_at AS member_revoked_at,i.request_id,unixepoch() AS checked_at
      FROM international_workspace_members m JOIN international_saas_authorities a ON a.organization_id=m.organization_id
      JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id
      JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
      WHERE m.organization_id=? AND m.user_id=? AND m.revoked_at IS NULL AND i.state='ready' LIMIT 1`).bind(organizationId,userId).first<AuthorityRow & {membership_id:string;user_id:string;role:AccountRole;joined_at:number;member_revoked_at:number|null;request_id:string;checked_at:number}>();
    if (!source) throw new UsAuthorityError('forbidden', 403);
    const row = snapshotPrivateJson(source) as typeof source;
    if (!Number.isSafeInteger(row.checked_at) || !Number.isSafeInteger(policy.now)) throw new UsAuthorityError('service_unavailable', 503);
    const record = fromRow(row), intent = await d1WorkspaceCreationStore(database).find(row.owner_user_id,row.request_id);
    if (!intent || row.organization_id !== organizationId || row.user_id !== userId) throw new UsAuthorityError('service_unavailable', 503);
    const currentPolicy = { ...policy, now: Math.max(policy.now, row.checked_at) };
    const value = usWorkspaceAutomationAuthority(intent, record, { membershipId:row.membership_id, organizationId:row.organization_id, userId:row.user_id, role:row.role, joinedAt:row.joined_at, revokedAt:row.member_revoked_at }, currentPolicy);
    const fresh = await d1UsAuthorityStore(database).access(organizationId,userId,currentPolicy,'automation');
    if (fresh.organizationId !== value.organizationId || fresh.userId !== value.userId || fresh.role !== value.role || fresh.subscriptionId !== value.subscriptionId) throw new UsAuthorityError('forbidden', 403);
    return value;
  } catch (error) {
    if (error instanceof UsAuthorityError) throw error;
    throw new UsAuthorityError('service_unavailable', 503);
  }
}

export function parseUsSaasPolicy(bindings: { INTERNATIONAL_US_SAAS_CATALOG_JSON?: string; INTERNATIONAL_US_BILLING_ENVIRONMENT?: string }, now: number): UsSaasPolicy {
  const environment = bindings.INTERNATIONAL_US_BILLING_ENVIRONMENT;
  if (!['TEST','PRODUCTION'].includes(String(environment))) throw new UsAuthorityError('service_unavailable', 503);
  try {
    const entries: unknown = JSON.parse(bindings.INTERNATIONAL_US_SAAS_CATALOG_JSON || '[]');
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Invalid catalogue');
    const catalog = entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['offer','seatLimit'].includes(key))) throw new Error('Invalid entry');
      const fields = entry as {offer:SaasSubscriptionOffer;seatLimit:number};
      const offer = validateSubscriptionOffer(fields.offer);
      if (!Number.isSafeInteger(fields.seatLimit) || fields.seatLimit < 1 || fields.seatLimit > 1000) throw new Error('Invalid seats');
      return Object.freeze({ offer, seatLimit:fields.seatLimit });
    });
    if (catalog.some(({offer}) => offer.country !== 'US' || offer.currency !== 'USD' || offer.environment !== environment)) throw new Error('Invalid market');
    return { catalog:Object.freeze(catalog), environment:environment as SubscriptionEnvironment, now };
  } catch { throw new UsAuthorityError('service_unavailable', 503); }
}
export async function requireUsWorkspaceAccess(organizationId: string, userId: string, module: SaasModule = 'gestion') {
  const { env } = await import('cloudflare:workers');
  const policy = parseUsSaasPolicy(env as unknown as Parameters<typeof parseUsSaasPolicy>[0], Math.floor(Date.now()/1000));
  const database = (await import('../runtime')).database();
  return d1UsAuthorityStore(database).access(organizationId,userId,policy,module);
}

export async function requireUsWorkspaceAutomationAuthority(organizationId: string, userId: string): Promise<UsWorkspaceAutomationAuthority> {
  const { env } = await import('cloudflare:workers');
  const policy = parseUsSaasPolicy(env as unknown as Parameters<typeof parseUsSaasPolicy>[0], Math.floor(Date.now()/1000));
  return d1UsWorkspaceAutomationAuthority((await import('../runtime')).database(), organizationId, userId, policy);
}

/** Marker lookup only, after account authentication. A missing schema must not
 * silently reinterpret a reserved/ready US space as a Swiss legacy company. */
export async function isUsWorkspaceAdmission(organizationId: string): Promise<boolean> {
  try {
    const database = (await import('../runtime')).database();
    const row = await database.prepare('SELECT creation_id FROM international_workspace_creation_intents WHERE organization_id=? LIMIT 1').bind(organizationId).first<{creation_id:string}>();
    return row !== null;
  } catch { throw new UsAuthorityError('service_unavailable', 503); }
}

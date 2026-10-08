import { canonicalCreationJson, creationUuid, validateCreationReceipt, WorkspaceCreationError, type WorkspaceCreationIntent, type WorkspaceCreationStore } from './workspace-creation';
import { validateCompanyConfiguration } from './country-config';

type CreationDatabase = Pick<D1Database, 'prepare'>;
interface Row { creation_id: string; organization_id: string; actor_user_id: string; request_id: string; confirmation_version: number; company_name: string; configuration_fingerprint: string; configuration_json: string; state: string; pg_receipt_json: string | null; own_subscription_id: string | null; created_at: string; updated_at: string }
function fromRow(row: Row): WorkspaceCreationIntent {
  try {
    const configuration = validateCompanyConfiguration(JSON.parse(row.configuration_json));
    for (const id of [row.creation_id, row.organization_id, row.actor_user_id, row.request_id]) creationUuid(id);
    if (configuration.organizationId !== row.organization_id || configuration.country !== 'US' || configuration.currency !== 'USD' || configuration.taxConfiguration.status !== 'unconfigured' || row.confirmation_version !== 1 || !/^[0-9a-f]{64}$/.test(row.configuration_fingerprint) || typeof row.company_name !== 'string' || !row.company_name || row.company_name.length > 160 || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at)) || !['reserved','postgres_confirmed'].includes(row.state) || row.own_subscription_id !== null) throw new Error('Invalid intent');
    const intent: WorkspaceCreationIntent = { creationId: row.creation_id, organizationId: row.organization_id, actorUserId: row.actor_user_id, requestId: row.request_id, confirmationVersion: 1, companyName: row.company_name, fingerprint: row.configuration_fingerprint, configuration, state: row.state as WorkspaceCreationIntent['state'], receipt: null, createdAt: row.created_at, updatedAt: row.updated_at };
    const receipt = row.pg_receipt_json === null ? null : validateCreationReceipt(JSON.parse(row.pg_receipt_json), intent);
    if ((intent.state === 'reserved') !== (receipt === null)) throw new Error('Invalid intent state');
    return { ...intent, receipt };
  } catch { throw new WorkspaceCreationError('service_unavailable', 503); }
}
function dbFailure(error: unknown): WorkspaceCreationError {
  if (error instanceof WorkspaceCreationError) return error;
  if (error instanceof Error && error.message.includes('international_intent_not_new')) return new WorkspaceCreationError('workspace_not_new', 409);
  return new WorkspaceCreationError('service_unavailable', 503);
}
export function d1WorkspaceCreationStore(database: CreationDatabase): WorkspaceCreationStore {
  const find = async (actorUserId: string, requestId: string) => {
    try {
      const row = await database.prepare('SELECT * FROM international_workspace_creation_intents WHERE actor_user_id=? AND request_id=?').bind(actorUserId, requestId).first<Row>();
      return row ? fromRow(row) : null;
    } catch (error) { throw dbFailure(error); }
  };
  return {
    find,
    async reserve(candidate) {
      try {
        await database.prepare(`INSERT INTO international_workspace_creation_intents(creation_id,organization_id,actor_user_id,request_id,country_code,confirmation_version,company_name,configuration_fingerprint,configuration_json,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?) ON CONFLICT(actor_user_id,request_id) DO NOTHING`).bind(candidate.creationId, candidate.organizationId, candidate.actorUserId, candidate.requestId, 'US', 1, candidate.companyName, candidate.fingerprint, canonicalCreationJson(candidate.configuration), candidate.createdAt, candidate.updatedAt).run();
        const saved = await find(candidate.actorUserId, candidate.requestId);
        if (!saved) throw new WorkspaceCreationError('service_unavailable', 503);
        return saved;
      } catch (error) { throw dbFailure(error); }
    },
    async confirm(intent, receipt, timestamp) {
      try {
        receipt = validateCreationReceipt(receipt, intent);
        if (!Number.isFinite(Date.parse(timestamp))) throw new WorkspaceCreationError('service_unavailable', 503);
        await database.prepare(`UPDATE international_workspace_creation_intents SET state='postgres_confirmed',pg_receipt_json=?,updated_at=?
          WHERE creation_id=? AND organization_id=? AND actor_user_id=? AND request_id=? AND configuration_fingerprint=? AND state='reserved'`).bind(canonicalCreationJson(receipt), timestamp, intent.creationId, intent.organizationId, intent.actorUserId, intent.requestId, intent.fingerprint).run();
        const saved = await find(intent.actorUserId, intent.requestId);
        if (!saved || saved.creationId !== intent.creationId || saved.organizationId !== intent.organizationId || saved.fingerprint !== intent.fingerprint || saved.state !== 'postgres_confirmed' || !saved.receipt || canonicalCreationJson({ ...saved.receipt, replayed: false }) !== canonicalCreationJson({ ...receipt, replayed: false })) throw new WorkspaceCreationError('service_unavailable', 503);
        return saved;
      } catch (error) { throw dbFailure(error); }
    },
  };
}

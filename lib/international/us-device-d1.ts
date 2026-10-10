import { UsDeviceError, type UsDeviceAdmission } from './us-device-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';

export interface UsDeviceChallenge {
  device_code_hash: string; user_code: string; installation_id: string; session_token_hash: string; supported_schema_version: ErpSchemaVersion;
  created_at: number; expires_at: number; status: 'pending'|'approved'|'consumed'; organization_id: string|null;
  approved_user_id: string|null; approved_role: UsDeviceAdmission['role']|null; subscription_id: string|null;
  entitlement_valid_until: number|null; approved_at: number|null; consumed_session_id: string|null;
}
export interface UsDeviceSessionRow {
  session_id: string; device_code_hash: string; token_hash: string; installation_id: string; organization_id: string;
  user_id: string; role: UsDeviceAdmission['role']; subscription_id: string; supported_schema_version: ErpSchemaVersion;
  created_at: number; expires_at: number; entitlement_valid_until: number; revoked_at: number|null;
}
export interface UsDeviceStore {
  start(this:void, input: {codeHash:string;userCode:string;installationId:string;tokenHash:string;schema:ErpSchemaVersion;now:number}):Promise<void>;
  challenge(this:void, selector:'code'|'user', value:string):Promise<UsDeviceChallenge|null>;
  approve(this:void, userCode:string, admission:UsDeviceAdmission, now:number):Promise<void>;
  consume(this:void, challenge:UsDeviceChallenge, sessionId:string, now:number):Promise<void>;
  session(this:void, tokenHash:string, active?:boolean):Promise<UsDeviceSessionRow|null>;
  revoke(this:void, tokenHash:string, now:number):Promise<void>;
}
export function d1UsDeviceStore(database:Pick<D1Database,'prepare'|'batch'>):UsDeviceStore {
  const fail = ():never => {throw new UsDeviceError('service_unavailable',503);};
  // Capability4 is a new storage family, not a promotion of an old credential.
  // The migration preserves every1..3 row/hash/FK and both families use the
  // same current organization/member/entitlement view. Never choose authority
  // from a caller header, and refuse an ambiguous lookup rather than preferring
  // a family. Triggers enforce cross-family uniqueness even across races.
  const table=(kind:'challenges'|'sessions',schema:ErpSchemaVersion)=>schema===4?'international_us_device_v4_'+kind:'international_us_device_'+kind;
  async function one<T>(query:string,value:string):Promise<T|null>{
    const result=await database.prepare(query).bind(value,value).all<T>();
    if(!result.success||!Array.isArray(result.results)||result.results.length>1)return fail();
    return result.results[0]??null;
  }
  return {
    async start(v){try{await database.prepare(`INSERT INTO ${table('challenges',v.schema)}(device_code_hash,user_code,installation_id,session_token_hash,supported_schema_version,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?,'pending')`).bind(v.codeHash,v.userCode,v.installationId,v.tokenHash,v.schema,v.now,v.now+600).run();}catch{return fail();}},
    async challenge(selector,value){try{const field=selector==='code'?'device_code_hash':'user_code';return await one<UsDeviceChallenge>(`SELECT * FROM international_us_device_challenges WHERE ${field}=? UNION ALL SELECT * FROM international_us_device_v4_challenges WHERE ${field}=? LIMIT 2`,value);}catch{return fail();}},
    async approve(code,a,now){try{const c=await one<UsDeviceChallenge>('SELECT * FROM international_us_device_challenges WHERE user_code=? UNION ALL SELECT * FROM international_us_device_v4_challenges WHERE user_code=? LIMIT 2',code);if(!c)return;await database.prepare(`UPDATE ${table('challenges',c.supported_schema_version)} SET status='approved',organization_id=?,approved_user_id=?,approved_role=?,subscription_id=?,entitlement_valid_until=?,approved_at=? WHERE user_code=? AND status='pending' AND expires_at>?`).bind(a.organizationId,a.userId,a.role,a.subscriptionId,a.entitlementValidUntil,now,code,now).run();}catch{return fail();}},
    async consume(c,id,now){try{await database.batch([
      database.prepare(`INSERT INTO ${table('sessions',c.supported_schema_version)}(session_id,device_code_hash,token_hash,installation_id,organization_id,user_id,role,subscription_id,supported_schema_version,created_at,expires_at,entitlement_valid_until,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(id,c.device_code_hash,c.session_token_hash,c.installation_id,c.organization_id,c.approved_user_id,c.approved_role,c.subscription_id,c.supported_schema_version,now,Math.min(now+2592000,c.entitlement_valid_until!),c.entitlement_valid_until),
      database.prepare(`UPDATE ${table('challenges',c.supported_schema_version)} SET status='consumed',consumed_session_id=? WHERE device_code_hash=? AND status='approved' AND expires_at>?`).bind(id,c.device_code_hash,now),
    ]);}catch{return fail();}},
    async session(hash,active=false){try{const select=(name:string)=>active?`SELECT s.* FROM ${name} s JOIN international_us_device_admissible a ON a.organization_id=s.organization_id AND a.user_id=s.user_id AND a.role=s.role AND a.subscription_id=s.subscription_id AND a.entitlement_valid_until>=s.entitlement_valid_until WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch()`:`SELECT * FROM ${name} WHERE token_hash=?`;return await one<UsDeviceSessionRow>(`${select(table('sessions',3))} UNION ALL ${select(table('sessions',4))} LIMIT 2`,hash);}catch{return fail();}},
    async revoke(hash,now){try{const s=await one<UsDeviceSessionRow>('SELECT * FROM international_us_device_sessions WHERE token_hash=? UNION ALL SELECT * FROM international_us_device_v4_sessions WHERE token_hash=? LIMIT 2',hash);if(!s)return;await database.prepare(`UPDATE ${table('sessions',s.supported_schema_version)} SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`).bind(now,hash).run();}catch{return fail();}},
  };
}

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashUsDeviceSecret } from './us-device-contract';
import { seedUsDeviceFixture, sqliteUsDeviceDatabase } from './us-device-test-fixture';
const open:ReturnType<typeof sqliteUsDeviceDatabase>[]=[];
afterEach(()=>{for(const f of open.splice(0))f.sql.close();});
async function fixture(){const db=sqliteUsDeviceDatabase();open.push(db);return {...db,...await seedUsDeviceFixture(db.database)};}
async function approved(f:Awaited<ReturnType<typeof fixture>>){const c=await f.start();expect((await f.approve(c.userCode)).status).toBe(200);return (await f.store.challenge('code',await hashUsDeviceSecret('code',c.deviceCode)))!;}
function rawInsert(f:Awaited<ReturnType<typeof fixture>>,c:Awaited<ReturnType<typeof approved>>,patch:Record<string,string|number|null>={}){
  const row={session_id:'usd_'+randomUUID(),device_code_hash:c.device_code_hash,token_hash:c.session_token_hash,installation_id:c.installation_id,organization_id:c.organization_id,user_id:c.approved_user_id,role:c.approved_role,subscription_id:c.subscription_id,supported_schema_version:c.supported_schema_version,created_at:f.now(),expires_at:Math.min(f.now()+2592000,c.entitlement_valid_until!),entitlement_valid_until:c.entitlement_valid_until,revoked_at:null,...patch};
  const names=Object.keys(row);return f.sql.prepare(`INSERT INTO international_us_device_sessions(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(row));
}
describe('actual US credential SQL atomicity, immutability and current authority fences',()=>{
  it('does not allow a session insertion alone even with valid approved authority (deferred paired consumption FK)',async()=>{
    const f=await fixture(),c=await approved(f);expect(()=>rawInsert(f,c)).toThrow();expect(f.sql.prepare('SELECT count(*) total FROM international_us_device_sessions').get()).toEqual({total:0});
  });
  it.each(['organization_id','user_id','role','token_hash','installation_id','subscription_id','supported_schema_version','expires_at','revoked_at'] as const)('rolls back a forged %s session and paired consumption',async field=>{
    const f=await fixture(),c=await approved(f),id='usd_'+randomUUID();
    const patch:Record<string,string|number|null>={session_id:id,[field]:field==='role'?'admin':field==='supported_schema_version'?1:field==='expires_at'?f.now()+2592001:field==='revoked_at'?f.now():field==='token_hash'?Buffer.alloc(32,3).toString('base64url'):randomUUID()};
    f.sql.exec('BEGIN');expect(()=>{try{rawInsert(f,c,patch);f.sql.prepare("UPDATE international_us_device_challenges SET status='consumed',consumed_session_id=? WHERE device_code_hash=?").run(id,c.device_code_hash);f.sql.exec('COMMIT');}catch(error){f.sql.exec('ROLLBACK');throw error;}}).toThrow();
    expect(f.sql.prepare('SELECT count(*) total FROM international_us_device_sessions').get()).toEqual({total:0});expect(f.sql.prepare('SELECT status FROM international_us_device_challenges').get()).toEqual({status:'approved'});
  });
  it('refuses false ready authority and CH organization approval at SQL even when called directly',async()=>{
    const f=await fixture(),c=await f.start();expect(()=>f.sql.prepare("UPDATE international_us_device_challenges SET status='approved',organization_id=?,approved_user_id=?,approved_role='owner',subscription_id='sub_ch',entitlement_valid_until=?,approved_at=? WHERE user_code=?").run(randomUUID(),f.actor,f.now()+3600,f.now(),c.userCode)).toThrow('us_device_admission_required');
  });
  it('SQL expiry protects approval and exchange independently from JavaScript admission',async()=>{
    const f=await fixture(),c=await approved(f);f.sql.function('unixepoch',()=>f.now()+601);await expect(f.store.consume(c,'usd_'+randomUUID(),f.now())).rejects.toMatchObject({code:'service_unavailable'});
    expect(f.sql.prepare('SELECT count(*) total FROM international_us_device_sessions').get()).toEqual({total:0});
  });
  it('SQL rechecks active verified evidence immediately before admission commit',async()=>{
    const f=await fixture(),c=await approved(f);f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=?').run(f.now());await expect(f.store.consume(c,'usd_'+randomUUID(),f.now())).rejects.toMatchObject({code:'service_unavailable'});
    expect(f.sql.prepare('SELECT count(*) total FROM international_us_device_sessions').get()).toEqual({total:0});
  });
  it('prevents replacement/deletion/reassignment and revocation reactivation, preserving historical records',async()=>{
    const f=await fixture(),c=await approved(f);await f.store.consume(c,'usd_'+randomUUID(),f.now());
    for(const text of ["UPDATE international_us_device_sessions SET role='admin'","DELETE FROM international_us_device_sessions","DELETE FROM international_us_device_challenges","UPDATE international_us_device_challenges SET status='pending'"])expect(()=>f.sql.exec(text)).toThrow();
    const row=f.sql.prepare('SELECT * FROM international_us_device_sessions').get()!;const names=Object.keys(row);expect(()=>f.sql.prepare(`INSERT OR REPLACE INTO international_us_device_sessions(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(row))).toThrow();
    await f.store.revoke(f.sessionTokenHash,f.now());expect(()=>f.sql.exec('UPDATE international_us_device_sessions SET revoked_at=NULL')).toThrow();expect(await f.store.session(f.sessionTokenHash,true)).toBeNull();expect(await f.store.session(f.sessionTokenHash)).not.toBeNull();
  });
  it('preserves actual CH subscription/membership/device rows unchanged throughout US admission and revocation',async()=>{
    const f=await fixture(),ch='org_'+randomUUID();f.sql.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at,seat_limit)VALUES('sub_ch','cus_ch','price_ch','active',?,0,1)").run(f.now()+86400);
    f.sql.prepare("INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)VALUES(?,'CH fixture','sub_ch',?,0,0)").run(ch,f.actor);
    f.sql.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)VALUES('member_ch',?,?,'ch@example.invalid','owner',0)").run(ch,f.actor);
    const tables=['organizations','subscriptions','organization_members','device_sessions','license_activations'],snapshot=()=>Object.fromEntries(tables.map(table=>[table,f.sql.prepare('SELECT * FROM '+table).all()])),before=snapshot();
    const c=await approved(f);await f.store.consume(c,'usd_'+randomUUID(),f.now());await f.store.revoke(f.sessionTokenHash,f.now());expect(snapshot()).toEqual(before);
  });
});

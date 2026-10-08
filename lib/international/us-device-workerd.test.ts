import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUsDeviceFixture, usDeviceMigrationFiles, usDeviceMigrationSources } from './us-device-test-fixture';
import { createUsDeviceHandlers } from './us-device-server';
import { US_DEVICE_PROTOCOL } from './us-device-contract';
const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler'))('miniflare');
let runtime:{getD1Database(name:string):Promise<D1Database>;dispose():Promise<void>},database:D1Database;
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,script:'export default {fetch(){return new Response("US native isolated D1 SQL test");}}',d1Databases:['DB'],compatibilityDate:'2026-05-15'});
  database=await runtime.getD1Database('DB');expect(usDeviceMigrationFiles).toHaveLength(90);
  for(const source of usDeviceMigrationSources)for(const text of source.split('--> statement-breakpoint').filter(text=>text.trim()))await database.prepare(text).run();
},60000);
afterAll(async()=>{if(runtime)await runtime.dispose();});
describe('actual local workerd D1 transactions; Auth/PG/payment are synthetic TEST fixtures',()=>{
  it('atomically consumes capability4 in its additive family with simultaneous exact retries',async()=>{
    const f=await seedUsDeviceFixture(database),h=createUsDeviceHandlers({...f.deps,maxSchemaVersion:()=>4});
    const started=await h.START(f.request('start',{protocol:US_DEVICE_PROTOCOL,installationId:f.installationId,sessionTokenHash:f.sessionTokenHash,supportedSchemaVersion:4}));expect(started.status).toBe(201);const c=await started.json() as {userCode:string;deviceCode:string};expect((await h.APPROVE(f.request('approve',{protocol:US_DEVICE_PROTOCOL,userCode:c.userCode,organizationId:f.intent.organizationId}))).status).toBe(200);
    const replies=await Promise.all([f.exchange(c.deviceCode),f.exchange(c.deviceCode)]);expect(replies.map(r=>r.status)).toEqual([200,200]);const metadata=await replies[0].json();expect(metadata).toMatchObject({supportedSchemaVersion:4});expect(await replies[1].json()).toEqual(metadata);expect(await database.prepare('SELECT count(*) total FROM international_us_device_v4_sessions WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:1});expect(await database.prepare('SELECT count(*) total FROM international_us_device_sessions WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:0});
    const closed=createUsDeviceHandlers({...f.deps,maxSchemaVersion:()=>3});expect(await(await closed.ME(f.request('me',undefined,true))).json()).toEqual(metadata);f.setFlags(false);expect((await closed.REVOKE(f.request('revoke',undefined,true))).status).toBe(200);expect(await f.store.session(f.sessionTokenHash,true)).toBeNull();
  });
  it('rolls back actual D1 capability4 session insertion without its paired challenge consumption',async()=>{
    const f=await seedUsDeviceFixture(database),h=createUsDeviceHandlers({...f.deps,maxSchemaVersion:()=>4}),response=await h.START(f.request('start',{protocol:US_DEVICE_PROTOCOL,installationId:f.installationId,sessionTokenHash:f.sessionTokenHash,supportedSchemaVersion:4})),c=await response.json() as {userCode:string};await f.approve(c.userCode);await expect(database.batch([database.prepare(`INSERT INTO international_us_device_v4_sessions(session_id,device_code_hash,token_hash,installation_id,organization_id,user_id,role,subscription_id,supported_schema_version,created_at,expires_at,entitlement_valid_until) SELECT ?,device_code_hash,session_token_hash,installation_id,organization_id,approved_user_id,approved_role,subscription_id,4,?,min(?+2592000,entitlement_valid_until),entitlement_valid_until FROM international_us_device_v4_challenges WHERE user_code=?`).bind('usd_'+crypto.randomUUID(),f.now(),f.now(),c.userCode)])).rejects.toThrow();expect(await database.prepare('SELECT count(*) total FROM international_us_device_v4_sessions WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:0});
  });
  it('atomic consumption survives simultaneous requests without duplicate credentials',async()=>{
    const f=await seedUsDeviceFixture(database),c=await f.start();expect((await f.approve(c.userCode)).status).toBe(200);
    const replies=await Promise.all([f.exchange(c.deviceCode),f.exchange(c.deviceCode)]);expect(replies.map(r=>r.status)).toEqual([200,200]);expect(await replies[0].json()).toEqual(await replies[1].json());
    expect(await database.prepare('SELECT count(*) total FROM international_us_device_sessions WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:1});
  });
  it('recovers a lost actual D1 batch response and revokes with all US flags closed',async()=>{
    const f=await seedUsDeviceFixture(database),c=await f.start();await f.approve(c.userCode);
    const uncertainStore={...f.store,consume:async(...args:Parameters<typeof f.store.consume>)=>{await f.store.consume(...args);throw new Error('Private workerd response lost');}},handler=createUsDeviceHandlers({...f.deps,store:()=>uncertainStore});
    const request=f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken});const result=await handler.EXCHANGE(request);expect(result.status).toBe(200);
    const metadata=await result.json();expect(await(await f.exchange(c.deviceCode)).json()).toEqual(metadata);f.setFlags(false);expect((await f.handlers.REVOKE(f.request('revoke',undefined,true))).status).toBe(200);
    expect(await database.prepare('SELECT count(*) total FROM organizations').first()).toEqual({total:0});
  });
  it('deferred SQL pairing rolls back a session if its challenge consumption does not happen',async()=>{
    const f=await seedUsDeviceFixture(database),c=await f.start();await f.approve(c.userCode);
    const id='usd_'+crypto.randomUUID();await expect(database.batch([
      database.prepare(`INSERT INTO international_us_device_sessions(session_id,device_code_hash,token_hash,installation_id,organization_id,user_id,role,subscription_id,supported_schema_version,created_at,expires_at,entitlement_valid_until) SELECT ?,device_code_hash,session_token_hash,installation_id,organization_id,approved_user_id,approved_role,subscription_id,supported_schema_version,?,min(?+2592000,entitlement_valid_until),entitlement_valid_until FROM international_us_device_challenges WHERE user_code=?`).bind(id,f.now(),f.now(),c.userCode),
      database.prepare("UPDATE international_us_device_challenges SET status='consumed',consumed_session_id=? WHERE user_code='not-real'").bind(id),
    ])).rejects.toThrow();expect(await database.prepare('SELECT count(*) total FROM international_us_device_sessions WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:0});
  });
});

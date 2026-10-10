import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { US_DEVICE_PROTOCOL, UsDeviceError, hashUsDeviceSecret, validateUsDeviceStart, validateUsDeviceExchange, validateUsDeviceApprove, validateUsDeviceAdmission, type UsDeviceSession } from './us-device-contract';
import { createUsDeviceHandlers } from './us-device-server';
import { seedUsDeviceFixture, sqliteUsDeviceDatabase, usDeviceMigrationFiles } from './us-device-test-fixture';
const databases:ReturnType<typeof sqliteUsDeviceDatabase>[]=[];
afterEach(()=>{for(const f of databases.splice(0))f.sql.close();});
async function fixture(role:Parameters<typeof seedUsDeviceFixture>[1]='owner',seats=2,validFor=86400){const db=sqliteUsDeviceDatabase();databases.push(db);return {...db,...await seedUsDeviceFixture(db.database,role,seats,validFor)};}
async function connected(f:Awaited<ReturnType<typeof fixture>>){const c=await f.start();expect((await f.approve(c.userCode)).status).toBe(200);const response=await f.exchange(c.deviceCode);expect(response.status).toBe(200);return {c,metadata:await response.json() as UsDeviceSession};}
const count=(f:Awaited<ReturnType<typeof fixture>>,table:string)=>f.sql.prepare('SELECT count(*) AS total FROM '+table).get()!.total;

describe('US native HTTP with actual full SQLite D1 schema (synthetic Auth/PG/payment TEST ports)',()=>{
  it('uses all 90 actual D1 migrations (0000..0089) without skipping additive SQL',()=>{expect(usDeviceMigrationFiles.map(name=>Number(name.slice(0,4)))).toEqual(Array.from({length:90},(_,i)=>i));});
  it('seeds against the database clock even when JavaScript leads the SQL admission fence',async()=>{
    const db=sqliteUsDeviceDatabase();databases.push(db);
    const sqlTime=Number(db.sql.prepare('SELECT unixepoch() AS timestamp').get()!.timestamp);
    const shifted=vi.spyOn(Date,'now').mockReturnValue((sqlTime+2)*1000);
    try{
      const f={...db,...await seedUsDeviceFixture(db.database)};
      expect(f.policy.now).toBeLessThanOrEqual(Number(db.sql.prepare('SELECT unixepoch() AS timestamp').get()!.timestamp));
      expect((await connected(f)).metadata.organizationId).toBe(f.intent.organizationId);
    }finally{shifted.mockRestore();}
  });
  it.each(['owner','admin','accountant','member','read_only'] as const)('connects active %s without creating CH subscriptions/companies/licences',async role=>{
    const f=await fixture(role),{metadata}=await connected(f);
    expect(metadata).toEqual({protocol:US_DEVICE_PROTOCOL,edition:'us_experimental',status:'connected',sessionId:expect.stringMatching(/^usd_/),organizationId:f.intent.organizationId,organizationName:f.intent.companyName,userId:f.actor,installationId:f.installationId,role,subscriptionId:f.authority.subscriptionId,country:'US',currency:'USD',expiresAt:f.authority.evidence!.endsAt,entitlementValidUntil:f.authority.evidence!.endsAt,supportedSchemaVersion:3});
    expect(await (await f.handlers.ME(f.request('me',undefined,true))).json()).toEqual(metadata);
    for(const table of ['organizations','subscriptions','license_activations','device_sessions','device_authorizations'])expect(count(f,table)).toBe(0);
    expect(JSON.stringify(metadata)).not.toContain(f.sessionToken);expect(JSON.stringify(f.sql.prepare('SELECT * FROM international_us_device_sessions').all())).not.toContain(f.sessionToken);
  });
  it('keeps the fixed verification link and pending response exact; cookie or extra approval fields grant nothing',async()=>{
    const f=await fixture(),c=await f.start();expect(c.expiresAt).toBe(f.now()+600);
    const row=f.sql.prepare('SELECT * FROM international_us_device_challenges').get()!;expect(row.session_token_hash).toBe(f.sessionTokenHash);
    expect(await(await f.exchange(c.deviceCode)).json()).toEqual({protocol:US_DEVICE_PROTOCOL,status:'authorization_pending'});
    const response=await f.handlers.APPROVE(f.request('approve',{protocol:US_DEVICE_PROTOCOL,userCode:c.userCode,organizationId:f.intent.organizationId,role:'owner'}));expect(response.status).toBe(422);
    expect(count(f,'international_us_device_sessions')).toBe(0);
  });
  it('recovers an actually committed but lost exchange response with the same metadata/token and one session',async()=>{
    const f=await fixture(),c=await f.start();await f.approve(c.userCode);
    const real=f.database.batch.bind(f.database);let lose=true;f.database.batch=async<T>(statements:D1PreparedStatement[])=>{const result=await real(statements);if(lose){lose=false;throw new Error('Private lost response');}return result as D1Result<T>[];};
    const first=await f.exchange(c.deviceCode),receipt=await first.json();expect(first.status).toBe(200);
    expect(await(await f.exchange(c.deviceCode)).json()).toEqual(receipt);expect(count(f,'international_us_device_sessions')).toBe(1);
  });
  it('serializes two exchange attempts into one SQL credential and byte-equivalent replay',async()=>{
    const f=await fixture(),c=await f.start();await f.approve(c.userCode);
    // Node SQLite models sequential D1 batches, not hosted two-connection races.
    const one=await(await f.exchange(c.deviceCode)).json(),two=await(await f.exchange(c.deviceCode)).json();expect(two).toEqual(one);expect(count(f,'international_us_device_sessions')).toBe(1);
  });
  it.each(['token','installation','code'] as const)('refuses adoption with a foreign %s',async kind=>{
    const f=await fixture(),{c}=await connected(f);const body={protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken};
    if(kind==='token')body.sessionToken='zus_'+Buffer.alloc(32,18).toString('base64url');if(kind==='installation')body.installationId=randomUUID();if(kind==='code')body.deviceCode='zud_'+Buffer.alloc(32,18).toString('base64url');
    expect((await f.handlers.EXCHANGE(f.request('exchange',body))).status).toBe(401);expect(count(f,'international_us_device_sessions')).toBe(1);
  });
  it('requires explicit selected US organization and refuses approval by another Auth user',async()=>{
    const f=await fixture(),c=await f.start();f.setUser(randomUUID());expect((await f.approve(c.userCode)).status).toBe(403);
    expect((await f.handlers.APPROVE(f.request('approve',{protocol:US_DEVICE_PROTOCOL,userCode:c.userCode}))).status).toBe(422);
    expect(count(f,'international_us_device_sessions')).toBe(0);
  });
  it('detects changed browser identity while reading the request before any approval write',async()=>{
    const f=await fixture(),c=await f.start(),initial=f.deps.user;let reads=0;const handler=createUsDeviceHandlers({...f.deps,user:async()=>{if(++reads>1)return {userId:randomUUID()};return initial();}});
    expect((await handler.APPROVE(f.request('approve',{protocol:US_DEVICE_PROTOCOL,userCode:c.userCode,organizationId:f.intent.organizationId}))).status).toBe(401);
    expect(f.sql.prepare('SELECT status FROM international_us_device_challenges').get()).toEqual({status:'pending'});
  });
  it('revalidates browser/session/flags after approved SQL; no acknowledgement after a late account change',async()=>{
    const f=await fixture(),c=await f.start(),store={...f.store,approve:async(...args:Parameters<typeof f.store.approve>)=>{await f.store.approve(...args);f.setUser(randomUUID());}};
    const handler=createUsDeviceHandlers({...f.deps,store:()=>store});expect((await handler.APPROVE(f.request('approve',{protocol:US_DEVICE_PROTOCOL,userCode:c.userCode,organizationId:f.intent.organizationId}))).status).toBe(401);
    expect(f.sql.prepare('SELECT status FROM international_us_device_challenges').get()).toEqual({status:'approved'});
  });
  it('withholds committed exchange metadata if native flags close, and exact retry recovers after reopening',async()=>{
    const f=await fixture(),c=await f.start();await f.approve(c.userCode);const store={...f.store,consume:async(...args:Parameters<typeof f.store.consume>)=>{await f.store.consume(...args);f.setFlags(false);}};
    const handler=createUsDeviceHandlers({...f.deps,store:()=>store});expect((await handler.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken}))).status).toBe(404);
    expect(count(f,'international_us_device_sessions')).toBe(1);f.setFlags(true);expect((await f.exchange(c.deviceCode)).status).toBe(200);expect(count(f,'international_us_device_sessions')).toBe(1);
  });
  it('revokes and replays revoke when subscription and flags are closed, without a fresh grant',async()=>{
    const f=await fixture();await connected(f);f.setFlags(false);f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=?').run(f.now());
    for(let i=0;i<2;i++)expect(await(await f.handlers.REVOKE(f.request('revoke',undefined,true))).json()).toEqual({protocol:US_DEVICE_PROTOCOL,revoked:true});
    f.setFlags(true);expect((await f.handlers.ME(f.request('me',undefined,true))).status).toBe(401);
  });
  it('allows multiple installations for the same member at a one-person seat limit',async()=>{
    const f=await fixture('owner',1);await connected(f);
    const token='zus_'+Buffer.alloc(32,22).toString('base64url'),install=randomUUID(),tokenHash=await hashUsDeviceSecret('session',token);
    const started=await(await f.handlers.START(f.request('start',{protocol:US_DEVICE_PROTOCOL,installationId:install,sessionTokenHash:tokenHash,supportedSchemaVersion:1}))).json() as {userCode:string;deviceCode:string};await f.approve(started.userCode);
    expect((await f.handlers.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:started.deviceCode,installationId:install,sessionToken:token}))).status).toBe(200);
    expect(count(f,'international_us_device_sessions')).toBe(2);expect(count(f,'international_workspace_members')).toBe(1);
    expect(()=>f.sql.prepare("INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,joined_at)VALUES(?,?,?,'member',?)").run('third',f.intent.organizationId,randomUUID(),f.now())).toThrow();
  });
  it('SQL admission refuses a revoked member between the last JS check and credential commit',async()=>{
    const f=await fixture(),c=await f.start();await f.approve(c.userCode);const store={...f.store,consume:async(...args:Parameters<typeof f.store.consume>)=>{f.sql.prepare('UPDATE international_workspace_members SET revoked_at=? WHERE user_id=?').run(f.now(),f.actor);return f.store.consume(...args);}};
    const handler=createUsDeviceHandlers({...f.deps,store:()=>store});expect((await handler.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken}))).status).toBe(403);
    expect(count(f,'international_us_device_sessions')).toBe(0);expect(f.sql.prepare('SELECT status FROM international_us_device_challenges').get()).toEqual({status:'approved'});
  });
  it('retains consumed history but refuses replay after membership revocation',async()=>{
    const f=await fixture(),{c}=await connected(f);f.sql.prepare('UPDATE international_workspace_members SET revoked_at=? WHERE user_id=?').run(f.now(),f.actor);
    expect((await f.exchange(c.deviceCode)).status).toBe(403);expect(count(f,'international_us_device_sessions')).toBe(1);
  });
  it('refuses unconsumed expired challenges but permits exact consumed replay after the challenge lifetime',async()=>{
    const f=await fixture(),{c,metadata}=await connected(f);f.setNow(f.now()+601);expect(await(await f.exchange(c.deviceCode)).json()).toEqual(metadata);
    const second=await fixture(),pending=await second.start();second.setNow(second.now()+601);expect((await second.exchange(pending.deviceCode)).status).toBe(410);
  });
  it('refuses an expired connected credential and permits its logout',async()=>{const f=await fixture();await connected(f);/* Controlled local SQL clock follows the service clock in this expiry test. */f.sql.function('unixepoch',()=>f.now());f.setNow(f.authority.evidence!.endsAt);expect((await f.handlers.ME(f.request('me',undefined,true))).status).toBe(401);expect((await f.handlers.REVOKE(f.request('revoke',undefined,true))).status).toBe(200);});
  it('never interprets CH tokens or cookies as US authority',async()=>{
    const f=await fixture();for(const bearer of [undefined,'zds_'+Buffer.alloc(32,3).toString('base64url'),'zdv_'+Buffer.alloc(32,3).toString('base64url'),'zus_invalid']){
      const request=new Request('https://zentraapp.ch/api/international/device/me',{headers:{Cookie:'auth=fictitious',...(bearer?{Authorization:'Bearer '+bearer}:{})}});
      expect((await f.handlers.ME(request)).status).toBe(401);
    }
  });
  it('closed flags and exhausted quota do not read a body or allocate SQL credentials',async()=>{
    const f=await fixture();f.setFlags(false);const body=vi.fn();const request=f.request('start',{});request.body!.getReader=body;
    expect((await f.handlers.START(request)).status).toBe(404);expect(body).not.toHaveBeenCalled();f.setFlags(true);
    const handler=createUsDeviceHandlers({...f.deps,rateLimit:async()=>{throw new UsDeviceError('rate_limited',429);}});expect((await handler.START(request)).status).toBe(429);expect(body).not.toHaveBeenCalled();expect(count(f,'international_us_device_challenges')).toBe(0);
  });
  it('redacts raw SQL/unknown private errors rather than returning their message or arbitrary code',async()=>{
    const f=await fixture(),handler=createUsDeviceHandlers({...f.deps,store:()=>{throw new UsDeviceError('PRIVATE_TOKEN_secret',503);}});
    const r=await handler.ME(f.request('me',undefined,true));expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'service_unavailable'});
  });
  it('keeps strict CSRF browser-only approval and Authorization never falls back to cookies',async()=>{
    const f=await fixture(),c=await f.start();const request=new Request('https://zentraapp.ch/api/international/device/approve',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.invalid'},body:JSON.stringify({protocol:US_DEVICE_PROTOCOL,userCode:c.userCode,organizationId:f.intent.organizationId})});expect((await f.handlers.APPROVE(request)).status).toBe(403);
    expect((await f.handlers.APPROVE(f.request('approve',{protocol:US_DEVICE_PROTOCOL,userCode:c.userCode,organizationId:f.intent.organizationId},true))).status).toBe(401);
  });
  it('rejects malformed DTOs synchronously without invoking getters or accepting noncanonical token bits',()=>{
    const getter=vi.fn(()=>US_DEVICE_PROTOCOL);expect(()=>validateUsDeviceStart({get protocol(){return getter();}})).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>validateUsDeviceExchange({protocol:US_DEVICE_PROTOCOL,deviceCode:'zud_'+ 'A'.repeat(42)+'B',installationId:randomUUID(),sessionToken:'zus_'+Buffer.alloc(32).toString('base64url')})).toThrow();
    expect(()=>validateUsDeviceApprove({protocol:US_DEVICE_PROTOCOL,userCode:'ABCD-EFGH',organizationId:'org_'+randomUUID()})).toThrow();
  });
  it('bounds a long paid TEST entitlement to exactly thirty days, never its full duration',async()=>{
    const f=await fixture('owner',1,40*86400),{metadata}=await connected(f);expect(metadata.expiresAt).toBe(f.now()+30*86400);expect(metadata.entitlementValidUntil).toBe(f.now()+40*86400);
  });
  it.each([3,4] as const)('keeps captured capability%s metadata and exact exchange replay unchanged after a compatible current renewal',async schema=>{
    const f=await fixture(),h=createUsDeviceHandlers({...f.deps,maxSchemaVersion:()=>4});
    const started=await h.START(f.request('start',{protocol:US_DEVICE_PROTOCOL,installationId:f.installationId,sessionTokenHash:f.sessionTokenHash,supportedSchemaVersion:schema})),c=await started.json() as {deviceCode:string;userCode:string};
    expect((await f.approve(c.userCode)).status).toBe(200);const original=await(await f.exchange(c.deviceCode)).json() as UsDeviceSession;
    const snapshot=f.sql.prepare('SELECT * FROM '+(schema===4?'international_us_device_v4_sessions':'international_us_device_sessions')).all();
    const admission=await f.deps.access(f.intent.organizationId,f.actor),renewed=createUsDeviceHandlers({...f.deps,access:async()=>({...admission,entitlementValidUntil:f.authority.evidence!.endsAt+86400})});
    expect(await(await renewed.ME(f.request('me',undefined,true))).json()).toEqual(original);
    expect(await(await renewed.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken}))).json()).toEqual(original);
    expect(f.sql.prepare('SELECT * FROM '+(schema===4?'international_us_device_v4_sessions':'international_us_device_sessions')).all()).toEqual(snapshot);
    f.sql.function('unixepoch',()=>f.now());f.setNow(original.expiresAt);
    expect((await renewed.ME(f.request('me',undefined,true))).status).toBe(401);
    expect((await renewed.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken}))).status).toBe(401);
  });
  it('permits a monotonic renewal during awaited admission without changing an approved challenge or its new token bounds',async()=>{
    const f=await fixture(),c=await f.start();expect((await f.approve(c.userCode)).status).toBe(200);
    const captured=f.authority.evidence!.endsAt;let reads=0;
    const renewed=createUsDeviceHandlers({...f.deps,access:async(...args)=>({...await f.deps.access(...args),entitlementValidUntil:++reads===1?captured:captured+86400})});
    const response=await renewed.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken}));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({expiresAt:captured,entitlementValidUntil:captured});
    expect(f.sql.prepare('SELECT entitlement_valid_until FROM international_us_device_challenges').get()).toEqual({entitlement_valid_until:captured});
  });
  it('rejects a current entitlement shorter than the captured credential even while both dates are future',async()=>{
    const f=await fixture();await connected(f);
    const shortened=createUsDeviceHandlers({...f.deps,access:async(...args)=>({...await f.deps.access(...args),entitlementValidUntil:f.authority.evidence!.endsAt-1})});
    expect((await shortened.ME(f.request('me',undefined,true))).status).toBe(403);expect(f.sql.prepare('SELECT revoked_at FROM international_us_device_sessions').get()).toEqual({revoked_at:null});
  });
  it.each(['role','configuration'] as const)('does not disclose connected state after fresh %s changes',async what=>{
    const f=await fixture();await connected(f);let reads=0;
    const handler=createUsDeviceHandlers({...f.deps,access:async(...args)=>{const a=await f.deps.access(...args);return ++reads>1?{...a,...(what==='role'?{role:'read_only' as const}:{configurationStamp:'changed'})}:a;}});
    const response=await handler.ME(f.request('me',undefined,true));expect(response.status).toBe(what==='role'?403:401);expect(await response.json()).toEqual({error:what==='role'?'forbidden':'session_changed'});
  });
  it('withholds metadata if flags close during the authority/configuration read',async()=>{
    const f=await fixture();await connected(f);const handler=createUsDeviceHandlers({...f.deps,access:async(...args)=>{const a=await f.deps.access(...args);f.setFlags(false);return a;}});expect((await handler.ME(f.request('me',undefined,true))).status).toBe(404);
  });
  it('does not invoke getters or expose hidden/debug columns from privileged session/challenge ports',async()=>{
    const f=await fixture(),{c}=await connected(f),getter=vi.fn(()=>f.actor);
    const store={...f.store,session:async()=>({get user_id(){return getter();}} as Awaited<ReturnType<typeof f.store.session>>)};
    const handler=createUsDeviceHandlers({...f.deps,store:()=>store});expect((await handler.ME(f.request('me',undefined,true))).status).toBe(503);expect(getter).not.toHaveBeenCalled();
    const badChallenge={...f.store,challenge:async()=>({get status(){return getter();}} as unknown as Awaited<ReturnType<typeof f.store.challenge>>)};
    const exchange=createUsDeviceHandlers({...f.deps,store:()=>badChallenge});expect((await exchange.EXCHANGE(f.request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode:c.deviceCode,installationId:f.installationId,sessionToken:f.sessionToken}))).status).toBe(503);expect(getter).not.toHaveBeenCalled();
  });
  it('unknown bearer cannot revoke a different installation, even when flags are closed',async()=>{
    const f=await fixture();await connected(f);f.setFlags(false);const request=new Request('https://zentraapp.ch/api/international/device/revoke',{method:'POST',headers:{Authorization:'Bearer zus_'+Buffer.alloc(32,199).toString('base64url')}});expect((await f.handlers.REVOKE(request)).status).toBe(401);expect(f.sql.prepare('SELECT revoked_at FROM international_us_device_sessions').get()).toEqual({revoked_at:null});
  });
  it('keeps hashed purposes domain separated from both each other and legacy CH tokens',async()=>{
    const f=await fixture(),payload=f.sessionToken.slice(4),{createHash}=await import('node:crypto');
    expect(await hashUsDeviceSecret('session',f.sessionToken)).toBe(createHash('sha256').update('zentra:us-device-session:v1:'+f.sessionToken).digest('base64url'));
    const code='zud_'+payload;expect(await hashUsDeviceSecret('code',code)).toBe(createHash('sha256').update('zentra:us-device-code:v1:'+code).digest('base64url'));
    expect(await hashUsDeviceSecret('session',f.sessionToken)).not.toBe(await hashUsDeviceSecret('code',code));await expect(hashUsDeviceSecret('session','zds_'+payload)).rejects.toMatchObject({status:401});
  });
  it('preserves the creation/Rust name limit of 160 UTF16 units on private projections',async()=>{
    const f=await fixture(),a=await f.deps.access(f.intent.organizationId,f.actor);
    expect(validateUsDeviceAdmission({...a,organizationName:'😀'.repeat(80)}).organizationName).toHaveLength(160);
    expect(()=>validateUsDeviceAdmission({...a,organizationName:'😀'.repeat(80)+'x'})).toThrow();
    expect(()=>validateUsDeviceAdmission({...a,organizationName:'private\nname'})).toThrow();
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mock = vi.hoisted(() => ({ db:null as unknown, user:null as unknown, rate:vi.fn(), signIn:vi.fn(), updateProfile:vi.fn(), updatePassword:vi.fn(), updateEmail:vi.fn(), signOut:vi.fn(), clear:vi.fn(), memberships:vi.fn(), portal:vi.fn() }));
vi.mock('@/lib/runtime',()=>({database:()=>mock.db,runtimeValue:()=>''}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:async()=>mock.user}));
vi.mock('@/lib/account',async original=>({...await original<typeof import('./account')>(),enforceAccountRateLimit:mock.rate,membershipsForUser:mock.memberships}));
vi.mock('@/lib/supabase-auth-runtime',()=>({supabaseAuthClient:()=>mock,supabaseAuthSiteOrigin:()=> 'https://zentra.example'}));
vi.mock('@/lib/supabase-auth-cookies',()=>({clearSupabaseAuthCookies:mock.clear,readSupabaseAuthCookies:async()=>({accessToken:'existing'}),writeSupabasePkceCookie:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined})}));
vi.mock('@/lib/stripe',async original=>({...await original<typeof import('./stripe')>(),requireSameOrigin:()=> 'https://zentra.example',createPortalSession:mock.portal}));
import { startAccountTrial, trialLicenseEntitlement } from './account-trial';
import { linkPaidCompany } from './subscription-account';
import { accountSessionAllowed, revokeAccountSessions } from './account-session-policy';
import { accountPreferences, saveAccountPreferences } from './account-preferences';
import { PUT as profile } from '../app/api/account/profile/route';
import { POST as portal } from '../app/api/stripe/portal/route';
import { saveSettings, settingsFor } from './automation/config';
let db:DatabaseSync;
function prepare(query:string){let args:SQLInputValue[]=[];return {query,get args(){return args;},bind(...values:SQLInputValue[]){args=values;return this;},async first(){return db.prepare(query).get(...args)??null;},async all(){return {results:db.prepare(query).all(...args)};},async run(){const r=db.prepare(query).run(...args);return {success:true,meta:{changes:Number(r.changes)}};}};}
const user={userId:'user-a',email:'a@example.test',displayName:'A',provider:'supabase',emailConfirmed:true};
function request(body:unknown,path='/api/account/profile',origin='https://zentra.example'){return new Request(`https://zentra.example${path}`,{method:path.endsWith('portal')?'POST':'PUT',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});}
beforeEach(()=>{vi.resetAllMocks();db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const f of readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())db.exec(readFileSync(`drizzle/${f}`,'utf8'));mock.db={prepare,async batch(statements:ReturnType<typeof prepare>[]){db.exec('BEGIN');try{const r=statements.map(item=>{const x=db.prepare(item.query).run(...item.args);return {success:true,meta:{changes:Number(x.changes)}}});db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};mock.user=user;mock.signIn.mockResolvedValue({accessToken:'verified',user:{id:'user-a',emailConfirmed:true}});mock.signOut.mockResolvedValue(undefined);mock.memberships.mockResolvedValue([{organizationId:'org-a',subscriptionId:'sub-a',role:'owner'}]);mock.portal.mockResolvedValue('https://billing.stripe.com/p/session_fixture');db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)VALUES('sub-a','cus_fixture','price-a','active',1,1);INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)VALUES('org-a','A','sub-a','user-a',1,1);`);});
afterEach(()=>db.close());
describe('Phase 2 account mutations',()=>{
  it('uses the verified current identity for an email-change confirmation',async()=>{
    const res=await profile(request({action:'email',email:'next@example.test',currentPassword:'correct-password',expectedUserId:user.userId}));
    expect(res.status).toBe(200);expect(mock.signIn).toHaveBeenCalledWith(user.email,'correct-password');
    expect(mock.updateEmail).toHaveBeenCalledWith('verified','next@example.test','https://zentra.example/api/auth/confirmation',expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    expect(mock.signOut).toHaveBeenCalledWith('verified','local');
  });
  it('keeps preferences isolated and rejects a stale browser save',async()=>{const p=await saveAccountPreferences('user-a',{revision:0,theme:'dark'});expect(p.revision).toBe(1);expect((await accountPreferences('user-b')).theme).toBe('system');await expect(saveAccountPreferences('user-a',{revision:0,theme:'light'})).rejects.toMatchObject({status:409});expect((await accountPreferences('user-a')).theme).toBe('dark');});
  it('permits only one simultaneous initial preferences save',async()=>{const results=await Promise.allSettled([saveAccountPreferences('new',{revision:0,theme:'dark'}),saveAccountPreferences('new',{revision:0,theme:'light'})]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);});
  it('refuses cross-origin profile mutation before authentication',async()=>{expect((await profile(request({action:'name'},undefined,'https://evil.test'))).status).toBe(403);expect(mock.updateProfile).not.toHaveBeenCalled();});
  it('refuses an operation started on another account',async()=>{expect((await profile(request({expectedUserId:'other',action:'name',displayName:'Else'}))).status).toBe(409);expect(mock.updateProfile).not.toHaveBeenCalled();});
  it('updates a name using the authenticated access token only',async()=>{expect((await profile(request({expectedUserId:'user-a',action:'name',displayName:'Alice'}))).status).toBe(200);expect(mock.updateProfile).toHaveBeenCalledWith('existing','Alice');});
  it('cannot change credentials through a mismatched reauthentication identity',async()=>{mock.signIn.mockResolvedValue({accessToken:'foreign',user:{id:'user-b',emailConfirmed:true}});expect((await profile(request({expectedUserId:'user-a',action:'password',currentPassword:'password',password:'new-password-long'}))).status).toBe(403);expect(mock.updatePassword).not.toHaveBeenCalled();expect(mock.signOut).toHaveBeenCalledWith('foreign','local');});
  it('requires current credentials and closes the verification session on invalid email',async()=>{const result=await profile(request({expectedUserId:'user-a',action:'email',currentPassword:'current',email:'invalid'}));expect(result.status).toBe(400);expect(mock.signIn).toHaveBeenCalledWith(user.email,'current');expect(mock.signOut).toHaveBeenCalledWith('verified','local');expect(mock.updateEmail).not.toHaveBeenCalled();});
  it('changes the password and closes account sessions',async()=>{const result=await profile(request({expectedUserId:'user-a',action:'password',currentPassword:'current',password:'new-password-long'}));expect(result.status).toBe(200);expect(mock.updatePassword).toHaveBeenCalledWith('verified','new-password-long');expect(mock.signOut).toHaveBeenCalledWith('verified','global');expect(mock.clear).toHaveBeenCalled();});
  it('opens billing for the company owner without a Checkout cookie',async()=>{const result=await portal(request({organizationId:'org-a'},'/api/stripe/portal'));expect(result.status).toBe(200);expect(mock.portal).toHaveBeenCalledWith('cus_fixture','https://zentra.example/compte/abonnement?organizationId=org-a');});
  it.each(['org-b',''])('refuses a guessed organization for billing (%s)',async organizationId=>{expect((await portal(request({organizationId},'/api/stripe/portal'))).status).toBe(403);expect(mock.portal).not.toHaveBeenCalled();});
  it('refuses billing for an administrator who is not owner',async()=>{mock.memberships.mockResolvedValue([{organizationId:'org-a',subscriptionId:'sub-a',role:'admin'}]);expect((await portal(request({organizationId:'org-a'},'/api/stripe/portal'))).status).toBe(403);});
  it('prevents one administrator overwriting another Automation change',async()=>{const input={enabled:false,mode:'shadow',flags:[],thresholds:{medium:.65,high:.9},revision:0};await saveSettings('org-a','user-a',input);await expect(saveSettings('org-a','user-a',input)).rejects.toMatchObject({status:409});expect((await settingsFor('org-a')).revision).toBe(1);});
});

const trialUser={userId:'new-user',email:'new@example.test',displayName:'Marie'};
it('creates one real trial workspace under concurrent retries and never extends its end',async()=>{
 const [a,b]=await Promise.all([startAccountTrial(trialUser,'Entreprise'),startAccountTrial(trialUser,'Entreprise')]);
 expect(a).toEqual(b);expect(a.ends_at-a.started_at).toBe(14*86400);
 expect(await trialLicenseEntitlement(a.subscription_id,trialUser.userId)).toMatchObject({seat_limit:1});
 expect(await trialLicenseEntitlement(a.subscription_id,'outsider')).toBeNull();
 db.prepare('UPDATE account_trials SET ends_at=? WHERE user_id=?').run(a.started_at+1,trialUser.userId);
 expect((await startAccountTrial(trialUser,'Changed')).ends_at).toBe(a.started_at+1);
});
it('prevents a reused email on another identity from creating a second trial',async()=>{
 await startAccountTrial(trialUser,'Entreprise');await expect(startAccountTrial({...trialUser,userId:'different'},'Else')).rejects.toMatchObject({status:409});
 expect(db.prepare("SELECT count(*) as n FROM organizations WHERE subscription_id LIKE 'trial_%'").get()?.n).toBe(1);
});
it('upgrades the same trial company only after confirmed payment',async()=>{
 const trial=await startAccountTrial(trialUser,'Entreprise');
 db.prepare('INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at)VALUES(?,?,?,?,?)').run('lic_trial',trial.subscription_id,'installation_trial',1,1);
 await expect(linkPaidCompany('sub-a',trialUser)).rejects.toMatchObject({status:402});
 db.prepare("UPDATE subscriptions SET last_paid_invoice_id='in_paid',entitlement_valid_until=? WHERE subscription_id='sub-a'").run(Math.floor(Date.now()/1000)+86400);
 db.exec("DELETE FROM organizations WHERE organization_id='org-a'");
 const company=await linkPaidCompany('sub-a',trialUser);expect(company.id).toBe(trial.organization_id);
 expect(db.prepare('SELECT count(*) AS n FROM organizations').get()?.n).toBe(1);
 expect(await trialLicenseEntitlement(trial.subscription_id,trialUser.userId)).toBeNull();
 expect(db.prepare("SELECT subscription_id FROM license_activations WHERE license_id='lic_trial'").get()?.subscription_id).toBe('sub-a');
});
it('rejects already-issued browser tokens after global session revocation',async()=>{
 const now=Math.floor(Date.now()/1000),token=(iat:number)=>`header.${Buffer.from(JSON.stringify({sub:'user-a',iat})).toString('base64url')}.signature`;
 await revokeAccountSessions('user-a');expect(await accountSessionAllowed('user-a',token(now-1))).toBe(false);expect(await accountSessionAllowed('user-a',token(now+2))).toBe(true);
});

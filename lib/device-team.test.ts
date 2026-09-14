import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const stubs = vi.hoisted(() => ({ database: vi.fn(), user: vi.fn(), select: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/runtime', () => ({ database: stubs.database }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: stubs.user }));
vi.mock('@/lib/supabase-server-runtime', () => ({ supabaseServerClient: () => ({ select: stubs.select, upsert: stubs.upsert }) }));
import { GET, POST } from '../app/api/account/team/route';
import { companyProfile } from './company-profile';
import { hashOpaqueToken } from './account-security';
import { POST as invite } from '../app/api/account/invitations/route';
import { POST as accept } from '../app/api/account/invitations/accept/route';
import { POST as revoke } from '../app/api/account/members/revoke/route';
import { POST as startDevice } from '../app/api/account/device/start/route';
import { POST as approveDevice } from '../app/api/account/device/approve/route';
import { requireBrowserMembership } from './account';
import { teamSeats } from './team-seats';
import { ZENTRA_PLANS } from './plans';

type SqlValue = string | number | null;
let db: DatabaseSync;
function prepared(sql: string) {
  const statement = db.prepare(sql);
  let args: SqlValue[] = [];
  const result = {
    bind: (...values: SqlValue[]) => {
      args = values;
      return result;
    },
    first: async () => statement.get(...args) ?? null,
    all: async () => ({ results: statement.all(...args) }),
    run: async () => ({
      meta: { changes: Number(statement.run(...args).changes) },
      success: true,
    }),
  };
  return result;
}
const actor = (id: string) =>
  stubs.user.mockResolvedValue({
    userId: id,
    email: `${id}@example.test`,
    displayName: id,
    provider: 'supabase',
    emailConfirmed: true,
  });
function request(path: string, body: unknown) {
  return new Request(`https://zentra.example${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://zentra.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    for (const sql of readFileSync(new URL(name, folder), 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) db.exec(sql);
  stubs.database.mockReturnValue({
    prepare: prepared,
    batch: async (statements: ReturnType<typeof prepared>[]) => {
      db.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,entitlement_plan_id,seat_limit) VALUES('sub_test','cus_test','price_start','active',2000000000,0,1,2000000000,'zentra-start-monthly-59-chf',3);
    INSERT INTO organizations VALUES('org_test','Test','sub_test','owner',1,1);
    INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('mem_owner','org_test','owner','owner@example.test','owner',1);`);
  actor('owner');
  stubs.select.mockResolvedValue([]); stubs.upsert.mockResolvedValue([]);
  db.prepare('INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES(?,?,?,?,?)').run('lic_test','sub_test','00000000-0000-4000-8000-000000000001',1,1);
  db.prepare('INSERT INTO device_sessions VALUES(?,?,?,?,?,?,?,?,NULL)').run('session_test',await hashOpaqueToken('device-session',token),'org_test','owner','00000000-0000-4000-8000-000000000001',1,1,2000000000);
});
afterEach(() => db.close());

const token = 'zds_'+'a'.repeat(43);
const profile = {company_name:' Atelier test ',noga_section:'F',noga_division:'43',activity_description:'Peinture',vat_registered:false};
function device(body?:unknown, auth=token) {return new Request('https://zentra.example/api/account/team?organizationId=org_other',{method:body?'POST':'GET',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
describe('Native team API with real membership and capacity guards',()=>{
 it('rejects missing, expired and revoked sessions before touching Supabase',async()=>{
  expect((await GET(device(undefined,'invalid'))).status).toBe(401);
  db.exec('UPDATE device_sessions SET expires_at=1');expect((await GET(device())).status).toBe(401);
  db.exec('UPDATE device_sessions SET expires_at=2000000000; UPDATE organization_members SET revoked_at=1');expect((await GET(device())).status).toBe(401);
  expect(stubs.select).not.toHaveBeenCalled();
 });
 it('scopes reads and writes to the verified organization, ignoring forged identifiers',async()=>{
  stubs.select.mockResolvedValue([{profile}]);
  const result=await GET(device());expect(result.status).toBe(200);expect(await result.json()).toMatchObject({organizationId:'org_test',canManage:true,seats:{used:1,limit:3},profile});
  expect(stubs.select).toHaveBeenCalledWith('zentra_company_profiles',expect.objectContaining({organization_id:'eq.org_test'}));
  expect((await POST(device({action:'profile',organizationId:'org_other',profile:{...profile,logo_path:'C:/private',extra_settings_json:{secret:true},invoice_start_number:999}}))).status).toBe(200);
  const sent=stubs.upsert.mock.calls[0][1];expect(sent.organization_id).toBe('org_test');expect(sent.profile).not.toHaveProperty('logo_path');expect(sent.profile).not.toHaveProperty('extra_settings_json');expect(sent.profile).not.toHaveProperty('invoice_start_number');expect(sent.profile.company_name).toBe('Atelier test');
 });
 it.each(['member','accountant','read_only'])('does not let %s manage or enumerate private team addresses',async role=>{
  db.prepare('UPDATE organization_members SET role=?').run(role);
  expect((await POST(device({action:'invite',email:'safe@example.test',role:'member'}))).status).toBe(403);
  const res=await GET(device());expect(res.status).toBe(200);expect(await res.json()).toMatchObject({canManage:false,members:[],invitations:[]});
 });
 it('reserves places, rejects duplicates and owner role, frees a cancelled invitation',async()=>{
  const first=await POST(device({action:'invite',email:' Person@example.test ',role:'accountant'}));expect(first.status).toBe(201);
  const body=await first.json() as {invitation:{id:string;email:string;role:string}};expect(body.invitation.email).toBe('person@example.test');expect(body.invitation.role).toBe('accountant');
  expect((await POST(device({action:'invite',email:'person@example.test',role:'member'}))).status).toBe(409);
  expect((await POST(device({action:'invite',email:'owner2@example.test',role:'owner'}))).status).toBe(400);
  expect((await POST(device({action:'invite',email:'other@example.test',role:'read_only'}))).status).toBe(201);
  expect((await POST(device({action:'invite',email:'full@example.test',role:'member'}))).status).toBe(409);
  expect((await POST(device({action:'revoke',invitationId:'inv_00000000-0000-4000-8000-000000000000'}))).status).toBe(409);
  expect((await POST(device({action:'revoke',invitationId:body.invitation.id}))).status).toBe(200);
  expect((await POST(device({action:'revoke',invitationId:body.invitation.id}))).status).toBe(409);
  expect((await POST(device({action:'invite',email:'full@example.test',role:'member'}))).status).toBe(201);
 });
 it.each(ZENTRA_PLANS)('enforces $name seats with the owner included',async plan=>{
  db.prepare('UPDATE subscriptions SET entitlement_plan_id=?,seat_limit=?').run(plan.licensePlan,plan.seats);
  for(let i=1;i<plan.seats;i++)expect((await POST(device({action:'invite',email:`person${i}@example.test`,role:'member'}))).status).toBe(201);
  expect((await POST(device({action:'invite',email:'extra@example.test',role:'member'}))).status).toBe(409);
 });
 it('requires a current subscription',async()=>{db.exec('UPDATE subscriptions SET entitlement_valid_until=1');expect((await GET(device())).status).toBe(402);expect(stubs.select).not.toHaveBeenCalled();});
 it('validates company identity and bounds fields before storing',()=>{
  for(const input of [null,[],{}, {...profile,company_name:''},{...profile,city:42},{...profile,activity_description:'x'.repeat(2001)}])expect(()=>companyProfile(input)).toThrow();
  expect(companyProfile({...profile,vat_registered:'true'}).vat_registered).toBe(false);
 });
 it('accepts empty optional native settings when sharing a company',async()=>{
  const nativeProfile={...profile,noga_detailed_code:null,vat_number:null,uid_number:null,address_line2:null,phone:null};
  const response=await POST(device({action:'profile',profile:nativeProfile}));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({saved:true});
  expect(stubs.upsert).toHaveBeenCalledWith('zentra_company_profiles',expect.objectContaining({
   organization_id:'org_test',profile:expect.objectContaining({company_name:'Atelier test',noga_detailed_code:'',vat_number:'',uid_number:'',address_line2:'',phone:''}),
  }),{onConflict:'organization_id'});
 });
 it('still rejects a missing required identity and structured optional values',async()=>{
  for(const invalid of [{...profile,company_name:null},{...profile,noga_detailed_code:{code:'43'}},{...profile,phone:42}]){
   expect((await POST(device({action:'profile',profile:invalid}))).status).toBe(400);
  }
  expect(stubs.upsert).not.toHaveBeenCalled();
 });
});

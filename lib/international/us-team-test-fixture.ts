import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { seedUsDeviceFixture, sqliteUsDeviceDatabase } from './us-device-test-fixture';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';
// TEST-only local fixture, never imported by a runtime binding or route.
export const teamSql=readFileSync(new URL('../../drizzle/0090_international_us_team_admission.sql',import.meta.url),'utf8');
export type DeviceFixture=Awaited<ReturnType<typeof seedUsDeviceFixture>>;
// These contexts/payment/catalogue/Auth/PG facts are explicitly fictitious TEST.
export function teamContext(f:Pick<DeviceFixture,'owner'|'intent'|'authority'|'policy'|'now'>, userId:string=f.owner,email:string|null='owner@example.test',role:UsTeamContext['role']='owner',mode:UsTeamContext['mode']='member'):UsTeamContext {
  return {schemaVersion:1,organizationId:f.intent.organizationId,mode,role,user:{userId,email,emailConfirmed:email!==null},subscriptionId:f.authority.subscriptionId,
    environment:'TEST',catalogVersion:f.authority.offer.catalogVersion,priceId:f.authority.offer.priceId,seatLimit:f.policy.catalog[0].seatLimit,
    checkedAt:f.now(),validStartsAt:f.authority.evidence!.startsAt,validEndsAt:f.authority.evidence!.endsAt,credential:{kind:'browser'}};
}
export async function teamFixture(seatLimit=8,oldRole:'owner'|'admin'|'accountant'|'member'|'read_only'='owner') {
  const memory=sqliteUsDeviceDatabase(),f=await seedUsDeviceFixture(memory.database,oldRole,seatLimit);memory.sql.exec(teamSql);
  const store=d1UsTeamStore(memory.database,{now:f.now});return {...memory,...f,team:store,context:()=>teamContext(f)};
}
export async function teamCommit(f:{team:ReturnType<typeof d1UsTeamStore>},c:UsTeamContext,q:UsTeamPrivateCommand){return f.team.commit({context:c,command:q,requestHash:await hashUsTeamCommand(c.organizationId,c.user.userId,q)});}
export async function invite(f:Awaited<ReturnType<typeof teamFixture>>,email='recipient@example.test',role:Exclude<UsTeamContext['role'],'owner'>='member',expectedRevision?:number) {
  const c=f.context(),token=newUsTeamToken(),q:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:expectedRevision??await f.team.revision(c),action:'create_invitation',email,role,invitationId:randomUUID(),tokenHash:await hashUsTeamToken(token),expiresAt:c.checkedAt+604800};
  const result=await teamCommit(f,c,q);return {token,q,result};
}
export async function accept(f:Awaited<ReturnType<typeof teamFixture>>,v:Awaited<ReturnType<typeof invite>>,userId=randomUUID()) {
  if(v.q.action!=='create_invitation')throw Error('TEST fixture');
  const c=teamContext(f,userId,v.q.email,v.q.role,'recipient');const q:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await f.team.revision(c),action:'accept_invitation',invitationId:v.q.invitationId,tokenHash:v.q.tokenHash,membershipId:randomUUID(),firstName:'Élodie',lastName:'Smith',displayName:'Élodie Smith'};
  const result=await teamCommit(f,c,q);return {c,q,result,userId};
}

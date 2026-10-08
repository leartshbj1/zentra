import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError } from '../supabase-server';
import { getUsSellerProfile, putUsSellerProfile, validateUsSellerProfileWrite, type SellerProfileStore } from './seller-profile';

const actor={organizationId:'fictitious-us-seller',userId:'fictitious-owner',role:'owner' as const};
const write={expectedRevision:0,requestId:'10000000-0000-4000-8000-000000000001',profile:{displayName:'Fictitious Seller',contactEmail:'seller@example.test',contactPhone:'+1 212 555 0100'}};
const configured={status:'configured',organizationId:actor.organizationId,revision:1,profile:write.profile,updatedBy:actor.userId,updatedAt:'2026-10-08T12:00:00.123456+00:00'};
function fixture(value:unknown={...configured,requestId:write.requestId,replayed:false}){
  const rpc=vi.fn(async(_name:string,_parameters:Readonly<Record<string,unknown>>):Promise<unknown>=>structuredClone(value));
  const store:SellerProfileStore={async rpc<T>(name:string,parameters:Readonly<Record<string,unknown>>):Promise<T>{return await rpc(name,parameters) as T;}};return {rpc,store};
}
describe('dedicated public US seller service',()=>{
  it('normalizes only allowed public strings and owns an immutable canonical write',()=>{
    const input={...write,requestId:write.requestId.toUpperCase(),profile:{displayName:'  Société Fictive  ',contactEmail:' sales@example.test ',contactPhone:' +1 212 555 0100 '}};
    const result=validateUsSellerProfileWrite(input);expect(result).toEqual({...write,profile:{displayName:'Société Fictive',contactEmail:'sales@example.test',contactPhone:'+1 212 555 0100'}});expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.profile)).toBe(true);input.profile.displayName='changed';expect(result.profile.displayName).toBe('Société Fictive');
  });
  it.each(['organizationId','userId','role','ein','logoRef','logoUrl','taxConfiguration','authority'])('rejects forbidden profile field %s',field=>{
    expect(()=>validateUsSellerProfileWrite({...write,profile:{...write.profile,[field]:'forged'}})).toThrow('invalid_request');
  });
  it.each([null,[],{},{...write,requestId:'not-a-uuid'},{...write,expectedRevision:-1},{...write,expectedRevision:0.5},{...write,expectedRevision:Number.MAX_SAFE_INTEGER-1},{...write,userId:'forged'},{...write,profile:{displayName:''}},{...write,profile:{displayName:'x'.repeat(257)}},{...write,profile:{displayName:'private\ncontrol'}},{...write,profile:{displayName:'Seller',contactEmail:'not-email'}},{...write,profile:{displayName:'Seller',contactPhone:null}}])('rejects malformed or oversized input %j',input=>{
    expect(()=>validateUsSellerProfileWrite(input)).toThrow('invalid_request');
  });
  it('does not invoke input getters or accept hidden/symbol fields',()=>{
    const getter=vi.fn(()=> 'Secret');expect(()=>validateUsSellerProfileWrite({...write,profile:Object.defineProperty({},'displayName',{enumerable:true,get:getter})})).toThrow('invalid_request');expect(getter).not.toHaveBeenCalled();
    expect(()=>validateUsSellerProfileWrite({...write,[Symbol('authority')]:true})).toThrow('invalid_request');expect(()=>validateUsSellerProfileWrite(Object.assign(Object.create({requestId:write.requestId}),write))).toThrow('invalid_request');
  });
  it.each(['owner','admin','accountant','member','read_only'] as const)('allows the fresh %s actor to read without consulting CH storage',async role=>{
    const t=fixture(configured);expect(await getUsSellerProfile(t.store,{...actor,role})).toEqual(configured);expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_read_us_seller_profile',{p_organization:actor.organizationId});
  });
  it('returns an explicit unconfigured seller without a fabricated name',async()=>{
    const empty={status:'unconfigured',organizationId:actor.organizationId,revision:0};const t=fixture(empty);expect(await getUsSellerProfile(t.store,actor)).toEqual(empty);
  });
  it.each(['admin','accountant','member','read_only'] as const)('refuses a %s writer before the hook or persistence',async role=>{
    const t=fixture(),beforeWrite=vi.fn(async()=>{});await expect(putUsSellerProfile(t.store,{...actor,role},write,beforeWrite)).rejects.toMatchObject({code:'forbidden',status:403});expect(beforeWrite).not.toHaveBeenCalled();expect(t.rpc).not.toHaveBeenCalled();
  });
  it('keeps beforeWrite Auth errors intact rather than translating them to storage errors',async()=>{
    const t=fixture(),revoked=new AccountPublicError('private auth token',401);await expect(putUsSellerProfile(t.store,actor,write,async()=>{throw revoked;})).rejects.toBe(revoked);expect(t.rpc).not.toHaveBeenCalled();
  });
  it('runs fresh admission before the single scoped internal RPC',async()=>{
    const t=fixture(),beforeWrite=vi.fn(async()=>{expect(t.rpc).not.toHaveBeenCalled();});expect(await putUsSellerProfile(t.store,actor,write,beforeWrite)).toEqual({...configured,requestId:write.requestId,replayed:false});expect(beforeWrite).toHaveBeenCalledOnce();expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_put_us_seller_profile',{p_organization:actor.organizationId,p_actor:actor.userId,p_expected_revision:0,p_request_id:write.requestId,p_profile:write.profile});
  });
  it('keeps the admitted tenant and actor identity stable across the prewrite await',async()=>{
    const t=fixture(),mutableActor={...actor};await putUsSellerProfile(t.store,mutableActor,write,async()=>{mutableActor.organizationId='foreign';mutableActor.userId='other-user';});expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_put_us_seller_profile',{p_organization:actor.organizationId,p_actor:actor.userId,p_expected_revision:0,p_request_id:write.requestId,p_profile:write.profile});
  });
  it.each(['2026-10-08','2026-10-08T12:00:00','2026-02-30T12:00:00Z','2026-10-08T24:00:00Z','2026-10-08T12:00:00+24:00','2026-10-08T12:00:00.1234567Z'])('rejects ambiguous or invalid privileged timestamp %s',async updatedAt=>{
    const t=fixture({...configured,updatedAt,requestId:write.requestId,replayed:false});await expect(putUsSellerProfile(t.store,actor,write)).rejects.toMatchObject({code:'service_unavailable',status:503});
  });
  it.each(['2026-10-08T12:00:00.123456+00:00','2026-10-08T12:00:00.1-04:00','2026-10-08T12:00:00Z'])('preserves exact valid PostgreSQL timestamp %s',async updatedAt=>{
    const t=fixture({...configured,updatedAt,requestId:write.requestId,replayed:true});expect((await putUsSellerProfile(t.store,actor,write)).updatedAt).toBe(updatedAt);
  });
  it('refuses malformed privileged actor identity and status accessors without invoking them',async()=>{
    await expect(getUsSellerProfile(fixture({...configured,updatedBy:'actor\ncontrol'}).store,actor)).rejects.toMatchObject({code:'service_unavailable'});
    const getter=vi.fn(()=> 'unconfigured'),row={organizationId:actor.organizationId,revision:0};Object.defineProperty(row,'status',{enumerable:true,get:getter});const store:SellerProfileStore={async rpc<T>(){return row as T;}};await expect(getUsSellerProfile(store,actor)).rejects.toMatchObject({code:'service_unavailable'});expect(getter).not.toHaveBeenCalled();
  });
  it.each(['organizationId','revision','profile','updatedBy','updatedAt','requestId','replayed','extra'])('rejects malformed receipt %s without publishing privileged content',async field=>{
    const row:Record<string,unknown>={...configured,requestId:write.requestId,replayed:false};if(field==='organizationId')row.organizationId='foreign';if(field==='revision')row.revision=2;if(field==='profile')row.profile={displayName:'Changed'};if(field==='updatedBy')row.updatedBy='different-owner';if(field==='updatedAt')row.updatedAt='invalid';if(field==='requestId')row.requestId='different';if(field==='replayed')row.replayed='true';if(field==='extra')row.authority='private-token';
    const t=fixture(row);await expect(putUsSellerProfile(t.store,actor,write)).rejects.toMatchObject({code:'service_unavailable',status:503});
  });
  it('allows an exact old replay receipt without hydrating from the current mutable head',async()=>{
    const t=fixture({...configured,requestId:write.requestId,replayed:true});expect(await putUsSellerProfile(t.store,actor,write)).toEqual({...configured,requestId:write.requestId,replayed:true});expect(t.rpc).toHaveBeenCalledOnce();
  });
  it.each([['PS001','revision_conflict',409],['PS002','request_id_conflict',409],['PS003','workspace_unavailable',409],['PS004','invalid_request',422],['PS005','service_unavailable',503],['secret','service_unavailable',503]] as const)('maps SQL state %s to public metadata only',async(state,code,status)=>{
    const t=fixture();t.rpc.mockRejectedValue(new SupabaseServerError(400,state));await expect(putUsSellerProfile(t.store,actor,write)).rejects.toMatchObject({code,status,message:code});
  });
  it.each([{...configured,organizationId:'foreign'},{...configured,profile:{displayName:'Seller',ein:'12-3456789'}},{status:'unconfigured',organizationId:'foreign',revision:0},{status:'unconfigured',organizationId:actor.organizationId,revision:0,private:'token'},null])('does not trust a malformed privileged read %j',async row=>{
    const t=fixture(row);await expect(getUsSellerProfile(t.store,actor)).rejects.toMatchObject({code:'service_unavailable',status:503});
  });
});

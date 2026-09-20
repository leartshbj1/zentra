import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,verify,randomUUID} from 'node:crypto';
import {Vault} from '../windows-local/vault.mjs';
import {PlatformBackend,platformEnvelope,desktopAccount,validatePlatformAction} from '../windows-local/platform.mjs';
const keys=generateKeyPairSync('ed25519');
const action=()=>({operation:'save_key',apiKey:'jev-private-fixture',expectedRevision:'initial',operationId:randomUUID()});
test('key operations are scoped to their own signature and schema',()=>{
 const e=platformEnvelope(action(),keys.privateKey);
 assert(verify(null,Buffer.from('zentra-founder-platform-v1\n'+e.payload),keys.publicKey,Buffer.from(e.signature,'base64url')));
 assert(!verify(null,Buffer.from('zentra-founder-access-v1\n'+e.payload),keys.publicKey,Buffer.from(e.signature,'base64url')));
 assert.throws(()=>validatePlatformAction({operation:'state',apiKey:'secret'}));assert.throws(()=>validatePlatformAction({...action(),url:'https://elsewhere.invalid'}));
});
test('an uncertain key write is DPAPI protected, redacted from status and resumed without retyping',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'zentra-key-test-'));const vault=new Vault(root);vault.key=async()=>keys.privateKey;const a=action();
 try{
  const first=new PlatformBackend(vault,async()=>{throw Error('offline');});await assert.rejects(first.request(a),/Connexion interrompue/);
  assert(!(await readFile(path.join(root,'founder-pending-platform.dpapi'))).includes(Buffer.from(a.apiKey)));
  assert.deepEqual(await first.status(),{pending:{operation:'save_key',operationId:a.operationId}});
  let received;const next=new PlatformBackend(vault,async(url,body)=>{assert.equal(url,'https://www.zentraapp.ch/api/founder/platform');received=JSON.parse(Buffer.from(body.payload,'base64url')).action;return {status:200,body:{configured:true}};});
  await assert.rejects(next.request({...a,apiKey:'another-secret'}),/en attente/);assert.deepEqual(await next.retry(),{configured:true});assert.deepEqual(received,a);assert.equal((await next.status()).pending,null);
 }finally{assert(path.resolve(root).startsWith(path.join(os.tmpdir(),'zentra-key-test-')));await rm(root,{recursive:true});}
});
test('desktop account detection returns verified identity only and keeps its token out of the renderer',async()=>{
 const token='fixture-device-secret',session={version:1,session_token:token,organization_id:'org_a',session_expires_at:new Date(Date.now()+86400000).toISOString()};
 const options={read:async()=>Buffer.from('protected'),unprotect:()=>Buffer.from(JSON.stringify(session)),fetcher:async(url,opts)=>{assert.equal(url,'https://zentraapp.ch/api/account/me');assert.equal(opts.headers.Authorization,'Bearer '+token);assert.equal(opts.redirect,'manual');return new Response(JSON.stringify({email:'connected@example.invalid',organization:{id:'org_a',name:'Test company',role:'owner'},unexpectedSecret:token}));}};
 const result=await desktopAccount(options);assert.equal(result.email,'connected@example.invalid');assert(!JSON.stringify(result).includes(token));
 assert.equal((await desktopAccount({...options,fetcher:async()=>new Response('{}',{status:401})})).connected,false);
 assert.equal((await desktopAccount({...options,fetcher:async()=>new Response(JSON.stringify({email:'test@example.invalid',organization:{id:'other'}}))})).connected,false);
});

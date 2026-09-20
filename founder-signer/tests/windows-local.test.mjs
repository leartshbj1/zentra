import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {request as httpRequest} from 'node:http';
import {dpapi,Vault} from '../windows-local/vault.mjs';
import {Backend,envelope,validateAction,validatePayload} from '../windows-local/backend.mjs';
import {startServer} from '../windows-local/server.mjs';
const keys=generateKeyPairSync('ed25519');
const action=()=>({operation:'grant',email:'test@example.invalid',duration:'14_days',customDate:'',operationId:randomUUID(),expectedRevision:0,note:'Test'});
test('Windows protects bytes for this account and rejects corrupted storage',()=>{
 const original=Buffer.from('non-secret-test-data');const protectedBytes=dpapi(original,true);assert(!protectedBytes.includes(original));assert.deepEqual(dpapi(protectedBytes),original);protectedBytes[protectedBytes.length-1]^=1;assert.throws(()=>dpapi(protectedBytes));
});
test('Founder signature keeps the production protocol and domain separation',()=>{
 const e=envelope(action(),keys.privateKey);assert(verify(null,Buffer.from('zentra-founder-access-v1\n'+e.payload),keys.publicKey,Buffer.from(e.signature,'base64url')));assert(!verify(null,Buffer.from(e.payload),keys.publicKey,Buffer.from(e.signature,'base64url')));
 assert.throws(()=>validateAction({...action(),email:'bad'}));assert.throws(()=>validateAction({...action(),operationId:'bad'}));assert.throws(()=>validateAction({...action(),privateKey:'anything'}));assert.throws(()=>validatePayload({}));
});

test('Support product and plan are validated and protected by the founder signature',()=>{
 const a={...action(),product:'support',plan:'business'};const e=envelope(a,keys.privateKey);
 assert.deepEqual(JSON.parse(Buffer.from(e.payload,'base64url')).action,a);
 const changed=JSON.parse(Buffer.from(e.payload,'base64url'));changed.action.plan='starter';
 assert(!verify(null,Buffer.from('zentra-founder-access-v1\n'+Buffer.from(JSON.stringify(changed)).toString('base64url')),keys.publicKey,Buffer.from(e.signature,'base64url')));
 assert.throws(()=>validateAction({...action(),plan:'starter'}));assert.throws(()=>validateAction({...a,plan:'pro'}));assert.throws(()=>validateAction({...a,product:'unknown'}));
});
test('Automation and its chosen company are signed, without a Support formula',()=>{
 const a={...action(),product:'automation',organizationId:'org_test'};const e=envelope(a,keys.privateKey);
 const payload=JSON.parse(Buffer.from(e.payload,'base64url'));assert.deepEqual(payload.action,a);
 payload.action.organizationId='org_elsewhere';assert(!verify(null,Buffer.from('zentra-founder-access-v1\n'+Buffer.from(JSON.stringify(payload)).toString('base64url')),keys.publicKey,Buffer.from(e.signature,'base64url')));
 assert.throws(()=>validateAction({...a,plan:'starter'}));assert.throws(()=>validateAction({...a,product:'support',plan:'starter'}));assert.throws(()=>validateAction({...a,operation:'revoke'}));
});
test('An uncertain write survives restart, prohibits other writes, and retries the same operation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'zentra-founder-test-'));const vault=new Vault(root);vault.key=async()=>keys.privateKey;
 try{
  const a={...action(),product:'automation',organizationId:'org_test'};const first=new Backend(vault,{post:async()=>{throw Error('simulated offline');}});
  await assert.rejects(first.invoke('founder_request',{action:a}),/Connexion interrompue/);
  const stored=await readFile(path.join(root,'founder-pending-access.dpapi'));assert(!stored.includes(Buffer.from(a.email)));
  let received;const restarted=new Backend(vault,{post:async(url,e)=>{received=JSON.parse(Buffer.from(e.payload,'base64url')).action;return {status:200,body:{replayed:true}};}});
  assert.deepEqual(await restarted.pending(),a);
  await assert.rejects(restarted.invoke('founder_request',{action:action()}),/demande attend/);
  assert.deepEqual(await restarted.invoke('founder_request',{action:a}),{replayed:true});assert.deepEqual(received,a);assert.equal(await restarted.pending(),null);
  for(const reference of ['../founder-admin-key.dpapi','license-signing-key.dpapi','owner-license-token/../../x.dpapi'])await assert.rejects(vault.token(reference));
 }finally{assert(path.resolve(root).startsWith(path.join(os.tmpdir(),'zentra-founder-test-')));await rm(root,{recursive:true});}
});
test('Local server requires a launch secret, session, exact origin and CSRF token; no arbitrary files are served',async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));let calls=0;
 const app=await startServer(root,{invoke:async()=>{calls++;return {ready:true};}});
 try{
  assert.equal((await fetch(app.origin+'/')).status,403);
  assert.equal((await fetch(app.origin+'/health')).status,403);
  assert.equal((await fetch(app.origin+'/invoke',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
  const launch=await fetch(app.origin+'/launch/'+app.launchToken,{redirect:'manual'});assert.equal(launch.status,303);
  const cookie=launch.headers.get('set-cookie').split(';')[0];assert(launch.headers.get('set-cookie').includes('HttpOnly'));
  const html=await (await fetch(app.origin+'/',{headers:{Cookie:cookie}})).text();assert(html.includes('bridge.js'));assert(!html.includes(app.launchToken));
  const bridge=await (await fetch(app.origin+'/bridge.js',{headers:{Cookie:cookie}})).text();const csrf=bridge.match(/const csrf="([A-Za-z0-9_-]+)"/)[1];
  const headers={Cookie:cookie,Origin:app.origin,'Content-Type':'application/json','X-Zentra-Session':csrf};
  assert.equal((await fetch(app.origin+'/invoke',{method:'POST',headers:{...headers,Origin:'https://attacker.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(app.origin+'/invoke',{method:'POST',headers:{...headers,'X-Zentra-Session':'bad'},body:'{}'})).status,403);
  const result=await fetch(app.origin+'/invoke',{method:'POST',headers,body:JSON.stringify({command:'founder_status'})});assert.equal(result.status,200);assert.equal(calls,1);
  assert.equal((await fetch(app.origin+'/vault/founder-admin-key.dpapi',{headers:{Cookie:cookie}})).status,404);
  assert.equal((await fetch(app.origin+'/backend.mjs',{headers:{Cookie:cookie}})).status,404);
  const wrongHost=await new Promise((resolve,reject)=>{const r=httpRequest(app.origin+'/',{headers:{Cookie:cookie,Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});assert.equal(wrongHost,403);
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
});

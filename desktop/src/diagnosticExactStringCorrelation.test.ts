import {beforeEach,describe,expect,it,vi} from 'vitest';
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:transport.invoke}));
import {diagnosticOperation,diagnosticsApi,knownErrorIncident,recentDiagnosticEvents,resolveErrorIncident,withKnownErrorIncident} from './diagnostics';
const collisionA='synthetic-network-rejection-dauRda-cBiml';
const collisionB='synthetic-network-rejection-FHlW-XlZn0na';
const failures=()=>recentDiagnosticEvents().filter(event=>event.phase==='failure');
async function source(message:unknown,operation='create_record'){
 await diagnosticOperation('command',operation,async()=>{throw message;}).catch(()=>{});
 return 'ZT-'+failures().at(-1)!.id;
}
beforeEach(async()=>{transport.invoke.mockReset();transport.invoke.mockResolvedValue(null);await diagnosticsApi.clear();});
describe('exact ephemeral diagnostic string association and explicit bounds',()=>{
 it('does not claim the source of a different string even when the old FNV32 and length collide',async()=>{
  const code=await source(collisionA);expect(knownErrorIncident(collisionA)).toEqual({code});expect(knownErrorIncident(collisionB)).toBeUndefined();
  const wrapper=withKnownErrorIncident(Error('canonical collision guide'),collisionB);
  expect(knownErrorIncident(wrapper)).toBeUndefined();expect(resolveErrorIncident(wrapper).code).not.toBe(code);
 });
 it('keeps each distinct colliding string attached to its own recorded source',async()=>{
  const first=await source(collisionA),second=await source(collisionB,'update_record');
  expect(first).not.toBe(second);expect(knownErrorIncident(collisionA)).toEqual({code:first});expect(knownErrorIncident(collisionB)).toEqual({code:second});
  expect(resolveErrorIncident(withKnownErrorIncident(Error('guide first'),collisionA)).code).toBe(first);
  expect(resolveErrorIncident(withKnownErrorIncident(Error('guide second'),collisionB)).code).toBe(second);
 });
 it('still refuses to choose one source for the same primitive string used by two failures',async()=>{
  const first=await source(collisionA),second=await source(collisionA,'update_record');expect(first).not.toBe(second);
  expect(knownErrorIncident(collisionA)).toBeUndefined();const wrapper=withKnownErrorIncident(Error('canonical duplicate guide'),collisionA);expect(knownErrorIncident(wrapper)).toBeUndefined();
  const shown=resolveErrorIncident(wrapper).code;expect([first,second]).not.toContain(shown);expect(resolveErrorIncident(wrapper).code).toBe(shown);
 });
 it('accepts a 4096-unit primitive key and refuses any source association at 4097 units',async()=>{
  const admitted='a'.repeat(4096),tooLong='b'.repeat(4097),first=await source(admitted),second=await source(tooLong);
  expect(knownErrorIncident(admitted)).toEqual({code:first});expect(knownErrorIncident(tooLong)).toBeUndefined();
  const wrapper=withKnownErrorIncident(Error('canonical long source'),tooLong);expect(knownErrorIncident(wrapper)).toBeUndefined();expect(resolveErrorIncident(wrapper).code).not.toBe(second);
 });
 it('uses UTF-16 unit bounds, including astral characters, without truncating keys',async()=>{
  const admitted='😀'.repeat(2048),tooLong='😀'.repeat(2049);expect(admitted.length).toBe(4096);expect(tooLong.length).toBe(4098);
  const code=await source(admitted);await source(tooLong,'update_record');expect(knownErrorIncident(admitted)).toEqual({code});expect(knownErrorIncident(tooLong)).toBeUndefined();
 });
 it('preserves the exact Error object source even if its message cannot fit the string map',async()=>{
  const original=Error('private-long-object-'.repeat(500)),code=await source(original);expect(original.message.length).toBeGreaterThan(4096);
  expect(knownErrorIncident(original)).toEqual({code});expect(knownErrorIncident(original.message)).toBeUndefined();
  const wrapper=withKnownErrorIncident(Error('canonical exact object'),original);expect(resolveErrorIncident(wrapper).code).toBe(code);
 });
 it('caps retained keys at forty entries and never substitutes an evicted source',async()=>{
  const messages=Array.from({length:41},(_,index)=>`synthetic-entry-${index}`);const codes:string[]=[];
  for(const message of messages)codes.push(await source(message));
  expect(knownErrorIncident(messages[0])).toBeUndefined();expect(knownErrorIncident(messages[1])).toEqual({code:codes[1]});expect(knownErrorIncident(messages[40])).toEqual({code:codes[40]});
  expect(knownErrorIncident(withKnownErrorIncident(Error('evicted source guide'),messages[0]))).toBeUndefined();
 });
 it('caps aggregate retained content at 65536 UTF-16 units by evicting the oldest exact key',async()=>{
  const messages=Array.from({length:17},(_,index)=>`entry-${String(index).padStart(2,'0')}-`.padEnd(4096,String.fromCharCode(65+index)));const codes:string[]=[];
  for(const message of messages.slice(0,16))codes.push(await source(message));
  expect(knownErrorIncident(messages[0])).toEqual({code:codes[0]});expect(messages.slice(0,16).reduce((sum,value)=>sum+value.length,0)).toBe(65536);
  codes.push(await source(messages[16]));expect(knownErrorIncident(messages[0])).toBeUndefined();expect(knownErrorIncident(messages[1])).toEqual({code:codes[1]});expect(knownErrorIncident(messages[16])).toEqual({code:codes[16]});
 });
 it('retains an explicitly bound wrapper reference after its primitive string key is evicted',async()=>{
  const original='synthetic-original-evicted',code=await source(original),wrapper=withKnownErrorIncident(Error('canonical retained wrapper'),original);
  for(let index=0;index<40;index++)await source(`synthetic-following-${index}`);
  expect(knownErrorIncident(original)).toBeUndefined();expect(resolveErrorIncident(wrapper).code).toBe(code);
 });
 it('clears the retained character budget together with the incident associations',async()=>{
  const messages=Array.from({length:16},(_,index)=>`before-${index}-`.padEnd(4096,'x'));for(const message of messages)await source(message);
  await diagnosticsApi.clear();expect(knownErrorIncident(messages[0])).toBeUndefined();
  const after=Array.from({length:16},(_,index)=>`after-${index}-`.padEnd(4096,'y'));const codes:string[]=[];for(const message of after)codes.push(await source(message));
  expect(knownErrorIncident(after[0])).toEqual({code:codes[0]});expect(knownErrorIncident(after[15])).toEqual({code:codes[15]});
 });
 it('names the honest stability limit for oversized primitive presentations; neither is a source',async()=>{
  const oversized='private-oversized-'.repeat(300),sourceCode=await source(oversized);
  const first=resolveErrorIncident(oversized).code,second=resolveErrorIncident(oversized).code;
  expect(first).not.toBe(sourceCode);expect(second).not.toBe(sourceCode);expect(first).not.toBe(second);expect(knownErrorIncident(oversized)).toBeUndefined();
  expect(failures().slice(-2).map(event=>event.operation)).toEqual(['client.present_error','client.present_error']);
 });
 it('never retains a non-string message accessor result as a string key or follows arbitrary getters',async()=>{
  let lookups=0;const message=new Proxy({},{get(){lookups++;throw Error('hostile fixture lookup');}});const original=Error('fixture');Object.defineProperty(original,'message',{value:message});
  const code=await source(original),afterSource=lookups;const wrapper=withKnownErrorIncident(Error('canonical hostile guide'),original);expect(resolveErrorIncident(wrapper).code).toBe(code);expect(lookups).toBe(afterSource);expect(knownErrorIncident(message)).toBeUndefined();
 });
 it('keeps all exact keys private in memory, including bounded secrets and oversized messages',async()=>{
  const secret='private-email-fixture@example.test|nonce-'+ 'a'.repeat(32),long='private-oversized-export-'.repeat(300);await source(secret);await source(long);
  resolveErrorIncident(withKnownErrorIncident(Error('canonical private guide'),secret));resolveErrorIncident(long);
  const journal=JSON.stringify(recentDiagnosticEvents());expect(journal).not.toContain(secret);expect(journal).not.toContain(long);expect(journal).not.toContain('private-email');expect(journal).not.toContain('nonce-');expect(journal).not.toContain('canonical private guide');
  for(const event of recentDiagnosticEvents())expect(Object.keys(event).sort()).toEqual(['area','durationMs','errorCode','id','operation','phase','sessionId','timestamp'].filter(key=>key in event).sort());
 });
});

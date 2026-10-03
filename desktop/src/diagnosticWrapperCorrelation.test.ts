import {beforeEach,describe,expect,it,vi} from 'vitest';
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:transport.invoke}));
import {diagnosticInvoke,diagnosticOperation,diagnosticsApi,knownErrorIncident,recentDiagnosticEvents,resolveErrorIncident,withKnownErrorIncident} from './diagnostics';
import {createWorkspaceEntity,WorkspaceCreationOutcomeUnknownError} from './workspaceCreation';
import {QuickClientCreationUnconfirmedError} from './documentQuickClientDraft';
import {refreshWorkspaceAfterMutation,WorkspaceRefreshAfterMutationError} from './workspaceMutation';
import {memberOriginNativeFailure} from './memberOriginBridge';
import {WorkspaceMemberOriginChangedError} from './workspaceMemberOrigin';
import {WorkspaceOriginChangedError} from './workspaceOrigin';
import type {Workspace} from './types';
const id='11111111-aaaa-4aaa-8aaa-111111111111',scope='synthetic-company';
const empty={onboardingCompleted:true,workNotesScope:scope,clients:[]} as unknown as Workspace;
const failures=()=>recentDiagnosticEvents().filter(event=>event.phase==='failure');
beforeEach(async()=>{transport.invoke.mockReset();transport.invoke.mockResolvedValue(null);await diagnosticsApi.clear();});
describe('explicit diagnostic source association',()=>{
 it('links the exact known source object to an ordinary wrapper without changing its identity, class or message',async()=>{
  const original=Error('network timeout private-original');await diagnosticOperation('command','create_record',async()=>{throw original;}).catch(()=>{});
  const before=recentDiagnosticEvents().length;const wrapper=Error('canonical authored guide',{cause:original});
  expect(withKnownErrorIncident(wrapper,original)).toBe(wrapper);expect(wrapper).toBeInstanceOf(Error);expect(wrapper.message).toBe('canonical authored guide');
  expect(knownErrorIncident(wrapper)).toEqual(knownErrorIncident(original));expect(resolveErrorIncident(wrapper).code).toBe('ZT-'+failures()[0].id);expect(recentDiagnosticEvents()).toHaveLength(before);
 });
 it('links a unique recorded primitive native rejection, without any getter or cause search',async()=>{
  const original='network timeout primitive';transport.invoke.mockRejectedValueOnce(original);await diagnosticInvoke('create_record',{data:{password:'fixture private'}}).catch(()=>{});
  const wrapper=withKnownErrorIncident(Error('canonical guide'),original);expect(resolveErrorIncident(wrapper).code).toBe('ZT-'+failures()[0].id);expect(failures()).toHaveLength(1);
 });
 it('keeps the real nested creation and quick-client wrappers ordinary and preserves the same true command incident',async()=>{
  const original=Error('network timeout exact-nested');const first=await createWorkspaceEntity('clients',{id},()=>diagnosticOperation('command','create_record',async()=>{throw original;}),async()=>empty,scope).catch(reason=>reason);
  expect(first).toBeInstanceOf(WorkspaceCreationOutcomeUnknownError);expect(first.mutationCause).toBe(original);expect(first.recordId).toBe(id);
  const wrapper=new QuickClientCreationUnconfirmedError(first);expect(wrapper).not.toBeInstanceOf(WorkspaceCreationOutcomeUnknownError);expect(wrapper.cause).toBe(first);
  expect(resolveErrorIncident(first).code).toBe('ZT-'+failures()[0].id);expect(resolveErrorIncident(wrapper).code).toBe('ZT-'+failures()[0].id);expect(failures()).toHaveLength(1);
 });
 it('does not choose either source when two concurrent commands reject the same primitive string',async()=>{
  const original='network timeout concurrent';await Promise.all([diagnosticOperation('command','create_record',async()=>{throw original;}).catch(()=>{}),diagnosticOperation('command','update_record',async()=>{throw original;}).catch(()=>{})]);
  const source=failures().map(event=>'ZT-'+event.id);const wrapper=withKnownErrorIncident(Error('canonical ambiguous guide'),original);expect(knownErrorIncident(wrapper)).toBeUndefined();
  const code=resolveErrorIncident(wrapper).code;expect(source).not.toContain(code);expect(resolveErrorIncident(wrapper).code).toBe(code);expect(failures().at(-1)).toMatchObject({operation:'client.present_error'});
 });
 it('does not choose a source for an Error object reused by two failed commands',async()=>{
  const original=Error('network timeout reused-object');await diagnosticOperation('command','create_record',async()=>{throw original;}).catch(()=>{});await diagnosticOperation('command','update_record',async()=>{throw original;}).catch(()=>{});
  const ids=failures().map(event=>'ZT-'+event.id);expect(knownErrorIncident(original)).toBeUndefined();const wrapper=withKnownErrorIncident(Error('canonical reused guide'),original);expect(knownErrorIncident(wrapper)).toBeUndefined();
  const code=resolveErrorIncident(wrapper).code;expect(ids).not.toContain(code);expect(resolveErrorIncident(wrapper).code).toBe(code);const presentation=resolveErrorIncident(original).code;expect(ids).not.toContain(presentation);expect(resolveErrorIncident(original).code).toBe(presentation);
 });
 it('keeps equal-message distinct source objects precise even though their message string is ambiguous',async()=>{
  const first=Error('network same-message'),second=Error('network same-message');await diagnosticOperation('command','create_record',async()=>{throw first;}).catch(()=>{});await diagnosticOperation('command','update_record',async()=>{throw second;}).catch(()=>{});
  const [a,b]=failures();expect(resolveErrorIncident(withKnownErrorIncident(Error('guide one'),first)).code).toBe('ZT-'+a.id);expect(resolveErrorIncident(withKnownErrorIncident(Error('guide two'),second)).code).toBe('ZT-'+b.id);expect(knownErrorIncident(first.message)).toBeUndefined();
 });
 it('does not promote a known presentation-only incident into a fake command source',()=>{
  const source=Error('unrecorded original');const presentation=resolveErrorIncident(source).code;const wrapper=withKnownErrorIncident(Error('canonical no command'),source);
  expect(knownErrorIncident(wrapper)).toBeUndefined();expect(resolveErrorIncident(wrapper).code).not.toBe(presentation);expect(failures().every(event=>event.operation==='client.present_error')).toBe(true);
 });
 it('never follows an arbitrary cause, mutationCause, prototype or message accessor on an unrecorded object',()=>{
  let reads=0;const hostile={get cause(){reads++;throw Error('cause getter');},get mutationCause(){reads++;throw Error('mutation getter');},get message(){reads++;throw Error('message getter');}};const wrapper=Error('canonical safe');
  expect(withKnownErrorIncident(wrapper,hostile)).toBe(wrapper);expect(knownErrorIncident(hostile)).toBeUndefined();expect(reads).toBe(0);expect(recentDiagnosticEvents()).toHaveLength(0);
 });
 it('performs its association and known-incident lookup without hostile getters or proxy prototype access',()=>{
  let reads=0;const hostile=new Proxy({},{get(){reads++;throw Error('property access');},getPrototypeOf(){reads++;throw Error('prototype access');}});const wrapper=Error('canonical safe wrapper');
  expect(withKnownErrorIncident(wrapper,hostile)).toBe(wrapper);expect(knownErrorIncident(hostile)).toBeUndefined();expect(reads).toBe(0);expect(recentDiagnosticEvents()).toHaveLength(0);
 });
 it('can link a previously recorded hostile exact object without inspecting it again',async()=>{
  let reads=0;const source=new Proxy({},{get(){reads++;throw Error('access');},getPrototypeOf(){reads++;throw Error('prototype');}});await diagnosticOperation('command','create_record',async()=>{throw source;}).catch(()=>{});const before=reads;
  const wrapper=withKnownErrorIncident(Error('canonical hostile guide'),source);expect(resolveErrorIncident(wrapper).code).toBe('ZT-'+failures()[0].id);expect(reads).toBe(before);
 });
 it.each(['L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.','Le compte connecté a changé. Rouvrez cette action avec le bon compte.','Le contexte local du compte doit être vérifié. Rouvrez votre espace.'])('preserves terminal conversion and the exact source incident for %s',async message=>{
  const source='Champ invalide : '+message;await diagnosticOperation('command','create_record',async()=>{throw source;}).catch(()=>{});const mapped=memberOriginNativeFailure(source)!;
  expect(mapped).toBeInstanceOf(WorkspaceOriginChangedError);if(message.startsWith('Le '))expect(mapped).toBeInstanceOf(WorkspaceMemberOriginChangedError);expect(mapped.message).toBe(message);expect(resolveErrorIncident(mapped).code).toBe('ZT-'+failures()[0].id);expect(failures()[0].errorCode).toBe('CONFLICT');
 });
 it('links a confirmed write/read failure only to the actual read incident and never invokes the acknowledged write again',async()=>{
  let writes=0;await diagnosticOperation('command','create_record',async()=>{writes++;return null;});const readError=Error('network read timeout');const result=await refreshWorkspaceAfterMutation(()=>diagnosticOperation('command','get_workspace',async()=>{throw readError;})).catch(reason=>reason);
  expect(result).toBeInstanceOf(WorkspaceRefreshAfterMutationError);expect(result.refreshCause).toBe(readError);expect(resolveErrorIncident(result).code).toBe('ZT-'+failures()[0].id);expect(failures()[0].operation).toBe('get_workspace');expect(writes).toBe(1);
 });
 it('does not read arbitrary cause even when it points to a known command failure',async()=>{
  const source=Error('network hidden source');await diagnosticOperation('command','create_record',async()=>{throw source;}).catch(()=>{});let reads=0;const wrapper=Error('canonical unrelated');Object.defineProperty(wrapper,'cause',{get(){reads++;return source;}});
  expect(knownErrorIncident(wrapper)).toBeUndefined();const shown=resolveErrorIncident(wrapper).code;expect(shown).not.toBe('ZT-'+failures()[0].id);expect(reads).toBe(0);
 });
 it('keeps one source reference through rerender-style reads and removes it after explicit clear',async()=>{
  const source=Error('network clear source');await diagnosticOperation('command','create_record',async()=>{throw source;}).catch(()=>{});const wrapped=withKnownErrorIncident(Error('canonical clear'),source),code=resolveErrorIncident(wrapped).code;for(let i=0;i<20;i++)expect(resolveErrorIncident(wrapped).code).toBe(code);expect(failures()).toHaveLength(1);
  await diagnosticsApi.clear();expect(knownErrorIncident(source)).toBeUndefined();expect(knownErrorIncident(wrapped)).toBeUndefined();expect(resolveErrorIncident(wrapped).code).not.toBe(code);
 });
 it('exports only bounded diagnostic metadata; source messages, sentinels, args, IDs and context are absent',async()=>{
  const privateData={password:'synthetic-secret-password',email:'fixture@example.test',nonce:'a'.repeat(32),scope,id};const source=Error('network secret source '+JSON.stringify(privateData));transport.invoke.mockRejectedValueOnce(source);await diagnosticInvoke('create_record',{data:privateData}).catch(()=>{});const wrapper=withKnownErrorIncident(Error('canonical authored sentinel',{cause:source}),source);resolveErrorIncident(wrapper);
  const journal=JSON.stringify(recentDiagnosticEvents());for(const token of [...Object.values(privateData),'canonical authored sentinel',source.message])expect(journal).not.toContain(token);expect(failures()).toHaveLength(1);
 });
});

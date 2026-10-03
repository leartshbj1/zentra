// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
/** Real bridge and origin wrappers; only native IPC is closed/simulated.
 * Intent metadata must not read payloads or change command/business semantics. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({invoke:vi.fn(),external:0}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:native.invoke,isTauri:()=>false}));
vi.hoisted(()=>{globalThis.fetch=async()=>{native.external++;throw Error('External requests forbidden');};Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});});
import {desktopApi,archiveEntityMutation} from './bridge';
import {withDiagnosticIntent,withEntityDiagnosticIntent,copyDiagnosticIntent,diagnosticIntentOperation,type DiagnosticIntentCommand,type DiagnosticIntentAction} from './diagnosticIntent';
import {diagnosticInvoke,diagnosticsApi,recentDiagnosticEvents,resolveErrorIncident} from './diagnostics';
import {invokeInMemberOrigin} from './memberOriginBridge';
import {WorkspaceMemberOriginChangedError} from './workspaceMemberOrigin';
import {WorkspaceCreationOutcomeUnknownError} from './workspaceCreation';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';
import type {EntityKind,DocumentLine,Quote,Invoice} from './types';
const scope='synthetic-intent-company',nonce='a'.repeat(32),id='11111111-1111-4111-8111-111111111111';
const privateText='fixture@example.test private-password /private/path';
const entities=[['clients','clients','client'],['suppliers','suppliers','supplier'],['projects','projects','project'],['employees','employees','employee'],['quotes','quotes','quote'],['invoices','invoices','invoice'],['catalogItems','catalog_items','catalog_item'],['timeEntries','time_entries','time_entry'],['expenses','expenses','expense'],['payslips','payslips','payslip']] as const;
const line:DocumentLine={id:'new-line',catalogItemId:null,description:privateText,quantity:2,unit:'h',unitPriceCents:12345,discountBp:123,vatRateBp:810};
const privateData=Object.freeze({id,name:privateText,totalCents:98765,notes:privateText});
let mode='',failure:unknown=Error('network private synthetic');
const calls=()=>native.invoke.mock.calls.filter(([command])=>!['clear_diagnostics','append_diagnostic_events'].includes(command));
const pairs=(operation:string)=>recentDiagnosticEvents().filter(event=>event.operation===operation);
function privacy(){const journal=JSON.stringify(recentDiagnosticEvents());for(const token of [privateText,id,scope,nonce,'98765','12345'])expect(journal).not.toContain(token);for(const event of recentDiagnosticEvents())expect(Object.keys(event).every(key=>['id','sessionId','timestamp','area','operation','phase','durationMs','errorCode'].includes(key))).toBe(true);}
beforeEach(async()=>{
 mode='';failure=Error('network '+privateText);native.invoke.mockReset();native.invoke.mockImplementation(async(command:string,args:any)=>{
  if(command==='clear_diagnostics'||command==='append_diagnostic_events')return null;
  if(['create_record','update_record','delete_record','save_document_with_items'].includes(command)){if(mode==='write-failure')throw failure;return {id:args.data?.id??'saved-result',private:privateText};}
  if(command==='get_app_state'){if(mode==='read-failure')throw failure;return {onboarding_completed:true};}
  if(command==='get_workspace')return {work_notes_scope:scope,settings:null,clients:[],suppliers:[],projects:[],employees:[],quotes:[],invoices:[]};
  return {accepted:true};
 });await diagnosticsApi.clear();
});
afterEach(()=>{privacy();expect(native.external).toBe(0);expect(calls().some(([command])=>['get_form_draft_identity','get_cloud_account_state'].includes(command))).toBe(false);});
describe('actual bridge closed entity diagnostic provenance',()=>{
 it.each(entities)('create %s keeps the exact preflight/write/read order and entity name',async(entity,backend,label)=>{
  await desktopApi.createEntity(entity,privateData,scope,nonce);
  expect(calls().map(([command])=>command)).toEqual(['get_app_state','get_workspace','create_record','get_app_state','get_workspace']);
  const args=calls()[2][1];expect(args).toEqual({entity:backend,data:{id,name:privateText,total_cents:98765,notes:privateText},expectedWorkspaceScope:scope,expectedMemberContextNonce:nonce});
  expect(Object.keys(args)).toEqual(['entity','data','expectedWorkspaceScope','expectedMemberContextNonce']);expect(pairs(`record.${label}.create`).map(event=>event.phase)).toEqual(['start','success']);
 });
 it.each(entities)('update %s preserves payload and optional origin argument ordering',async(entity,backend,label)=>{
  await desktopApi.updateEntity(entity,id,privateData,scope,nonce);
  expect(calls().map(([command])=>command)).toEqual(['update_record','get_app_state','get_workspace']);expect(calls()[0][1]).toEqual({entity:backend,id,data:{id,name:privateText,total_cents:98765,notes:privateText},expectedWorkspaceScope:scope,expectedMemberContextNonce:nonce});
  expect(Object.keys(calls()[0][1])).toEqual(['entity','id','data','expectedWorkspaceScope','expectedMemberContextNonce']);expect(pairs(`record.${label}.update`).map(event=>event.phase)).toEqual(['start','success']);
 });
 it.each(entities)('archive %s retains the exact existing update-versus-delete command',async(entity,backend,label)=>{
  const expected=['clients','suppliers','catalogItems'].includes(entity)?'update_record':'delete_record';await desktopApi.archiveEntity(entity,id,scope,nonce);
  expect(calls().map(([command])=>command)).toEqual([expected,'get_app_state','get_workspace']);const args=calls()[0][1];expect(args.entity).toBe(backend);expect(args.id).toBe(id);
  if(expected==='update_record'){expect(args.data).toEqual({archived_at:expect.any(String)});expect(Object.keys(args.data)).toEqual(['archived_at']);}else expect(args).not.toHaveProperty('data');
  expect(pairs(`record.${label}.${expected==='update_record'?'update':'delete'}`).map(event=>event.phase)).toEqual(['start','success']);
 });
 it.each([['quotes',false],['quotes',true],['invoices',false],['invoices',true]] as const)('saves %s edit=%s with unchanged atomic document fields and lines',async(entity,edit)=>{
  const data=Object.freeze({...privateData,type:'deposit',depositPercentageBp:3333,depositBasisLines:[line]}),existing=edit?{id:'existing-document',lines:[line]} as Quote|Invoice:undefined;
  await desktopApi.saveDocument(entity,data,[line],existing,scope,nonce);
  expect(calls().map(([command])=>command)).toEqual(['save_document_with_items','get_app_state','get_workspace']);const args=calls()[0][1];expect(Object.keys(args)).toEqual(['input','expectedWorkspaceScope','expectedMemberContextNonce']);
  expect(args.input.entity).toBe(entity);expect(args.input.id).toBe(existing?.id??null);expect(args.input.data.deposit_percentage_bp).toBe(3333);expect(args.input.data.total_cents).toBe(98765);expect(args.input.data.deposit_basis_json[0].description).toBe(privateText);expect(args.input.items[0]).toMatchObject({id:edit?'new-line':null,description:privateText,unit_price_cents:12345,discount_bp:123,vat_bp:810});
  expect(pairs(entity==='quotes'?'document.quote.save':'document.invoice.save').map(event=>event.phase)).toEqual(['start','success']);expect(data.depositBasisLines[0]).toBe(line);
 });
 it('keeps saveProject create/update return values and command count intact',async()=>{
  expect(await desktopApi.saveProject(privateData,undefined,scope,nonce)).toBe(id);expect(calls()).toHaveLength(1);expect(pairs('record.project.create')).toHaveLength(2);
  expect(await desktopApi.saveProject(privateData,'project-existing',scope,nonce)).toBe('project-existing');expect(calls()).toHaveLength(2);expect(pairs('record.project.update')).toHaveLength(2);
 });
 it('keeps the legacy payslip/line generic commands, amounts and ordering intact',async()=>{
  const kept={id:'line-kept',label:privateText,kind:'earning' as const,amountCents:500,postingAccountId:undefined,expenseAccountId:undefined},removed={...kept,id:'line-removed'},fresh={...kept,id:'line-new',amountCents:250};
  await desktopApi.savePayslip({employeeId:'synthetic-employee'},[kept,fresh],{id:'synthetic-payslip',employeeId:'synthetic-employee',period:'2026-10',status:'draft',paymentDate:'',notes:'',createdAt:'2026-10-03',lines:[kept,removed]},scope,nonce);
  expect(calls().map(([command])=>command)).toEqual(['update_record','delete_record','update_record','create_record','get_app_state','get_workspace']);
  expect(calls().slice(0,4).map(([,args])=>args.entity)).toEqual(['payslips','payslip_items','payslip_items','payslip_items']);expect(calls()[2][1].data.amount_cents).toBe(500);expect(calls()[3][1].data.amount_cents).toBe(250);
  for(const name of ['record.payslip.update','record.payslip_item.delete','record.payslip_item.update','record.payslip_item.create'])expect(pairs(name).map(event=>event.phase)).toEqual(['start','success']);
 });
 it('keeps named historical calls without origin fields and one-argument reads unchanged',async()=>{
  await desktopApi.updateEntity('clients',id,{name:privateText});expect(calls()[0][1]).toEqual({entity:'clients',id,data:{name:privateText}});expect(calls().slice(1).map(call=>call.length)).toEqual([1,1]);
  await desktopApi.saveDocument('quotes',{notes:privateText},[line]);for(const [,args]of calls())expect(args??{}).not.toHaveProperty('expectedWorkspaceScope');
 });
 it('preserves the actual unknown-creation class, source reference and no-replay behavior',async()=>{
  mode='write-failure';const result=await desktopApi.createEntity('employees',privateData,scope,nonce).catch(reason=>reason);expect(result).toBeInstanceOf(WorkspaceCreationOutcomeUnknownError);expect(result.mutationCause).toBe(failure);expect(calls().filter(([command])=>command==='create_record')).toHaveLength(1);
  const event=pairs('record.employee.create').find(event=>event.phase==='failure')!;expect(resolveErrorIncident(result).code).toBe('ZT-'+event.id);
 });
 it('keeps an ordinary update rejection as the exact original object without any refresh',async()=>{
  mode='write-failure';await expect(desktopApi.updateEntity('clients',id,privateData,scope,nonce)).rejects.toBe(failure);expect(calls()).toHaveLength(1);expect(pairs('record.client.update').map(event=>event.phase)).toEqual(['start','failure']);
 });
 it('keeps native member guards terminal and classified while retaining the entity log',async()=>{
  mode='write-failure';failure='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';const result=await desktopApi.updateEntity('suppliers',id,privateData,scope,nonce).catch(reason=>reason);expect(result).toBeInstanceOf(WorkspaceMemberOriginChangedError);expect(calls()).toHaveLength(1);expect(pairs('record.supplier.update').at(-1)?.errorCode).toBe('CONFLICT');
 });
 it('keeps acknowledged document writes separate from read failures, without replaying the write',async()=>{
  mode='read-failure';const result=await desktopApi.saveDocument('invoices',{notes:privateText},[line],undefined,scope,nonce).catch(reason=>reason);expect(result).toBeInstanceOf(WorkspaceRefreshAfterMutationError);expect(result.refreshCause).toBe(failure);expect(calls().map(([command])=>command)).toEqual(['save_document_with_items','get_app_state']);expect(resolveErrorIncident(result).code).toBe('ZT-'+pairs('get_app_state').find(event=>event.phase==='failure')!.id);
 });
});
describe('trusted identity metadata only, never payload inference',()=>{
 it('tags and copies exact frozen objects without adding any serialization properties',async()=>{
  const body=Object.freeze({entity:'suppliers',data:Object.freeze({name:privateText})});expect(withEntityDiagnosticIntent(body,'create_record','clients')).toBe(body);const target={...body};expect(copyDiagnosticIntent(body,target,'create_record')).toBe(target);
  native.invoke.mockResolvedValueOnce(body);expect(await diagnosticInvoke('create_record',target)).toBe(body);expect(native.invoke.mock.calls.at(-1)?.[1]).toBe(target);expect(Object.keys(body)).toEqual(['entity','data']);expect(pairs('record.client.create')).toHaveLength(2);
 });
 it('preserves metadata through the real origin argument copy without inspecting nested hostile data',async()=>{
  const read=vi.fn(()=>{throw Error('hostile data read');}),data=new Proxy({},{get:read,ownKeys:read,getOwnPropertyDescriptor:read,getPrototypeOf:read});const args=withEntityDiagnosticIntent(Object.freeze({entity:'employees',data}),'create_record','employees');native.invoke.mockResolvedValueOnce(true);
  await expect(invokeInMemberOrigin(diagnosticInvoke,'create_record',args,{workspaceScope:scope,memberContextNonce:nonce})).resolves.toBe(true);const passed=native.invoke.mock.calls.at(-1)![1];expect(passed.data).toBe(data);expect(passed).toMatchObject({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonce});expect(read).not.toHaveBeenCalled();expect(pairs('record.employee.create')).toHaveLength(2);
 });
 it('does not inspect argument getters or a revoked proxy when resolving a trusted intent',async()=>{
  const read=vi.fn(()=>{throw Error('logger getter read');}),args=Object.defineProperties({},{data:{get:read},entity:{get:read},id:{get:read}});withEntityDiagnosticIntent(args,'delete_record','projects');native.invoke.mockResolvedValue(true);await diagnosticInvoke('delete_record',args);
  const proxy=Proxy.revocable({},{});withEntityDiagnosticIntent(proxy.proxy,'create_record','clients');proxy.revoke();await diagnosticInvoke('create_record',proxy.proxy);expect(read).not.toHaveBeenCalled();expect(pairs('record.project.delete')).toHaveLength(2);expect(pairs('record.client.create')).toHaveLength(2);
 });
 it.each(['unknown','__proto__','constructor','toString',new String('clients'),null])('refuses invalid entity annotation %s without reading or logging data',async(entity)=>{
  const args={entity:'clients',data:{name:privateText}};withEntityDiagnosticIntent(args,'create_record',entity);expect(diagnosticIntentOperation('create_record',args)).toBeUndefined();native.invoke.mockResolvedValue(true);await diagnosticInvoke('create_record',args);expect(pairs('create_record')).toHaveLength(2);
 });
 it('refuses hostile command/action annotations and removes any stale trusted metadata',async()=>{
  const read=vi.fn(()=>{throw Error('intent coercion');}),hostile=new Proxy({},{get:read,getPrototypeOf:read,ownKeys:read,getOwnPropertyDescriptor:read}),args={data:{entity:'clients',name:privateText}};
  withEntityDiagnosticIntent(args,'create_record','clients');withEntityDiagnosticIntent(args,'create_record',hostile);expect(diagnosticIntentOperation('create_record',args)).toBeUndefined();withDiagnosticIntent(args,hostile as DiagnosticIntentCommand,'clients' as DiagnosticIntentAction);expect(read).not.toHaveBeenCalled();native.invoke.mockResolvedValue(true);await diagnosticInvoke('create_record',args);expect(pairs('create_record')).toHaveLength(2);
 });
 it('refuses an entity intent copied to a different command and arbitrary payload spoofing',async()=>{
  const args=withEntityDiagnosticIntent({data:{entity:'clients',operation:'record.client.create'}},'create_record','clients'),copy={data:args.data};copyDiagnosticIntent(args,copy,'update_record');expect(diagnosticIntentOperation('update_record',copy)).toBeUndefined();native.invoke.mockResolvedValue(true);await diagnosticInvoke('update_record',copy);expect(pairs('update_record')).toHaveLength(2);
 });
 it('rejects a non-document entity for the document command without inventing a document action',async()=>{
  const args=withEntityDiagnosticIntent({input:{entity:'quotes',data:{notes:privateText}}},'save_document_with_items','employees');expect(diagnosticIntentOperation('save_document_with_items',args)).toBeUndefined();native.invoke.mockResolvedValue(true);await diagnosticInvoke('save_document_with_items',args);expect(pairs('save_document_with_items')).toHaveLength(2);
 });
 it.each(['automation_request','supplier_inbox_request','appointment_inbox_request','unknown','__proto__',new String('create_record')])('refuses a wrong entity-helper command %s even when its action belongs to another intent family',async(command)=>{
  const args=withEntityDiagnosticIntent({},'create_record','clients');withEntityDiagnosticIntent(args,command as Parameters<typeof withEntityDiagnosticIntent>[1],'state');expect(diagnosticIntentOperation('create_record',args)).toBeUndefined();expect(diagnosticIntentOperation('automation_request',args)).toBeUndefined();native.invoke.mockResolvedValue(true);await diagnosticInvoke('create_record',args);expect(pairs('create_record')).toHaveLength(2);
 });
 it('does not lose existing automation/supplier intents when the bridge preserves generic origin metadata',async()=>{
  const tagged=withDiagnosticIntent({data:{action:'workflow_save',text:privateText}},'automation_request','workflow_save');const copy=copyDiagnosticIntent(tagged,{...tagged},'automation_request');native.invoke.mockResolvedValue(true);await diagnosticInvoke('automation_request',copy);expect(pairs('automation.workflow_save')).toHaveLength(2);
 });
 it('keeps archive planner values identical and adds no intent fields to serialization',()=>{
  const mutation=archiveEntityMutation('suppliers',id,'2026-10-03T00:00:00Z');expect(mutation).toEqual({command:'update_record',args:{entity:'suppliers',id,data:{archived_at:'2026-10-03T00:00:00Z'}}});expect(JSON.stringify(mutation)).not.toContain('record.supplier.update');
 });
});

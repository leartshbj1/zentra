import {afterEach,describe,expect,it,vi} from 'vitest';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:invokeMock}));
import {desktopApi} from './bridge';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';
import {recentDiagnosticEvents} from './diagnostics';

class Reader {
 static pending:Reader[]=[];
 static throwOnRead:Error|undefined;
 result='';onload:(()=>void)|null=null;onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;
 readAsDataURL(){if(Reader.throwOnRead)throw Reader.throwOnRead;Reader.pending.push(this);}
 abort(){this.onabort?.();}
 resolve(){this.result='data:application/pdf;base64,'+Buffer.from('%PDF-SYNTHETIC-PRIVATE-BYTES').toString('base64');this.onload?.();}
}
const sourceScope='SYNTHETIC_PRIVATE_SCOPE_A',otherScope='SYNTHETIC_PRIVATE_SCOPE_C',entityId='SYNTHETIC_PRIVATE_ENTITY';
const receipt=()=>new File(['%PDF-SYNTHETIC-PRIVATE-BYTES'],'SYNTHETIC_PRIVATE_FILE.pdf',{type:'application/pdf'});
const operations=[
 ['customer','add_customer_credit_settlement_attachment','settlementId',desktopApi.addCustomerCreditSettlementAttachment],
 ['expense','add_expense_refund_attachment','refundId',desktopApi.addExpenseRefundAttachment],
 ['supplier','add_supplier_credit_refund_attachment','refundId',desktopApi.addSupplierCreditRefundAttachment],
] as const;
function fixture(scope=sourceScope){Reader.pending=[];Reader.throwOnRead=undefined;vi.stubGlobal('FileReader',Reader);invokeMock.mockImplementation(async(command:string)=>command==='get_app_state'?{onboarding_completed:true,activity_profile_required:false,data_dir:''}:command==='get_workspace'?{work_notes_scope:scope,settings:{company_name:'Synthetic company',noga_section:'F',noga_division:'43',activity_description:'Synthetic activity'}}:{});}
async function resolveReader(){for(let i=0;i<5&&!Reader.pending.length;i++)await Promise.resolve();Reader.pending.at(-1)?.resolve();}
afterEach(()=>{vi.unstubAllGlobals();invokeMock.mockReset();Reader.pending=[];Reader.throwOnRead=undefined;});
describe.each(operations)('attachment origin contract %s',(kind,command,idKey,add)=>{
 it('preserves the legacy omitted-scope payload and a single attachment creation',async()=>{
  fixture();const promise=add(entityId,receipt());await resolveReader();const workspace=await promise;
  expect(workspace.workNotesScope).toBe(sourceScope);const calls=invokeMock.mock.calls.filter(([name])=>name===command);
  expect(calls).toHaveLength(1);expect(calls[0][1]).toEqual({[idKey]:entityId,attachment:{original_name:'SYNTHETIC_PRIVATE_FILE.pdf',content_base64:Buffer.from('%PDF-SYNTHETIC-PRIVATE-BYTES').toString('base64')}});
 });
 it('uses the captured scope as top-level metadata without altering the attachment',async()=>{
  fixture();const promise=add(entityId,receipt(),sourceScope);await resolveReader();const workspace=await promise;
  expect(workspace.workNotesScope).toBe(sourceScope);const calls=invokeMock.mock.calls.filter(([name])=>name===command);
  expect(calls).toHaveLength(1);expect(calls[0][1]).toEqual({[idKey]:entityId,attachment:{original_name:'SYNTHETIC_PRIVATE_FILE.pdf',content_base64:Buffer.from('%PDF-SYNTHETIC-PRIVATE-BYTES').toString('base64')},expectedWorkspaceScope:sourceScope});
 });
 it('emits no IPC when cancelled before, during or immediately after the file read',async()=>{
  for(const when of ['before','during','after'] as const){fixture();const controller=new AbortController();if(when==='before')controller.abort();
   const promise=add(entityId,receipt(),sourceScope,controller.signal);const observed=promise.then(()=>({ok:true as const}),error=>({ok:false as const,error}));
   if(when==='during')controller.abort();if(when==='after'){Reader.pending.at(-1)?.resolve();controller.abort();}else await resolveReader();
   const result=await observed;expect(result.ok,when).toBe(false);if(!result.ok)expect(result.error).toMatchObject({name:'AbortError'});
   expect(invokeMock.mock.calls.filter(([name])=>name===command),when).toHaveLength(0);expect(invokeMock.mock.calls.filter(([name])=>name==='get_workspace'),when).toHaveLength(0);
   invokeMock.mockReset();
  }
 });
 it('preserves the original mutation rejection and never starts refresh or repeats it',async()=>{
  fixture();const rejection=Error('SYNTHETIC_PRIVATE_NATIVE_REJECTION');invokeMock.mockImplementation(async(name:string)=>{if(name===command)throw rejection;return{};});
  const promise=add(entityId,receipt(),sourceScope);const observed=promise.catch(error=>error);await resolveReader();expect(await observed).toBe(rejection);
  expect(invokeMock.mock.calls.filter(([name])=>name===command)).toHaveLength(1);expect(invokeMock.mock.calls.filter(([name])=>name==='get_workspace')).toHaveLength(0);
 });
 it('retains the accepted outcome on a foreign read and permits a read-only retry with one exact receipt',async()=>{
  fixture(otherScope);const promise=add(entityId,receipt(),sourceScope);const observed=promise.catch(error=>error);await resolveReader();const rejected=await observed;
  expect(rejected).toBeInstanceOf(WorkspaceRefreshAfterMutationError);expect(rejected.refreshCause.message).toContain('L’entreprise ouverte a changé');
  const accepted=invokeMock.mock.calls.filter(([name])=>name===command);expect(accepted).toHaveLength(1);
  fixture(sourceScope);const current=await desktopApi.loadWorkspace();expect(current.workNotesScope).toBe(sourceScope);
  expect(invokeMock.mock.calls.filter(([name])=>name===command)).toEqual(accepted);
 });
 it('preserves an original file-read error before any native mutation',async()=>{
  fixture();const original=Error('SYNTHETIC_PRIVATE_READ_ERROR');Reader.throwOnRead=original;
  await expect(add(entityId,receipt(),sourceScope)).rejects.toBe(original);expect(invokeMock.mock.calls.filter(([name])=>name===command)).toHaveLength(0);
 });
 it('keeps diagnostics free of file contents, filename, IDs, scope and raw rejection',async()=>{
  fixture();const offset=recentDiagnosticEvents().length;const rejection=Error('SYNTHETIC_PRIVATE_NATIVE_REJECTION');invokeMock.mockRejectedValue(rejection);
  const promise=add(entityId,receipt(),sourceScope);const observed=promise.catch(error=>error);await resolveReader();expect(await observed).toBe(rejection);
  const events=recentDiagnosticEvents().slice(offset);expect(events.some(e=>e.operation===command&&e.phase==='failure')).toBe(true);
  const text=JSON.stringify(events);for(const value of [entityId,sourceScope,'SYNTHETIC_PRIVATE_FILE.pdf','SYNTHETIC_PRIVATE_NATIVE_REJECTION',Buffer.from('%PDF-SYNTHETIC-PRIVATE-BYTES').toString('base64')])expect(text).not.toContain(value);
  expect(events.every(e=>Object.keys(e).every(key=>['id','sessionId','timestamp','area','operation','phase','durationMs','errorCode'].includes(key)))).toBe(true);
 });
});

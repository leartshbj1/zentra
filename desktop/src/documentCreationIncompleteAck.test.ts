import {beforeEach,describe,expect,it,vi} from 'vitest';
import {desktopApi,prepareDocumentSaveInput} from './bridge';
import {prepareDocumentCreationRequest,DocumentCreationUnconfirmedError,type DocumentCreationInput} from './documentCreationRequest';
import {WorkspaceOriginChangedError} from './workspaceOrigin';
import {WorkspaceMemberOriginChangedError} from './workspaceMemberOrigin';
import {diagnosticsApi,knownErrorIncident,recentDiagnosticEvents} from './diagnostics';
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const id='11111111-2222-4333-8444-555555555555',scope='company',nonce='a'.repeat(32);
const line={id:'line',catalogItemId:null,description:'Private line',quantity:2,unit:'h',unitPriceCents:3000,discountBp:200,vatRateBp:810};
function request(){return prepareDocumentCreationRequest(id,prepareDocumentSaveInput('invoices',{title:'Private title',status:'draft',notes:'Private notes',depositBasisLines:[line]},[line]) as DocumentCreationInput,scope,'member');}
function missing(req=request()){return {receiptVersion:1,creationRequestId:id,entity:req.input.entity,status:'missing',documentId:id,originalResponse:null,currentDocument:null,currentItems:[],originalMatchesCurrent:null};}
beforeEach(async()=>{transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string)=>{if(command==='clear_diagnostics')return;throw Error('Unexpected native command '+command);});await diagnosticsApi.clear();transport.invoke.mockClear();});
describe('actual bridge rejects incomplete or wrong document creation acknowledgements',()=>{
 it.each(['id-only','wrong-request'] as const)('%s ACK after pure missing preflight remains ordinary unconfirmed with zero reads/replay',async(kind)=>{
  const req=request();transport.invoke.mockImplementation(async(command:string)=>{if(command==='get_document_creation_receipt')return missing(req);if(command==='save_document_with_items')return kind==='id-only'?{document:{id}}:{creationRequestId:'22222222-2222-4222-8222-222222222222',document:{id},items:[{id:'line'}]};throw Error('No workspace read should happen for unverified ACK');});
  const reason=await desktopApi.saveDocumentCreation(req,scope,nonce).catch(error=>error);expect(reason).toBeInstanceOf(DocumentCreationUnconfirmedError);expect(reason).not.toHaveProperty('recordId');expect(transport.invoke.mock.calls.map(call=>call[0])).toEqual(['get_document_creation_receipt','save_document_with_items']);expect(transport.invoke.mock.calls[1][1]).toEqual({input:req.input,creationRequestId:id,expectedWorkspaceScope:scope,expectedMemberContextNonce:nonce});
 });
});

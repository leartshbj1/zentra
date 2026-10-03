import {describe,expect,it} from 'vitest';
import {freezeDocumentCreationRequest,prepareDocumentCreationRequest,readDocumentCreationReceipt,validDocumentCreationRequest,validDocumentCreationId,type DocumentCreationInput} from './documentCreationRequest';
const id='11111111-2222-4333-8444-555555555555';
const input=():DocumentCreationInput=>({entity:'quotes',id:null,data:{title:'Synthetic document',total_cents:10810,deposit_basis_json:null},items:[{id:null,catalog_item_id:null,description:'Synthetic line',quantity:1,unit:'h',unit_price_cents:10000,discount_bp:0,vat_bp:810}]});
const request=()=>prepareDocumentCreationRequest(id,input(),'company','member');
const receipt=(status='confirmed')=>({receiptVersion:1,creationRequestId:id,documentId:id,entity:'quotes',status,originalResponse:status==='missing'?null:{creationRequestId:id,document:{id,title:'Original'},items:[{id:'line',position:0,quote_id:id}]},currentDocument:status==='confirmed'?{id,title:'Later'}:null,currentItems:status==='confirmed'?[{id:'line',position:0,quote_id:id}]:[],originalMatchesCurrent:status==='confirmed'?false:null});
describe('exact durable document creation contract',()=>{
 it('deep-freezes the exact ordered backend payload without defaults, updates or nonce',()=>{const source=input(),result=prepareDocumentCreationRequest(id,source,'company','member');expect(result.input).toEqual(source);expect(Object.keys(result.input)).toEqual(Object.keys(source));expect(Object.isFrozen(result.input.items[0])).toBe(true);expect(Object.keys(result)).toEqual(['requestVersion','creationRequestId','companyId','memberId','input']);source.items[0].description='changed';expect(result.input.items[0].description).toBe('Synthetic line');});
 it.each(['','ABCDEFAB-2222-4333-8444-555555555555',id+' ',id.replace('-',''),null])('rejects noncanonical UUID %s',value=>expect(validDocumentCreationId(value)).toBe(false));
 it('legacy payload without UUID never becomes a request silently',()=>{expect(validDocumentCreationRequest({input:input()})).toBe(false);expect(()=>freezeDocumentCreationRequest({input:input()})).toThrow();});
 it('rejects an update ID in a creation request',()=>{expect(()=>prepareDocumentCreationRequest(id,{...input(),id:'existing'} as never,'company','member')).toThrow();});
 it.each(['memberContextNonce','expectedMemberContextNonce','nonce'])('rejects persisted connection field %s',field=>expect(validDocumentCreationRequest({...request(),[field]:'a'.repeat(32)})).toBe(false));
 it('reads no object getter or toJSON while validating/freezing untrusted local data',()=>{let reads=0;const hostile=Object.defineProperty(input().data,'private',{enumerable:true,get(){reads++;throw Error('hostile');}});expect(()=>prepareDocumentCreationRequest(id,{...input(),data:hostile},'company','member')).toThrow();expect(reads).toBe(0);});
 it('reads no array getter while freezing local lines',()=>{let reads=0;const rows=input().items;Object.defineProperty(rows,'0',{enumerable:true,get(){reads++;throw Error('hostile');}});expect(()=>prepareDocumentCreationRequest(id,{...input(),items:rows},'company','member')).toThrow();expect(reads).toBe(0);});
 it.each(['missing','confirmed','deleted'])('validates exact %s receipt without inventing evidence',status=>{const result=readDocumentCreationReceipt(receipt(status),request());expect(result.status).toBe(status);expect(result.documentId).toBe(id);});
 it('keeps original and current data separate when later edits exist',()=>{const result=readDocumentCreationReceipt(receipt(),request());expect(result.originalResponse?.document.title).toBe('Original');expect(result.currentDocument?.title).toBe('Later');expect(result.originalMatchesCurrent).toBe(false);});
 it.each(['creationRequestId','documentId','entity','receiptVersion'])('rejects incompatible receipt %s',field=>expect(()=>readDocumentCreationReceipt({...receipt(),[field]:'other'},request())).toThrow());
 it('missing cannot carry a target row or confirmation',()=>expect(()=>readDocumentCreationReceipt({...receipt('missing'),currentDocument:{id}},request())).toThrow());
 it('deleted cannot appear as current or matched',()=>expect(()=>readDocumentCreationReceipt({...receipt('deleted'),originalMatchesCurrent:true},request())).toThrow());
});

import {DocumentCreationUnconfirmedError,isDocumentCreationUnconfirmedError} from './documentCreationRequest';
describe('explicit document confirmation provenance', () => {
 it('brands only actual construction and retains identity after a prototype change',()=>{
   const error=new DocumentCreationUnconfirmedError(new Error('lost'));
   expect(isDocumentCreationUnconfirmedError(error)).toBe(true);
   Object.setPrototypeOf(error,null);
   expect(isDocumentCreationUnconfirmedError(error)).toBe(true);
 });
 it.each([
  ['message string',()=>new DocumentCreationUnconfirmedError(null).message],
  ['ordinary error',()=>Object.assign(new Error(new DocumentCreationUnconfirmedError(null).message),{name:'DocumentCreationUnconfirmedError'})],
  ['borrowed prototype',()=>Object.assign(Object.create(DocumentCreationUnconfirmedError.prototype),{message:'La création du document doit être vérifiée avant tout nouvel envoi.'})],
  ['lookalike',()=>({name:'DocumentCreationUnconfirmedError',message:'La création du document doit être vérifiée avant tout nouvel envoi.'})],
  ['wrapped cause',()=>new Error('wrapper',{cause:new DocumentCreationUnconfirmedError(null)})],
  ['structured clone',()=>structuredClone(new DocumentCreationUnconfirmedError(null))],
  ['serialized object',()=>JSON.parse(JSON.stringify(new DocumentCreationUnconfirmedError(null)))],
 ] as const)('does not admit a %s',(_name,make)=>expect(isDocumentCreationUnconfirmedError(make())).toBe(false));
 it('does not inspect untrusted getters, prototypes, proxy traps or causes',()=>{
   let accesses=0;const hostile=new Proxy({},{get(){accesses++;throw Error('no getter');},getPrototypeOf(){accesses++;throw Error('no prototype');},has(){accesses++;throw Error('no property');}});
   expect(isDocumentCreationUnconfirmedError(hostile)).toBe(false);
   expect(isDocumentCreationUnconfirmedError(Object.defineProperty({},'cause',{get(){accesses++;throw Error('no cause');}}))).toBe(false);
   expect(isDocumentCreationUnconfirmedError(null)).toBe(false);expect(isDocumentCreationUnconfirmedError(undefined)).toBe(false);expect(isDocumentCreationUnconfirmedError(()=>undefined)).toBe(false);expect(accesses).toBe(0);
 });
});

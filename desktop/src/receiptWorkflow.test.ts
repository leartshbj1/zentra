import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke}));
import {desktopApi} from './bridge';
import {receiptDraft,receiptFormIssue,receiptDraftLines,receiptWasRecorded,receiptQuantityInput,receiptIssueProblems,receiptReverseProblems,receiptStockEffects,ReceiptOutcomeUnknownError,ReceiptRefreshError,runReceiptMutation,receiptNativeIssue,requireReceiptWorkspace} from './receiptWorkflow';
import {initialOnboardingSettings} from './onboardingDraft';
import type {SupplierOrder,SupplierReceipt,Workspace,CatalogItem} from './types';
import {todayIso} from './utils';
const order={id:'order',supplierId:'supplier',status:'confirmed',orderDate:'2026-01-01',lines:[{id:'line',catalogItemId:'item',description:'Peinture',unit:'litre',quantityMilli:10000,cancelledQuantityMilli:0,fulfillmentMode:'stocked_receipt'},{id:'untracked',description:'Échantillon',unit:'pièce',quantityMilli:2000,cancelledQuantityMilli:0,fulfillmentMode:'untracked_receipt'}]} as unknown as SupplierOrder;
const receipt={id:'receipt',supplierOrderId:'order',status:'draft',receiptDate:'2026-09-02',reference:'BL 1',notes:'Livraison',updatedAt:'v1',lines:[{id:'received',supplierOrderLineId:'line',quantityMilli:2125,description:'Peinture',unit:'litre'}]} as SupplierReceipt;
const item={id:'item',name:'Peinture',trackStock:true,kind:'product',stockQuantityMilli:5000} as CatalogItem;
const workspace=(receipts:SupplierReceipt[]=[receipt])=>({onboardingCompleted:true,settings:initialOnboardingSettings,supplierOrders:[order],supplierReceipts:receipts,supplierInvoiceMatches:[],catalogItems:[item],stockMovements:[]}) as unknown as Workspace;
afterEach(()=>invoke.mockReset());
describe('réception guidée',()=>{
  it('starts with zero quantities and preserves exact quantities and missing historical lines',()=>{
    expect(receiptDraft(order).quantities.line).toBe('0');
    expect(receiptQuantityInput(9000000000000000)).toBe('9000000000000.000');
    expect(receiptQuantityInput(2125)).toBe('2.125');
    const draft=receiptDraft(order,receipt);
    expect(receiptFormIssue(draft,order,workspace())).toBeNull();
    expect(receiptDraftLines(draft,order)).toEqual([{supplierOrderLineId:'line',quantityMilli:2125}]);
    const orphan={...receipt,lines:[{...receipt.lines[0],supplierOrderLineId:'gone'}]};
    expect(receiptFormIssue(receiptDraft(order,orphan),order,workspace([orphan]))?.field).toBe('record');
  });
  it.each(['','-1','2.1256','abc','9000000000001'])('points to an invalid quantity without coercing it: %s',value=>{
    const draft=receiptDraft(order,receipt);draft.quantities.line=value;
    expect(receiptFormIssue(draft,order,workspace())).toMatchObject({field:'quantity',lineId:'line'});
    expect(draft.quantities.line).toBe(value);
  });
  it('accepts commas, real partial deliveries, and refuses quantities already received',()=>{
    const draft=receiptDraft(order);draft.quantities.line='2,125';
    expect(receiptFormIssue(draft,order,workspace([]))).toBeNull();
    const existing={...receipt,status:'issued',lines:[{...receipt.lines[0],quantityMilli:9000}]} as SupplierReceipt;
    expect(receiptFormIssue(draft,order,workspace([existing]))).toMatchObject({field:'quantity',lineId:'line'});
  });
  it.each(['2026-02-30','2025-12-31','2999-01-01',''])('explains a date correction: %s',date=>{
    expect(receiptFormIssue({...receiptDraft(order,receipt),date},order,workspace())?.field).toBe('date');
  });
  it('accepts today and rejects long text without dropping it',()=>{
    expect(receiptFormIssue({...receiptDraft(order,receipt),date:todayIso()},order,workspace())).toBeNull();
    expect(receiptFormIssue({...receiptDraft(order,receipt),reference:'x'.repeat(201)},order,workspace())?.field).toBe('reference');
    expect(receiptFormIssue({...receiptDraft(order,receipt),notes:'x'.repeat(20001)},order,workspace())?.field).toBe('notes');
  });
  it('refuses an unreadable remaining quantity before preparing stock',()=>{
    const incomplete={...order,lines:order.lines.map(line=>({...line,cancelledQuantityMilli:Number.NaN}))};
    expect(receiptFormIssue(receiptDraft(incomplete,receipt),incomplete,workspace())?.field).toBe('record');
  });
  it('makes current status, missing stock and line errors reviewable',()=>{
    expect(receiptIssueProblems({...receipt,status:'issued'},workspace())[0]).toMatch(/déjà/);
    expect(receiptIssueProblems(receipt,{...workspace(),catalogItems:[]})).toEqual([expect.stringMatching(/suivi de stock/)]);
    expect(receiptNativeIssue('La quantité réceptionnable restante de la ligne line est 1000.',order)).toMatchObject({field:'quantity',lineId:'line'});
  });
  it('aggregates stock impact and prevents reversal with missing stock or invoice links',()=>{
    const source={...receipt,status:'issued',lines:[...receipt.lines,{...receipt.lines[0],id:'second',supplierOrderLineId:'other'}]} as SupplierReceipt;
    const data={...workspace([source]),supplierOrders:[{...order,lines:[...order.lines,{...order.lines[0],id:'other'}]}]};
    expect(receiptStockEffects(source,data)[0].quantity).toBe(4250n);
    expect(receiptReverseProblems(source,data)).toEqual([]);
    expect(receiptReverseProblems(source,{...data,catalogItems:[{...item,stockQuantityMilli:4000}]})).toEqual([expect.stringMatching(/pas assez/)]);
    expect(receiptReverseProblems(source,{...data,supplierInvoiceMatches:[{supplierReceiptLineId:'received'} as never]})).toEqual([expect.stringMatching(/facture fournisseur/)]);
  });
  it('verifies exact draft contents, issued state and reversal reason after a lost response',()=>{
    const intent={kind:'draft' as const,id:receipt.id,snapshot:{...receipt,reference:' BL 1 ',notes:' Livraison '}};
    expect(receiptWasRecorded(workspace(),intent)).toBe(true);
    expect(receiptWasRecorded(workspace(),{...intent,snapshot:{...receipt,notes:'Different'}})).toBe(false);
    expect(receiptWasRecorded(workspace(),{kind:'issue',id:receipt.id,snapshot:receipt})).toBe(false);
    const done={...receipt,status:'reversed',reversalReason:'Retour'} as SupplierReceipt;
    expect(receiptWasRecorded(workspace([done]),{kind:'issue',id:receipt.id,snapshot:receipt})).toBe(true);
    expect(receiptWasRecorded(workspace([done]),{kind:'reverse',id:receipt.id,reason:' Retour '})).toBe(true);
    expect(receiptWasRecorded(workspace([done]),{kind:'reverse',id:receipt.id,reason:'Erreur'})).toBe(false);
    expect(()=>requireReceiptWorkspace({...workspace(),onboardingCompleted:false})).toThrow();
  });
  it('keeps acknowledged but missing rows in recovery and accepts later draft edits',async()=>{
    const intent={kind:'draft' as const,id:receipt.id,snapshot:receipt};
    const failure=await runReceiptMutation(intent,async()=>({}),async()=>workspace([])).catch(e=>e);
    expect(failure).toBeInstanceOf(ReceiptRefreshError);
    expect(()=>failure.validateRead(workspace([{...receipt,notes:'Later edit'}]))).not.toThrow();
    const rejected=await runReceiptMutation(intent,async()=>{throw Error('Période fermée');},async()=>{throw Error('must not load');}).catch(e=>e);
    expect(rejected).toBeInstanceOf(ReceiptOutcomeUnknownError);
    expect(rejected.mutationCause.message).toBe('Période fermée');
  });
  it('sends expected versions separately without changing operation replay inputs',async()=>{
    invoke.mockImplementation(async (name:string)=>{if(name==='get_app_state')throw Error('Read interrupted');return {};});
    await desktopApi.saveSupplierReceiptDraft({id:receipt.id,expectedUpdatedAt:'v1',supplierOrderId:'order',receiptDate:receipt.receiptDate,reference:' BL 1 ',lines:[{supplierOrderLineId:'line',quantityMilli:2125}]}).catch(()=>{});
    expect(invoke.mock.calls[0]).toEqual(['save_supplier_receipt_draft',{expectedUpdatedAt:'v1',input:{receipt:{id:'receipt',supplier_order_id:'order',receipt_date:'2026-09-02',reference:'BL 1',notes:null},lines:[{supplier_order_line_id:'line',quantity_milli:2125}]}}]);
    invoke.mockClear();await desktopApi.issueSupplierReceipt('request','receipt',receipt).catch(()=>{});
    expect(invoke.mock.calls[0]).toEqual(['issue_supplier_receipt',{expectedUpdatedAt:'v1',input:{request_id:'request',supplier_receipt_id:'receipt'}}]);
  });
  it('keeps native supplier receipt identities and reversal labels in stock history',async()=>{
    invoke.mockImplementation(async(name:string)=>{
      if(name==='get_app_state')return {onboarding_completed:1};
      if(name==='get_workspace')return {settings:{company_name:'Recette',extra_settings_json:JSON.stringify(initialOnboardingSettings)},stock_movements:[{id:'entry',source_type:'supplier_receipt',movement_type:'entry',supplier_receipt_id:'receipt',supplier_receipt_line_id:'line',quantity_delta_milli:2125},{id:'reverse',source_type:'supplier_receipt',movement_type:'exit',supplier_receipt_id:'receipt',supplier_receipt_line_id:'line',reverses_stock_movement_id:'entry',quantity_delta_milli:-2125}]};
      throw Error(`unexpected ${name}`);
    });
    const data=await desktopApi.loadWorkspace();
    expect(data.stockMovements).toMatchObject([{sourceType:'receipt',stockReceiptId:'receipt',stockReceiptLineId:'line',quantityDeltaMilli:2125},{sourceType:'receipt_reversal',stockReceiptId:'receipt',stockReceiptLineId:'line',quantityDeltaMilli:-2125}]);
  });
});

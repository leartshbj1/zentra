import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class {},invoke}));
import { desktopApi } from './bridge';
import { stockFormIssue, stockNativeIssue, stockWasRecorded, WorkspaceStockOutcomeUnknownError, WorkspaceStockRefreshError, type StockIntent } from './stockWorkflow';
import { stockQuantityFromInput,formatCatalogQuantity } from './catalog';
import { initialOnboardingSettings } from './onboardingDraft';
import type { CatalogItem,StockMovement,Workspace } from './types';
const item={id:'item',kind:'product',name:'Peinture',unit:'litre',trackStock:true,stockQuantityMilli:10_000,archivedAt:null} as CatalogItem;
const intent:StockIntent={requestId:'request',catalogItemId:'item',movementType:'correction',quantityDeltaMilli:-2000,countedQuantityMilli:8000,reason:' Inventaire ',date:'2026-09-13',reference:' INV-1 '};
const receipt={requestId:'request',catalogItemId:'item',sourceType:'manual',movementType:'correction',quantityDeltaMilli:-2000,balanceAfterMilli:8000,reason:'Inventaire',movementDate:'2026-09-13',reference:'INV-1'} as StockMovement;
const workspace=(rows:StockMovement[]=[receipt])=>({onboardingCompleted:true,settings:initialOnboardingSettings,catalogItems:[item],stockMovements:rows,stockAvailability:[],stockReservationEvents:[]}) as unknown as Workspace;
afterEach(()=>invoke.mockReset());
describe('saisie et lecture du stock',()=>{
  it('preserves every supported milli-unit while reading and displaying large quantities',()=>{
    expect(stockQuantityFromInput('8999999999999.999')).toBe(8_999_999_999_999_999);
    expect(formatCatalogQuantity(8_999_999_999_999_999).replace(/[\s’']/g,'')).toBe('8999999999999,999');
    expect(formatCatalogQuantity(-1)).toBe('-0,001');
    expect(stockQuantityFromInput('+0,125')).toBe(125);
    for(const text of ['','  ','1.1234','1e3','NaN','9007199254741.992']) expect(stockQuantityFromInput(text)).toBeNull();
  });
  it('guides invalid quantities, reservations, dates and reasons before submitting',()=>{
    const draft={quantity:'8',date:'2026-09-13',reason:'Inventaire',reference:''};
    expect(stockFormIssue(item,'correction',true,10_000,2000,draft)).toBeNull();
    for(const quantity of ['-1','10','1','bad']) expect(stockFormIssue(item,'correction',true,10000,2000,{...draft,quantity})?.field).toBe('quantity');
    expect(stockFormIssue(item,'correction',true,10000,0,{...draft,quantity:'0'})).toBeNull();
    expect(stockFormIssue(item,'entry',false,10000,0,{...draft,date:'2026-02-30'})?.field).toBe('date');
    expect(stockFormIssue(item,'entry',false,10000,0,{...draft,reason:' '})?.field).toBe('reason');
    expect(stockFormIssue(item,'entry',false,10000,0,{...draft,reference:'a'.repeat(201)})?.field).toBe('reference');
    expect(stockFormIssue({...item,archivedAt:'date'},'entry',false,10000,0,draft)?.field).toBe('item');
    expect(stockNativeIssue(new Error('reason est obligatoire.'))?.field).toBe('reason');
  });
  it('requires the original request, product, date, type, amount and count receipt',()=>{
    expect(stockWasRecorded(workspace(),intent)).toBe(true);
    for(const patch of [{requestId:'other'},{catalogItemId:'other'},{sourceType:'invoice'},{movementType:'exit'},{quantityDeltaMilli:-1000},{balanceAfterMilli:7999},{reason:'other'},{reference:'other'},{movementDate:'2026-09-12'}]) {
      expect(stockWasRecorded(workspace([{...receipt,...patch} as StockMovement]),intent)).toBe(false);
    }
    expect(stockWasRecorded(workspace([]),intent)).toBe(false);
    expect(()=>stockWasRecorded({...workspace(),settings:null},intent)).toThrow('chargés');
  });
});
const cases=[
  ['record_stock_entry',()=>desktopApi.recordStockEntry({requestId:'request',catalogItemId:'item',quantityMilli:2000,reason:' Motif ',reference:' REF ',date:'2026-09-13'}),'entry',2000,12000],
  ['record_stock_exit',()=>desktopApi.recordStockExit({requestId:'request',catalogItemId:'item',quantityMilli:2000,reason:' Motif ',reference:' REF ',date:'2026-09-13'}),'exit',-2000,8000],
  ['record_stock_correction',()=>desktopApi.recordStockCorrection({requestId:'request',catalogItemId:'item',deltaQuantityMilli:-2000,reason:' Motif ',reference:' REF ',date:'2026-09-13'}),'correction',-2000,8000],
  ['record_stock_count',()=>desktopApi.recordStockCount({requestId:'request',catalogItemId:'item',expectedQuantityMilli:10000,countedQuantityMilli:8000,reason:' Motif ',reference:' REF ',date:'2026-09-13'}),'correction',-2000,8000],
] as const;
describe.each(cases)('%s', (command,run,type,delta,balance)=>{
  const raw=()=>({settings:{company_name:'Entreprise',extra_settings_json:'{}'},catalog_items:[{id:'item',kind:'product',name:'Produit',track_stock:1,stock_quantity_milli:balance}],stock_movements:[{id:'movement',request_id:'request',catalog_item_id:'item',source_type:'manual',movement_type:type,quantity_delta_milli:delta,balance_after_milli:balance,reason:'Motif',reference:'REF',movement_date:'2026-09-13'}]});
  it('checks the receipt after one write and sends normalized input',async()=>{
    invoke.mockImplementation(async name=>name===command?{}:name==='get_app_state'?{onboarding_completed:true}:raw());
    const value=await run();expect(value.stockMovements).toHaveLength(1);
    const input=invoke.mock.calls[0][1].input;
    expect(input).toMatchObject({request_id:'request',catalog_item_id:'item',reason:'Motif',reference:'REF',date:'2026-09-13'});
    if(command==='record_stock_count') expect(input).toMatchObject({expected_quantity_milli:10000,counted_quantity_milli:8000});
    expect(invoke.mock.calls.map(c=>c[0])).toEqual([command,'get_app_state','get_workspace']);
  });
  it('holds an acknowledged write until its actual receipt is readable',async()=>{
    invoke.mockImplementation(async name=>name===command?{}:name==='get_app_state'?{onboarding_completed:true}:{...raw(),stock_movements:[]});
    const error=await run().catch(error=>error);
    expect(error).toBeInstanceOf(WorkspaceStockRefreshError);
    expect(()=>error.validateRead(workspace([]))).toThrow('historique');
    expect(invoke.mock.calls.filter(c=>c[0]===command)).toHaveLength(1);
  });
  it('can identify a committed movement after its reply is lost, without resending',async()=>{
    const cause=new Error('Réponse perdue');invoke.mockImplementation(async name=>{if(name===command)throw cause;return name==='get_app_state'?{onboarding_completed:true}:raw();});
    const error=await run().catch(error=>error);expect(error).toBeInstanceOf(WorkspaceStockOutcomeUnknownError);expect(error.mutationCause).toBe(cause);
    expect(error.wasRecorded(await desktopApi.loadWorkspace())).toBe(true);
    expect(invoke.mock.calls.filter(c=>c[0]===command)).toHaveLength(1);
  });
});

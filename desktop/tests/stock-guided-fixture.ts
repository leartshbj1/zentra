import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
// Exercise the production invoke/normalization/recovery path; only SQLite I/O is simulated.
const native={load:desktopApi.loadWorkspace,entry:desktopApi.recordStockEntry,exit:desktopApi.recordStockExit,correction:desktopApi.recordStockCorrection,count:desktopApi.recordStockCount};
export function installStockGuidedFixture(data:Workspace) {
  const stored=JSON.parse(sessionStorage.getItem('stock-guided-store')||'null')||{catalog_items:[{id:'stock-product',kind:'product',name:'Peinture de recette',sku:'PEINT-1',unit:'litre',description:'Peinture pour les projets',sales_price_cents:1500,purchase_cost_cents:800,vat_bp:0,track_stock:1,stock_quantity_milli:10000,reorder_level_milli:2000}],stock_movements:[],stock_reservation_events:[]};
  stored.settings={company_name:'Atelier de recette',extra_settings_json:JSON.stringify(data.settings)};
  const item=stored.catalog_items[0];
  data.catalogItems=[{id:item.id,kind:'product',name:item.name,sku:item.sku,unit:item.unit,description:item.description,salesPriceCents:1500,purchaseCostCents:800,vatBp:0,trackStock:true,stockQuantityMilli:item.stock_quantity_milli,reorderLevelMilli:2000,archivedAt:item.archived_at||null}];
  data.stockMovements=stored.stock_movements.map((r:any)=>({id:r.id,sequence:r.sequence,requestId:r.request_id,sourceKey:r.source_key,catalogItemId:r.catalog_item_id,movementType:r.movement_type,quantityDeltaMilli:r.quantity_delta_milli,balanceAfterMilli:r.balance_after_milli,reason:r.reason,reference:r.reference,movementDate:r.movement_date,sourceType:r.source_type,createdAt:r.created_at}));data.stockReservationEvents=[];data.stockAvailability=[{catalogItemId:item.id,onHandMilli:item.stock_quantity_milli,reservedMilli:2000,availableMilli:item.stock_quantity_milli-2000}];
  const state={stored,attempts:0,writes:0,mode:'',hold:false,release:()=>{},blockRead:false,empty:false,omitReceipt:false,reserved:2000};
  const persist=()=>sessionStorage.setItem('stock-guided-store',JSON.stringify(stored));
  const move=(delta:number,input:Record<string,any>)=>{
    item.stock_quantity_milli+=delta;
    const row={id:crypto.randomUUID(),sequence:stored.stock_movements.length+1,source_key:`manual:${input.request_id}`,request_id:input.request_id,catalog_item_id:item.id,movement_type:input.type,quantity_delta_milli:delta,balance_after_milli:item.stock_quantity_milli,reason:input.reason,reference:input.reference||null,movement_date:input.date,source_type:'manual',created_at:new Date().toISOString()};
    stored.stock_movements.push(row);persist();return row;
  };
  Object.assign(window,{stockFixture:{state,adjust:(delta:number)=>move(delta,{request_id:crypto.randomUUID(),type:'correction',reason:'Mouvement dans une autre fenêtre',date:'2026-09-13'}),persist}});
  Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:{input:Record<string,any>})=>{
    if(command==='get_app_state'||command==='get_workspace') {
      if(state.blockRead)throw new Error('Lecture du stock interrompue.');
      if(command==='get_app_state')return {onboarding_completed:!state.empty};
      return structuredClone({...stored,stock_movements:state.omitReceipt?[]:stored.stock_movements,stock_availability:[{catalog_item_id:item.id,on_hand_milli:item.stock_quantity_milli,reserved_milli:state.reserved,available_milli:item.stock_quantity_milli-state.reserved}]});
    }
    if(!['record_stock_entry','record_stock_exit','record_stock_correction','record_stock_count'].includes(command))throw new Error(`Commande hors recette stock : ${command}`);
    state.attempts++;if(state.hold)await new Promise<void>(resolve=>{state.release=resolve;});
    const mode=state.mode;state.mode='';
    if(mode==='refuse')throw new Error('reason est obligatoire.');
    const input=args.input;
    if(item.archived_at)throw new Error('Produit archivé');
    if(command==='record_stock_count'&&input.expected_quantity_milli!==item.stock_quantity_milli)throw new Error('Le stock a changé depuis votre vérification.');
    if(stored.stock_movements.some((row:{request_id:string})=>row.request_id===input.request_id))throw new Error('Requête déjà enregistrée dans la recette.');
    const delta=command==='record_stock_count'?input.counted_quantity_milli-input.expected_quantity_milli:command==='record_stock_correction'?input.delta_quantity_milli:command==='record_stock_exit'?-input.quantity_milli:input.quantity_milli;
    if(item.stock_quantity_milli+delta<state.reserved)throw new Error('Quantité réservée aux commandes clients.');
    const row=move(delta,{...input,type:command==='record_stock_entry'?'entry':command==='record_stock_exit'?'exit':'correction'});state.writes++;
    if(mode==='ack-unreadable'||mode==='lost-unreadable')state.blockRead=true;
    if(mode==='lost'||mode==='lost-unreadable')throw new Error('Réponse du mouvement perdue.');
    return {movement:row,idempotent:false};
  }}});
  desktopApi.loadWorkspace=native.load;desktopApi.recordStockEntry=native.entry;desktopApi.recordStockExit=native.exit;desktopApi.recordStockCorrection=native.correction;desktopApi.recordStockCount=native.count;
}
declare global { interface Window {stockFixture:{state:any;adjust:(delta:number)=>void;persist:()=>void};__qaStockRefresh:()=>Promise<void>} }

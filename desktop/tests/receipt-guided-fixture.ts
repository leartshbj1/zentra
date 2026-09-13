import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
const native={load:desktopApi.loadWorkspace,save:desktopApi.saveSupplierReceiptDraft,issue:desktopApi.issueSupplierReceipt,reverse:desktopApi.reverseSupplierReceipt};
const camel=(value:Record<string,any>)=>Object.fromEntries(Object.entries(value).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));

export function installReceiptGuidedFixture(data:Workspace){
  const stored=JSON.parse(sessionStorage.getItem('receipt-guided-store')||'null')||{
    settings:{company_name:'Entreprise de recette',extra_settings_json:JSON.stringify(data.settings)},
    suppliers:[{id:'supplier',name:'Couleurs du Léman',email:'exemple@example.test',archived_at:null}],
    catalog_items:[{id:'paint',kind:'product',name:'Peinture blanche',unit:'litre',track_stock:1,stock_quantity_milli:5000,archived_at:null}],
    supplier_orders:[{id:'order',supplier_id:'supplier',number:'CF-2026-001',title:'Peinture du bureau',status:'confirmed',order_date:'2026-01-01',currency:'CHF',total_cents:100000,created_at:'2026-01-01T12:00:00Z',updated_at:'v1'}],
    supplier_order_lines:[{id:'paint-line',supplier_order_id:'order',catalog_item_id:'paint',description:'Peinture blanche',unit:'litre',quantity_milli:10000,cancelled_quantity_milli:0,position:0,fulfillment_mode:'stocked_receipt'},{id:'sample-line',supplier_order_id:'order',catalog_item_id:null,description:'Échantillons de couleurs',unit:'pièce',quantity_milli:2000,cancelled_quantity_milli:0,position:1,fulfillment_mode:'untracked_receipt'}],
    supplier_receipts:[],supplier_receipt_lines:[],supplier_invoices:[],supplier_invoice_matches:[],stock_movements:[{id:'opening',sequence:1,catalog_item_id:'paint',source_type:'opening',movement_type:'entry',quantity_delta_milli:5000,balance_after_milli:5000}],operations:{},version:100,
  };
  const state={stored,attempts:[] as any[],writes:0,mode:'',blockRead:false,empty:false,omitReceipt:false,hold:false,release:()=>{}};
  const persist=()=>sessionStorage.setItem('receipt-guided-store',JSON.stringify(stored));
  const version=()=>`2026-09-13T12:00:00.${++stored.version}Z`;
  const receiptLines=(id:string)=>stored.supplier_receipt_lines.filter((row:any)=>row.supplier_receipt_id===id);
  const remaining=(id:string)=>stored.supplier_order_lines.find((row:any)=>row.id===id).quantity_milli-stored.supplier_receipt_lines.filter((line:any)=>line.supplier_order_line_id===id&&stored.supplier_receipts.some((r:any)=>r.id===line.supplier_receipt_id&&r.status==='issued')).reduce((n:number,line:any)=>n+line.quantity_milli,0);
  const header=(id:string)=>stored.supplier_receipts.find((row:any)=>row.id===id);
  const change=(id:string,quantity:number)=>{const row=header(id);if(row.status!=='draft')throw Error('Only a draft may change');const line=receiptLines(id).find((row:any)=>row.supplier_order_line_id==='paint-line');line.quantity_milli=quantity;row.updated_at=version();persist();};
  data.suppliers=stored.suppliers.map(camel);data.catalogItems=stored.catalog_items.map((row:any)=>({...camel(row),trackStock:!!row.track_stock}));
  data.supplierOrders=stored.supplier_orders.map((row:any)=>({...camel(row),lines:stored.supplier_order_lines.filter((line:any)=>line.supplier_order_id===row.id).map(camel)}));
  data.supplierReceipts=stored.supplier_receipts.map((row:any)=>({...camel(row),lines:receiptLines(row.id).map(camel)}));
  data.supplierInvoices=[];data.supplierInvoiceMatches=[];
  data.stockMovements=stored.stock_movements.map(camel);data.stockAvailability=[];data.stockReservationEvents=[];
  Object.assign(window,{receiptFixture:{state,change,persist},__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
    if(command==='get_app_state'||command==='get_workspace'){
      if(state.blockRead)throw Error('Lecture des réceptions interrompue.');
      if(command==='get_app_state')return {onboarding_completed:!state.empty};
      return structuredClone({...stored,supplier_receipts:state.omitReceipt?[]:stored.supplier_receipts});
    }
    if(!['save_supplier_receipt_draft','issue_supplier_receipt','reverse_supplier_receipt'].includes(command))throw Error(`Commande hors recette réception : ${command}`);
    state.attempts.push({command,args:structuredClone(args)});
    const mode=state.mode;state.mode='';
    if(state.hold)await new Promise<void>(resolve=>{state.release=resolve;});
    if(mode==='refuse')throw Error('La période comptable est fermée.');
    const input=args.input,id=input.receipt?.id||input.supplier_receipt_id;
    let row=header(id);
    if(command!=='save_supplier_receipt_draft'&&stored.operations[input.request_id])return {idempotent:true};
    if(args.expectedUpdatedAt!==undefined&&(!row||row.updated_at!==args.expectedUpdatedAt))throw Error('Cette réception a changé depuis le contrôle. Relisez ses quantités avant de les valider.');
    if(command==='save_supplier_receipt_draft'){
      if(row&&row.status!=='draft')throw Error('Cette réception n’est plus modifiable.');
      if(!input.lines.length)throw Error('Une réception exige une ligne.');
      for(const line of input.lines)if(line.quantity_milli<=0||line.quantity_milli>remaining(line.supplier_order_line_id))throw Error(`La quantité réceptionnable restante de la ligne ${line.supplier_order_line_id} a changé.`);
      if(row)Object.assign(row,input.receipt,{reference:input.receipt.reference||'',notes:input.receipt.notes||'',updated_at:version()});
      else{row={...input.receipt,status:'draft',number:'',reference:input.receipt.reference||'',notes:input.receipt.notes||'',created_at:version(),updated_at:version()};stored.supplier_receipts.push(row);}
      stored.supplier_receipt_lines=stored.supplier_receipt_lines.filter((line:any)=>line.supplier_receipt_id!==id);
      stored.supplier_receipt_lines.push(...input.lines.map((line:any,position:number)=>{const original=stored.supplier_order_lines.find((row:any)=>row.id===line.supplier_order_line_id);return {...line,id:crypto.randomUUID(),supplier_receipt_id:id,position,description:original.description,unit:original.unit};}));
    }else{
      const reverse=command==='reverse_supplier_receipt';
      if(!row||row.status!==(reverse?'issued':'draft'))throw Error('État de réception incompatible.');
      const effects=receiptLines(id).filter((line:any)=>stored.supplier_order_lines.find((row:any)=>row.id===line.supplier_order_line_id)?.fulfillment_mode==='stocked_receipt');
      for(const line of receiptLines(id))if(!reverse&&line.quantity_milli>remaining(line.supplier_order_line_id))throw Error('La quantité disponible a changé.');
      for(const line of effects){const original=stored.supplier_order_lines.find((row:any)=>row.id===line.supplier_order_line_id),item=stored.catalog_items.find((row:any)=>row.id===original.catalog_item_id);if(reverse&&item.stock_quantity_milli<line.quantity_milli)throw Error('Stock insuffisant pour annuler.');}
      if(reverse&&stored.supplier_invoice_matches.some((match:any)=>receiptLines(id).some((line:any)=>line.id===match.supplier_receipt_line_id)))throw Error('Une facture est liée à la réception.');
      for(const line of effects){
        const original=stored.supplier_order_lines.find((row:any)=>row.id===line.supplier_order_line_id),item=stored.catalog_items.find((row:any)=>row.id===original.catalog_item_id),quantity=(reverse?-1:1)*line.quantity_milli;
        const reversed=reverse?stored.stock_movements.find((row:any)=>row.supplier_receipt_line_id===line.id&&row.movement_type==='entry')?.id:null;
        item.stock_quantity_milli+=quantity;
        stored.stock_movements.push({id:crypto.randomUUID(),sequence:stored.stock_movements.length+1,catalog_item_id:item.id,source_type:'supplier_receipt',supplier_receipt_id:id,supplier_receipt_line_id:line.id,reverses_stock_movement_id:reversed,movement_type:reverse?'exit':'entry',quantity_delta_milli:quantity,balance_after_milli:item.stock_quantity_milli,reason:reverse?input.reason:'Réception fournisseur',movement_date:row.receipt_date,created_at:version()});
      }
      Object.assign(row,{status:reverse?'reversed':'issued',number:'RF-2026-001',updated_at:version(),...(reverse?{reversal_reason:input.reason,reversed_at:version()}:{issued_at:version()})});stored.operations[input.request_id]={command};
    }
    state.writes++;persist();
    if(mode==='ack-unreadable'||mode==='lost-unreadable')state.blockRead=true;
    if(mode==='lost'||mode==='lost-unreadable')throw Error('Réponse de la réception perdue.');
    return {};
  }}});
  desktopApi.loadWorkspace=native.load;desktopApi.saveSupplierReceiptDraft=native.save;desktopApi.issueSupplierReceipt=native.issue;desktopApi.reverseSupplierReceipt=native.reverse;
}
declare global{interface Window{receiptFixture:{state:any;change:(id:string,quantity:number)=>void;persist:()=>void};__qaReceiptRefresh:()=>Promise<void>}}

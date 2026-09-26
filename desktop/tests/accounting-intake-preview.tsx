// Local synthetic company. No provider calls, journal writes or real documents.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FixedAssetsPanel } from '../src/FixedAssetsPanel';
import { InvoiceScanPanel } from '../src/InvoiceScanPanel';
import { AutomationCompanyProvider } from '../src/AutomationCompany';
import { fixedAssetsApi, type FixedAssetRow } from '../src/fixedAssets';
import { setAppearance } from '../src/appearance';
import type { Workspace } from '../src/types';
import '../src/styles.css';import '../src/workspace-design.css';import '../src/mobile.css';import '../src/experience.css';import '../src/dark.generated.css';import '../src/dark.css';import '../src/workspace-atelier.css';
const params=new URLSearchParams(location.search);setAppearance(params.get('theme')==='dark'?'dark':'light');
const rows:FixedAssetRow[]=[];
const qa={registered:0,depreciated:0,scanApplied:0,scans:0};Object.assign(window,{__accountingIntakeQa:qa});
fixedAssetsApi.list=async()=>({items:structuredClone(rows)});
fixedAssetsApi.register=async asset=>{qa.registered++;rows.push({asset,depreciatedCents:0,bookValueCents:asset.costCents,cancelled:false,nextYear:2026,nextAmountCents:asset.costCents/5,blocker:null,history:[]});return {items:structuredClone(rows)};};
fixedAssetsApi.depreciate=async row=>{qa.depreciated++;const stored=rows.find(r=>r.asset.id===row.asset.id)!;stored.depreciatedCents+=row.nextAmountCents;stored.bookValueCents-=row.nextAmountCents;stored.nextAmountCents=0;stored.history.push({id:'entry-qa',entry_date:'2026-12-31',amount_cents:row.nextAmountCents});return {items:structuredClone(rows)};};
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:{data?:{action?:string}})=>{
  if(command==='set_native_appearance')return;
  if(command==='automation_request'&&!args.data)return {organizationId:'fixture',active:true,canManage:true,available:['supplier_routing'],settings:{enabled:true,consent:true,mode:'suggest',flags:['supplier_routing'],thresholds:{medium:.65,high:.9}}};
  if(command==='automation_request'&&args.data?.action==='invoice_scan'){qa.scans++;return {status:'suggestion',requiresConfirmation:true,extraction:{kind:'supplier_invoice',supplierName:'Papeterie du Léman',reference:'TEST-2026-019',invoiceDate:'2026-09-26',dueDate:'2026-10-26',currency:'CHF',netCents:10000,vatCents:810,totalCents:10810,vatBp:810,issues:[],confidence:.99,evidence:{}}};}
  throw Error(`Unexpected fixture action: ${command}`);
}}});
const workspace={accounts:[{id:'asset',code:'1500',name:'Immobilisations corporelles',accountType:'asset',normalBalance:'debit',reportSection:'fixed_assets',active:true},{id:'depreciation',code:'6800',name:'Amortissements',accountType:'expense',normalBalance:'debit',reportSection:'depreciation',active:true},{id:'expense',code:'4000',name:'Achats de matériel',accountType:'expense',normalBalance:'debit',reportSection:'cost_of_goods',active:true}],accountingSettings:{enabled:true,expenseAccountId:'expense'}} as unknown as Workspace;
function Preview(){const[applied,setApplied]=useState(false);return <AutomationCompanyProvider organizationId="fixture"><main className="desktop-app" data-experience="clarity" style={{display:'block',padding:'clamp(16px,4vw,56px)',maxWidth:1100,margin:'auto',minHeight:'100vh'}}><p style={{color:'var(--work-muted)',fontSize:13}}>Aperçu · entreprise et données fictives</p><FixedAssetsPanel workspace={workspace} readOnly={false} onChanged={async()=>{}} onSetup={()=>{}}/><section className="panel" style={{marginTop:32}}><h2>Nouvelle facture fournisseur</h2><InvoiceScanPanel disabled={false} onBusy={()=>{}} onApply={()=>{qa.scanApplied++;setApplied(true);}}/>{applied&&<p role="status">Informations reprises dans le brouillon fictif.</p>}</section></main></AutomationCompanyProvider>}
createRoot(document.getElementById('root')!).render(<Preview/>);

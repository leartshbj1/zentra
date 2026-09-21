// Synthetic fixtures only; excluded from the production entry point.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SupplierInbox} from '../src/SupplierInboxPanel';
import {useSupplierInbox,type SupplierInboxState} from '../src/supplierInbox';
import {AutomationDailySummaryView} from '../src/AutomationDailySummary';
import {desktopApi} from '../src/bridge';
import type {Workspace} from '../src/types';
import type {AutomationState} from '../src/automation';
import {setAppLanguage,languageNames,type AppLanguage} from '../src/language';
import {setAppearance} from '../src/appearance';
import '../src/styles.css';import '../src/workspace-design.css';import '../src/mobile.css';import '../src/dark.generated.css';import '../src/dark.css';
const workspace={suppliers:[{id:'vendor',name:'Papeterie du Léman SA',email:'factures@example.test',archivedAt:null}],supplierInvoices:[],accounts:[{id:'expense',code:'6500',name:'Charges administratives',accountType:'expense',active:true}]} as Workspace;
desktopApi.loadWorkspace=async()=>workspace;
const item={id:'11111111-1111-4111-8111-111111111111',organizationId:'qa',fileName:'Facture septembre.pdf',mediaType:'application/pdf',sha256:'fixture',sender:'factures@example.test',subject:'Votre facture de septembre',state:'review',invoiceId:null,automatic:false,otherDevice:false,createdAt:1,extraction:{supplierName:'Papeterie du Léman SA',reference:'F-2026-0014',invoiceDate:'2026-09-20',dueDate:'2026-10-20',currency:'CHF',netCents:10000,vatCents:810,totalCents:10810,vatBp:810,category:'materials',confidence:.92,issues:['Le compte de charges reste à vérifier.'],evidence:{}}};
let queue:SupplierInboxState={organizationId:'qa',linked:true,autoPost:false,automationActive:true,items:[structuredClone(item)]};
let trace:string[]=[];
const stream='BT /F1 18 Tf 40 740 Td (FACTURE FOURNISSEUR) Tj 0 -50 Td (Papeterie du Leman SA) Tj 0 -40 Td (No F-2026-0014) Tj 0 -40 Td (Total CHF 108.10) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((s,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${s}\nendobj\n`;});const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:{data?:{action?:string;id:string;automatic?:boolean}})=>{
  const data=args?.data;if(command==='open_supplier_inbox_settings'){trace.push('settings');return;}
  if(command!=='supplier_inbox_request')throw Error('Unexpected command '+command);
  if(!data)return structuredClone(queue);
  trace.push(data.action||'');
  if(data.action==='document')return{base64:btoa(pdf)};
  if(data.action==='ignore'){queue.items=[];return{saved:true};}
  if(data.action==='import'){queue.items=queue.items.map(i=>({...i,state:'imported',invoiceId:i.id,automatic:!!data.automatic}));return{saved:true,id:data.id,acknowledged:true};}
  throw Error('Unexpected inbox action');
}}});
const automation={organizationId:'qa',active:true,canManage:true,available:['supplier_routing'],settings:{enabled:true,consent:true,mode:'suggest',flags:['supplier_routing'],thresholds:{high:.95,medium:.65}},activity:{date:'2026-09-20',timeZone:'Europe/Zurich',updatedAt:1,displayName:'Camille',totals:{analyzed:0,suggestions:0,confirmed:0,needsReview:0,observed:0},features:[],supplierInbox:{received:8,imported:6,automatic:5,needsReview:2,recent:[]}}} as AutomationState;
function Preview(){const[output,setOutput]=useState(''),[readOnly,setReadOnly]=useState(false),[org,setOrg]=useState('qa');const inbox=useSupplierInbox(org,readOnly,()=>!!document.querySelector('[role=dialog]'),()=>setOutput('Données actualisées'));
return <main className="desktop-app" data-experience="apple" style={{maxWidth:1200,margin:'auto',padding:16}}><div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:24}}><select aria-label="Langue" onChange={e=>setAppLanguage(e.target.value as AppLanguage)}>{Object.entries(languageNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><button onClick={()=>setAppearance('dark')}>Sombre</button><button onClick={()=>setAppearance('light')}>Clair</button><button onClick={()=>setReadOnly(!readOnly)}>Consultation</button><button onClick={()=>{queue={...queue,autoPost:true,items:[{...structuredClone(item),state:'ready'}]};void inbox.refresh();}}>Automatique</button><button onClick={()=>setOrg(org==='qa'?'other':'qa')}>Changer entreprise</button></div><AutomationDailySummaryView state={automation}/><SupplierInbox inbox={inbox} workspace={workspace} readOnly={readOnly} onOpen={id=>setOutput('Facture ouverte : '+id+' · '+trace.join(','))} onCreateSupplier={async()=>{setOutput('Ajouter fournisseur');return 'vendor';}}/><output>{output}</output></main>;}
createRoot(document.getElementById('root')!).render(<Preview/>);

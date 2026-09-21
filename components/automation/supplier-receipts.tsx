'use client';
import { useEffect, useState } from 'react';
import type { inboxState } from '@/lib/supplier-inbox/service';
type State=Awaited<ReturnType<typeof inboxState>>;
const money=(cents:number|null,currency:string|null)=>cents===null?'À vérifier':new Intl.NumberFormat('fr-CH',{style:'currency',currency:currency||'CHF'}).format(cents/100);
const categories:Record<string,string>={materials:'Matériel et marchandises',software:'Logiciels',telecom:'Télécommunications',rent:'Loyer',insurance:'Assurances',transport:'Transport',services:'Prestations de services',other:'À classer'};
export function SupplierReceipts({organizationId,initialState}:{organizationId:string;initialState:State}) {
 const [state,setState]=useState(initialState),[query,setQuery]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true,running=false;const controller=new AbortController();const refresh=async()=>{if(running||document.visibilityState==='hidden')return;running=true;try{const res=await fetch(`/api/supplier-inbox?organizationId=${encodeURIComponent(organizationId)}`,{cache:'no-store',signal:controller.signal});const data=await res.json() as State;if(!res.ok||data.organizationId!==organizationId)throw Error();if(active){setState(data);setError('');}}catch{if(active)setError('La réception est momentanément indisponible. Vos derniers documents restent affichés.');}finally{running=false;}};const timer=setInterval(()=>void refresh(),20000);document.addEventListener('visibilitychange',refresh);return()=>{active=false;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[organizationId]);
 const items=state.items.filter(i=>i.state!=='ignored');
 const visible=items.filter(i=>[i.extraction.reference,i.extraction.supplierName,i.fileName].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
 return <section className="automation-panel supplier-receipts" aria-label="Réception dans Gestion">
  <div className="supplier-receipts__heading"><div><h2>De la boîte mail à Gestion</h2><p>Ouvrez Automation dans l’application Gestion pour vérifier et comptabiliser les factures.</p></div><a href="/support/espace">Ouvrir Support →</a></div>
  {error&&<p role="status">{error}</p>}
  {!state.linked?<p>Reliez votre entreprise depuis les connexions de Zentra Support.</p>:<>
   <p><strong>{items.filter(i=>i.state!=='imported').length}</strong> à vérifier · <strong>{items.filter(i=>i.state==='imported').length}</strong> enregistrées{state.items.length>=100?' · 100 derniers documents':''}</p>
   <label className="supplier-receipts__search">Rechercher une facture<input type="search" placeholder="Fournisseur ou référence" value={query} onChange={e=>setQuery(e.target.value)}/></label>
   <div className="supplier-receipts__list">{visible.map(item=><details key={item.id} data-receipt-id={item.id}>
    <summary><span><strong>{item.extraction.supplierName||item.sender}</strong><small>{item.extraction.reference||item.fileName}</small></span><strong>{money(item.extraction.totalCents,item.extraction.currency)}</strong><span>{item.state==='imported'?(item.automatic?'Comptabilisée automatiquement':'Enregistrée dans Gestion'):item.state==='processing'?'Enregistrement en cours':'À vérifier'}</span></summary>
    <dl><div><dt>Référence</dt><dd>{item.extraction.reference||'À compléter'}</dd></div><div><dt>Date</dt><dd>{item.extraction.invoiceDate||'À compléter'}</dd></div><div><dt>Échéance</dt><dd>{item.extraction.dueDate||'À compléter'}</dd></div><div><dt>Hors taxe</dt><dd>{money(item.extraction.netCents,item.extraction.currency)}</dd></div><div><dt>TVA</dt><dd>{money(item.extraction.vatCents,item.extraction.currency)} · {item.extraction.vatBp===null?'À vérifier':`${item.extraction.vatBp/100} %`}</dd></div><div><dt>Catégorie proposée</dt><dd>{categories[item.extraction.category||'']||'À vérifier'}</dd></div></dl>
    <p>{item.fileName}</p>{item.extraction.issues.length>0&&<ul>{item.extraction.issues.map((issue,n)=><li key={n}>{issue}</li>)}</ul>}
   </details>)}</div>
   {!visible.length&&<p>{query?'Aucune facture ne correspond à cette recherche.':'Votre prochaine facture apparaîtra ici après réception dans Support.'}</p>}
  </>}
 </section>;
}

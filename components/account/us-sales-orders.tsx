'use client';
import { useEffect, useEffectEvent, useLayoutEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';
import { browserUsSalesOrderCopy, browserUsSalesOrderError, browserUsSalesOrderSourceStatus } from '@/lib/international/browser-us-sales-order-copy';
import { BrowserUsSalesOrderError, createBrowserUsSalesOrderSession, type BrowserUsSalesOrderSession } from '@/lib/international/browser-us-sales-order-session';
import type { UsSalesOrderSource, UsSalesOrderCommand, UsSalesOrderPage, UsSalesOrderRecord } from '@/lib/international/us-sales-order-contract';
import { browserDocumentAnchor } from '@/lib/international/browser-projects';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney } from '@/lib/international/money';
import { estimateTotals, lineTotals } from '@/lib/international/invoicing';
import type { ErpState } from '@/lib/international/runtime-types';
import './us-sales-orders.css';

export interface UsSalesOrdersProps {
  organizationId:string; expectedUserId:string; role:AccountRole; language:SiteLanguage; state:ErpState;
  newOrdersEnabled:boolean; admitted:boolean; blocked:boolean; accessEpoch:number; active:boolean;
  onBusyChange(this:void,value:boolean):void; onPendingChange(this:void,value:boolean):void; onInvalidated(this:void):void;
  registerInvalidation(this:void,invalidate:(()=>void)|null):void;
  invoiceTargetId?:string;
}
/** Independent commercial register: no optimistic issued records and no
 * financial write. Quiet head polling never replaces a form draft. */
export function UsSalesOrders(props:UsSalesOrdersProps){if(!props.admitted)return null;return <UsSalesOrdersPanel key={`${props.organizationId}:${props.expectedUserId}:${props.role}:${props.accessEpoch}`} {...props}/>;}
function UsSalesOrdersPanel(props:UsSalesOrdersProps) {
  const c=browserUsSalesOrderCopy[props.language], prefix=useId(), locale=`${props.language}-US`;
  const latest=useRef(props);useLayoutEffect(()=>{latest.current=props;},[props]);
  const session=useRef<BrowserUsSalesOrderSession|null>(null), generation=useRef(0), working=useRef(false), cursor=useRef<number|null>(null), opened=useRef<UsSalesOrderRecord|null>(null);
  const [beforeSequence,setBeforeSequence]=useState<number|null>(null), [actionBasis,setActionBasis]=useState<number|null>(null), [page,setPage]=useState<UsSalesOrderPage|null>(null), [record,setRecord]=useState<UsSalesOrderRecord|null>(null);
  const [reading,setReading]=useState(false), [busy,setBusy]=useState(false), [loading,setLoading]=useState(true), [pending,setPending]=useState(false), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const [source,setSource]=useState<UsSalesOrderSource|null>(null),[sourceLoading,setSourceLoading]=useState(false),sourceSequence=useRef(0);
  const [creating,setCreating]=useState(false), [estimateId,setEstimate]=useState(''), [date,setDate]=useState(''), [customerReference,setCustomerReference]=useState('');
  const actionRevision=useRef<number|null>(null), selectedEstimate=useRef('');
  const [action,setAction]=useState<'confirm'|'cancel'|null>(null), [reference,setReference]=useState(''), [reason,setReason]=useState(''), [updates,setUpdates]=useState(false);
  const current=()=>props.admitted;
  const permitted=props.role!=='read_only', disabled=props.blocked||busy||reading||pending||loading||!current();
  const alive=(stamp:number)=>generation.current===stamp&&latest.current.admitted;
  function failure(reason:unknown) { if(reason instanceof BrowserUsSalesOrderError&&reason.code==='stale_read')return;
    if(reason instanceof BrowserUsSalesOrderError&&reason.outcome==='unauthorized'){session.current?.dispose();session.current=null;opened.current=null;setPage(null);setRecord(null);setCreating(false);setReference('');setReason('');setCustomerReference('');setEstimate('');setDate('');latest.current.onInvalidated();}
    setError(browserUsSalesOrderError(latest.current.language,reason instanceof BrowserUsSalesOrderError?reason.code:'service_unavailable',reason instanceof BrowserUsSalesOrderError&&reason.outcome==='uncertain'));
  }
  const chooseEstimate=async(id:string,keepError=false)=>{selectedEstimate.current=id;setEstimate(id);setSource(null);const seq=++sourceSequence.current,instance=session.current,stamp=generation.current;if(!instance||!id)return;setSourceLoading(true);if(!keepError)setError('');try{const result=await instance.source(id);if(alive(stamp)&&seq===sourceSequence.current)setSource(result);}catch(reason){if(alive(stamp)&&seq===sourceSequence.current)failure(reason);}finally{if(alive(stamp)&&seq===sourceSequence.current)setSourceLoading(false);}};
  async function load(before=cursor.current,quiet=false,keepError=false) {
    const instance=session.current, stamp=generation.current; if(!instance||working.current)return;
    working.current=true;setReading(true);if(!quiet)setLoading(true);
    try {const result=await instance.load(before);if(!alive(stamp))return;setPage(result);cursor.current=before;setBeforeSequence(before);setUpdates(false);if(!quiet&&!keepError)setError('');if(selectedEstimate.current)void chooseEstimate(selectedEstimate.current,keepError||quiet);
      const selected=opened.current;if(selected){const refreshed=await instance.read(selected.order.id);if(!alive(stamp)||opened.current!==selected)return;opened.current=refreshed;setRecord(refreshed);if(refreshed.order.revision!==selected.order.revision&&actionRevision.current!==null)setNotice(browserUsSalesOrderCopy[latest.current.language].conflict);}
    }catch(reason){if(alive(stamp))failure(reason);}finally{if(alive(stamp)){working.current=false;setReading(false);if(!quiet)setLoading(false);}}
  }
  const initialize=useEffectEvent(()=>void load(null));
  const register=useEffectEvent((invalidate:(()=>void)|null)=>latest.current.registerInvalidation(invalidate));
  const end=useEffectEvent(()=>{generation.current++;session.current=null;});
  useEffect(()=>{
    generation.current++;const stamp=generation.current;const unregister=props.registerInvalidation;
    const instance=createBrowserUsSalesOrderSession({organizationId:props.organizationId,expectedUserId:props.expectedUserId,role:props.role});session.current=instance;
    const invalidate=()=>{generation.current++;instance.dispose();session.current=null;setSource(null);selectedEstimate.current='';sourceSequence.current++;setSourceLoading(false);opened.current=null;working.current=false;setPage(null);setRecord(null);setCreating(false);actionRevision.current=null;setActionBasis(null);setAction(null);setEstimate('');setDate('');setReference('');setReason('');setCustomerReference('');setPending(false);setBusy(false);setReading(false);setLoading(false);latest.current.onBusyChange(false);latest.current.onPendingChange(false);};
    register(invalidate);
    queueMicrotask(()=>{if(alive(stamp))initialize();});
    let timer:ReturnType<typeof setTimeout>|undefined, probing=false;
    async function poll(){if(!alive(stamp)||probing)return;if(timer)clearTimeout(timer);timer=undefined;try{if(!probing&&!working.current&&document.visibilityState==='visible'&&navigator.onLine&&latest.current.active){probing=true;const changed=await instance.changed();if(!alive(stamp))return;
          if(changed&&!instance.hasPending()){if(cursor.current===null)await load(null,true);else setUpdates(true);}
        }}catch(reason){if(alive(stamp)&&reason instanceof BrowserUsSalesOrderError&&reason.outcome==='unauthorized')failure(reason);}finally{probing=false;if(alive(stamp))timer=setTimeout(()=>void poll(),3000);}}
    timer=setTimeout(()=>void poll(),3000);const wake=()=>void poll();const auth=()=>{invalidate();latest.current.onInvalidated();};
    document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);window.addEventListener(AUTH_CHANGED_EVENT,auth);
    return()=>{if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);window.removeEventListener(AUTH_CHANGED_EVENT,auth);instance.dispose();end();unregister(null);};
    // All mutable rendering callbacks are read through latest; identity is the privacy boundary.
  },[props.organizationId,props.expectedUserId,props.role,props.accessEpoch,props.registerInvalidation]);
  useEffect(()=>{if(action)document.getElementById(`${prefix}-action-reference`)?.focus();},[action,prefix]);
  async function open(id:string){const instance=session.current,stamp=generation.current;if(!instance||working.current)return;working.current=true;setBusy(true);setError('');try{const value=await instance.read(id);if(alive(stamp)){opened.current=value;setRecord(value);actionRevision.current=null;setActionBasis(null);setAction(null);setReference('');setReason('');}}catch(reason){if(alive(stamp))failure(reason);}finally{if(alive(stamp)){working.current=false;setBusy(false);}}}
  async function write(orderId:string,revision:number|null,command:UsSalesOrderCommand,retry=false){const instance=session.current,stamp=generation.current;if(!instance||working.current||!permitted||!retry&&disabled)return;
    working.current=true;setBusy(true);latest.current.onBusyChange(true);setError('');setNotice('');
    try{await(retry?instance.retry():instance.change(orderId,revision,command));if(!alive(stamp))return;setNotice(c.saved);setCreating(false);actionRevision.current=null;setActionBasis(null);setAction(null);setReference('');setReason('');setEstimate('');selectedEstimate.current='';setDate('');setCustomerReference('');}
    catch(reason){if(alive(stamp))failure(reason);}
    finally{if(alive(stamp)){const unresolved=instance.hasPending();setPending(unresolved);latest.current.onPendingChange(unresolved);setBusy(false);latest.current.onBusyChange(false);working.current=false;if(!unresolved)await load(null,false,true);}}
  }
  const renewSource=useEffectEvent(()=>{if(selectedEstimate.current)void chooseEstimate(selectedEstimate.current,true);});
  useEffect(()=>{const stamp=generation.current;queueMicrotask(()=>{if(alive(stamp))renewSource();});},[props.state.revision]);
  function create(event:SubmitEvent){event.preventDefault();const source=props.state.estimates.find(e=>e.id===estimateId);if(!source||source.status!=='accepted'||!sourceReady||!page||page.erpRevision!==props.state.revision){setError(c.stale);return;}void write(crypto.randomUUID(),null,{type:'create_from_estimate',estimateId:source.id,expectedEstimateRevision:source.revision,orderDate:date,customerReference:customerReference.trim()||null});}
  async function download(format:'pdf'|'html'|'csv'|'json'){const instance=session.current,selected=opened.current,stamp=generation.current;if(!instance||!selected||working.current)return;working.current=true;setBusy(true);setError('');try{const blob=await instance.download(selected.order.id,selected.order.revision,props.language,format);if(!alive(stamp))return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${selected.order.number}.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(reason){if(alive(stamp))failure(reason);}finally{if(alive(stamp)){working.current=false;setBusy(false);}}}
  if(!current())return null;
  const choices=props.state.estimates.filter(e=>e.status==='accepted'&&!props.state.invoices.some(i=>i.sourceEstimateId===e.id));
  const sourceReady=source?.status==='accepted'&&source.estimateId===estimateId&&source.estimateRevision===props.state.estimates.find(e=>e.id===estimateId)?.revision&&source.erpRevision===props.state.revision&&source.activeOrderId===null&&source.invoiceId===null;
  return <section className="us-erp-section us-sales-orders" aria-labelledby={`${prefix}-title`}>
    <header className="us-orders-heading"><div><h2 id={`${prefix}-title`}>{c.title}</h2><p className="us-erp-muted">{c.subtitle}</p></div>{permitted&&props.newOrdersEnabled&&<button className="account-button secondary" type="button" disabled={disabled} aria-expanded={creating} onClick={()=>{setCreating(!creating);setError('');}}>{c.create}</button>}</header>
    {!props.newOrdersEnabled&&<p className="us-erp-muted">{c.paused}</p>}
    {error&&<p role="alert" className="us-orders-error">{error}</p>}{notice&&<output>{notice}</output>}
    {pending&&<button type="button" className="account-button secondary" disabled={busy||reading||!permitted} onClick={()=>void write('',null,{type:'cancel',reason:''},true)}>{c.retry}</button>}
    {creating&&permitted&&props.newOrdersEnabled&&<form onSubmit={create} className="us-orders-form"><fieldset disabled={disabled} className="us-erp-form"><label>{c.estimate}<select required value={estimateId} onChange={e=>void chooseEstimate(e.target.value)}><option value="">{c.choose}</option>{choices.map(e=><option key={e.id} value={e.id}>{e.number} · {e.customer.name}</option>)}</select></label><div className="us-erp-grid"><label>{c.date}<input type="date" required value={date} onInput={e=>setDate(e.currentTarget.value)} onChange={e=>setDate(e.target.value)}/></label><label>{c.customerReference}<input maxLength={500} value={customerReference} onChange={e=>setCustomerReference(e.target.value)}/></label></div><p className="us-erp-muted">{sourceLoading?browserUsSalesOrderSourceStatus[props.language].checking:c.source}</p>{source?.activeOrderId&&<output>{browserUsSalesOrderSourceStatus[props.language].reserved}</output>}{source?.activeOrderId&&<button type="button" className="us-orders-text" disabled={busy||reading||loading} onClick={()=>void open(source.activeOrderId!)}>{c.detail}</button>}{source&&!sourceReady&&!source.activeOrderId&&<output>{c.stale}</output>}<button type="submit" disabled={!sourceReady||sourceLoading} className="account-button">{c.save}</button></fieldset></form>}
    {loading&&!page?<output>{c.loading}</output>:page?<><div className="us-orders-toolbar"><span>{new Intl.NumberFormat(locale).format(page.total)} {page.total===1?({fr:'commande',en:'order',de:'Auftrag',it:'ordine'}as const)[props.language]:c.total}</span><button type="button" disabled={busy||reading||pending||loading} onClick={()=>void load(null)}>{beforeSequence!==null?c.latest:c.load}</button></div>{updates&&<output>{c.newUpdates}</output>}{!page.orders.length?<p className="us-erp-muted">{c.empty}</p>:<ul className="us-orders-list">{page.orders.map(o=><li key={o.id}><button type="button" disabled={busy||reading||loading} className="us-orders-row" aria-label={`${o.number} · ${o.customerName} · ${c[o.invoice?'invoiced':o.state]}`} aria-expanded={record?.order.id===o.id} onClick={()=>void open(o.id)}><span><strong>{o.number}</strong><span>{o.customerName}</span><time dateTime={o.orderDate}>{formatDateOnly(o.orderDate,locale)}</time></span><span className="us-orders-amount"><strong>{formatMoney(o.net,locale)}</strong><span>{c[o.invoice?'invoiced':o.state]}</span></span></button></li>)}</ul>}{page.nextBeforeSequence!==null&&<button type="button" className="account-button secondary" disabled={busy||reading||pending||loading} aria-label={c.more} onClick={()=>void load(page.nextBeforeSequence)}>{c.more}</button>}</>:!loading&&<button type="button" className="account-button secondary" onClick={()=>void load(null)}>{c.load}</button>}
    {record&&<article className="us-orders-detail" aria-label={`${c.detail} ${record.order.number}`}><header className="us-orders-heading"><div><h3>{record.order.number}</h3><p>{record.order.sourceEstimate.customer.name}</p></div><button type="button" className="us-orders-text" onClick={()=>{opened.current=null;setRecord(null);actionRevision.current=null;setActionBasis(null);setAction(null);}}>{c.close}</button></header><dl className="us-erp-facts"><div><dt>{c.original}</dt><dd><a href={`#${browserDocumentAnchor('estimate',record.order.sourceEstimate.id)}`}>{record.order.sourceEstimate.number}</a></dd></div><div><dt>{c.date}</dt><dd>{formatDateOnly(record.order.orderDate,locale)}</dd></div><div><dt>{c.revision}</dt><dd>{record.order.revision}</dd></div><div><dt>{c.sourceRevision}</dt><dd>{record.order.sourceEstimate.revision}</dd></div>{record.order.customerReference&&<div><dt>{c.customerReference}</dt><dd>{record.order.customerReference}</dd></div>}</dl><ul className="us-erp-saved-lines">{record.order.sourceEstimate.lines.map(l=><li key={l.id}><span>{l.description}</span><strong>{formatMoney(lineTotals(l,'USD').net,locale)}</strong></li>)}</ul><p className="us-erp-subtotal">{c.net}<strong>{formatMoney(estimateTotals(record.order.sourceEstimate).net,locale)}</strong></p><p className="us-erp-muted">{c.tax}</p>{record.order.sourceEstimate.notes&&<p className="us-erp-notes">{record.order.sourceEstimate.notes}</p>}{record.order.confirmation&&<p>{c.reference}: {record.order.confirmation.reference}</p>}{record.order.cancellation&&<p>{c.reason}: {record.order.cancellation.reason}</p>}
      <div className="us-orders-actions">{(['pdf','html','csv','json'] as const).map(f=><button type="button" key={f} disabled={busy||reading||loading||pending} onClick={()=>void download(f)}>{c.export} {f.toUpperCase()}</button>)}</div>
      {record.invoice?<p><a href={`#${browserDocumentAnchor('invoice',record.invoice.id)}`}>{record.invoice.number}</a></p>:permitted&&!action&&<div className="us-orders-actions">{record.order.state==='draft'&&props.newOrdersEnabled&&<button type="button" className="account-button" disabled={disabled} onClick={()=>{actionRevision.current=record.order.revision;setActionBasis(record.order.revision);setAction('confirm');}}>{c.confirm}</button>}{record.order.state==='confirmed'&&props.invoiceTargetId&&['owner','admin','accountant'].includes(props.role)&&<a href={`#${props.invoiceTargetId}`} className="account-button secondary" onClick={()=>document.getElementById(props.invoiceTargetId!)?.focus()}>{c.invoice}</a>}{record.order.state!=='cancelled'&&<button type="button" className="us-orders-text" disabled={disabled} onClick={()=>{actionRevision.current=record.order.revision;setActionBasis(record.order.revision);setAction('cancel');}}>{c.cancel}</button>}</div>}
      {action&&!record.invoice&&permitted&&<form className="us-orders-form" onSubmit={e=>{e.preventDefault();if(actionRevision.current!==record.order.revision){setError(c.conflict);return;}void write(record.order.id,record.order.revision,action==='confirm'?{type:'confirm',reference:reference.trim()}:{type:'cancel',reason:reason.trim()});}}><fieldset className="us-erp-form" disabled={disabled}><label>{action==='confirm'?c.reference:c.reason}<input id={`${prefix}-action-reference`} required maxLength={500} value={action==='confirm'?reference:reason} onChange={e=>action==='confirm'?setReference(e.target.value):setReason(e.target.value)}/></label><p className="us-erp-muted">{action==='confirm'?c.referenceHelp:c.cancelHelp}</p><div className="us-orders-actions"><button className="account-button" type="submit" disabled={actionBasis!==record.order.revision}>{action==='confirm'?c.confirm:c.confirmCancel}</button><button type="button" onClick={()=>{actionRevision.current=null;setActionBasis(null);setAction(null);}}>{c.back}</button></div></fieldset></form>}
    </article>}
  </section>;
}

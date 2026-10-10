'use client';

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { ArrowLeft, Check, ChevronRight } from 'lucide-react';
import type { SiteLanguage } from '@/lib/site-language';
import type { CompanyAddress } from '@/lib/international/types';
import { countrySubdivisions, validateAddress } from '@/lib/international/addresses';
import { formatMoney, money } from '@/lib/international/money';
import { formatDateOnly } from '@/lib/international/localization';
import type { BrowserUsFinancialPilotSession, BrowserUsFinancialPilotState } from '@/lib/international/browser-us-financial-pilot-session';
import type { UsFinancialPilotOverview, UsFinancialPilotPage, UsFinancialPilotParty, UsFinancialPilotPeriodRow } from '@/lib/international/us-financial-pilot-contract';
import { validateUsFinancialPilotPurchasingRequest, type UsFinancialPilotPurchasingCommand, type UsFinancialPilotPurchasingReceipt } from '@/lib/international/us-financial-pilot-purchasing';
import type { UsFinancialPilotVendorBillDetail, UsFinancialPilotPurchasingPage, UsFinancialPilotVendorBillRow, UsFinancialPilotVendorDetail } from '@/lib/international/us-financial-pilot-purchasing-projection';
import { browserUsFinancialPilotCommercialCopy } from '@/lib/international/browser-us-financial-pilot-commercial-copy';
import { browserUsFinancialPilotPurchasingCopy, browserUsFinancialPilotPurchasingErrorCopy } from '@/lib/international/browser-us-financial-pilot-purchasing-copy';
import { purchasingAmount, purchasingTotal, purchasingDecimal, reviewPurchasingCommand } from '@/lib/international/browser-us-financial-pilot-purchasing-input';
import './us-financial-pilot-purchasing.css';

interface Props { session: BrowserUsFinancialPilotSession; state: BrowserUsFinancialPilotState; snapshot: UsFinancialPilotOverview; language: SiteLanguage; active: boolean }
type AddressDraft = { country:'US'|'CH'; line1:string; line2:string; city:string; subdivision:string; postalCode:string };
type DraftBase = { token:number; revision:number };
type VendorDraft = DraftBase & { type:'vendor'; vendorId:string|null; kind:'business'|'individual'; name:string; email:string; phone:string; contactName:string; terms:string; billing:AddressDraft; shipping:AddressDraft|null };
type BillDraft = DraftBase & { type:'bill'; vendorId:string; reference:string; sourceReference:string; date:string; accountingDate:string; dueDate:string; periodId:string; net:string; tax:string };
type PaymentDraft = DraftBase & { type:'payment'; billId:string; amount:string; paymentDate:string; accountingDate:string; periodId:string; reference:string };
type Draft = VendorDraft | BillDraft | PaymentDraft;
type Review = { token:number; revision:number; command:UsFinancialPilotPurchasingCommand; vendor:UsFinancialPilotParty|null; bill:UsFinancialPilotVendorBillDetail|null; period:UsFinancialPilotPeriodRow|null };
const blankAddress = ():AddressDraft => ({country:'US',line1:'',line2:'',city:'',subdivision:'',postalCode:''});
const addressDraft = (a:CompanyAddress):AddressDraft => ({...a,line2:a.line2??''});
const usd=(minor:string)=>formatMoney(money('USD',minor),'en-US');
const date=(value:string)=>formatDateOnly(value,'en-US');
const exactInteger=BigInt;
function today(zone:string):string { const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>p.find(part=>part.type===type)!.value).join('-'); }
function address(a:AddressDraft):CompanyAddress { return validateAddress({country:a.country,line1:a.line1.trim(),...(a.line2.trim()?{line2:a.line2.trim()}:{}),city:a.city.trim(),subdivision:a.subdivision,postalCode:a.postalCode.trim()},a.country); }
function commandFor(draft:Draft):UsFinancialPilotPurchasingCommand {
  let command:UsFinancialPilotPurchasingCommand;
  if(draft.type==='vendor') {
    if(!/^(0|[1-9][0-9]{0,2})$/.test(draft.terms)||Number(draft.terms)>365)throw new TypeError('invalid_purchasing_input');
    command={type:'save_vendor',vendorId:draft.vendorId,vendor:{kind:draft.kind,name:draft.name.trim(),email:draft.email.trim()||null,phone:draft.phone.trim()||null,contactName:draft.contactName.trim()||null,paymentTermsDays:Number(draft.terms),billingAddress:address(draft.billing),shippingAddress:draft.shipping?address(draft.shipping):null}};
  } else if(draft.type==='bill') {
    purchasingTotal(draft.net,draft.tax);
    command={type:'record_vendor_bill',vendorId:draft.vendorId,reference:draft.reference.trim(),sourceReference:draft.sourceReference.trim(),date:draft.date,accountingDate:draft.accountingDate,dueDate:draft.dueDate,periodId:draft.periodId,netMinor:purchasingAmount(draft.net),purchaseTaxMinor:purchasingAmount(draft.tax)};
  } else command={type:'record_vendor_payment',billId:draft.billId,amountMinor:purchasingAmount(draft.amount,true),paymentDate:draft.paymentDate,accountingDate:draft.accountingDate,periodId:draft.periodId,reference:draft.reference.trim()};
  // The local review uses the same closed public grammar as the transport.
  return validateUsFinancialPilotPurchasingRequest({consumer:'financial-pilot',schemaVersion:1,requestId:'00000000-0000-4000-8000-000000000001',expectedRevision:draft.revision,command}).command;
}
function Address({value,language}:{value:CompanyAddress;language:SiteLanguage}) { return <address>{value.line1}<br/>{value.line2&&<>{value.line2}<br/></>}{value.country==='US'?`${value.city}, ${value.subdivision} ${value.postalCode}`:`${value.postalCode} ${value.city}`}<br/>{new Intl.DisplayNames([language],{type:'region'}).of(value.country)}</address>; }
function Party({value,language}:{value:UsFinancialPilotParty;language:SiteLanguage}) { const c=browserUsFinancialPilotCommercialCopy[language];return <div className="fpp-party"><h3>{value.name}</h3><p>{value.kind==='business'?c.business:c.individual}</p><Address value={value.billingAddress} language={language}/>{value.shippingAddress&&<><h4>{c.shippingTitle}</h4><Address value={value.shippingAddress} language={language}/></>}{value.contactName&&<p>{c.contactName}: {value.contactName}</p>}{value.email&&<p>{c.email}: {value.email}</p>}{value.phone&&<p>{c.phone}: {value.phone}</p>}<p>{c.terms}: {value.paymentTermsDays}</p></div>; }
function AddressFields({value,onChange,language,legend}:{value:AddressDraft;onChange:(value:AddressDraft)=>void;language:SiteLanguage;legend:string}) {
  const c=browserUsFinancialPilotCommercialCopy[language];
  return <fieldset className="fpp-address"><legend>{legend}</legend><div className="fp-form-grid">
    <label>{c.country}<select value={value.country} onChange={e=>onChange({...value,country:e.target.value as AddressDraft['country'],subdivision:'',postalCode:''})}>{(['US','CH'] as const).map(country=><option key={country} value={country}>{new Intl.DisplayNames([language],{type:'region'}).of(country)}</option>)}</select></label>
    <label>{c.state}<select required value={value.subdivision} onChange={e=>onChange({...value,subdivision:e.target.value})}><option value="">{c.state}</option>{countrySubdivisions[value.country].map(code=><option key={code} value={code}>{code}</option>)}</select></label>
    <label className="fpp-wide">{c.line1}<input required maxLength={200} value={value.line1} onChange={e=>onChange({...value,line1:e.target.value})}/></label>
    <label className="fpp-wide">{c.line2} · {c.optional}<input maxLength={200} value={value.line2} onChange={e=>onChange({...value,line2:e.target.value})}/></label>
    <label>{c.city}<input required maxLength={120} value={value.city} onChange={e=>onChange({...value,city:e.target.value})}/></label>
    <label>{c.postalCode}<input required maxLength={10} pattern={value.country==='US'?'[0-9]{5}(-[0-9]{4})?':'[1-9][0-9]{3}'} value={value.postalCode} onChange={e=>onChange({...value,postalCode:e.target.value})}/></label>
  </div></fieldset>;
}

export function UsFinancialPilotPurchasing({session,state,snapshot,language,active}:Props) {
  const c=browserUsFinancialPilotPurchasingCopy[language],contact=browserUsFinancialPilotCommercialCopy[language];
  const sequence=useRef(0),lifetime=useRef(0),readGeneration=useRef(0);
  const [mode,setMode]=useState<'vendors'|'bills'>('vendors'),[draft,setDraft]=useState<Draft|null>(null),[review,setReview]=useState<Review|null>(null),[confirmed,setConfirmed]=useState(false);
  const [selectedVendor,setSelectedVendor]=useState<string|null>(null),[vendorDetail,setVendorDetail]=useState<UsFinancialPilotVendorDetail|null>(null);
  const [selectedBill,setSelectedBill]=useState<string|null>(null),[billDetail,setBillDetail]=useState<UsFinancialPilotVendorBillDetail|null>(null),[paymentCursor,setPaymentCursor]=useState<{revision:number;cursor?:string}>({revision:0});
  const [vendorPage,setVendorPage]=useState<UsFinancialPilotPage<UsFinancialPilotParty>|null>(null),[billPage,setBillPage]=useState<UsFinancialPilotPurchasingPage<UsFinancialPilotVendorBillRow>|null>(null);
  const [choices,setChoices]=useState<{revision:number;items:readonly UsFinancialPilotParty[];nextCursor:string|null}|null>(null),[periodChoices,setPeriodChoices]=useState<{revision:number;items:readonly UsFinancialPilotPeriodRow[];nextCursor:string|null}|null>(null);
  const [busy,setBusy]=useState(false),[errorCode,setErrorCode]=useState(''),[message,setMessage]=useState(''),[detailTick,setDetailTick]=useState(0),[minimumRevision,setMinimumRevision]=useState(0);
  const locked=busy||state.writing||state.pending, pending=state.pendingKind==='purchasing';
  const currentVendor=vendorDetail?.revision===snapshot.revision&&vendorDetail.vendor.id===selectedVendor?vendorDetail.vendor:null;
  const currentBill=billDetail?.revision===snapshot.revision&&billDetail.bill.id===selectedBill?billDetail:null;
  const vendors=vendorPage?.revision===snapshot.revision?vendorPage:snapshot.vendors;
  const bills=billPage?.revision===snapshot.revision?billPage:null;
  const vendorChoices=[...new Map([...snapshot.vendors.items,...vendors.items,...(choices?.revision===snapshot.revision?choices.items:[]),...(vendorDetail?.revision===snapshot.revision?[vendorDetail.vendor]:[]),...(review?.revision===snapshot.revision&&review.vendor?[review.vendor]:[])].map(v=>[v.id,v])).values()];
  const vendorCursor=choices?.revision===snapshot.revision?choices.nextCursor:snapshot.vendors.nextCursor;
  const periods=periodChoices?.revision===snapshot.revision?periodChoices.items:snapshot.periods.items;
  const periodCursor=periodChoices?.revision===snapshot.revision?periodChoices.nextCursor:snapshot.periods.nextCursor;
  const reviewCurrent=!!review&&review.token===draft?.token&&review.revision===snapshot.revision&&!state.requiresRefresh;
  const shownError=errorCode||(active?state.error?.code:'')||'';
  useEffect(()=>()=>{lifetime.current++;readGeneration.current++;},[]);
  useEffect(()=>{
    const at=++readGeneration.current;if(!active||state.pending||state.writing||snapshot.revision<minimumRevision)return;
    const task=mode==='vendors'&&selectedVendor?session.readVendor(selectedVendor,snapshot.revision).then(v=>{if(at===readGeneration.current)setVendorDetail(v);}):mode==='bills'&&selectedBill?session.readVendorBill(selectedBill,snapshot.revision,paymentCursor.revision===snapshot.revision?paymentCursor.cursor:undefined).then(v=>{if(at===readGeneration.current)setBillDetail(v);}):mode==='bills'?session.readVendorBills(undefined,snapshot.revision).then(v=>{if(at===readGeneration.current)setBillPage(old=>old?.revision===v.revision?old:v);}):Promise.resolve();
    void task.catch(error=>{if(at===readGeneration.current&&!['stale_read','session_disposed'].includes(error?.code))setErrorCode(error?.code??'service_unavailable');});
  },[session,active,mode,selectedVendor,selectedBill,snapshot.revision,paymentCursor,state.pending,state.writing,detailTick,minimumRevision]);
  function changeDraft(value:Draft) { setDraft(value);setReview(null);setConfirmed(false);setErrorCode(''); }
  function clearDraft() {setDraft(null);setReview(null);setConfirmed(false);setErrorCode('');}
  function startVendor(value?:UsFinancialPilotParty) {
    if(locked||draft)return;
    changeDraft({type:'vendor',token:++sequence.current,revision:snapshot.revision,vendorId:value?.id??null,kind:value?.kind??'business',name:value?.name??'',email:value?.email??'',phone:value?.phone??'',contactName:value?.contactName??'',terms:String(value?.paymentTermsDays??30),billing:value?addressDraft(value.billingAddress):blankAddress(),shipping:value?.shippingAddress?addressDraft(value.shippingAddress):null});setMessage('');
  }
  function startBill(vendorId='') {
    if(locked||draft)return;const day=today(snapshot.company.timeZone),p=periods.find(p=>p.status==='open'&&p.start<=day&&p.end>=day);
    changeDraft({type:'bill',token:++sequence.current,revision:snapshot.revision,vendorId,reference:'',sourceReference:'',date:day,accountingDate:day,dueDate:day,periodId:p?.id??'',net:'',tax:''});setMessage('');
  }
  function startPayment() {
    if(locked||draft||!currentBill)return;const day=today(snapshot.company.timeZone),p=periods.find(p=>p.status==='open'&&p.start<=day&&p.end>=day);
    changeDraft({type:'payment',token:++sequence.current,revision:snapshot.revision,billId:currentBill.bill.id,amount:purchasingDecimal(currentBill.bill.outstandingMinor),paymentDate:day,accountingDate:day,periodId:p?.id??'',reference:''});setMessage('');
  }
  async function loadMore(kind:'vendors'|'bills'|'choices'|'periods',cursor:string) {
    if(locked)return;const at=lifetime.current,revision=snapshot.revision;setBusy(true);setErrorCode('');
    try {if(kind==='bills'){const page=await session.readVendorBills(cursor,revision);if(at===lifetime.current)setBillPage(page);}else {const page=await session.readList(kind==='periods'?'periods':'vendors',cursor,revision);if(at!==lifetime.current)return;if(kind==='vendors')setVendorPage(page as UsFinancialPilotPage<UsFinancialPilotParty>);else if(kind==='choices')setChoices(old=>({revision,items:[...(old?.revision===revision?old.items:snapshot.vendors.items),...page.items as readonly UsFinancialPilotParty[]],nextCursor:page.nextCursor}));else setPeriodChoices(old=>({revision,items:[...(old?.revision===revision?old.items:snapshot.periods.items),...page.items as readonly UsFinancialPilotPeriodRow[]],nextCursor:page.nextCursor}));}}
    catch(error){if(at===lifetime.current)setErrorCode((error as {code?:string}).code??'service_unavailable');}finally{if(at===lifetime.current)setBusy(false);}
  }
  async function reviewDraft(event?:SubmitEvent) {
    event?.preventDefault();if(!draft||locked)return;const captured=draft,at=lifetime.current;setBusy(true);setErrorCode('');setConfirmed(false);setReview(null);
    try {
      const command=commandFor(captured),{snapshot:current,vendor,bill,period}=await reviewPurchasingCommand(session,command);
      if(at===lifetime.current){setReview({token:captured.token,revision:current.revision,command,vendor,bill,period});if(vendor)setVendorDetail({consumer:'financial-pilot',schemaVersion:1,organizationId:current.organizationId,revision:current.revision,ledgerRevision:current.ledgerRevision,vendor});}
    } catch(error){if(at===lifetime.current)setErrorCode((error as {code?:string}).code??'invalid_purchasing_input');}finally{if(at===lifetime.current)setBusy(false);}
  }
  function complete(receipt:UsFinancialPilotPurchasingReceipt) {
    setMinimumRevision(receipt.revision);setDraft(null);setReview(null);setConfirmed(false);setErrorCode('');setMessage(receipt.action==='save_vendor'?c.vendorSaved:receipt.action==='record_vendor_bill'?c.billSaved:c.paymentSaved);
    if(receipt.action==='save_vendor'){setMode('vendors');setSelectedVendor(receipt.entityId);setVendorDetail(null);}else {setMode('bills');if(receipt.action==='record_vendor_bill')setSelectedBill(receipt.entityId);setBillDetail(null);setPaymentCursor({revision:0});}setDetailTick(value=>value+1);
  }
  async function confirmReview() {
    if(!reviewCurrent||!confirmed||!review||locked)return;const at=lifetime.current;setErrorCode('');
    try {const receipt=await session.purchasing(review.command,review.revision);if(at===lifetime.current)complete(receipt);}catch(error){if(at===lifetime.current)setErrorCode((error as {code?:string}).code??'service_unavailable');}
  }
  async function retry() {if(state.writing)return;const at=lifetime.current;try {const receipt=await session.retryPurchasing();if(at===lifetime.current)complete(receipt);}catch(error){if(at===lifetime.current)setErrorCode((error as {code?:string}).code??'service_unavailable');}}
  const periodField=draft&&draft.type!=='vendor'&&<><label>{c.period}<select required value={draft.periodId} onChange={e=>changeDraft({...draft,periodId:e.target.value})}><option value="">{c.period}</option>{periods.filter(p=>p.status==='open').map(p=><option key={p.id} value={p.id}>{date(p.start)} – {date(p.end)}</option>)}{draft.periodId&&!periods.some(p=>p.id===draft.periodId)&&<option value={draft.periodId}>{draft.periodId}</option>}</select></label>{periodCursor&&<button className="fp-link" type="button" onClick={()=>{void loadMore('periods',periodCursor);}}>{c.morePeriods}</button>}</>;
  return <section className="fpp-workspace" hidden={!active} aria-label={c.vendors}>
    <div className="fpp-navigation"><button type="button" className="fp-link" aria-current={mode==='vendors'?'page':undefined} onClick={()=>setMode('vendors')}>{c.vendors}</button><button type="button" className="fp-link" aria-current={mode==='bills'?'page':undefined} onClick={()=>setMode('bills')}>{c.bills}</button></div>
    {message&&<p className="fp-success" aria-live="polite"><Check size={18} aria-hidden/>{message}</p>}
    {shownError&&<div className="fp-notice" role="alert"><p>{browserUsFinancialPilotPurchasingErrorCopy(language,shownError)}</p></div>}
    {pending?<div className="fp-notice" aria-live="polite"><p>{c.pending}</p><button type="button" className="account-button secondary" disabled={state.writing} onClick={()=>{void retry();}}>{state.writing?c.saving:c.retry}</button></div>:state.pending&&<p className="fp-notice">{c.competing}</p>}
    {draft&&<form className="fp-payment fpp-entry" onSubmit={reviewDraft}>
      <h2>{draft.type==='vendor'?(draft.vendorId?c.editVendor:c.newVendor):draft.type==='bill'?c.newBill:c.recordPayment}</h2>
      <fieldset disabled={locked||!!review} className="fpp-fields">
        {draft.type==='vendor'?<><div className="fp-form-grid">
          <label>{c.vendorKind}<select value={draft.kind} onChange={e=>changeDraft({...draft,kind:e.target.value as VendorDraft['kind']})}><option value="business">{contact.business}</option><option value="individual">{contact.individual}</option></select></label>
          <label>{contact.name}<input required maxLength={200} value={draft.name} onChange={e=>changeDraft({...draft,name:e.target.value})}/></label>
          <label>{contact.contactName} · {contact.optional}<input maxLength={200} value={draft.contactName} onChange={e=>changeDraft({...draft,contactName:e.target.value})}/></label>
          <label>{contact.email} · {contact.optional}<input type="email" maxLength={254} value={draft.email} onChange={e=>changeDraft({...draft,email:e.target.value})}/></label>
          <label>{contact.phone} · {contact.optional}<input type="tel" maxLength={80} value={draft.phone} onChange={e=>changeDraft({...draft,phone:e.target.value})}/></label>
          <label>{c.terms}<input required inputMode="numeric" pattern="(0|[1-9][0-9]{0,2})" maxLength={3} value={draft.terms} onChange={e=>changeDraft({...draft,terms:e.target.value})}/></label>
        </div><AddressFields value={draft.billing} language={language} legend={contact.billing} onChange={billing=>changeDraft({...draft,billing})}/><label className="fpp-check"><input type="checkbox" checked={!!draft.shipping} onChange={e=>changeDraft({...draft,shipping:e.target.checked?blankAddress():null})}/>{contact.shipping}</label>{draft.shipping&&<AddressFields value={draft.shipping} language={language} legend={contact.shippingTitle} onChange={shipping=>changeDraft({...draft,shipping})}/>}</>:draft.type==='bill'?<><p className="fpp-note">{c.sourceNotice}</p><div className="fp-form-grid">
          <label className="fpp-wide">{c.vendor}<select required value={draft.vendorId} onChange={e=>changeDraft({...draft,vendorId:e.target.value})}><option value="">{c.chooseVendor}</option>{vendorChoices.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}{draft.vendorId&&!vendorChoices.some(v=>v.id===draft.vendorId)&&<option value={draft.vendorId}>{draft.vendorId}</option>}</select></label>
          {vendorCursor&&<button type="button" className="fp-link fpp-wide" onClick={()=>{void loadMore('choices',vendorCursor);}}>{c.moreVendors}</button>}
          <label>{c.reference}<input required maxLength={500} value={draft.reference} onChange={e=>changeDraft({...draft,reference:e.target.value})}/></label>
          <label>{c.source}<input required maxLength={500} value={draft.sourceReference} onChange={e=>changeDraft({...draft,sourceReference:e.target.value})}/></label>
          {([{key:'date',label:c.date},{key:'accountingDate',label:c.accountingDate},{key:'dueDate',label:c.dueDate}] as const).map(f=><label key={f.key}>{f.label}<input required type="date" value={draft[f.key]} onChange={e=>changeDraft({...draft,[f.key]:e.target.value})}/></label>)}{periodField}
          <label>{c.net}<input required inputMode="decimal" maxLength={39} value={draft.net} onChange={e=>changeDraft({...draft,net:e.target.value})}/></label>
          <label>{c.tax}<input required inputMode="decimal" maxLength={39} value={draft.tax} onChange={e=>changeDraft({...draft,tax:e.target.value})}/></label>
        </div><p className="fpp-note">{c.decimal}</p></>:<><p className="fpp-note">{c.paymentNotice}</p><div className="fp-form-grid">
          <label>{c.amount}<input required inputMode="decimal" maxLength={39} value={draft.amount} onChange={e=>changeDraft({...draft,amount:e.target.value})}/></label>
          {([{key:'paymentDate',label:c.paymentDate},{key:'accountingDate',label:c.accountingDate}] as const).map(f=><label key={f.key}>{f.label}<input required type="date" value={draft[f.key]} onChange={e=>changeDraft({...draft,[f.key]:e.target.value})}/></label>)}{periodField}
          <label>{c.paymentReference}<input required maxLength={500} value={draft.reference} onChange={e=>changeDraft({...draft,reference:e.target.value})}/></label>
        </div></>}
      </fieldset>
      {draft.revision!==snapshot.revision||state.requiresRefresh?<p className="fp-draft-changed">{c.changed}</p>:null}
      {!review&&<div className="fp-actions"><button className="account-button fp-primary" type="submit" disabled={locked}>{busy?c.loading:c.review}</button><button className="account-button secondary" type="button" disabled={state.pending||state.writing||busy} onClick={clearDraft}>{c.cancel}</button></div>}
    </form>}
    {review&&draft&&<section className="fpp-review fp-document" aria-label={c.reviewTitle}>
      <h2>{c.reviewTitle}</h2><p className="fpp-note">{c.reviewed}</p>
      {review.vendor&&<section><h3>{c.currentVendor}</h3><Party value={review.vendor} language={language}/></section>}
      {review.command.type==='save_vendor'?<section><h3>{c.draftTitle}</h3><Party value={{id:review.command.vendorId??'new',...review.command.vendor}} language={language}/></section>:<>
        {review.bill&&<dl className="fp-report-facts"><div><dt>{c.reference}</dt><dd>{review.bill.bill.reference}</dd></div><div><dt>{c.currentBalance}</dt><dd>{usd(review.bill.bill.outstandingMinor)}</dd></div></dl>}
        <dl className="fp-report-facts">
          {review.command.type==='record_vendor_bill'?<><div><dt>{c.reference}</dt><dd>{review.command.reference}</dd></div><div><dt>{c.source}</dt><dd>{review.command.sourceReference}</dd></div><div><dt>{c.date}</dt><dd>{date(review.command.date)}</dd></div><div><dt>{c.dueDate}</dt><dd>{date(review.command.dueDate)}</dd></div><div><dt>{c.net}</dt><dd>{usd(review.command.netMinor)}</dd></div><div><dt>{c.tax}</dt><dd>{usd(review.command.purchaseTaxMinor)}</dd></div><div><dt>{c.total}</dt><dd>{usd((exactInteger(review.command.netMinor)+exactInteger(review.command.purchaseTaxMinor)).toString())}</dd></div></>:<><div><dt>{c.paymentReference}</dt><dd>{review.command.reference}</dd></div><div><dt>{c.paymentDate}</dt><dd>{date(review.command.paymentDate)}</dd></div><div><dt>{c.amount}</dt><dd>{usd(review.command.amountMinor)}</dd></div></>}
          <div><dt>{c.accountingDate}</dt><dd>{date(review.command.accountingDate)}</dd></div>{review.period&&<div><dt>{c.reviewPeriod}</dt><dd>{date(review.period.start)} – {date(review.period.end)}</dd></div>}
        </dl><p className="fpp-note">{review.command.type==='record_vendor_bill'?c.sourceNotice:c.paymentNotice}</p>
      </>}
      {!reviewCurrent&&<p className="fp-draft-changed">{c.changed}</p>}
      <label className="fpp-check"><input type="checkbox" checked={confirmed} disabled={locked||!reviewCurrent} onChange={e=>setConfirmed(e.target.checked)}/>{c.humanConfirm}</label>
      <div className="fp-actions"><button className="account-button fp-primary" type="button" disabled={locked||!reviewCurrent||!confirmed} onClick={()=>{void confirmReview();}}>{state.writing?c.saving:c.confirm}</button><button className="account-button secondary" type="button" disabled={locked} onClick={()=>{setReview(null);setConfirmed(false);}}>{c.edit}</button>{!reviewCurrent&&<button className="account-button secondary" type="button" disabled={locked} onClick={()=>{void reviewDraft();}}>{c.review}</button>}</div>
    </section>}
    {!draft&&(mode==='vendors'?selectedVendor?<>
      <button className="fp-back" type="button" onClick={()=>{setSelectedVendor(null);setVendorDetail(null);}}><ArrowLeft size={18} aria-hidden/>{c.back}</button>
      {currentVendor?<><article className="fp-document"><h2>{c.vendorTitle}</h2><Party value={currentVendor} language={language}/></article><div className="fp-actions"><button className="account-button secondary" disabled={locked} type="button" onClick={()=>startVendor(currentVendor)}>{c.editVendor}</button><button className="account-button fp-primary" disabled={locked} type="button" onClick={()=>startBill(currentVendor.id)}>{c.newBill}</button></div></>:<p className="fp-empty">{c.loading}</p>}
    </>:<section className="fp-register"><div className="fp-register-title"><h2>{c.vendors}</h2><span>{vendors.total}</span></div><div className="fp-actions"><button className="account-button fp-primary" disabled={locked} type="button" onClick={()=>startVendor()}>{c.newVendor}</button><button className="account-button secondary" disabled={locked} type="button" onClick={()=>startBill()}>{c.newBill}</button></div>{vendors.items.length?<ul className="fp-records">{vendors.items.map(v=><li key={v.id}><button className="fp-invoice-row" type="button" onClick={()=>{setSelectedVendor(v.id);setVendorDetail(null);setErrorCode('');}}><div><strong>{v.name}</strong><span>{v.billingAddress.city} · {v.billingAddress.country}</span></div><ChevronRight size={18} aria-hidden/></button></li>)}</ul>:<p className="fp-empty">{c.emptyVendors}</p>}<div className="fp-pagination">{vendorPage?.revision===snapshot.revision&&<button className="fp-link" disabled={locked} onClick={()=>setVendorPage(null)}>{c.first}</button>}{vendors.nextCursor&&<button className="account-button secondary" disabled={locked} onClick={()=>{void loadMore('vendors',vendors.nextCursor!);}}>{c.more}</button>}</div></section>:selectedBill?<>
      <button className="fp-back" type="button" onClick={()=>{setSelectedBill(null);setBillDetail(null);setPaymentCursor({revision:0});}}><ArrowLeft size={18} aria-hidden/>{c.back}</button>
      {currentBill?<><div className="fp-detail-heading"><div><h2>{currentBill.bill.reference}</h2><p>{currentBill.bill.vendorName}</p></div><span className="fp-status">{currentBill.bill.status==='paid'?c.paidStatus:c[currentBill.bill.status]}</span></div><dl className="fp-facts">{([{label:c.total,value:currentBill.bill.totalMinor},{label:c.paid,value:currentBill.bill.paidMinor},{label:c.balance,value:currentBill.bill.outstandingMinor}] as const).map(f=><div key={f.label}><dt>{f.label}</dt><dd>{usd(f.value)}</dd></div>)}</dl>{currentBill.bill.outstandingMinor!=='0'&&<button className="account-button fp-primary" disabled={locked} type="button" onClick={startPayment}>{c.recordPayment}</button>}
      <article className="fp-document"><h3>{c.historicalVendor}</h3><Party value={currentBill.vendor} language={language}/><dl className="fp-report-facts">{([{label:c.date,value:date(currentBill.bill.date)},{label:c.accountingDate,value:date(currentBill.bill.accountingDate)},{label:c.dueDate,value:date(currentBill.bill.dueDate)},{label:c.period,value:currentBill.bill.periodId},{label:c.source,value:currentBill.sourceReference},{label:c.manual,value:currentBill.approvalSource==='manual_entry'?c.manual:currentBill.approvalSource},{label:c.approval,value:currentBill.bill.approvedBy},{label:c.recordedAt,value:new Intl.DateTimeFormat('en-US',{timeZone:snapshot.company.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(currentBill.bill.approvedAt))},{label:c.net,value:usd(currentBill.bill.netMinor)},{label:c.tax,value:usd(currentBill.bill.purchaseTaxMinor)}] as const).map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl><p className="fpp-note">{c.sourceNotice}</p></article>
      <section className="fp-history"><h3>{c.history} · {currentBill.payments.total}</h3>{currentBill.payments.items.length?<ul>{currentBill.payments.items.map(p=><li key={p.id}><div><strong>{p.reference}</strong><span>{c.paymentDate}: {date(p.paymentDate)}</span><span>{c.accountingDate}: {date(p.accountingDate)} · {p.periodId}</span><span>{c.approval}: {p.recordedBy} · {new Intl.DateTimeFormat('en-US',{timeZone:snapshot.company.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(p.recordedAt))}</span></div><strong>{usd(p.amountMinor)}</strong></li>)}</ul>:<p>{c.noPayments}</p>}<div className="fp-pagination">{paymentCursor.revision===snapshot.revision&&paymentCursor.cursor&&<button className="fp-link" disabled={locked} onClick={()=>setPaymentCursor({revision:snapshot.revision})}>{c.first}</button>}{currentBill.payments.nextCursor&&<button className="account-button secondary" disabled={locked} onClick={()=>setPaymentCursor({revision:snapshot.revision,cursor:currentBill.payments.nextCursor!})}>{c.more}</button>}</div></section></>:<p className="fp-empty">{c.loading}</p>}
    </>:<section className="fp-register"><div className="fp-register-title"><h2>{c.bills}</h2><span>{bills?.total??''}</span></div><div className="fp-actions"><button className="account-button fp-primary" disabled={locked} type="button" onClick={()=>startBill()}>{c.newBill}</button></div>{bills?bills.items.length?<ul className="fp-records">{bills.items.map(b=><li key={b.id}><button type="button" className="fp-invoice-row" onClick={()=>{setSelectedBill(b.id);setBillDetail(null);setPaymentCursor({revision:0});setErrorCode('');}}><div><strong>{b.reference}</strong><span>{b.vendorName}</span><span>{date(b.dueDate)} · {b.status==='paid'?c.paidStatus:c[b.status]}</span></div><div className="fp-row-amount"><strong>{usd(b.outstandingMinor)}</strong><span>{c.balance}</span></div><ChevronRight size={18} aria-hidden/></button></li>)}</ul>:<p className="fp-empty">{c.emptyBills}</p>:<p className="fp-empty">{c.loading}</p>}<div className="fp-pagination">{bills&&billPage&&<button className="fp-link" disabled={locked} onClick={()=>{setBillPage(null);setDetailTick(v=>v+1);}}>{c.first}</button>}{bills?.nextCursor&&<button className="account-button secondary" disabled={locked} onClick={()=>{void loadMore('bills',bills.nextCursor!);}}>{c.more}</button>}</div></section>)}
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRightLeft, History, Receipt, RotateCcw } from 'lucide-react';
import { desktopApi } from './bridge';
import type { CustomerCreditSettlement, Invoice, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { createId, errorMessage, formatDate, formatMoney, invoiceOpenBalance as invoiceBalance, todayIso } from './utils';
import { supplierRefundAmount, supplierRefundDateError } from './supplierCreditRefunds';
import './CustomerCreditPanel.css';
import { readCustomerCreditRequest,saveCustomerCreditRequest,clearCustomerCreditRequest } from './customerCreditRequest';
import { RefundAttachmentList,RefundReceiptPicker } from './RefundAttachments';
import { CustomerCreditRecovery } from './CustomerCreditRecovery';
import { readCreditRecovery } from './customerCreditRecoveryState';
import { revealInDialog } from './dialogFocus';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;
const labels = {apply:'Déduit d’une facture', refund:'Remboursé au client', reverse_apply:'Déduction annulée', reverse_refund:'Remboursement annulé'};

export function CustomerCreditPanel({ invoice, workspace, busy, readOnly = false, act }: {
  invoice: Invoice; workspace: Workspace; busy: boolean; readOnly?: boolean; act: ActionRunner;
}) {
  const credits=invoice.type==='credit_note' ? [workspace.invoices.find((item)=>item.id===invoice.id) ?? invoice]
    : workspace.invoices.filter((item)=>item.type==='credit_note' && (item.originalInvoiceId===invoice.id || item.creditSettlements?.some((event)=>event.invoiceId===invoice.id)) && item.status!=='draft' && item.status!=='cancelled');
  if (!credits.length) return null;
  const recoveryOriginals=[...new Set(credits.filter(credit=>!credit.customerCredit||readCreditRecovery(credit.originalInvoiceId||'')).map(credit=>credit.originalInvoiceId).filter((id):id is string=>Boolean(id)))];
  return <section className="customer-credit-panel" aria-label="Avoirs et règlements liés">
    <header><Receipt size={20}/><div><h3>Avoirs et règlements</h3><p>Les montants déduits et remboursés restent reliés aux documents.</p></div></header>
    {recoveryOriginals.map(id=><CustomerCreditRecovery key={id} originalInvoiceId={id} busy={busy} readOnly={readOnly} act={act}/>)}
    {credits.map((credit)=><CreditCard key={credit.id} credit={credit} workspace={workspace} busy={busy} readOnly={readOnly} act={act}/>)}
  </section>;
}

function CreditCard({credit,workspace,busy,readOnly,act}: {credit:Invoice;workspace:Workspace;busy:boolean;readOnly:boolean;act:ActionRunner}) {
  const [saved]=useState(()=>readCustomerCreditRequest(credit.id));
  const [mode,setMode]=useState<'apply'|'refund'|null>(saved?.input.eventType ?? null);
  const [reverse,setReverse]=useState<CustomerCreditSettlement|undefined>(()=>credit.creditSettlements?.find((event)=>event.id===saved?.reverseId));
  const [amount,setAmount]=useState(saved ? (saved.input.amountCents/100).toFixed(2) : '');
  const [date,setDate]=useState(saved?.input.date ?? todayIso());
  const [target,setTarget]=useState(saved?.input.invoiceId ?? '');
  const [bank,setBank]=useState(saved?.input.bankAccountId ?? workspace.accountingSettings?.bankAccountId ?? '');
  const [reference,setReference]=useState(saved?.input.reference ?? '');
  const [reason,setReason]=useState(saved?.input.reason ?? '');
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  const [pending,setPending]=useState(Boolean(saved));
  const [attachmentEventId,setAttachmentEventId]=useState<string|null>(null);
  const [receipt,setReceipt]=useState<File|null>(null);
  const [attachmentError,setAttachmentError]=useState('');
  const attachmentHeading=useRef<HTMLHeadingElement>(null);
  const attachmentSaving=useRef(false);
  useEffect(()=>{if(attachmentEventId)revealInDialog(attachmentHeading.current);},[attachmentEventId]);
  const inFlight=useRef(false);
  const heading=useRef<HTMLDivElement>(null);
  const formHeading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{
    if(mode) revealInDialog(formHeading.current);
  },[mode,reverse?.id]);
  const request=useRef<{key:string;id:string} | undefined>(saved ? {
    key:JSON.stringify(saved.reverseId ? {settlementId:saved.reverseId,date:saved.input.date,reason:saved.input.reason} : (({requestId:_,...payload})=>payload)(saved.input)),id:saved.input.requestId,
  } : undefined);
  const balance=credit.customerCredit;
  const events=credit.creditSettlements ?? [];
  const original=workspace.invoices.find((item)=>item.id===credit.originalInvoiceId);
  const reversed=new Set(events.map((event)=>event.reversesId).filter(Boolean));
  const targets=workspace.invoices.filter((item)=>item.type!=='credit_note' && item.status!=='draft' && item.status!=='cancelled' && item.clientId===credit.clientId && item.currency===credit.currency && invoiceBalance(item,workspace.invoices,workspace.payments)>0);
  const targetInvoice=targets.find((item)=>item.id===target);
  const available=balance?.remainingCents ?? 0;
  const amountCents=reverse?.amountCents ?? supplierRefundAmount(amount);
  const minimum=[credit.issueDate,...events.map((event)=>event.date),targetInvoice?.issueDate ?? '',reverse?.date ?? ''].sort().at(-1)!;
  const inputError=!amountCents ? 'Saisissez un montant positif avec deux décimales au maximum.'
    : !reverse && amountCents>available ? 'Le montant dépasse le solde disponible de l’avoir.'
    : !reverse && mode==='apply' && (!targetInvoice || amountCents>invoiceBalance(targetInvoice,workspace.invoices,workspace.payments)) ? 'Choisissez une facture dont le solde couvre cette déduction.'
    : !reverse && mode==='refund' && !bank ? 'Choisissez le compte du remboursement.'
    : supplierRefundDateError(date,minimum,todayIso());
  const valid=!inputError && (reverse || reference.trim()) && reason.trim().length>=5;
  const begin=(value:'apply'|'refund',event?:CustomerCreditSettlement)=>{
    setMode(value);setReverse(event);setAmount(((event?.amountCents ?? available)/100).toFixed(2));
    setReference(event?.reference ?? '');setReason('');setDate(todayIso());setError('');request.current=undefined;
  };
  const submit=async()=>{
    if (busy || readOnly || inFlight.current || (!valid && !pending) || !amountCents || !mode) return;
    if(saved?.reverseId && !reverse) {setError('Le règlement à corriger est absent de cet historique. Actualisez le dossier avant de reprendre la demande.');return;}
    const payload={creditNoteId:credit.id,eventType:mode,invoiceId:mode==='apply'?target:null,date,amountCents,bankAccountId:mode==='refund'?bank:null,reference,reason};
    const key=JSON.stringify(reverse ? {settlementId:reverse.id,date,reason} : payload);
    if (!request.current || request.current.key!==key) request.current={key,id:createId()};
    const requestId=request.current.id;
    try { saveCustomerCreditRequest({input:{...payload,requestId},reverseId:reverse?.id}); }
    catch {setError('La demande ne peut pas être conservée pour une reprise fiable. Libérez du stockage local avant de continuer.');return;}
    inFlight.current=true;setError('');setAttempt((value)=>value+1);
    const success=await act(async()=>{
      try {
        return reverse ? await desktopApi.reverseCustomerCreditSettlement({requestId,settlementId:reverse.id,date,reason})
          : await desktopApi.recordCustomerCreditSettlement({...payload,requestId});
      } catch (cause) {
        const message=errorMessage(cause,'Le résultat du règlement n’a pas pu être confirmé.');
        // A native validation/transaction error is a definitive rejection. A lost reply
        // retains the identical request and input, so retry cannot pay twice.
        setPending(!/^(Champ invalide|Erreur de base de données locale|Enregistrement introuvable|Données JSON invalides)/.test(message));
        if (/^(Champ invalide|Erreur de base de données locale|Enregistrement introuvable|Données JSON invalides)/.test(message)) clearCustomerCreditRequest(credit.id);
        setError(message);throw cause;
      }
    },reverse?'Correction du règlement enregistrée.':'Règlement de l’avoir enregistré.',false).finally(()=>{inFlight.current=false;});
    if (success) {
      clearCustomerCreditRequest(credit.id);
      setPending(false);setMode(null);setReverse(undefined);request.current=undefined;
      requestAnimationFrame(()=>revealInDialog(heading.current));
    }
  };
  return <article className="customer-credit-card">
    <div className="customer-credit-card__heading" ref={heading} tabIndex={-1}><div><strong>{credit.number || credit.title}</strong><p>Facture d’origine : {original?.number || '—'}</p></div>{balance && <div className="customer-credit-card__available"><span>Disponible</span><strong>{formatMoney(available,credit.currency)}</strong></div>}</div>
    {balance ? <>
      <dl className="customer-credit-card__totals"><div><dt>Déduit des factures</dt><dd>{formatMoney(balance.allocatedCents,credit.currency)}</dd></div><div><dt>Remboursé</dt><dd>{formatMoney(balance.refundedCents,credit.currency)}</dd></div></dl>
      {!mode && !attachmentEventId && available>0 && <div className="customer-credit-card__actions"><Button variant="secondary" disabled={busy||readOnly} onClick={()=>begin('apply')}><ArrowRightLeft size={16}/>Déduire d’une facture</Button><Button variant="secondary" disabled={busy||readOnly} onClick={()=>begin('refund')}><ArrowDownLeft size={16}/>Enregistrer un remboursement</Button></div>}
    </> : <p className="muted">Avoir historique : documentez ses règlements dans l’assistant de reprise ci-dessus.</p>}
    {credit.creditRecovery&&<details className="customer-credit-card__history"><summary><History size={16}/>Reprise documentée le {formatDate(credit.creditRecovery.recordedAt.slice(0,10))}</summary><p><strong>{credit.creditRecovery.reference}</strong><br/>{credit.creditRecovery.reason}</p></details>}
    {events.length>0 && <details className="customer-credit-card__history"><summary><History size={16}/>Historique · {events.length} opération{events.length>1?'s':''}</summary><ol>{events.map((event)=>{
      const counterpart=workspace.invoices.find((item)=>item.id===event.invoiceId)?.number || workspace.accounts.find((account)=>account.id===event.bankAccountId)?.name;
      const files=(workspace.attachments ?? []).filter((file)=>file.entityType==='customer_credit_settlement'&&file.entityId===event.id);
      return <li key={event.id}><div><strong>{labels[event.eventType]}</strong><span>{formatDate(event.date)} · {counterpart}</span><span>{event.reference} · {event.reason}</span><small>{event.journalValid?'Comptabilisé':event.journalEntryId?'Écriture à vérifier':'À comptabiliser'}</small><RefundAttachmentList attachments={files} label="Justificatifs du règlement"/></div><div className="customer-credit-card__event-amount"><strong>{formatMoney(event.amountCents,credit.currency)}</strong>{!event.reversesId && !reversed.has(event.id) && !mode && !attachmentEventId && <Button size="small" variant="ghost" disabled={busy||readOnly} onClick={()=>begin(event.eventType==='apply'?'apply':'refund',event)}><RotateCcw size={14}/>Corriger</Button>}{reversed.has(event.id)&&<small>Annulé par une correction</small>}<Button size="small" variant="secondary" disabled={busy||readOnly||Boolean(mode)||Boolean(attachmentEventId)||files.length>=20} onClick={()=>{setAttachmentEventId(event.id);setReceipt(null);setAttachmentError('');}}>Joindre une pièce</Button></div></li>;
    })}</ol></details>}
    {attachmentEventId && <form className="customer-credit-form" onSubmit={async(event)=>{
      event.preventDefault();if(busy||readOnly||!receipt||attachmentSaving.current)return;
      attachmentSaving.current=true;setAttachmentError('');
      try {
        const success=await act(async()=>{
          try{return await desktopApi.addCustomerCreditSettlementAttachment(attachmentEventId,receipt);}
          catch(cause){setAttachmentError(errorMessage(cause,'Le justificatif n’a pas pu être confirmé. Réessayez le même fichier.'));throw cause;}
        },'Le justificatif est lié au règlement.',false);
        if(success){setAttachmentEventId(null);setReceipt(null);requestAnimationFrame(()=>revealInDialog(heading.current));}
      } finally{attachmentSaving.current=false;}
    }}>
      <h4 ref={attachmentHeading} tabIndex={-1}>Justificatif du règlement</h4>
      <p>{events.find((event)=>event.id===attachmentEventId)?.reference} · La pièce restera conservée avec l’historique, y compris après une correction.</p>
      <RefundReceiptPicker receipt={receipt} onChange={setReceipt} disabled={busy||readOnly} onError={setAttachmentError} label="Fichier à joindre" hint="PDF, JPG, PNG ou WebP · 25 Mo maximum."/>
      {attachmentError && <ErrorPanel message={attachmentError} reveal/>}
      <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={()=>setAttachmentEventId(null)}>Annuler</Button><Button type="submit" disabled={busy||readOnly||!receipt}>Ajouter le justificatif</Button></div>
    </form>}
    {mode && <form className="customer-credit-form" onSubmit={(event)=>{event.preventDefault();void submit();}}>
      <h4 ref={formHeading} tabIndex={-1}>{reverse?'Corriger un règlement':mode==='apply'?'Déduire de la facture':'Remboursement versé au client'}</h4>
      <p>{reverse?'La correction conserve l’opération d’origine dans l’historique.':mode==='refund'?'Enregistrez le virement déjà effectué au client.':'Le montant choisi réduira le solde de la facture.'}</p>
      <fieldset className="form-grid" disabled={busy||readOnly||pending}>
        {!reverse && mode==='apply' && <Field label="Facture à régler" required wide><select required value={target} onChange={(event)=>setTarget(event.target.value)}><option value="">Choisir une facture</option>{targets.map((item)=><option key={item.id} value={item.id}>{item.number} · {formatMoney(invoiceBalance(item,workspace.invoices,workspace.payments),item.currency)} à régler</option>)}</select></Field>}
        {!reverse && mode==='refund' && <Field label="Compte du virement" required wide><select required value={bank} onChange={(event)=>setBank(event.target.value)}><option value="">Choisir un compte</option>{workspace.accounts.filter((account)=>account.active&&account.accountType==='asset'&&account.id!==workspace.accountingSettings?.arAccountId).map((account)=><option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></Field>}
        <Field label={`Montant (${credit.currency})`} required><input inputMode="decimal" value={amount} required readOnly={Boolean(reverse)} onChange={(event)=>setAmount(event.target.value)}/></Field>
        <Field label={reverse?'Date de correction':'Date effective'} required><input type="date" required min={minimum} max={todayIso()} value={date} onChange={(event)=>setDate(event.target.value)}/></Field>
        <Field label={mode==='refund'?'Référence bancaire':'Référence de la déduction'} required><input required maxLength={255} value={reference} readOnly={Boolean(reverse)} onChange={(event)=>setReference(event.target.value)}/></Field>
        <Field label="Motif" required><textarea required minLength={5} maxLength={1000} value={reason} onChange={(event)=>setReason(event.target.value)}/></Field>
      </fieldset>
      {inputError && <p className="customer-credit-form__hint">{inputError}</p>}
      {error && <ErrorPanel key={attempt} message={error} reveal/>}
      {pending && <p role="status">Réessayez cette même demande pour vérifier son résultat sans créer un second règlement.</p>}
      <div className="form-actions"><Button variant="secondary" disabled={busy||pending} onClick={()=>{setMode(null);setReverse(undefined);}}>Annuler</Button><Button type="submit" disabled={busy||readOnly||(!valid&&!pending)}>{pending?'Vérifier la même demande':reverse?'Enregistrer la correction':'Enregistrer le règlement'}</Button></div>
    </form>}
  </article>;
}

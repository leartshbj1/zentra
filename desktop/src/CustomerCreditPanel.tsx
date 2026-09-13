import {CustomerSettlementForm} from './CustomerSettlementForm';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRightLeft, History, Receipt, RotateCcw } from 'lucide-react';
import { desktopApi } from './bridge';
import type { CustomerCreditSettlement, Invoice, Workspace } from './types';
import { Button, ErrorPanel } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import './CustomerCreditPanel.css';
import { readCustomerCreditRequest } from './customerCreditRequest';
import { RefundAttachmentList,RefundReceiptPicker } from './RefundAttachments';
import { CustomerCreditRecovery } from './CustomerCreditRecovery';
import { readCreditRecovery } from './customerCreditRecoveryState';
import { revealInDialog } from './dialogFocus';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (cause:unknown)=>void) => Promise<boolean>;
const labels = {apply:'Déduit d’une facture', refund:'Remboursé au client', reverse_apply:'Déduction annulée', reverse_refund:'Remboursement annulé'};

export function CustomerCreditPanel({ invoice, workspace, busy, readOnly = false, act, onReadWorkspace, onOpenHelp }: {
  invoice: Invoice; workspace: Workspace; busy: boolean; readOnly?: boolean; act: ActionRunner; onReadWorkspace:()=>Promise<Workspace>; onOpenHelp:(destination:'accounts'|'periods'|'bank')=>void;
}) {
  const credits=invoice.type==='credit_note' ? workspace.invoices.filter(item=>item.id===invoice.id)
    : workspace.invoices.filter((item)=>item.type==='credit_note' && (item.originalInvoiceId===invoice.id || item.creditSettlements?.some((event)=>event.invoiceId===invoice.id)) && item.status!=='draft' && item.status!=='cancelled');
  if (!credits.length) return null;
  const recoveryOriginals=[...new Set(credits.filter(credit=>!credit.customerCredit||readCreditRecovery(credit.originalInvoiceId||'')).map(credit=>credit.originalInvoiceId).filter((id):id is string=>Boolean(id)))];
  return <section className="customer-credit-panel" aria-label="Avoirs et règlements liés">
    <header><Receipt size={20}/><div><h3>Avoirs et règlements</h3><p>Les montants déduits et remboursés restent reliés aux documents.</p></div></header>
    {recoveryOriginals.map(id=><CustomerCreditRecovery key={id} originalInvoiceId={id} busy={busy} readOnly={readOnly} act={act}/>)}
    {credits.map((credit)=><CreditCard key={credit.id} credit={credit} workspace={workspace} busy={busy} readOnly={readOnly} act={act} onReadWorkspace={onReadWorkspace} onOpenHelp={onOpenHelp}/>)}
  </section>;
}

function CreditCard({credit,workspace,busy,readOnly,act,onReadWorkspace,onOpenHelp}: {credit:Invoice;workspace:Workspace;busy:boolean;readOnly:boolean;act:ActionRunner;onReadWorkspace:()=>Promise<Workspace>;onOpenHelp:(destination:'accounts'|'periods'|'bank')=>void}) {
  const [saved]=useState(()=>readCustomerCreditRequest(credit.id));
  const [action,setAction]=useState<{mode:'apply'|'refund';reverseId?:string}|null>(saved?{mode:saved.input.eventType,reverseId:saved.reverseId}:null);
  const mode=action?.mode;
  const [attachmentEventId,setAttachmentEventId]=useState<string|null>(null);
  const [receipt,setReceipt]=useState<File|null>(null);
  const [attachmentError,setAttachmentError]=useState('');
  const attachmentHeading=useRef<HTMLHeadingElement>(null);
  const attachmentSaving=useRef(false);
  useEffect(()=>{if(attachmentEventId)revealInDialog(attachmentHeading.current);},[attachmentEventId]);
  const heading=useRef<HTMLDivElement>(null);
  const balance=credit.customerCredit;
  const events=credit.creditSettlements ?? [];
  const original=workspace.invoices.find((item)=>item.id===credit.originalInvoiceId);
  const reversed=new Set(events.map((event)=>event.reversesId).filter(Boolean));
  const available=balance?.remainingCents??0;
  const begin=(mode:'apply'|'refund',event?:CustomerCreditSettlement)=>setAction({mode,reverseId:event?.id});
  return <article className="customer-credit-card">
    <div className="customer-credit-card__heading" ref={heading} tabIndex={-1}><div><strong>{credit.number || credit.title}</strong><p>Facture d’origine : {original?.number || '—'}</p></div>{balance && <div className="customer-credit-card__available"><span>Disponible</span><strong>{formatMoney(available,credit.currency)}</strong></div>}</div>
    {balance ? <>
      <dl className="customer-credit-card__totals"><div><dt>Déduit des factures</dt><dd>{formatMoney(balance.allocatedCents,credit.currency)}</dd></div><div><dt>Remboursé</dt><dd>{formatMoney(balance.refundedCents,credit.currency)}</dd></div></dl>
      {!mode && !attachmentEventId && available>0 && <div className="customer-credit-card__actions"><Button variant="secondary" disabled={busy||readOnly} onClick={()=>begin('apply')}><ArrowRightLeft size={16}/>Déduire d’une facture</Button><Button variant="secondary" disabled={busy||readOnly} onClick={()=>begin('refund')}><ArrowDownLeft size={16}/>Enregistrer un remboursement</Button></div>}
    </> : <p className="muted">Avoir historique : documentez ses règlements dans l’assistant de reprise ci-dessus.</p>}
    {credit.creditRecovery&&<details className="customer-credit-card__history"><summary><History size={16}/>Reprise documentée le {formatDate(credit.creditRecovery.recordedAt.slice(0,10))}</summary><p><strong>{credit.creditRecovery.reference}</strong><br/>{credit.creditRecovery.reason}</p>{credit.creditRecovery.receivedVat&&<div className="credit-recovery__tax"><strong>TVA rapprochée dans ce dossier</strong><p>Variations de TVA due conservées avec les écritures d’origine.</p><ul>{credit.creditRecovery.vatAdjustments?.map((a,index)=><li key={index}>{formatDate(a.date)} · {a.reference} : <strong>{a.dueChangeCents>0?'+':''}{formatMoney(a.dueChangeCents,credit.currency)}</strong></li>)}</ul></div>}</details>}
    {events.length>0 && <details className="customer-credit-card__history"><summary><History size={16}/>Historique · {events.length} opération{events.length>1?'s':''}</summary><ol>{events.map((event)=>{
      const counterpart=workspace.invoices.find((item)=>item.id===event.invoiceId)?.number || workspace.accounts.find((account)=>account.id===event.bankAccountId)?.name;
      const files=(workspace.attachments ?? []).filter((file)=>file.entityType==='customer_credit_settlement'&&file.entityId===event.id);
      return <li key={event.id}><div><strong>{labels[event.eventType]}</strong><span>{formatDate(event.date)} · {counterpart}</span><span>{event.reference} · {event.reason}</span><small>{event.journalValid?'Comptabilisé':event.journalEntryId?'Écriture à vérifier':'À comptabiliser'}</small><RefundAttachmentList attachments={files} label="Justificatifs du règlement"/></div><div className="customer-credit-card__event-amount"><strong>{formatMoney(event.amountCents,credit.currency)}</strong>{!event.reversesId && !event.bankMatchId && !reversed.has(event.id) && !mode && !attachmentEventId && <Button size="small" variant="ghost" disabled={busy||readOnly} onClick={()=>begin(event.eventType==='apply'?'apply':'refund',event)}><RotateCcw size={14}/>Corriger</Button>}{event.bankMatchId&&<><small>Rapproché au relevé. Dissociez-le dans Banque avant de corriger le remboursement.</small><Button type="button" size="small" variant="ghost" disabled={busy} onClick={()=>onOpenHelp('bank')}>Vérifier dans Banque</Button></>}{reversed.has(event.id)&&<small>Annulé par une correction</small>}<Button size="small" variant="secondary" disabled={busy||readOnly||Boolean(mode)||Boolean(attachmentEventId)||files.length>=20} onClick={()=>{setAttachmentEventId(event.id);setReceipt(null);setAttachmentError('');}}>Joindre une pièce</Button></div></li>;
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
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setAttachmentEventId(null)}>Annuler</Button><Button type="submit" disabled={busy||readOnly||!receipt}>Ajouter le justificatif</Button></div>
    </form>}
    {action && <CustomerSettlementForm key={`${credit.id}:${action.mode}:${action.reverseId||''}`} creditId={credit.id} mode={action.mode} reverseId={action.reverseId} workspace={workspace} busy={busy} readOnly={readOnly} act={act} onReadWorkspace={onReadWorkspace} onOpenHelp={onOpenHelp} onCancel={()=>setAction(null)} onDone={()=>{setAction(null);requestAnimationFrame(()=>revealInDialog(heading.current));}}/>}

  </article>;
}

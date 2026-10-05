import {CustomerSettlementForm} from './CustomerSettlementForm';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRightLeft, History, Receipt, RotateCcw } from 'lucide-react';
import { desktopApi } from './bridge';
import type { CustomerCreditSettlement, Invoice, Workspace } from './types';
import { Button, ErrorPanel } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import './CustomerCreditPanel.css';
import { t, useAppLanguage } from './language';
import { readCustomerCreditRequest } from './customerCreditRequest';
import {useVerifiedFormDraftScope} from './useFormDraft';
import { RefundAttachmentList,RefundReceiptPicker } from './RefundAttachments';
import { CustomerCreditRecovery } from './CustomerCreditRecovery';
import { readCreditRecovery,legacyCreditRecoveryReviewRequired,creditRecoveryScopeKey } from './customerCreditRecoveryState';
import { revealInDialog } from './dialogFocus';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (cause:unknown)=>void, validateRead?: (workspace:Workspace)=>void) => Promise<boolean>;
const labels = {apply:'Déduit d’une facture', refund:'Remboursé au client', reverse_apply:'Déduction annulée', reverse_refund:'Remboursement annulé'};

export function CustomerCreditPanel({ invoice, workspace, busy, readOnly = false, act, onReadWorkspace, onOpenHelp }: {
  invoice: Invoice; workspace: Workspace; busy: boolean; readOnly?: boolean; act: ActionRunner; onReadWorkspace:()=>Promise<Workspace>; onOpenHelp:(destination:'accounts'|'periods'|'bank')=>void;
}) {
  useAppLanguage();
  const recoveryScope=useVerifiedFormDraftScope(workspace,'customer-credit-recovery',invoice.originalInvoiceId||invoice.id);
  const credits=invoice.type==='credit_note' ? workspace.invoices.filter(item=>item.id===invoice.id)
    : workspace.invoices.filter((item)=>item.type==='credit_note' && (item.originalInvoiceId===invoice.id || item.creditSettlements?.some((event)=>event.invoiceId===invoice.id)) && item.status!=='draft' && item.status!=='cancelled');
  if (!credits.length) return null;
  const recoveryOriginals=[...new Set(credits.filter(credit=>!credit.customerCredit||readCreditRecovery(credit.originalInvoiceId||'',recoveryScope)||legacyCreditRecoveryReviewRequired(credit.originalInvoiceId||'',recoveryScope)).map(credit=>credit.originalInvoiceId).filter((id):id is string=>Boolean(id)))];
  return <section className="customer-credit-panel" aria-label={t("Avoirs et règlements liés")}>
    <header><Receipt size={20}/><div><h3>{t("Avoirs et règlements")}</h3><p>{t("Les montants déduits et remboursés restent reliés aux documents.")}</p></div></header>
    {recoveryOriginals.map(id=><CustomerCreditRecovery key={`${creditRecoveryScopeKey(recoveryScope)}:${id}`} originalInvoiceId={id} workspace={workspace} busy={busy} readOnly={readOnly} act={act} onReadWorkspace={onReadWorkspace}/>)}
    {credits.map((credit)=><CreditCard key={`${workspace.workNotesScope}:${credit.id}`} credit={credit} workspace={workspace} busy={busy} readOnly={readOnly} act={act} onReadWorkspace={onReadWorkspace} onOpenHelp={onOpenHelp}/>)}
  </section>;
}

function CreditCard({credit,workspace,busy,readOnly,act,onReadWorkspace,onOpenHelp}: {credit:Invoice;workspace:Workspace;busy:boolean;readOnly:boolean;act:ActionRunner;onReadWorkspace:()=>Promise<Workspace>;onOpenHelp:(destination:'accounts'|'periods'|'bank')=>void}) {
  useAppLanguage();
  const requestScope=useVerifiedFormDraftScope(workspace,'customer-credit-request',credit.id);
  const [saved]=useState(()=>readCustomerCreditRequest(credit.id,requestScope));
  const [action,setAction]=useState<{mode:'apply'|'refund';reverseId?:string}|null>(saved?{mode:saved.input.eventType,reverseId:saved.reverseId}:null);
  const mode=action?.mode;
  const [attachmentEventId,setAttachmentEventId]=useState<string|null>(null);
  const [receipt,setReceipt]=useState<File|null>(null);
  const [attachmentError,setAttachmentError]=useState('');
  const attachmentHeading=useRef<HTMLHeadingElement>(null);
  const attachmentSaving=useRef(false);
  const attachmentOriginScope=useRef(workspace.workNotesScope).current;
  const attachmentContext=useRef({scope:workspace.workNotesScope,busy,readOnly});attachmentContext.current={scope:workspace.workNotesScope,busy,readOnly};
  const attachmentAlive=useRef(false),attachmentFlight=useRef<AbortController|null>(null);
  useLayoutEffect(()=>{attachmentAlive.current=true;return()=>{attachmentAlive.current=false;attachmentFlight.current?.abort();};},[]);
  useLayoutEffect(()=>{if(workspace.workNotesScope!==attachmentOriginScope||readOnly)attachmentFlight.current?.abort();},[workspace.workNotesScope,attachmentOriginScope,readOnly]);
  const isAttachmentCurrent=()=>attachmentAlive.current&&attachmentContext.current.scope===attachmentOriginScope;
  const validateAttachmentRead=(next:Workspace)=>{if(!isAttachmentCurrent()||(attachmentOriginScope!==undefined&&next.workNotesScope!==attachmentOriginScope))throw Error('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');};
  useEffect(()=>{if(attachmentEventId)revealInDialog(attachmentHeading.current);},[attachmentEventId]);
  const heading=useRef<HTMLDivElement>(null);
  const balance=credit.customerCredit;
  const events=credit.creditSettlements ?? [];
  const original=workspace.invoices.find((item)=>item.id===credit.originalInvoiceId);
  const reversed=new Set(events.map((event)=>event.reversesId).filter(Boolean));
  const available=balance?.remainingCents??0;
  const begin=(mode:'apply'|'refund',event?:CustomerCreditSettlement)=>setAction({mode,reverseId:event?.id});
  return <article className="customer-credit-card">
    <div className="customer-credit-card__heading" ref={heading} tabIndex={-1}><div><strong>{credit.number || credit.title}</strong><p>{t('Facture d’origine : {number}',{number:original?.number || '—'})}</p></div>{balance && <div className="customer-credit-card__available"><span>{t("Disponible")}</span><strong>{formatMoney(available,credit.currency)}</strong></div>}</div>
    {balance ? <>
      <dl className="customer-credit-card__totals"><div><dt>{t("Déduit des factures")}</dt><dd>{formatMoney(balance.allocatedCents,credit.currency)}</dd></div><div><dt>{t("Remboursé")}</dt><dd>{formatMoney(balance.refundedCents,credit.currency)}</dd></div></dl>
      {!mode && !attachmentEventId && available>0 && <div className="customer-credit-card__actions"><Button variant="secondary" disabled={busy||readOnly} onClick={()=>begin('apply')}><ArrowRightLeft size={16}/>{t("Déduire d’une facture")}</Button><Button variant="secondary" disabled={busy||readOnly} onClick={()=>begin('refund')}><ArrowDownLeft size={16}/>{t("Enregistrer un remboursement")}</Button></div>}
    </> : <p className="muted">{t("Avoir historique : documentez ses règlements dans l’assistant de reprise ci-dessus.")}</p>}
    {credit.creditRecovery&&<details className="customer-credit-card__history"><summary><History size={16}/>{t('Reprise documentée le {date}',{date:formatDate(credit.creditRecovery.recordedAt.slice(0,10))})}</summary><p><strong>{credit.creditRecovery.reference}</strong><br/>{credit.creditRecovery.reason}</p>{credit.creditRecovery.receivedVat&&<div className="credit-recovery__tax"><strong>{t("TVA rapprochée dans ce dossier")}</strong><p>{t("Variations de TVA due conservées avec les écritures d’origine.")}</p><ul>{credit.creditRecovery.vatAdjustments?.map((a,index)=><li key={index}>{formatDate(a.date)} · {a.reference} : <strong>{a.dueChangeCents>0?'+':''}{formatMoney(a.dueChangeCents,credit.currency)}</strong></li>)}</ul></div>}</details>}
    {events.length>0 && <details className="customer-credit-card__history"><summary><History size={16}/>{events.length===1?t('Historique · 1 opération'):t('Historique · {count} opérations',{count:events.length})}</summary><ol>{events.map((event)=>{
      const counterpart=workspace.invoices.find((item)=>item.id===event.invoiceId)?.number || workspace.accounts.find((account)=>account.id===event.bankAccountId)?.name;
      const files=(workspace.attachments ?? []).filter((file)=>file.entityType==='customer_credit_settlement'&&file.entityId===event.id);
      return <li key={event.id}><div><strong>{t(labels[event.eventType])}</strong><span>{formatDate(event.date)} · {counterpart}</span><span>{event.reference} · {event.reason}</span><small>{t(event.journalValid?'Comptabilisé':event.journalEntryId?'Écriture à vérifier':'À comptabiliser')}</small><RefundAttachmentList attachments={files} workspaceScope={workspace.workNotesScope} label={t("Justificatifs du règlement")} openLabel={t('Ouvrir')} openingLabel={t('Ouverture…')} openAriaLabel={name=>t('Ouvrir {name}',{name})} errorTitle={t('Justificatif indisponible')}/></div><div className="customer-credit-card__event-amount"><strong>{formatMoney(event.amountCents,credit.currency)}</strong>{!event.reversesId && !event.bankMatchId && !reversed.has(event.id) && !mode && !attachmentEventId && <Button size="small" variant="ghost" disabled={busy||readOnly} onClick={()=>begin(event.eventType==='apply'?'apply':'refund',event)}><RotateCcw size={14}/>{t("Corriger")}</Button>}{event.bankMatchId&&<><small>{t("Rapproché au relevé. Dissociez-le dans Banque avant de corriger le remboursement.")}</small><Button type="button" size="small" variant="ghost" disabled={busy} onClick={()=>onOpenHelp('bank')}>{t("Vérifier dans Banque")}</Button></>}{reversed.has(event.id)&&<small>{t("Annulé par une correction")}</small>}<Button size="small" variant="secondary" disabled={busy||readOnly||Boolean(mode)||Boolean(attachmentEventId)||files.length>=20} onClick={()=>{setAttachmentEventId(event.id);setReceipt(null);setAttachmentError('');}}>{t("Joindre une pièce")}</Button></div></li>;
    })}</ol></details>}
    {attachmentEventId && <form className="customer-credit-form" onSubmit={async(event)=>{
      event.preventDefault();if(!isAttachmentCurrent()||attachmentContext.current.busy||attachmentContext.current.readOnly||!receipt||attachmentSaving.current)return;
      attachmentSaving.current=true;setAttachmentError('');
      const controller=new AbortController();attachmentFlight.current=controller;
      try {
        const success=await act(async()=>{
          try{return await desktopApi.addCustomerCreditSettlementAttachment(attachmentEventId,receipt,attachmentOriginScope,controller.signal);}
          catch(cause){if(isAttachmentCurrent())setAttachmentError(errorMessage(cause,'Le justificatif n’a pas pu être confirmé. Réessayez le même fichier.'));throw cause;}
        },t('Le justificatif est lié au règlement.'),false,undefined,validateAttachmentRead);
        if(success&&isAttachmentCurrent()){setAttachmentEventId(null);setReceipt(null);requestAnimationFrame(()=>{if(isAttachmentCurrent())revealInDialog(heading.current);});}
      } finally{attachmentSaving.current=false;if(attachmentFlight.current===controller)attachmentFlight.current=null;}
    }}>
      <h4 ref={attachmentHeading} tabIndex={-1}>{t("Justificatif du règlement")}</h4>
      <p>{events.find((event)=>event.id===attachmentEventId)?.reference} · {t("La pièce restera conservée avec l’historique, y compris après une correction.")}</p>
      <RefundReceiptPicker receipt={receipt} onChange={setReceipt} disabled={busy||readOnly} onError={setAttachmentError} label={t("Fichier à joindre")} hint={t("PDF, JPG, PNG ou WebP · 25 Mo maximum.")} removeLabel={t('Retirer le justificatif sélectionné')}/>
      {attachmentError && <ErrorPanel message={attachmentError} reveal/>}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setAttachmentEventId(null)}>{t("Annuler")}</Button><Button type="submit" disabled={busy||readOnly||!receipt}>{t("Ajouter le justificatif")}</Button></div>
    </form>}
    {action && <CustomerSettlementForm key={`${credit.id}:${action.mode}:${action.reverseId||''}`} creditId={credit.id} mode={action.mode} reverseId={action.reverseId} workspace={workspace} busy={busy} readOnly={readOnly} act={act} onReadWorkspace={onReadWorkspace} onOpenHelp={onOpenHelp} onCancel={()=>setAction(null)} onResumePending={pending=>setAction({mode:pending.input.eventType,reverseId:pending.reverseId})} onDone={()=>{setAction(null);requestAnimationFrame(()=>revealInDialog(heading.current));}}/>}

  </article>;
}

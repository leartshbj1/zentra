import { ErrorDetails } from './ErrorGuidance';
import { useEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney, invoiceOpenBalance, todayIso } from './utils';
import { creditAmount, creditAmountInput } from './creditAllocationWorkflow';
import { paymentNativeProblem, paymentProblem, requirePaymentWorkspace, type PaymentDraft, type PaymentProblem } from './paymentWorkflow';
import { FormDraftNotice, useFormDraft, useVerifiedFormDraftScope } from './useFormDraft';
import { formDraftFingerprint } from './formDrafts';
import { assertPaymentRequestCurrent, clearConfirmedPaymentRequest, confirmPaymentRequest, createPaymentReceipt, extendPaymentRequest, paymentRequestScopeKey, readPaymentRequest, retainPaymentRequest, validPaymentDraft, type PaymentReceipt, type PaymentRequestRead } from './paymentRequest';
import './credit-allocation.css';

export function PaymentForm({ invoiceId, workspace, busy, readOnly, close, act, onReadWorkspace, onOpenAccounting }: {
  invoiceId:string; workspace:Workspace; busy:boolean; readOnly:boolean; close:()=>void;
  act:(action:()=>Promise<Workspace>,message:string,close?:boolean,onError?:(reason:unknown)=>void)=>Promise<boolean>;
  onReadWorkspace:()=>Promise<Workspace>; onOpenAccounting:(section?:'accounts'|'periods')=>void;
}) {
  const invoice=workspace.invoices.find(row=>row.id===invoiceId);
  const balance=invoice?invoiceOpenBalance(invoice,workspace.invoices,workspace.payments):null;
  const bank=workspace.accounts.find(row=>row.id===workspace.accountingSettings?.bankAccountId);
  const scope=useVerifiedFormDraftScope(workspace,'customer-payment',invoiceId),scopeKey=paymentRequestScopeKey(scope);
  const [originKey]=useState(scopeKey),origin=useRef(scopeKey),alive=useRef(true);
  origin.current=scopeKey;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const [request,setRequest]=useState<PaymentRequestRead>(()=>readPaymentRequest(scope,invoiceId));
  const receipt=request.kind==='pending'?request.receipt:null;
  const [requestId]=useState(()=>receipt?.record.variants[0].requestId??createId());
  const retainedInput=receipt?.record.variants.at(-1);
  const initial:PaymentDraft=retainedInput?{amount:creditAmountInput(retainedInput.amountCents),date:retainedInput.date,method:retainedInput.method,reference:retainedInput.reference,notes:retainedInput.notes}:{amount:'',date:todayIso(),method:'Virement bancaire',reference:'',notes:''};
  const persisted=useFormDraft({scope,initial,fingerprint:formDraftFingerprint({invoiceId,status:invoice?.status,balance,bankAccountId:bank?.id??null,enabled:workspace.accountingSettings?.enabled}),validate:validPaymentDraft});
  const draft=persisted.value;
  // A retained financial request must be checked before editing or sending it.
  // Absence never retires its UUID: corrected versions still share that UUID.
  const [editable,setEditable]=useState(!receipt),[confirmed,setConfirmed]=useState(false);
  const writable=useRef(!readOnly);writable.current=!readOnly;
  const [review,setReview]=useState<string|null>(null),[problem,setProblem]=useState<PaymentProblem|null>(null),[serverError,setServerError]=useState(''),[pending,setPending]=useState(false);
  const flight=useRef(false),form=useRef<HTMLFormElement>(null);
  const sameOrigin=Boolean(scope&&scopeKey===originKey),waiting=Boolean(receipt&&!editable);
  const locked=busy||pending,disabled=locked||readOnly||confirmed||!sameOrigin||request.kind==='blocked'||waiting||Boolean(persisted.pending)||persisted.conflict||persisted.invalid,amount=creditAmount(draft.amount);
  const key=JSON.stringify([invoice?.status,invoice?.number,invoice?.issueDate,invoice?.currency,balance,bank,workspace.accountingSettings?.enabled,draft]);
  const changed=review!==null&&key!==review;
  const preview=balance!==null&&amount!==null&&amount>0&&amount<=balance;
  function focus(field:PaymentProblem['field']) {requestAnimationFrame(()=>{const target=form.current?.querySelector<HTMLElement>(`[name="${field}"]`)||form.current?.querySelector<HTMLElement>('.credit-allocation-alert');const disclosure=target?.closest('details');if(disclosure)disclosure.open=true;target?.focus({preventScroll:true});const anchor=target?.closest('.field')||target,body=form.current?.closest('.modal__body');if(anchor&&body)body.scrollTop+=anchor.getBoundingClientRect().top-body.getBoundingClientRect().top-12;});}
  function requireOrigin(){if(!alive.current||!scope||!originKey||origin.current!==originKey)throw Error('L’entreprise ou le compte ouvert a changé. Rouvrez le paiement dans son espace d’origine.');}
  function update(patch:Partial<PaymentDraft>){persisted.setValue(row=>({...row,...patch}));setProblem(null);setServerError('');}
  function showError(cause:unknown,fallback='Le paiement n’a pas pu être confirmé.'){if(!alive.current||origin.current!==originKey)return;const message=errorMessage(cause,fallback);setServerError(message);setProblem(paymentNativeProblem(message));focus('record');}
  function leave(){if(locked||flight.current)return;persisted.close(close);}
  async function inspect(current:PaymentReceipt):Promise<boolean>{
    requireOrigin();assertPaymentRequestCurrent(current,scope);
    const proof=await desktopApi.readPaymentRequest(current.record.variants,scope!.companyId);
    requireOrigin();assertPaymentRequestCurrent(current,scope);
    if(proof.status==='conflict')throw Error('Le paiement conservé ne correspond pas à son historique comptable. Consultez la facture avant de continuer ; aucun paiement ne sera renvoyé.');
    const next=await onReadWorkspace();requireOrigin();
    if(!confirmPaymentRequest(current,scope,next,proof)){setEditable(true);setReview(null);return false;}
    // The workspace has already been published by onReadWorkspace. Clear only
    // this exact receipt after both native and fresh accounting proofs agree.
    // Retire the editable draft first: a failed receipt cleanup must never
    // leave the already-confirmed amount as a reusable draft after restart.
    setConfirmed(true);
    if(!persisted.complete(true))throw Error('Le paiement est confirmé, mais son brouillon local ne peut pas être retiré. Sa demande de reprise reste conservée. Vérifiez le stockage de cet appareil puis vérifiez de nouveau l’enregistrement.');
    clearConfirmedPaymentRequest(current,scope,next,proof);
    const recorded=current.record.variants[proof.status==='recorded'?proof.variantIndex:0];
    const message=`Paiement reçu confirmé : ${formatMoney(recorded.amountCents,invoice?.currency)}. Le solde et la comptabilité sont actualisés.`;
    const published=await act(async()=>next,message,true);
    if(!published&&alive.current&&origin.current===originKey)close();
    return true;
  }
  async function refresh(){
    if(flight.current||locked)return;flight.current=true;setPending(true);
    try{
      requireOrigin();
      const latest=readPaymentRequest(scope,invoiceId);setRequest(latest);
      if(latest.kind==='blocked')throw Error(latest.message);
      if(latest.kind==='pending'){setEditable(false);if(await inspect(latest.receipt))return;}
      else{requirePaymentWorkspace(await onReadWorkspace());requireOrigin();}
      setProblem(null);setServerError('');
    }catch(cause){showError(cause,'La lecture des factures est interrompue. Votre saisie reste conservée. Réessayez la vérification.');}
    finally{flight.current=false;if(alive.current&&origin.current===originKey)setPending(false);}
  }
  async function submit(){
    if(flight.current||disabled)return;
    const issue=paymentProblem(invoice,workspace,draft,todayIso());
    if(issue){setReview(null);setProblem(issue);setServerError('');focus(issue.field);return;}
    if(review===null||changed){setReview(key);setProblem(null);setServerError('');requestAnimationFrame(()=>{form.current?.closest('.modal__body')?.scrollTo({top:0});form.current?.querySelector<HTMLElement>('.credit-allocation-review')?.focus({preventScroll:true});});return;}
    if(balance===null||!bank||!amount)return;
    flight.current=true;setPending(true);
    try{
      requireOrigin();
      if(receipt){assertPaymentRequestCurrent(receipt,scope);if(await inspect(receipt))return;}
      if(!writable.current)throw Error('Votre accès est en lecture seule. Le paiement reste conservé ; aucun enregistrement ne sera envoyé.');
      const input={requestId:receipt?.record.variants[0].requestId??requestId,invoiceId,amountCents:amount,date:draft.date,method:draft.method.trim(),reference:draft.reference.trim(),notes:draft.notes.trim(),expectedReview:{balanceCents:balance,bankAccountId:bank.id}};
      const current=receipt?extendPaymentRequest(receipt,scope,input):createPaymentReceipt(scope,input);
      retainPaymentRequest(current,scope);requireOrigin();
      setRequest({kind:'pending',receipt:current});setEditable(false);setProblem(null);setServerError('');
      let writeCause:unknown;
      try{requireOrigin();if(!writable.current)throw Error('Votre accès est en lecture seule.');await desktopApi.writePaymentRequest(invoiceId,input,scope!.companyId);}catch(cause){writeCause=cause;}
      requireOrigin();
      if(await inspect(current))return;
      if(writeCause!==undefined)showError(writeCause);
      else showError(Error('La demande reste conservée, mais son enregistrement ne figure pas dans les données relues. Vérifiez de nouveau avant de continuer.'));
    }catch(cause){showError(cause);}
    finally{flight.current=false;if(alive.current&&origin.current===originKey)setPending(false);}
  }
  return <Modal title="Enregistrer un paiement" description={`${invoice?.number||'Facture'} · ${workspace.clients.find(row=>row.id===invoice?.clientId)?.name||''}`} className="credit-allocation-modal" onClose={leave} dismissible={!locked}>
    <form ref={form} noValidate onSubmit={event=>{event.preventDefault();void submit();}}>
      {!sameOrigin&&<p role="alert" className="credit-allocation-notice">Rouvrez ce paiement dans son entreprise et son compte d’origine.</p>}
      {request.kind==='blocked'&&<p role="alert" className="credit-allocation-notice">{request.message}</p>}
      {confirmed&&<p role="status" className="credit-allocation-notice">Ce paiement est confirmé. Consultez son historique avant de préparer un autre encaissement.</p>}
      {waiting?<section className="credit-allocation-review" tabIndex={-1}><h3>Retrouver le paiement</h3><p>{formatMoney(retainedInput!.amountCents,invoice?.currency)} · {formatDate(retainedInput!.date)} · {retainedInput!.method}</p><p>Une demande est conservée sur cet appareil. Vérifiez son enregistrement avant de la reprendre.</p></section>:<>
      <FormDraftNotice draft={{...persisted,restore:()=>{persisted.restore();setReview(null);setProblem(null);setServerError('');focus('amount');}}} disabled={locked} />
      {receipt&&<p className="credit-allocation-notice">Aucun paiement confirmé dans les données relues. Vous pouvez corriger cette demande ; son identifiant de reprise est conservé.</p>}
      <ol className="credit-allocation-steps" aria-label="Étapes"><li aria-current={review===null?'step':undefined}>1 · Paiement reçu</li><li aria-current={review!==null?'step':undefined}>2 · Vérifier</li></ol>
      {review===null?<>
        <p className="credit-allocation-explanation">Recopiez l’argent réellement reçu du client. Un paiement partiel suffit : le reste demeure à encaisser. Cette action enregistre le paiement et n’envoie aucun virement.</p>
        <fieldset className="credit-allocation-fields" disabled={disabled}>
          <Field label={`Montant encaissé (${invoice?.currency||'CHF'})`} required error={problem?.field==='amount'?problem.message:undefined} hint="Recopiez le montant du relevé. Exemple : 125,50."><input name="amount" inputMode="decimal" value={draft.amount} onChange={event=>update({amount:event.target.value})}/></Field>
          {balance!==null&&balance>0&&<Button type="button" variant="secondary" onClick={()=>update({amount:creditAmountInput(balance)})}>Tout le solde est reçu · {formatMoney(balance,invoice?.currency)}</Button>}
          <Field label="Date de réception" required error={problem?.field==='date'?problem.message:undefined} hint="Le jour où l’argent a été reçu, au plus tard aujourd’hui."><input name="date" type="date" min={invoice?.issueDate} max={todayIso()} value={draft.date} onChange={event=>update({date:event.target.value})}/></Field>
          <Field label="Mode de paiement" required error={problem?.field==='method'?problem.message:undefined} hint="Ce libellé décrit le paiement. Le compte utilisé est affiché ci-dessous."><input name="method" list="invoice-payment-methods" maxLength={80} value={draft.method} onChange={event=>update({method:event.target.value})}/><datalist id="invoice-payment-methods"><option value="Virement bancaire"/><option value="Carte bancaire"/><option value="TWINT"/></datalist></Field>
          <details><summary>Référence et note · facultatif</summary><div className="credit-allocation-fields">
            <Field label="Référence" error={problem?.field==='reference'?problem.message:undefined}><input name="reference" maxLength={160} value={draft.reference} onChange={event=>update({reference:event.target.value})}/></Field>
            <Field label="Note" error={problem?.field==='notes'?problem.message:undefined}><textarea name="notes" rows={3} maxLength={5000} value={draft.notes} onChange={event=>update({notes:event.target.value})}/></Field>
          </div></details>
        </fieldset>
      </>:<section className="credit-allocation-review" tabIndex={-1}><h3>Vérifiez le paiement reçu</h3><p>{formatDate(draft.date)} · {draft.method}</p>{changed&&<p role="alert" className="credit-allocation-notice">La facture ou le compte a changé. Relisez le paiement, puis reprenez la vérification.</p>}</section>}
      <div className="credit-allocation-balances"><div><span>Reste à encaisser</span><strong>{balance===null?'À vérifier':formatMoney(balance,invoice?.currency)}</strong>{preview&&<small>Après : {formatMoney(balance!-amount!,invoice?.currency)}</small>}</div><div><span>Compte d’encaissement</span><strong>{bank?`${bank.code} · ${bank.name}`:'À configurer'}</strong>{preview&&<small>Paiement reçu : +{formatMoney(amount!,invoice?.currency)}</small>}</div></div>
      {review!==null&&(draft.reference||draft.notes)&&<details><summary>Référence et note</summary>{draft.reference&&<p className="credit-allocation-reason">{draft.reference}</p>}{draft.notes&&<p className="credit-allocation-reason">{draft.notes}</p>}</details>}
      </>}
      {problem?.field==='record'&&<div className="credit-allocation-alert" role="alert" tabIndex={-1}><strong>Vérifions ce point</strong><p>{problem.message}</p>{serverError&&<ErrorDetails error={serverError} />}{problem.accounting&&<><p>Retrouvez ensuite cette facture pour préparer à nouveau le paiement.</p><Button type="button" variant="secondary" disabled={locked} onClick={()=>onOpenAccounting(problem.section??'accounts')}>Ouvrir la comptabilité</Button></>}</div>}
      {(!workspace.accountingSettings?.enabled||!bank?.active||bank.accountType!=='asset')&&!problem?.accounting&&<div className="credit-allocation-alert"><p>Un compte d’encaissement doit être configuré. Retrouvez ensuite cette facture pour préparer à nouveau le paiement.</p><Button type="button" variant="secondary" disabled={locked} onClick={()=>onOpenAccounting('accounts')}>Configurer la comptabilité</Button></div>}
      {!waiting&&<Button type="button" variant="ghost" disabled={locked||!sameOrigin} onClick={()=>void refresh()}>{request.kind==='blocked'?'Relire la demande conservée':'Actualiser les factures'}</Button>}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={()=>review!==null&&!waiting?setReview(null):leave()}>{waiting?'Fermer':review!==null?'Modifier':'Annuler'}</Button>{waiting?<Button key="inspect-payment" type="button" disabled={locked||!sameOrigin} onClick={event=>{event.preventDefault();void refresh();}}>{pending?'Vérification…':'Vérifier l’enregistrement'}</Button>:<Button key="submit-payment" type="submit" disabled={disabled}>{pending?'Vérification…':review===null?'Vérifier le paiement':changed?'Reprendre la vérification':'Enregistrer le paiement'}</Button>}</div>
    </form>
  </Modal>;
}

import { useRef, useState } from 'react';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney, invoiceOpenBalance, todayIso } from './utils';
import { creditAmount, creditAmountInput } from './creditAllocationWorkflow';
import { paymentNativeProblem, paymentProblem, requirePaymentWorkspace, type PaymentDraft, type PaymentProblem } from './paymentWorkflow';
import './credit-allocation.css';

export function PaymentForm({ invoiceId, workspace, busy, readOnly, close, act, onReadWorkspace, onOpenAccounting }: {
  invoiceId:string; workspace:Workspace; busy:boolean; readOnly:boolean; close:()=>void;
  act:(action:()=>Promise<Workspace>,message:string,close?:boolean,onError?:(reason:unknown)=>void)=>Promise<boolean>;
  onReadWorkspace:()=>Promise<Workspace>; onOpenAccounting:(section?:'accounts'|'periods')=>void;
}) {
  const invoice=workspace.invoices.find(row=>row.id===invoiceId);
  const balance=invoice?invoiceOpenBalance(invoice,workspace.invoices,workspace.payments):null;
  const bank=workspace.accounts.find(row=>row.id===workspace.accountingSettings?.bankAccountId);
  const [requestId]=useState(createId);
  const [draft,setDraft]=useState<PaymentDraft>({amount:'',date:todayIso(),method:'Virement bancaire',reference:'',notes:''});
  const [review,setReview]=useState<string|null>(null),[problem,setProblem]=useState<PaymentProblem|null>(null),[serverError,setServerError]=useState(''),[pending,setPending]=useState(false);
  const flight=useRef(false),form=useRef<HTMLFormElement>(null);
  const locked=busy||pending,disabled=locked||readOnly,amount=creditAmount(draft.amount);
  const key=JSON.stringify([invoice?.status,invoice?.number,invoice?.issueDate,invoice?.currency,balance,bank,workspace.accountingSettings?.enabled,draft]);
  const changed=review!==null&&key!==review;
  const preview=balance!==null&&amount!==null&&amount>0&&amount<=balance;
  function focus(field:PaymentProblem['field']) {requestAnimationFrame(()=>{const target=form.current?.querySelector<HTMLElement>(`[name="${field}"]`)||form.current?.querySelector<HTMLElement>('.credit-allocation-alert');const disclosure=target?.closest('details');if(disclosure)disclosure.open=true;target?.focus({preventScroll:true});const anchor=target?.closest('.field')||target,body=form.current?.closest('.modal__body');if(anchor&&body)body.scrollTop+=anchor.getBoundingClientRect().top-body.getBoundingClientRect().top-12;});}
  function update(patch:Partial<PaymentDraft>){setDraft(row=>({...row,...patch}));setProblem(null);setServerError('');}
  async function refresh(){if(flight.current||locked)return;flight.current=true;setPending(true);try{requirePaymentWorkspace(await onReadWorkspace());setProblem(null);setServerError('');}catch{setProblem({field:'record',message:'La lecture des factures est interrompue. Votre saisie est conservée. Réessayez l’actualisation.'});focus('record');}finally{flight.current=false;setPending(false);}}
  async function submit(){
    if(flight.current||disabled)return;
    const issue=paymentProblem(invoice,workspace,draft,todayIso());
    if(issue){setReview(null);setProblem(issue);setServerError('');focus(issue.field);return;}
    if(review===null||changed){setReview(key);setProblem(null);setServerError('');requestAnimationFrame(()=>{form.current?.closest('.modal__body')?.scrollTo({top:0});form.current?.querySelector<HTMLElement>('.credit-allocation-review')?.focus({preventScroll:true});});return;}
    if(balance===null||!bank||!amount)return;
    flight.current=true;setPending(true);
    try{await act(()=>desktopApi.addPayment(invoiceId,{requestId,amountCents:amount,date:draft.date,method:draft.method.trim(),reference:draft.reference.trim(),notes:draft.notes.trim(),expectedReview:{balanceCents:balance,bankAccountId:bank.id}}),'Le paiement reçu est enregistré. Le solde de la facture et la comptabilité sont actualisés.',true,cause=>{const message=errorMessage(cause,'Le paiement n’a pas pu être confirmé.');setServerError(message);setProblem(paymentNativeProblem(message));focus('record');});}
    finally{flight.current=false;setPending(false);}
  }
  return <Modal title="Enregistrer un paiement" description={`${invoice?.number||'Facture'} · ${workspace.clients.find(row=>row.id===invoice?.clientId)?.name||''}`} className="credit-allocation-modal" onClose={locked?()=>{}:close} dismissible={!locked}>
    <form ref={form} noValidate onSubmit={event=>{event.preventDefault();void submit();}}>
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
      {problem?.field==='record'&&<div className="credit-allocation-alert" role="alert" tabIndex={-1}><strong>Vérifions ce point</strong><p>{problem.message}</p>{serverError&&<details><summary>Voir le message détaillé</summary><p>{serverError}</p></details>}{problem.accounting&&<><p>Retrouvez ensuite cette facture pour préparer à nouveau le paiement.</p><Button type="button" variant="secondary" disabled={locked} onClick={()=>onOpenAccounting(problem.section??'accounts')}>Ouvrir la comptabilité</Button></>}</div>}
      {(!workspace.accountingSettings?.enabled||!bank?.active||bank.accountType!=='asset')&&!problem?.accounting&&<div className="credit-allocation-alert"><p>Un compte d’encaissement doit être configuré. Retrouvez ensuite cette facture pour préparer à nouveau le paiement.</p><Button type="button" variant="secondary" disabled={locked} onClick={()=>onOpenAccounting('accounts')}>Configurer la comptabilité</Button></div>}
      <Button type="button" variant="ghost" disabled={locked} onClick={()=>void refresh()}>Actualiser les factures</Button>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={()=>review!==null?setReview(null):close()}>{review!==null?'Modifier':'Annuler'}</Button><Button type="submit" disabled={disabled}>{pending?'Vérification…':review===null?'Vérifier le paiement':changed?'Reprendre la vérification':'Enregistrer le paiement'}</Button></div>
    </form>
  </Modal>;
}

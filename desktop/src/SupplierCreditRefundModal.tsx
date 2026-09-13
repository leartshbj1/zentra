import { useEffect, useRef, useState } from 'react';
import type { Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { formatDate, formatMoney, todayIso } from './utils';
import { creditAmount, creditAmountInput } from './creditAllocationWorkflow';
import { requireSupplierRefundWorkspace, supplierRefundAvailable, supplierRefundNativeProblem, supplierRefundProblem, type SupplierRefundDraft, type SupplierRefundProblem, type SupplierRefundReview } from './supplierRefundWorkflow';
import './credit-allocation.css';

export function SupplierCreditRefundModal({ creditId, refundId, workspace, busy, readOnly=false, actionError, onClose, onConfirm, onRefresh, onOpenHelp }: {
  creditId:string; refundId?:string; workspace:Workspace; busy:boolean; readOnly?:boolean; actionError:string;
  onClose:()=>void; onRefresh:()=>Promise<Workspace>; onOpenHelp:(destination:'accounts'|'periods'|'bank')=>void;
  onConfirm:(input:{date:string;amountCents:number;reference:string;reason:string;expectedReview:SupplierRefundReview})=>Promise<boolean>;
}) {
  const credit=workspace.supplierCreditNotes.find(row=>row.id===creditId);
  const original=credit?.refunds.find(row=>row.id===refundId), reversing=Boolean(refundId);
  const available=supplierRefundAvailable(credit);
  const [draft,setDraft]=useState<SupplierRefundDraft>(()=>({amount:original?creditAmountInput(original.amountCents):'',date:todayIso(),reference:original?.reference||'',reason:''}));
  const [review,setReview]=useState<string|null>(null),[problem,setProblem]=useState<SupplierRefundProblem|null>(null),[pending,setPending]=useState(false);
  const [showServerError,setShowServerError]=useState(Boolean(actionError));
  const form=useRef<HTMLFormElement>(null),flight=useRef(false);
  const locked=busy||pending, disabled=locked||readOnly;
  const amount=reversing?original?.amountCents:creditAmount(draft.amount);
  const bankId=reversing?original?.bankAccountId:workspace.accountingSettings?.bankAccountId;
  const bank=workspace.accounts.find(row=>row.id===bankId);
  const key=JSON.stringify([credit?.status,credit?.currency,credit?.documentDate,available,bank,workspace.accountingSettings?.enabled,original,credit?.refunds.filter(row=>row.reversesId===refundId),draft]);
  const changed=review!==null&&review!==key;
  const minimum=[credit?.documentDate||'',original?.date||''].sort().at(-1)!;
  const previewValid=available!==null&&amount&&Number.isSafeInteger(amount)&&amount>0&&(reversing?Number.isSafeInteger(available+amount):amount<=available);
  const serverProblem=showServerError&&actionError?supplierRefundNativeProblem(actionError):null;
  const help=problem?.field==='record'?problem:serverProblem;
  function focus(field:SupplierRefundProblem['field']) {
    requestAnimationFrame(()=>{const target=form.current?.querySelector<HTMLElement>(`[name="${field}"]`)||form.current?.querySelector<HTMLElement>('.credit-allocation-alert');target?.focus({preventScroll:true});const anchor=target?.closest('.field')||target,body=form.current?.closest('.modal__body');if(anchor&&body)body.scrollTop+=anchor.getBoundingClientRect().top-body.getBoundingClientRect().top-12;});
  }
  useEffect(()=>{setShowServerError(Boolean(actionError));if(actionError)focus('record');},[actionError]);
  function update(patch:Partial<SupplierRefundDraft>){setDraft(row=>({...row,...patch}));setProblem(null);}
  function explain(issue:SupplierRefundProblem){setProblem(issue);focus(issue.field);}
  async function refresh(){
    if(flight.current||locked)return;flight.current=true;setPending(true);
    try{requireSupplierRefundWorkspace(await onRefresh());setProblem(null);}catch{explain({field:'record',message:'La lecture des avoirs reste indisponible. Vos informations sont conservées ; réessayez l’actualisation.'});}
    finally{flight.current=false;setPending(false);}
  }
  async function submit(){
    if(flight.current||disabled)return;
    const issue=supplierRefundProblem(credit,original,reversing,draft,workspace,todayIso());
    if(issue){setReview(null);explain(issue);return;}
    if(review===null||changed){setReview(key);setProblem(null);setShowServerError(false);requestAnimationFrame(()=>{form.current?.closest('.modal__body')?.scrollTo({top:0});form.current?.querySelector<HTMLElement>('.credit-allocation-review')?.focus({preventScroll:true});});return;}
    if(available===null||!bankId||!amount)return;
    flight.current=true;setPending(true);setProblem(null);
    try{await onConfirm({date:draft.date,amountCents:amount,reference:reversing?original!.reference:draft.reference.trim(),reason:draft.reason.trim(),expectedReview:{availableCents:available,bankAccountId:bankId}});}
    finally{flight.current=false;setPending(false);}
  }
  return <Modal className="credit-allocation-modal supplier-refund-modal" title={reversing?'Corriger le remboursement':'Remboursement reçu'} description={`${credit?.supplierName||'Fournisseur'} · ${credit?.number||credit?.reference||'Avoir'}`} onClose={locked?()=>{}:onClose}>
    <form ref={form} noValidate onSubmit={event=>{event.preventDefault();void submit();}}>
      <ol className="credit-allocation-steps" aria-label="Étapes"><li aria-current={review===null?'step':undefined}>1 · {reversing?'Expliquer':'Virement reçu'}</li><li aria-current={review!==null?'step':undefined}>2 · Vérifier</li></ol>
      {review===null?<>
        <p className="credit-allocation-explanation">{reversing?'Cette correction annule l’écriture du remboursement et rend le montant disponible sur l’avoir. Le remboursement initial reste dans l’historique. Elle n’envoie aucun argent au fournisseur.':'Recopiez le virement que votre fournisseur a réellement versé sur votre compte. Si l’argent n’est pas encore arrivé, conservez simplement l’avoir.'}</p>
        <fieldset className="credit-allocation-fields" disabled={disabled}>
          <Field label="Montant reçu (CHF)" required error={problem?.field==='amount'?problem.message:undefined} hint={reversing?'Le montant du remboursement initial est conservé.':'Recopiez le montant du relevé, par exemple 125,50.'}><input name="amount" inputMode="decimal" value={draft.amount} readOnly={reversing} onChange={event=>update({amount:event.target.value})}/></Field>
          {!reversing&&available!==null&&available>0&&<Button type="button" variant="secondary" onClick={()=>update({amount:creditAmountInput(available)})}>Tout le solde a été reçu · {formatMoney(available)}</Button>}
          <Field label={reversing?'Date de correction':'Date de réception'} required error={problem?.field==='date'?problem.message:undefined} hint="Le jour réel de cette opération, au plus tard aujourd’hui."><input name="date" type="date" min={minimum} max={todayIso()} value={draft.date} onChange={event=>update({date:event.target.value})}/></Field>
          <Field label="Référence bancaire" required error={problem?.field==='reference'?problem.message:undefined} hint={reversing?'La référence d’origine est conservée.':'Recopiez une référence ou le libellé du virement sur votre relevé.'}><input name="reference" value={draft.reference} readOnly={reversing} maxLength={255} onChange={event=>update({reference:event.target.value})}/></Field>
          <Field label="Motif" required error={problem?.field==='reason'?problem.message:undefined} hint="Une courte explication suffit, de 5 à 1 000 caractères."><textarea name="reason" rows={3} maxLength={1000} value={draft.reason} onChange={event=>update({reason:event.target.value})}/></Field>
          <Button type="button" variant="ghost" onClick={()=>update({reason:reversing?'Erreur de saisie du remboursement':'Retour de marchandises remboursé'})}>{reversing?'Utiliser le motif « Erreur de saisie »':'Utiliser le motif « Retour de marchandises »'}</Button>
        </fieldset>
      </>:<section className="credit-allocation-review" tabIndex={-1}><h3>{reversing?'Vérifiez la correction':'Vérifiez le virement reçu'}</h3><p>{formatDate(draft.date)} · {reversing?original?.reference:draft.reference}</p><p className="credit-allocation-reason">{draft.reason}</p>{changed&&<p className="credit-allocation-notice" role="alert">L’avoir ou le compte bancaire a changé. Relisez les montants, puis reprenez la vérification.</p>}</section>}
      <div className="credit-allocation-balances"><div><span>{reversing?'Compte du remboursement initial':'Compte bancaire utilisé'}</span><strong>{bank?`${bank.code} · ${bank.name}`:'À configurer'}</strong>{previewValid&&<small>{reversing?'Écriture de correction : −':'Virement reçu : +'}{formatMoney(amount!)}</small>}</div><div><span>Disponible sur l’avoir</span><strong>{available===null?'À vérifier':formatMoney(available)}</strong>{previewValid&&<small>Après : {formatMoney(available!+(reversing?amount!:-amount!))}</small>}</div></div>
      {(!bank?.active||bank.accountType!=='asset'||!reversing&&!workspace.accountingSettings?.enabled)&&<Button type="button" variant="secondary" disabled={locked} onClick={()=>onOpenHelp('accounts')}>Configurer le compte bancaire</Button>}
      {help&&<div className="credit-allocation-alert" role="alert" tabIndex={-1}><strong>Vérifions ce point</strong><p>{help.message}</p>{serverProblem&&<details><summary>Voir le message détaillé</summary><p>{actionError}</p></details>}{help.destination&&<><p>Retrouvez ensuite cet avoir dans Achats → Factures et avoirs pour préparer à nouveau cette opération.</p><Button type="button" variant="secondary" disabled={locked} onClick={()=>onOpenHelp(help.destination!)}>{help.destination==='bank'?'Ouvrir Banque':help.destination==='periods'?'Ouvrir les exercices':'Ouvrir Plan & liaisons'}</Button></>}</div>}
      <Button type="button" variant="ghost" disabled={locked} onClick={()=>void refresh()}>Actualiser les avoirs</Button>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={()=>review!==null?setReview(null):onClose()}>{review!==null?'Modifier':'Retour'}</Button><Button type="submit" variant={reversing&&review!==null&&!changed?'danger':'primary'} disabled={disabled}>{pending?'Vérification…':review===null?'Vérifier le remboursement':changed?'Reprendre la vérification':reversing?'Confirmer la correction':'Enregistrer le virement'}</Button></div>
    </form>
  </Modal>;
}

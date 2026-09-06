import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FolderClock, RefreshCw } from 'lucide-react';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { supplierRefundAmount, supplierRefundDateError } from './supplierCreditRefunds';
import { clearCreditRecovery, definitiveRecoveryError, readCreditRecovery, saveCreditRecovery } from './customerCreditRecoveryState';
import type { CustomerCreditRecoveryPlan, PendingCreditRecovery } from './customerCreditRecoveryState';
import { revealInDialog } from './dialogFocus';
import './CustomerCreditRecovery.css';

type CreditDraft={choice:''|'available'|'applied';amount:string;date:string};
export function CustomerCreditRecovery({originalInvoiceId,busy,readOnly,act}: {
  originalInvoiceId:string;busy:boolean;readOnly:boolean;
  act:(action:()=>Promise<Workspace>,message:string,close?:boolean)=>Promise<boolean>;
}) {
  const [saved]=useState(()=>readCreditRecovery(originalInvoiceId));
  const [open,setOpen]=useState(Boolean(saved));
  const [plan,setPlan]=useState<CustomerCreditRecoveryPlan>();
  const [drafts,setDrafts]=useState<Record<string,CreditDraft>>({});
  const [reference,setReference]=useState(''); const [reason,setReason]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [review,setReview]=useState<PendingCreditRecovery|undefined>(saved);
  const [pending,setPending]=useState(Boolean(saved));
  const [completed,setCompleted]=useState(false);
  const [working,setWorking]=useState(false); const lock=useRef(false);
  const [error,setError]=useState(''); const [attempt,setAttempt]=useState(0);
  const heading=useRef<HTMLHeadingElement>(null);
  const root=useRef<HTMLElement>(null);
  const disabled=busy||working;
  useEffect(()=>{if(open)requestAnimationFrame(()=>revealInDialog(heading.current));},[open,review]);
  const load=async()=>{
    if(lock.current)return; lock.current=true;setWorking(true);setError('');setOpen(true);setAttempt(n=>n+1);
    try {
      const result=await desktopApi.getCustomerCreditRecovery(originalInvoiceId);setPlan(result);setReview(undefined);
      setDrafts(previous=>Object.fromEntries(result.credits.map(c=>[c.id,previous[c.id]??{choice:'',amount:'',date:''}])));
    }catch(cause){setError(errorMessage(cause,'Le dossier de reprise ne peut pas être chargé.'));}
    finally{setWorking(false);lock.current=false;}
  };
  const close=()=>{setOpen(false);requestAnimationFrame(()=>root.current?.querySelector('button')?.focus());};
  const update=(id:string,patch:Partial<CreditDraft>)=>setDrafts(previous=>({...previous,[id]:{...previous[id],...patch}}));
  const appliedTotal=plan?.credits.reduce((sum,c)=>sum+(drafts[c.id]?.choice==='applied'?(supplierRefundAmount(drafts[c.id].amount)??0):0),0)??0;
  const exceedsInvoice=Boolean(plan&&appliedTotal>plan.invoiceTotalCents-plan.paidCents);
  const valid=Boolean(plan&&!plan.blocker&&!exceedsInvoice&&reference.trim()&&reference.trim().length<=255&&reason.trim().length>=5&&reason.trim().length<=1000&&confirmed
    &&plan.credits.every(c=>{
      const d=drafts[c.id];if(d?.choice==='available')return true;
      const amount=supplierRefundAmount(d?.amount??'');
      return d?.choice==='applied'&&amount!==null&&amount>0&&amount<=c.totalCents&&d.date&&!supplierRefundDateError(d.date,c.earliestApplicationDate,todayIso());
    }));
  const preview=async()=>{
    if(disabled||readOnly||lock.current||!valid||!plan)return;
    lock.current=true;setWorking(true);setError('');setAttempt(n=>n+1);
    const input={requestId:createId(),originalInvoiceId,sourceToken:plan.sourceToken,reference:reference.trim(),reason:reason.trim(),noPriorRefund:confirmed,
      credits:plan.credits.map(c=>{const d=drafts[c.id];return {creditNoteId:c.id,appliedCents:d.choice==='available'?0:supplierRefundAmount(d.amount)!,applicationDate:d.choice==='available'?null:d.date};})};
    try{setReview({input,preview:await desktopApi.previewCustomerCreditRecovery(input)});}
    catch(cause){setError(errorMessage(cause,'La simulation de reprise a échoué.'));}
    finally{setWorking(false);lock.current=false;}
  };
  const commit=async()=>{
    if(disabled||readOnly||lock.current||!review)return;
    try{saveCreditRecovery(review);}catch{setError('La demande ne peut pas être conservée. Libérez du stockage local avant de continuer.');return;}
    lock.current=true;setWorking(true);setError('');setAttempt(n=>n+1);
    try {
      const success=await act(async()=>{
        try{return await desktopApi.adoptCustomerCreditRecovery(review.input);}
        catch(cause){
          const message=errorMessage(cause,'Le résultat de la reprise n’a pas pu être confirmé.');
          const rejected=definitiveRecoveryError(message);setPending(!rejected);
          if(rejected)clearCreditRecovery(originalInvoiceId);
          setError(message);throw cause;
        }
      },'Les avoirs et leurs règlements documentés sont reliés au dossier.',false);
      if(success){
        const panel=root.current?.closest('.customer-credit-panel');
        clearCreditRecovery(originalInvoiceId);setPending(false);setReview(undefined);setCompleted(true);
        requestAnimationFrame(()=>revealInDialog(panel?.querySelector<HTMLElement>('.customer-credit-card__heading')??null));
      }
    }finally{setWorking(false);lock.current=false;}
  };
  if(completed)return null;
  return <article ref={root} className="credit-recovery" aria-label="Reprise des avoirs historiques">
    {!open ? <div className="credit-recovery__intro"><FolderClock size={22}/><div><strong>Compléter l’historique des avoirs</strong><p>Précisez les déductions déjà effectuées et les montants encore disponibles, pour tous les avoirs de cette facture.</p></div><Button variant="secondary" disabled={disabled} onClick={()=>{if(review){setOpen(true);}else void load();}}>{pending?'Reprendre la vérification':'Documenter les règlements'}</Button></div>
    : <div className="credit-recovery__body">
      <div className="credit-recovery__top"><span className="credit-recovery__eyebrow"><FolderClock size={16}/>Reprise du dossier</span><Button variant="ghost" size="small" disabled={disabled} onClick={close}>Fermer</Button></div>
      <ol className="credit-recovery__steps" aria-label="Étapes de la reprise"><li aria-current={!review?'step':undefined}><span>{review?<Check size={14}/>:1}</span>Documenter</li><li aria-current={review?'step':undefined}><span>2</span>Vérifier</li></ol>
      <h4 ref={heading} tabIndex={-1}>{review?'Vérifier les soldes après reprise':`Documenter les avoirs${plan?` · ${plan.number}`:''}`}</h4>
      {working&&!review&&!plan&&<p role="status">Chargement des documents…</p>}
      {!review&&plan?.blocker&&<div className="credit-recovery__notice"><strong>Rapprochement nécessaire</strong><p>{plan.blocker}</p></div>}
      {!review&&plan&&!plan.blocker&&<form onSubmit={e=>{e.preventDefault();void preview();}}>
        <p>Pour chaque avoir, indiquez ce qui a été déduit de {plan.number}. Le reste deviendra disponible pour une future déduction ou un remboursement.</p>
        <div className="credit-recovery__invoice"><span>Total facturé <strong>{formatMoney(plan.invoiceTotalCents,plan.currency)}</strong></span><span>Paiements enregistrés <strong>{formatMoney(plan.paidCents,plan.currency)}</strong></span></div>
        <fieldset disabled={disabled||readOnly}>
          {plan.credits.map(c=>{const d=drafts[c.id]??{choice:'',amount:'',date:''};
            const amount=supplierRefundAmount(d.amount);
            const amountError=d.amount?(amount===null?'Saisissez un montant positif avec au plus deux décimales.':amount>c.totalCents?`Cet avoir permet de déduire au maximum ${formatMoney(c.totalCents,plan.currency)}.`:undefined):undefined;
            const dateError=d.date?(d.date<c.earliestApplicationDate?'Cette date nécessite un rapprochement des opérations antérieures. Conservez la date réelle.':supplierRefundDateError(d.date,c.earliestApplicationDate,todayIso())||undefined):undefined;
            return <section className="credit-recovery__document" key={c.id} aria-label={`Reprise ${c.number}`}>
            <header><div><strong>{c.number}</strong><span>Émis le {formatDate(c.issueDate)}</span></div><strong>{formatMoney(c.totalCents,plan.currency)}</strong></header>
            <Field label={`Traitement de ${c.number}`} required wide><select required value={d.choice} onChange={e=>update(c.id,{choice:e.target.value as CreditDraft['choice']})}><option value="">Choisir le traitement</option><option value="available">Entièrement disponible</option><option value="applied">Déduit en tout ou en partie de cette facture</option></select></Field>
            {d.choice==='applied'&&<div className="form-grid"><Field label={`Montant déduit · ${c.number} (${plan.currency})`} required error={amountError}><input inputMode="decimal" value={d.amount} onChange={e=>update(c.id,{amount:e.target.value})} required aria-invalid={Boolean(amountError)}/></Field><Field label={`Date de déduction · ${c.number}`} required error={dateError}><input type="date" min={c.earliestApplicationDate} max={todayIso()} required value={d.date} onChange={e=>update(c.id,{date:e.target.value})} aria-invalid={Boolean(dateError)}/></Field><p className="credit-recovery__date-hint">Indiquez la date réelle. Si elle précède le {formatDate(c.earliestApplicationDate)}, un rapprochement des opérations antérieures est nécessaire.</p></div>}
          </section>;})}
          <div className="form-grid"><Field label="Référence du rapprochement" required><input value={reference} maxLength={255} onChange={e=>setReference(e.target.value)} required placeholder="Courriel, relevé ou accord client"/></Field><Field label="Motif de la reprise" required><textarea value={reason} minLength={5} maxLength={1000} onChange={e=>setReason(e.target.value)} required/></Field></div>
          <label className="credit-recovery__confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} required/><span>Je confirme qu’aucun remboursement ni déduction sur une autre facture n’a déjà été effectué, et que les déductions indiquées sont complètes.</span></label>
        </fieldset>
        {exceedsInvoice&&<p role="alert">Les déductions dépassent le solde de la facture, qui est de {formatMoney(Math.max(0,plan.invoiceTotalCents-plan.paidCents),plan.currency)}. Vérifiez les montants déjà imputés.</p>}
        <div className="form-actions"><Button type="submit" disabled={disabled||readOnly||!valid}>Vérifier la reprise<ArrowRight size={16}/></Button></div>
      </form>}
      {review&&<div className="credit-recovery__review">
        <div className="credit-recovery__balance"><span>Reste à régler sur {review.preview.number}</span><strong>{formatMoney(review.preview.invoiceRemainingCents,review.preview.currency)}</strong></div>
        <ul>{review.preview.credits.map(c=><li key={c.creditNoteId}><strong>{c.number}</strong><span>Déduit <b>{formatMoney(c.allocatedCents,review.preview.currency)}</b></span><span>Disponible <b>{formatMoney(c.remainingCents,review.preview.currency)}</b></span>{review.input.credits.find(i=>i.creditNoteId===c.creditNoteId)?.applicationDate&&<small>Déduction du {formatDate(review.input.credits.find(i=>i.creditNoteId===c.creditNoteId)!.applicationDate!)}</small>}</li>)}</ul>
        <p><strong>{review.input.reference}</strong><br/>{review.input.reason}</p>
        <p>La reprise conserve les documents émis et leur TVA. Elle n’enregistre aucun virement. Les déductions confirmées apparaîtront dans l’historique et le solde disponible pourra ensuite être utilisé.</p>
        {pending&&<p className="credit-recovery__notice" role="status">La réponse précédente a été interrompue. Vérifiez cette même demande pour retrouver son résultat sans créer une seconde reprise.</p>}
        <div className="form-actions">{!pending&&<Button variant="secondary" disabled={disabled} onClick={()=>{if(plan)setReview(undefined);else void load();}}><ArrowLeft size={16}/>Modifier</Button>}<Button disabled={disabled||readOnly} onClick={()=>void commit()}>{pending?'Vérifier la même reprise':'Confirmer la reprise'}<Check size={16}/></Button></div>
      </div>}
      {error&&<ErrorPanel key={attempt} message={error} reveal/>}
      {!pending&&!review&&<Button variant="ghost" disabled={disabled} onClick={()=>void load()}><RefreshCw size={15}/>Actualiser le dossier</Button>}
      {readOnly&&<p>La reprise est consultable. Son enregistrement nécessite un accès en écriture.</p>}
    </div>}
  </article>;
}

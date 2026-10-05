import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {t,useAppLanguage} from './language';
import {useVerifiedFormDraftScope} from './useFormDraft';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';
import { ArrowLeft, ArrowRight, Check, FolderClock, RefreshCw } from 'lucide-react';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { supplierRefundAmount, supplierRefundDateError } from './supplierCreditRefunds';
import { clearCreditRecovery, definitiveRecoveryError, readCreditRecovery, saveCreditRecovery,creditRecoveryScopeKey,legacyCreditRecoveryReviewRequired,legacyCreditRecoveryToken,adoptLegacyCreditRecovery,acknowledgeLegacyCreditRecoveryOtherCompany,completeLegacyCreditRecovery,requireCreditRecoveryAdmission,CreditRecoveryPendingConflictError } from './customerCreditRecoveryState';
import type { CustomerCreditRecoveryPlan, PendingCreditRecovery } from './customerCreditRecoveryState';
import { revealInDialog } from './dialogFocus';
import './CustomerCreditRecovery.css';

type CreditDraft={choice:''|'available'|'applied';amount:string;date:string};
const recoveryCopy={
 fr:{title:'Une ancienne reprise doit être vérifiée',explanation:'Son entreprise d’origine n’a pas été conservée. Relisez l’historique dans la bonne entreprise, puis choisissez ; rien ne sera renvoyé automatiquement.',history:'Vérifier l’historique',here:'Cette reprise concerne cette entreprise',elsewhere:'Cette reprise concerne une autre entreprise',confirmOther:'Autoriser une nouvelle saisie uniquement dans cette entreprise ? L’ancienne reprise restera conservée sans être renvoyée.',resume:'Reprendre la même reprise',check:'Vérifier la même reprise',checked:'L’historique actuel a été relu. Si la reprise reste à confirmer, renvoyez uniquement cette même demande ; son identifiant est conservé.'},
 de:{title:'Ein früherer Antrag muss geprüft werden',explanation:'Das zugehörige Unternehmen wurde nicht gespeichert. Lesen Sie den Verlauf im richtigen Unternehmen und wählen Sie dann; nichts wird automatisch erneut gesendet.',history:'Verlauf prüfen',here:'Dieser Antrag gehört zu diesem Unternehmen',elsewhere:'Dieser Antrag gehört zu einem anderen Unternehmen',confirmOther:'Eine neue Eingabe nur in diesem Unternehmen erlauben? Der frühere Antrag bleibt gespeichert und wird nicht erneut gesendet.',resume:'Denselben Antrag fortsetzen',check:'Denselben Antrag prüfen',checked:'Der aktuelle Verlauf wurde gelesen. Falls der Antrag noch bestätigt werden muss, senden Sie nur denselben Antrag erneut; seine Kennung bleibt erhalten.'},
 it:{title:'Una precedente richiesta deve essere verificata',explanation:'L’azienda di origine non è stata conservata. Rileggete la cronologia nell’azienda corretta, poi scegliete; nulla verrà reinviato automaticamente.',history:'Verificare la cronologia',here:'Questa richiesta riguarda questa azienda',elsewhere:'Questa richiesta riguarda un’altra azienda',confirmOther:'Consentire una nuova compilazione solo in questa azienda? La richiesta precedente resterà conservata senza essere reinviata.',resume:'Riprendere la stessa richiesta',check:'Verificare la stessa richiesta',checked:'La cronologia attuale è stata riletta. Se la richiesta resta da confermare, reinviate soltanto la stessa richiesta; il suo identificativo viene conservato.'},
 en:{title:'A previous request needs to be checked',explanation:'Its original company was not saved. Read the history in the correct company, then choose; nothing will be sent again automatically.',history:'Check the history',here:'This request belongs to this company',elsewhere:'This request belongs to another company',confirmOther:'Allow a new entry only in this company? The previous request will remain saved without being sent again.',resume:'Resume the same request',check:'Check the same request',checked:'The current history has been read. If the request still needs confirmation, send only this same request again; its identifier is preserved.'},
};
export function CustomerCreditRecovery({originalInvoiceId,workspace,busy,readOnly,act,onReadWorkspace}: {
  originalInvoiceId:string;workspace?:Workspace;busy:boolean;readOnly:boolean;onReadWorkspace?:()=>Promise<Workspace>;
  act:(action:()=>Promise<Workspace>,message:string,close?:boolean,onError?:(reason:unknown)=>void,validateRead?:(next:Workspace)=>void)=>Promise<boolean>;
}) {
  const requestScope=useVerifiedFormDraftScope(workspace,'customer-credit-recovery',originalInvoiceId);
  const originScope=useRef(requestScope).current,originKey=useRef(creditRecoveryScopeKey(requestScope)).current;
  const current=useRef({key:creditRecoveryScopeKey(requestScope),readOnly}),alive=useRef(false);
  useLayoutEffect(()=>{current.current={key:creditRecoveryScopeKey(requestScope),readOnly};},[requestScope?.companyId,requestScope?.organizationId,requestScope?.memberId,readOnly]);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const isCurrent=()=>alive.current&&Boolean(originKey)&&current.current.key===originKey;
  const requireCurrent=()=>{if(!isCurrent())throw Error('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');};
  const validateRead=(next:Workspace)=>{requireCurrent();if(next.workNotesScope!==originScope?.companyId)throw Error('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');};
  const [saved]=useState(()=>readCreditRecovery(originalInvoiceId,originScope));
  const [legacyBlocked,setLegacyBlocked]=useState(()=>!saved&&legacyCreditRecoveryReviewRequired(originalInvoiceId,originScope)),[legacyChecked,setLegacyChecked]=useState(false),[historyChecked,setHistoryChecked]=useState(false);
  const legacyReviewed=useRef<string|null>(null);
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
  const copy=recoveryCopy[useAppLanguage()];
  const disabled=busy||working||!originKey||creditRecoveryScopeKey(requestScope)!==originKey;
  const [pendingConflict,setPendingConflict]=useState(false);
  const admitLocal=()=>{
    if(legacyCreditRecoveryReviewRequired(originalInvoiceId,originScope)){setLegacyBlocked(true);setLegacyChecked(false);legacyReviewed.current=null;return false;}
    try{requireCreditRecoveryAdmission(originalInvoiceId,originScope,review);setPendingConflict(false);return true;}
    catch(cause){if(cause instanceof CreditRecoveryPendingConflictError)setPendingConflict(true);else setError(errorMessage(cause,'La demande ne peut pas être conservée. Libérez du stockage local avant de continuer.'));return false;}
  };
  useEffect(()=>{const check=()=>{if(isCurrent())admitLocal();};window.addEventListener('storage',check);return()=>window.removeEventListener('storage',check);},[originKey,review]);
  const reviewing=Boolean(review);
  useEffect(()=>{if(open)requestAnimationFrame(()=>revealInDialog(heading.current));},[open,reviewing]);
  const load=async()=>{
    if(!isCurrent()||legacyBlocked||lock.current||!admitLocal())return; lock.current=true;setWorking(true);setError('');setOpen(true);setAttempt(n=>n+1);
    try {
      const result=await desktopApi.getCustomerCreditRecovery(originalInvoiceId,originScope?.companyId);if(!isCurrent())return;setPlan(result);setReview(undefined);
      setDrafts(previous=>Object.fromEntries(result.credits.map(c=>[c.id,previous[c.id]??{choice:'',amount:'',date:''}])));
    }catch(cause){if(isCurrent())setError(errorMessage(cause,'Le dossier de reprise ne peut pas être chargé.'));}
    finally{lock.current=false;if(isCurrent())setWorking(false);}
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
    if(!isCurrent()||legacyBlocked||disabled||readOnly||lock.current||!valid||!plan||!admitLocal())return;
    lock.current=true;setWorking(true);setError('');setAttempt(n=>n+1);
    const input={requestId:createId(),originalInvoiceId,sourceToken:plan.sourceToken,reference:reference.trim(),reason:reason.trim(),noPriorRefund:confirmed,
      credits:plan.credits.map(c=>{const d=drafts[c.id];return {creditNoteId:c.id,appliedCents:d.choice==='available'?0:supplierRefundAmount(d.amount)!,applicationDate:d.choice==='available'?null:d.date};})};
    try{const result=await desktopApi.previewCustomerCreditRecovery(input,originScope?.companyId);if(isCurrent())setReview({input,preview:result});}
    catch(cause){if(isCurrent())setError(errorMessage(cause,'La simulation de reprise a échoué.'));}
    finally{lock.current=false;if(isCurrent())setWorking(false);}
  };
  const commit=async()=>{
    if(!isCurrent()||legacyBlocked||disabled||readOnly||current.current.readOnly||lock.current||!review||pending&&!historyChecked||(review.preview.receivedVat&&!review.input.confirmVatReconciliation)||!admitLocal())return;
    try{saveCreditRecovery(review,originScope);}catch{setError('La demande ne peut pas être conservée. Libérez du stockage local avant de continuer.');return;}
    lock.current=true;setWorking(true);setError('');setAttempt(n=>n+1);setHistoryChecked(false);
    try {
      const success=await act(async()=>{requireCurrent();if(current.current.readOnly)throw Error('Cette entreprise est en lecture seule.');return desktopApi.adoptCustomerCreditRecovery(review.input,originScope?.companyId);},t('Les avoirs et leurs règlements documentés sont reliés au dossier.'),false,cause=>{
        if(!isCurrent())return;const message=errorMessage(cause,'Le résultat de la reprise n’a pas pu être confirmé.');const rejected=!(cause instanceof WorkspaceRefreshAfterMutationError)&&definitiveRecoveryError(message);setPending(!rejected);if(rejected)clearCreditRecovery(originalInvoiceId,originScope,review);setError(message);
      },validateRead);
      if(isCurrent()&&success){
        const panel=root.current?.closest('.customer-credit-panel');
        completeLegacyCreditRecovery(originalInvoiceId,originScope,review);clearCreditRecovery(originalInvoiceId,originScope,review);setPending(false);setReview(undefined);setCompleted(true);
        requestAnimationFrame(()=>revealInDialog(panel?.querySelector<HTMLElement>('.customer-credit-card__heading')??null));
      }
    }finally{lock.current=false;if(isCurrent())setWorking(false);}
  };
  const checkHistory=async()=>{
    if(!isCurrent()||disabled||lock.current||!onReadWorkspace)return;lock.current=true;setWorking(true);setHistoryChecked(false);setLegacyChecked(false);legacyReviewed.current=null;setError('');
    try{const next=await onReadWorkspace();if(!isCurrent())return;validateRead(next);if(legacyCreditRecoveryReviewRequired(originalInvoiceId,originScope)){setLegacyBlocked(true);legacyReviewed.current=legacyCreditRecoveryToken(originalInvoiceId);setLegacyChecked(legacyReviewed.current!==null);}else if(admitLocal())setHistoryChecked(true);}
    catch(cause){if(isCurrent())setError(errorMessage(cause,'L’historique ne peut pas être relu. La demande reste conservée.'));}
    finally{lock.current=false;if(isCurrent())setWorking(false);}
  };
  const chooseLegacy=(here:boolean)=>{
    if(!isCurrent()||disabled||readOnly||current.current.readOnly||!legacyChecked||legacyReviewed.current===null)return;
    try{if(here){const retained=adoptLegacyCreditRecovery(originalInvoiceId,originScope,legacyReviewed.current);setReview(retained);setPending(true);setOpen(true);setHistoryChecked(false);setLegacyBlocked(false);}else if(window.confirm(copy.confirmOther)){acknowledgeLegacyCreditRecoveryOtherCompany(originalInvoiceId,originScope,legacyReviewed.current);setLegacyBlocked(false);}setError('');}
    catch(cause){setLegacyChecked(false);if(cause instanceof CreditRecoveryPendingConflictError)setPendingConflict(true);else setError(errorMessage(cause,'La vérification ne peut pas être conservée.'));}
  };
  const conflictMessage={fr:'Une autre demande attend une vérification dans cette entreprise. Fermez ce dossier, puis rouvrez-le pour relire cette demande. Rien n’a été remplacé ni renvoyé.',de:'Ein anderer Antrag wartet in diesem Unternehmen auf Prüfung. Schließen Sie dieses Dossier und öffnen Sie es erneut, um den Antrag zu lesen. Nichts wurde ersetzt oder erneut gesendet.',it:'Un’altra richiesta attende verifica in questa azienda. Chiudete questo dossier e riapritelo per rileggere la richiesta. Nulla è stato sostituito o reinviato.',en:'Another request needs to be checked in this company. Close this file and reopen it to read that request. Nothing was replaced or sent again.'}[useAppLanguage()];
  if(completed)return null;
  if(legacyBlocked)return <article ref={root} className="credit-recovery" aria-label={t("Reprise des avoirs historiques")}><div className="credit-recovery__notice" role="status"><strong>{copy.title}</strong><p>{copy.explanation}</p><Button variant="secondary" disabled={disabled||!onReadWorkspace} onClick={()=>void checkHistory()}>{copy.history}</Button>{legacyChecked&&<><Button disabled={disabled||readOnly} onClick={()=>chooseLegacy(true)}>{copy.here}</Button><Button variant="secondary" disabled={disabled||readOnly} onClick={()=>chooseLegacy(false)}>{copy.elsewhere}</Button></>}</div>{pendingConflict&&<p role="alert">{conflictMessage}</p>}{error&&<ErrorPanel message={error} operation="read"/>}</article>;
  return <article ref={root} className="credit-recovery" aria-label={t("Reprise des avoirs historiques")}>
    {!open ? <div className="credit-recovery__intro"><FolderClock size={22}/><div><strong>{t("Compléter l’historique des avoirs")}</strong><p>{t("Précisez les déductions déjà effectuées et les montants encore disponibles, pour tous les avoirs de cette facture.")}</p></div><Button variant="secondary" disabled={disabled} onClick={()=>{if(review){setOpen(true);}else void load();}}>{t(pending?'Reprendre la vérification':'Documenter les règlements')}</Button></div>
    : <div className="credit-recovery__body">
      <div className="credit-recovery__top"><span className="credit-recovery__eyebrow"><FolderClock size={16}/>{t("Reprise du dossier")}</span><Button variant="ghost" size="small" style={{flexShrink:0}} disabled={disabled} onClick={close}>{t("Fermer")}</Button></div>
      <ol className="credit-recovery__steps" aria-label={t("Étapes de la reprise")}><li aria-current={!review?'step':undefined}><span>{review?<Check size={14}/>:1}</span>{t("Documenter")}</li><li aria-current={review?'step':undefined}><span>2</span>{t("Vérifier")}</li></ol>
      <h4 ref={heading} tabIndex={-1}>{review?t('Vérifier les soldes après reprise'):`${t('Documenter les avoirs')}${plan?` · ${plan.number}`:''}`}</h4>
      {working&&!review&&!plan&&<p role="status">{t("Chargement des documents…")}</p>}
      {!review&&plan?.blocker&&<div className="credit-recovery__notice"><strong>{t("Rapprochement nécessaire")}</strong><p>{plan.blocker}</p></div>}
      {!review&&plan&&!plan.blocker&&<form onSubmit={e=>{e.preventDefault();void preview();}}>
        <p>{t('Pour chaque avoir, indiquez ce qui a été déduit de {number}. Le reste deviendra disponible pour une future déduction ou un remboursement.',{number:plan.number})}</p>
        {plan.receivedVat&&<p className="credit-recovery__notice">{t("TVA sur encaissements : la simulation rapproche les paiements et les déductions à leurs dates réelles. Vous pourrez vérifier les corrections proposées avant de les enregistrer.")}</p>}
        <div className="credit-recovery__invoice"><span>{t("Total facturé")} <strong>{formatMoney(plan.invoiceTotalCents,plan.currency)}</strong></span><span>{t("Paiements enregistrés")} <strong>{formatMoney(plan.paidCents,plan.currency)}</strong></span></div>
        <fieldset disabled={disabled||readOnly}>
          {plan.credits.map(c=>{const d=drafts[c.id]??{choice:'',amount:'',date:''};
            const amount=supplierRefundAmount(d.amount);
            const amountError=d.amount?(amount===null?t('Saisissez un montant positif avec au plus deux décimales.'):amount>c.totalCents?t('Cet avoir permet de déduire au maximum {amount}.',{amount:formatMoney(c.totalCents,plan.currency)}):undefined):undefined;
            const dateError=d.date?(d.date<c.earliestApplicationDate?t('Cette date nécessite un rapprochement des opérations antérieures. Conservez la date réelle.'):t(supplierRefundDateError(d.date,c.earliestApplicationDate,todayIso()))||undefined):undefined;
            return <section className="credit-recovery__document" key={c.id} aria-label={t('Reprise {number}',{number:c.number})}>
            <header><div><strong>{c.number}</strong><span>{t('Émis le {date}',{date:formatDate(c.issueDate)})}</span></div><strong>{formatMoney(c.totalCents,plan.currency)}</strong></header>
            <Field label={t('Traitement de {number}',{number:c.number})} required wide><select required value={d.choice} onChange={e=>update(c.id,{choice:e.target.value as CreditDraft['choice']})}><option value="">{t("Choisir le traitement")}</option><option value="available">{t("Entièrement disponible")}</option><option value="applied">{t("Déduit en tout ou en partie de cette facture")}</option></select></Field>
            {d.choice==='applied'&&<div className="form-grid"><Field label={t('Montant déduit · {number} ({currency})',{number:c.number,currency:plan.currency})} required error={amountError}><input inputMode="decimal" value={d.amount} onChange={e=>update(c.id,{amount:e.target.value})} required aria-invalid={Boolean(amountError)}/></Field><Field label={t('Date de déduction · {number}',{number:c.number})} required error={dateError}><input type="date" min={c.earliestApplicationDate} max={todayIso()} required value={d.date} onChange={e=>update(c.id,{date:e.target.value})} aria-invalid={Boolean(dateError)}/></Field><p className="credit-recovery__date-hint">{t('Indiquez la date réelle. Si elle précède le {date}, un rapprochement des opérations antérieures est nécessaire.',{date:formatDate(c.earliestApplicationDate)})}</p></div>}
          </section>;})}
          <div className="form-grid"><Field label={t("Référence du rapprochement")} required><input value={reference} maxLength={255} onChange={e=>setReference(e.target.value)} required placeholder={t("Courriel, relevé ou accord client")}/></Field><Field label={t("Motif de la reprise")} required><textarea value={reason} minLength={5} maxLength={1000} onChange={e=>setReason(e.target.value)} required/></Field></div>
          <label className="credit-recovery__confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} required/><span>{t("Je confirme qu’aucun remboursement ni déduction sur une autre facture n’a déjà été effectué, et que les déductions indiquées sont complètes.")}</span></label>
        </fieldset>
        {exceedsInvoice&&<p role="alert">{t('Les déductions dépassent le solde de la facture, qui est de {amount}. Vérifiez les montants déjà imputés.',{amount:formatMoney(Math.max(0,plan.invoiceTotalCents-plan.paidCents),plan.currency)})}</p>}
        <div className="form-actions"><Button type="submit" disabled={disabled||readOnly||!valid}>{t("Vérifier la reprise")}<ArrowRight size={16}/></Button></div>
      </form>}
      {review&&<div className="credit-recovery__review">
        <div className="credit-recovery__balance"><span>{t('Reste à régler sur {number}',{number:review.preview.number})}</span><strong>{formatMoney(review.preview.invoiceRemainingCents,review.preview.currency)}</strong></div>
        <ul>{review.preview.credits.map(c=><li key={c.creditNoteId}><strong>{c.number}</strong><span>{t("Déduit")} <b>{formatMoney(c.allocatedCents,review.preview.currency)}</b></span><span>{t("Disponible")} <b>{formatMoney(c.remainingCents,review.preview.currency)}</b></span>{review.input.credits.find(i=>i.creditNoteId===c.creditNoteId)?.applicationDate&&<small>{t('Déduction du {date}',{date:formatDate(review.input.credits.find(i=>i.creditNoteId===c.creditNoteId)!.applicationDate!)})}</small>}</li>)}</ul>
        <p><strong>{review.input.reference}</strong><br/>{review.input.reason}</p>
        {review.preview.receivedVat&&<section className="credit-recovery__tax" aria-label={t("Corrections de TVA")}>
          <h5>{t("TVA sur encaissements")}</h5><p>{t("Les écritures d’origine restent conservées. Les corrections ci-dessous replacent la TVA aux dates des opérations documentées.")}</p>
          <ul aria-label={t("Détail des corrections TVA")}>{review.preview.vatAdjustments?.map(a=><li key={`${a.sourceType}:${a.sourceId}`}><strong>{a.reference}</strong><small>{formatDate(a.date)} · {t(a.sourceType==='credit'?'TVA remise en attente':a.sourceType==='application'?'Déduction documentée':'TVA de l’encaissement rapprochée')}</small><span>{t("Variation de TVA due")} <b>{a.dueChangeCents>0?'+':''}{formatMoney(a.dueChangeCents,review.preview.currency)}</b></span></li>)}</ul>
          <p>{t("Si une période a déjà été déclarée, reportez les écarts dans son décompte rectificatif.")} <a href="https://www.estv.admin.ch/fr/decompter-la-tva" target="_blank" rel="noreferrer">{t("Consignes de l’AFC")}</a></p>
          <label className="credit-recovery__confirm"><input type="checkbox" checked={Boolean(review.input.confirmVatReconciliation)} disabled={disabled||readOnly||pending} onChange={e=>setReview({...review,input:{...review.input,confirmVatReconciliation:e.target.checked}})}/><span>{t("J’ai vérifié les dates et les corrections de TVA de cette reprise.")}</span></label>
        </section>}
        <p>{t(review.preview.receivedVat?'Les corrections de TVA et leurs preuves seront conservées avec la reprise.':'La reprise conserve les documents émis et leur TVA.')} {t("Elle n’enregistre aucun virement. Les déductions confirmées apparaîtront dans l’historique et le solde disponible pourra ensuite être utilisé.")}</p>
        {pending&&historyChecked&&<p className="credit-recovery__notice" role="status">{copy.checked}</p>}
        {pending&&<p className="credit-recovery__notice" role="status">{t("La réponse précédente a été interrompue. Vérifiez cette même demande pour retrouver son résultat sans créer une seconde reprise.")}</p>}
        <div className="form-actions">{!pending&&<Button variant="secondary" disabled={disabled} onClick={()=>{if(plan)setReview(undefined);else void load();}}><ArrowLeft size={16}/>{t("Modifier")}</Button>}{pending&&<Button variant="secondary" disabled={disabled||!onReadWorkspace} onClick={()=>void checkHistory()}>{copy.check}</Button>}<Button disabled={disabled||readOnly||pending&&!historyChecked||Boolean(review.preview.receivedVat&&!review.input.confirmVatReconciliation)} onClick={()=>void commit()}>{pending?copy.resume:t('Confirmer la reprise')}<Check size={16}/></Button></div>
      </div>}
      {pendingConflict&&<p className="credit-recovery__notice" role="alert">{conflictMessage}</p>}
      {error&&<ErrorPanel key={attempt} message={error} reveal/>}
      {!pending&&!review&&<Button variant="ghost" disabled={disabled} onClick={()=>void load()}><RefreshCw size={15}/>{t("Actualiser le dossier")}</Button>}
      {readOnly&&<p>{t("La reprise est consultable. Son enregistrement nécessite un accès en écriture.")}</p>}
    </div>}
  </article>;
}

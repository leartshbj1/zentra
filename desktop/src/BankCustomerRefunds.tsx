import { useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, FileClock, RefreshCw } from 'lucide-react';
import { BANK_CUSTOMER_REQUEST_EVENT, listBankCustomerRequests, listLegacyBankCustomerRequests, type BankCustomerRequest, type BankCustomerRequestOrigin, type ScopedBankCustomerRequest } from './bankCustomerRefundRequests';
import { RefundReceiptPicker } from './RefundAttachments';
import type { BankMovement, Workspace } from './types';
import { Button, ErrorPanel, Field, Modal, SectionHeading } from './ui';
import { createId, errorMessage, formatDate, formatMoney } from './utils';

export function useBankCustomerRequests(movements: BankMovement[], origin: BankCustomerRequestOrigin | null) {
  const ids = movements.map(row => row.id).sort().join('|'), identity=JSON.stringify(origin ? [origin.companyId,origin.organizationId ?? '',origin.memberId] : null);
  const [requests, setRequests] = useState<ScopedBankCustomerRequest[]>([]);
  const [legacy, setLegacy] = useState<BankCustomerRequest[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    let live = true, generation=0;
    setRequests([]);setLegacy([]);setError('');
    const refresh = () => {
      const read=++generation;
      if (!origin) return;
      void Promise.all([listBankCustomerRequests(origin),listLegacyBankCustomerRequests()]).then(([rows,old]) => { if (live && read===generation) { const current = new Set(ids.split('|')); setRequests(rows.filter(row => current.has(row.request.movementId)));setLegacy(old); setError(''); } }).catch(cause => { if (live && read===generation) setError(errorMessage(cause, 'Les demandes conservées ne sont pas accessibles.')); });
    };
    refresh(); window.addEventListener(BANK_CUSTOMER_REQUEST_EVENT, refresh);
    return () => { live = false;generation++; window.removeEventListener(BANK_CUSTOMER_REQUEST_EVENT, refresh); };
  }, [ids, identity, attempt]);
  return { requests, legacy, error, retry: () => setAttempt(value => value + 1) };
}

export function BankCustomerPending({ requests, disabled, onRun, onRemove }: {
  requests: ScopedBankCustomerRequest[]; disabled: boolean;
  onRun: (request: ScopedBankCustomerRequest) => Promise<void>;
  onRemove: (request: ScopedBankCustomerRequest) => Promise<void>;
}) {
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [toRemove, setToRemove] = useState('');
  const inFlight = useRef(false);
  if (!requests.length) return null;
  const run = async (row: ScopedBankCustomerRequest, remove = false) => {
    const request=row.request;
    if (disabled || inFlight.current) return;
    inFlight.current = true; setWorking(request.requestId); setError('');
    try { await (remove ? onRemove(row) : onRun(row)); setToRemove(''); }
    catch (cause) { setError(errorMessage(cause, 'Le résultat n’a pas pu être confirmé. La demande est conservée.')); }
    finally { setWorking(''); inFlight.current = false; }
  };
  return <section className="panel bank-customer-pending" aria-label="Demandes bancaires à vérifier">
    <SectionHeading eyebrow="Reprise" title="Demandes à vérifier" description="Une réponse n’a pas été confirmée. La vérification reprend exactement la même demande, sans second remboursement." />
    <div className="bank-customer-pending__list">{requests.map(row => {const request=row.request;return <article key={request.requestId}>
      <div><strong><FileClock size={17} />{request.kind === 'create' ? 'Remboursement client' : request.kind === 'match' ? 'Rapprochement client' : 'Dissociation du relevé'}</strong><p>{request.description}</p><small>{formatDate(request.date)} · {formatMoney(request.amountCents, request.currency)}{request.kind === 'create' && request.receipt ? ` · ${request.receipt.name}` : ''}</small>
        {request.kind === 'match' && request.dateDifferenceReason ? <p>Écart de dates : {request.dateDifferenceReason}</p> : request.kind !== 'match' ? <p>{request.reason}</p> : null}
      </div>
      <div className="bank-customer-pending__actions"><Button disabled={disabled || Boolean(working)} onClick={() => void run(row)}><RefreshCw size={15} />{working === request.requestId ? 'Vérification…' : 'Vérifier la demande'}</Button><Button variant="ghost" disabled={disabled || Boolean(working)} onClick={() => setToRemove(request.requestId)}>Retirer de cette liste</Button></div>
      {toRemove === request.requestId ? <div className="bank-customer-pending__remove"><p>Retirer la copie de reprise ne supprime aucun remboursement ni rapprochement déjà enregistré. Le relevé sera actualisé avant une nouvelle action.</p><Button variant="secondary" disabled={disabled || Boolean(working)} onClick={() => void run(row, true)}>Retirer la demande locale</Button><Button variant="ghost" disabled={Boolean(working)} onClick={() => setToRemove('')}>Conserver la demande</Button></div> : null}
    </article>;})}</div>
    {error ? <ErrorPanel title="Vérification à reprendre" message={error} /> : null}
  </section>;
}

export function BankCustomerLegacyPending({ requests, companyName, disabled, onReview, onAdopt }: {
  requests: BankCustomerRequest[]; companyName: string; disabled: boolean;
  onReview: (request: BankCustomerRequest) => Promise<BankMovement | null>;
  onAdopt: (request: BankCustomerRequest) => Promise<void>;
}) {
  const [review, setReview] = useState<{ request: BankCustomerRequest; movement: BankMovement | null } | null>(null);
  const [chosen, setChosen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('');
  const live=useRef(false),inFlight=useRef(false);
  useLayoutEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  if (!requests.length) return null;
  async function examine(request: BankCustomerRequest) {
    if(disabled||inFlight.current)return;inFlight.current=true;setWorking(true);setError('');setReview(null);setChosen(false);
    try {const movement=await onReview(request);if(live.current)setReview({request,movement});}
    catch(cause){if(live.current)setError(errorMessage(cause,'Le relevé n’a pas pu être relu. La copie ancienne reste conservée.'));}
    finally{inFlight.current=false;if(live.current)setWorking(false);}
  }
  async function adopt() {
    if(disabled||inFlight.current||!chosen||!review?.movement)return;inFlight.current=true;setWorking(true);setError('');
    try{await onAdopt(review.request);if(live.current){setReview(null);setChosen(false);}}
    catch(cause){if(live.current)setError(errorMessage(cause,'La demande n’a pas été liée à cet espace. Sa copie est conservée.'));}
    finally{inFlight.current=false;if(live.current)setWorking(false);}
  }
  return <section className="panel bank-customer-legacy" aria-label="Demandes anciennes à vérifier">
    <SectionHeading eyebrow="Copies anciennes" title="Choisissez leur entreprise" description="Ces demandes ont été conservées avant l’enregistrement de leur origine. Elles ne sont jamais envoyées automatiquement." />
    <p>{requests.length} copie{requests.length>1?'s':''} conservée{requests.length>1?'s':''} sur cet appareil.</p>
    {requests.map((request,index)=><Button key={request.requestId} variant="secondary" disabled={disabled||working} onClick={()=>void examine(request)}>Examiner la demande {index+1}</Button>)}
    {review?<div className="bank-customer-pending__remove">
      <strong>{review.request.description}</strong><p>{formatDate(review.request.date)} · {formatMoney(review.request.amountCents,review.request.currency)}</p>
      <p>{review.request.kind==='match'?review.request.dateDifferenceReason:review.request.reason}</p>
      {review.request.kind==='create'&&review.request.receipt?<p>Justificatif conservé : {review.request.receipt.name}</p>:null}
      <p>L’origine n’est pas connue. La présence du même mouvement dans cet espace ne prouve pas que cette demande lui appartient.</p>
      {review.movement?<><p>Relevé relu dans {companyName} : {formatDate(review.movement.bookingDate||review.movement.valueDate)} · {formatMoney(review.movement.amountCents,review.movement.currency)} · {review.movement.refundMatch?'déjà rapproché':'à vérifier'}.</p>
      <label><input type="checkbox" checked={chosen} disabled={disabled||working} onChange={event=>setChosen(event.target.checked)} /> Je confirme que cette demande appartient à l’entreprise {companyName}.</label>
      <Button disabled={disabled||working||!chosen} onClick={()=>void adopt()}>Lier la copie à cet espace</Button><p>Ce choix conserve le même identifiant, contenu et justificatif. La vérification financière demandera un clic séparé.</p></>:<p>Ce mouvement n’est pas présent dans le relevé relu. Ouvrez son entreprise d’origine. La demande reste conservée.</p>}
    </div>:null}
    {error?<ErrorPanel title="Copie ancienne conservée" message={error}/>:null}
  </section>;
}

export function BankCustomerRefundCreate({ movement, workspace, busy, readOnly, close, onSave }: {
  movement: BankMovement; workspace: Workspace; busy: boolean; readOnly: boolean;
  close: () => void; onSave: (request: BankCustomerRequest) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const date = movement.bookingDate || movement.valueDate || '';
  const credits = workspace.invoices.filter(credit => credit.type === 'credit_note' && !['draft', 'cancelled'].includes(credit.status) && credit.currency === 'CHF' && credit.issueDate <= date && (credit.customerCredit?.remainingCents ?? 0) >= movement.amountCents);
  const [creditId, setCreditId] = useState(credits.length === 1 ? credits[0].id : '');
  const [reference, setReference] = useState((movement.reference || `Remboursement du ${formatDate(date)}`).slice(0, 255));
  const [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [pending, setPending] = useState<BankCustomerRequest | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const credit = credits.find(row => row.id === creditId);
  const clientName = (id: string) => { const client = workspace.clients.find(row => row.id === id); return client?.company || client?.name || 'Client'; };
  const disabled = busy || readOnly || saving;
  const valid = credit && reference.trim().length > 0 && Array.from(reason.trim()).length >= 5 && movement.amountCents > 0 && movement.refundSuggestion?.canCreate;
  return <Modal title="Enregistrer le remboursement client" description={`${formatMoney(movement.amountCents, movement.currency)} · débit du ${formatDate(date)}`} onClose={close} dismissible={!saving && !busy}>
    <form className="bank-expense-form bank-customer-form" onSubmit={async event => {
      event.preventDefault(); if (disabled || inFlight.current || (!valid && !pending)) return;
      const request: BankCustomerRequest = pending || { kind: 'create', requestId, movementId: movement.id, customerCreditNoteId: creditId, reference: reference.trim(), reason: reason.trim(), receipt, description: `${credit?.number || 'Avoir client'} · ${clientName(credit?.clientId || '')}`, amountCents: movement.amountCents, currency: movement.currency, date };
      inFlight.current = true; setSaving(true); setError(''); setPending(request);
      try { await onSave(request); }
      catch (cause) { setError(errorMessage(cause, 'Le résultat n’a pas pu être confirmé. Réessayez la même demande.')); }
      finally { inFlight.current = false; setSaving(false); }
    }}>
      <p>Reliez à un avoir ce virement déjà effectué. Aucun virement n’est envoyé.</p>
      <fieldset className="bank-customer-fields" disabled={disabled || Boolean(pending)}>
        <Field label="Avoir client à rembourser" required><select required value={creditId} onChange={event => setCreditId(event.target.value)}><option value="">Choisir un avoir…</option>{credits.map(row => <option key={row.id} value={row.id}>{row.number || 'Avoir sans numéro'} · {clientName(row.clientId)} · {formatMoney(row.customerCredit?.remainingCents ?? 0, row.currency)} disponible</option>)}</select></Field>
        {!credits.length ? <p role="status">Aucun avoir daté ne dispose de ce montant à la date du débit. Les avoirs historiques peuvent être repris depuis leur facture d’origine.</p> : null}
        <Field label="Référence du remboursement" required><input required maxLength={255} value={reference} onChange={event => setReference(event.target.value)} /></Field>
        <Field label="Motif du remboursement" required><textarea required minLength={5} maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field>
        <RefundReceiptPicker receipt={receipt} onChange={setReceipt} disabled={disabled || Boolean(pending)} onError={setError} label="Justificatif complémentaire (facultatif)" hint="Le relevé sera relié au remboursement. Vous pouvez ajouter un PDF, JPG, PNG ou WebP, jusqu’à 25 Mo, au dossier du projet." />
      </fieldset>
      {credit ? <div className="correction-preview"><strong>{credit.number} · {clientName(credit.clientId)}</strong><p>Remboursement versé : {formatMoney(movement.amountCents, credit.currency)}</p><p>Disponible après remboursement : {formatMoney((credit.customerCredit?.remainingCents ?? 0) - movement.amountCents, credit.currency)}</p></div> : null}
      {pending && !saving ? <p role="status"><CheckCircle2 size={16} /> Le même contenu sera utilisé pour vérifier la demande. Après fermeture, retrouvez la copie conservée dans « Demandes à vérifier ».</p> : null}
      {error ? <ErrorPanel title="Remboursement à vérifier" message={error} reveal /> : null}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy || saving} onClick={close}>Fermer</Button><Button type="submit" disabled={disabled || (!valid && !pending)}>{saving ? 'Enregistrement…' : pending ? 'Vérifier la même demande' : 'Enregistrer et rapprocher'}</Button></div>
    </form>
  </Modal>;
}

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileClock, RefreshCw } from 'lucide-react';
import { BANK_CUSTOMER_REQUEST_EVENT, listBankCustomerRequests, type BankCustomerRequest } from './bankCustomerRefundRequests';
import { RefundReceiptPicker } from './RefundAttachments';
import type { BankMovement, Workspace } from './types';
import { Button, ErrorPanel, Field, Modal, SectionHeading } from './ui';
import { createId, errorMessage, formatDate, formatMoney } from './utils';

export function useBankCustomerRequests(movements: BankMovement[]) {
  const ids = movements.map(row => row.id).sort().join('|');
  const [requests, setRequests] = useState<BankCustomerRequest[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void listBankCustomerRequests().then(rows => { if (live) { const current = new Set(ids.split('|')); setRequests(rows.filter(row => current.has(row.movementId))); setError(''); } }).catch(cause => { if (live) setError(errorMessage(cause, 'Les demandes conservées ne sont pas accessibles.')); });
    };
    refresh(); window.addEventListener(BANK_CUSTOMER_REQUEST_EVENT, refresh);
    return () => { live = false; window.removeEventListener(BANK_CUSTOMER_REQUEST_EVENT, refresh); };
  }, [ids, attempt]);
  return { requests, error, retry: () => setAttempt(value => value + 1) };
}

export function BankCustomerPending({ requests, disabled, onRun, onRemove }: {
  requests: BankCustomerRequest[]; disabled: boolean;
  onRun: (request: BankCustomerRequest) => Promise<void>;
  onRemove: (request: BankCustomerRequest) => Promise<void>;
}) {
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [toRemove, setToRemove] = useState('');
  const inFlight = useRef(false);
  if (!requests.length) return null;
  const run = async (request: BankCustomerRequest, remove = false) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setWorking(request.requestId); setError('');
    try { await (remove ? onRemove(request) : onRun(request)); setToRemove(''); }
    catch (cause) { setError(errorMessage(cause, 'Le résultat n’a pas pu être confirmé. La demande est conservée.')); }
    finally { setWorking(''); inFlight.current = false; }
  };
  return <section className="panel bank-customer-pending" aria-label="Demandes bancaires à vérifier">
    <SectionHeading eyebrow="Reprise" title="Demandes à vérifier" description="Une réponse n’a pas été confirmée. La vérification reprend exactement la même demande, sans second remboursement." />
    <div className="bank-customer-pending__list">{requests.map(request => <article key={request.requestId}>
      <div><strong><FileClock size={17} />{request.kind === 'create' ? 'Remboursement client' : request.kind === 'match' ? 'Rapprochement client' : 'Dissociation du relevé'}</strong><p>{request.description}</p><small>{formatDate(request.date)} · {formatMoney(request.amountCents, request.currency)}{request.kind === 'create' && request.receipt ? ` · ${request.receipt.name}` : ''}</small>
        {request.kind === 'match' && request.dateDifferenceReason ? <p>Écart de dates : {request.dateDifferenceReason}</p> : request.kind !== 'match' ? <p>{request.reason}</p> : null}
      </div>
      <div className="bank-customer-pending__actions"><Button disabled={disabled || Boolean(working)} onClick={() => void run(request)}><RefreshCw size={15} />{working === request.requestId ? 'Vérification…' : 'Vérifier la demande'}</Button><Button variant="ghost" disabled={disabled || Boolean(working)} onClick={() => setToRemove(request.requestId)}>Retirer de cette liste</Button></div>
      {toRemove === request.requestId ? <div className="bank-customer-pending__remove"><p>Retirer la copie de reprise ne supprime aucun remboursement ni rapprochement déjà enregistré. Le relevé sera actualisé avant une nouvelle action.</p><Button variant="secondary" disabled={disabled || Boolean(working)} onClick={() => void run(request, true)}>Retirer la demande locale</Button><Button variant="ghost" disabled={Boolean(working)} onClick={() => setToRemove('')}>Conserver la demande</Button></div> : null}
    </article>)}</div>
    {error ? <ErrorPanel title="Vérification à reprendre" message={error} /> : null}
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

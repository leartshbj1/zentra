import { useEffect, useRef, useState } from 'react';
import { ChevronDown, History, Link2Off } from 'lucide-react';
import { Button, Field, Modal } from './ui';
import type { BankMovement, Workspace } from './types';
import { createId, errorMessage, formatDate, formatDateTime, formatMoney } from './utils';

export function BankExpenseCorrection({movement, workspace, busy, onClose, onConfirm}: {
  movement: BankMovement; workspace: Workspace; busy: boolean; onClose: () => void;
  onConfirm: (requestId: string, reconciliationId: string, reason: string) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) { errorRef.current?.focus({preventScroll:true}); errorRef.current?.scrollIntoView({block:'nearest'}); } },[error]);
  const link = movement.expenseReconciliation;
  const expense = workspace.expenses.find((row) => row.id === link?.expenseId);
  return <Modal title="Dissocier la dépense du relevé" description="Corrigez une association bancaire erronée." onClose={onClose} dismissible={!busy && !saving}>
    <form className="bank-expense-form" onSubmit={async (event) => {
      event.preventDefault();
      if (!link || busy || submitting.current || !acknowledged || Array.from(reason.trim()).length < 5) return;
      submitting.current=true; setSaving(true); setError('');
      try { await onConfirm(requestId,link.id,reason.trim()); }
      catch (cause) { setError(errorMessage(cause,'La dissociation a été refusée. Votre motif est conservé.')); }
      finally { submitting.current=false; setSaving(false); }
    }}>
      <div className="bank-expense-correction__summary"><strong>{expense?.reference || link?.reference || 'Dépense enregistrée'}</strong><span>{expense?.supplier || link?.supplier || movement.counterpartyName}</span><strong>{formatMoney(movement.amountCents)}</strong><span>Relevé du {formatDate(movement.bookingDate || movement.valueDate)}</span></div>
      <div className="info-strip"><Link2Off size={20} /><span><strong>Le paiement et la TVA restent enregistrés.</strong><br />Seule l’association au débit sera retirée. Le mouvement reviendra dans « À rapprocher » et la dépense restera dans vos achats, avec son justificatif.</span></div>
      <Field label="Motif de la correction" required hint="5 à 500 caractères. Ce motif restera dans l’historique du relevé."><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={4} required disabled={busy || saving} placeholder="Ex. ce débit correspond à un autre achat" /></Field>
      <label className="bank-expense-correction__ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={busy || saving} /><span>Je souhaite retirer l’association au relevé en conservant le paiement de cette dépense.</span></label>
      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="bank-expense-picker__error">{error}</p> : null}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy || saving} onClick={onClose}>Conserver l’association</Button><Button type="submit" disabled={busy || saving || !acknowledged || Array.from(reason.trim()).length < 5}>{saving ? 'Enregistrement…' : 'Dissocier du relevé'}</Button></div>
    </form>
  </Modal>;
}

export function BankExpenseHistory({movement}: {movement: BankMovement}) {
  const [limit,setLimit]=useState(5);
  const history=movement.expenseHistory ?? [];
  if (!history.length) return null;
  return <details className="bank-expense-history"><summary><History size={16} /> Historique des associations <span>{history.length}</span><ChevronDown size={14} className="bank-history-chevron" /></summary><div className="bank-expense-history__entries">{history.slice(0,limit).map((entry) => <article key={entry.id}><strong>{entry.reference || 'Dépense'} · {formatMoney(entry.amountCents)}</strong><span>{entry.supplier}</span><small>Associée le {formatDateTime(entry.confirmedAt)}</small><small>Dissociée le {formatDateTime(entry.unlinkedAt)} · paiement conservé</small><p>{entry.reason}</p>{entry.dateDifferenceReason ? <small>Écart de dates documenté lors de l’association : {entry.dateDifferenceReason}</small> : null}</article>)}</div>{history.length>limit ? <Button type="button" variant="ghost" size="small" onClick={() => setLimit(limit+5)}>Afficher les corrections suivantes</Button> : null}</details>;
}

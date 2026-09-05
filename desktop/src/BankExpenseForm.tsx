import { useEffect, useRef, useState } from 'react';
import type { BankMovement, Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney } from './utils';
import { fileSizeLabel, PROJECT_FILE_MAX_BYTES } from './projectDocuments';

export type BankExpenseDraft = {
  requestId: string; movementId: string; date: string; supplier: string; reference: string;
  category: string; projectId: string | null; vatCents: number; vatTreatment: string;
  note: string; receipt: File;
};

export function BankExpenseForm({ movement, workspace, busy, onClose, onSave }: {
  movement: BankMovement; workspace: Workspace; busy: boolean; onClose: () => void;
  onSave: (draft: BankExpenseDraft) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const [vat, setVat] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) { errorRef.current?.focus({ preventScroll: true }); errorRef.current?.scrollIntoView({ block: 'nearest' }); }
  }, [error]);
  const date = movement.bookingDate || movement.valueDate || '';
  const vatCents = /^\d+(?:[.,]\d{1,2})?$/.test(vat.trim()) ? Math.round(Number(vat.replace(',', '.')) * 100) : NaN;
  const validVat = Number.isSafeInteger(vatCents) && vatCents >= 0 && vatCents < movement.amountCents;
  const categories = workspace.settings?.work.costCategories ?? [];
  return <Modal title="Créer une dépense" description={`Paiement de ${formatMoney(movement.amountCents)} enregistré au ${formatDate(date)}.`} onClose={onClose} dismissible={!busy && !saving}>
    <form className="bank-expense-form" onSubmit={async (event) => {
      event.preventDefault();
      if (submitting.current || busy) return;
      if (!receipt) { setError('Joignez le justificatif de cet achat.'); return; }
      if (!validVat) { setError('Saisissez la TVA figurant sur la pièce, ou 0 si elle n’en comporte pas.'); return; }
      const data = new FormData(event.currentTarget);
      submitting.current = true; setSaving(true); setError('');
      try {
        await onSave({requestId, movementId: movement.id, date: String(data.get('date')), supplier: String(data.get('supplier')).trim(), reference: String(data.get('reference')).trim(), category: String(data.get('category')).trim(), projectId: String(data.get('project')) || null, vatCents, vatTreatment: String(data.get('treatment')), note: String(data.get('note')).trim(), receipt});
      } catch (reason) { setError(errorMessage(reason, 'La dépense n’a pas pu être enregistrée. Réessayez avec les mêmes données.')); }
      finally { submitting.current = false; setSaving(false); }
    }}>
      <p className="bank-expense-form__hint">Pour un achat payé en une fois. Si sa facture est déjà dans vos achats, utilisez le rapprochement existant.</p>
      <fieldset disabled={busy || saving}>
        <Field label="Justificatif" required hint="PDF, JPG, PNG ou WebP · 25 Mo maximum">
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (!file.size || file.size > PROJECT_FILE_MAX_BYTES || !/\.(pdf|jpe?g|png|webp)$/i.test(file.name)) { setError('Choisissez un PDF ou une image JPG, PNG ou WebP de 1 octet à 25 Mo.'); event.target.value = ''; return; }
            setReceipt(file); setError('');
          }} />
          {receipt ? <span className="bank-expense-form__file">{receipt.name} · {fileSizeLabel(receipt.size)}</span> : null}
        </Field>
        <div className="bank-expense-form__grid">
          <Field label="Fournisseur" required><input name="supplier" maxLength={500} required defaultValue={movement.counterpartyName || ''} /></Field>
          <Field label="Référence du justificatif" required><input name="reference" maxLength={255} required placeholder="N° de facture ou de ticket" /></Field>
          <Field label="Date du justificatif" required><input name="date" type="date" max={date} required /></Field>
          <Field label="Catégorie" required><input name="category" list="bank-expense-categories" maxLength={255} required placeholder="Ex. marchandises" /><datalist id="bank-expense-categories">{categories.map((category) => <option key={category} value={category} />)}</datalist></Field>
        </div>
        <Field label="Projet"><select name="project" defaultValue=""><option value="">Sans projet</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
        <Field label="TVA indiquée sur le justificatif (CHF)" required hint="Saisissez 0 si la pièce ne comporte pas de TVA."><input inputMode="decimal" value={vat} onChange={(event) => setVat(event.target.value)} required placeholder="Ex. 8,10" /></Field>
        <div className="bank-expense-form__total"><span>Hors TVA <strong>{validVat ? formatMoney(movement.amountCents - vatCents) : '—'}</strong></span><span>Total payé <strong>{formatMoney(movement.amountCents)}</strong></span></div>
        <Field label="Traitement de la TVA" required hint="La déduction est contrôlée selon votre profil TVA à la date de l’achat."><select name="treatment" required defaultValue=""><option value="" disabled>Choisir le traitement</option><option value="input_materials">Marchandises / prestations</option><option value="input_investments">Autres charges</option><option value="non_deductible">Sans déduction</option></select></Field>
        <Field label="Note"><textarea name="note" maxLength={1000} rows={2} /></Field>
      </fieldset>
      {error ? <p ref={errorRef} tabIndex={-1} className="bank-expense-picker__error" role="alert">{error}</p> : null}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy || saving} onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy || saving || !receipt || !validVat}>{saving ? 'Enregistrement…' : 'Créer et rapprocher'}</Button></div>
    </form>
  </Modal>;
}

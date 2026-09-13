import { useEffect, useRef, useState } from 'react';
import type { Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { formatDate, formatMoney, todayIso } from './utils';
import { creditAllocationProblem, creditAmount, creditAmountInput, creditBalances, eligibleCreditInvoices, requireCreditAllocationWorkspace, type CreditBalances, type CreditProblem } from './creditAllocationWorkflow';
import './credit-allocation.css';

export function SupplierCreditAllocationModal({ creditId, allocationId, workspace, busy, readOnly, actionError, onClose, onConfirm, onRefresh, onOpenAccounting }: {
  creditId: string; allocationId?: string; workspace: Workspace; busy: boolean; readOnly: boolean; actionError: string;
  onClose: () => void; onRefresh: () => Promise<Workspace>; onOpenAccounting: () => void;
  onConfirm: (input: { invoiceId: string; amountCents: number; reason: string; date: string; expectedBalances: CreditBalances }) => Promise<boolean>;
}) {
  const reverse = !!allocationId;
  const credit = workspace.supplierCreditNotes.find(row => row.id === creditId);
  const allocation = credit?.allocations.find(row => row.id === allocationId);
  const invoices = eligibleCreditInvoices(credit, workspace.supplierInvoices);
  const [invoiceId, setInvoiceId] = useState(allocation?.supplierInvoiceId || invoices[0]?.id || '');
  const invoice = workspace.supplierInvoices.find(row => row.id === invoiceId);
  const balances = creditBalances(credit, invoice);
  const maximum = balances ? Math.min(balances.creditAvailableCents, balances.invoiceBalanceCents) : 0;
  const [amount, setAmount] = useState(() => creditAmountInput(allocation?.amountCents ?? maximum));
  const [date, setDate] = useState(todayIso);
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [problem, setProblem] = useState<CreditProblem | null>(null);
  const [pending, setPending] = useState(false);
  const [showActionError, setShowActionError] = useState(Boolean(actionError));
  const visibleActionError = showActionError ? actionError : '';
  useEffect(() => { setShowActionError(Boolean(actionError)); }, [actionError]);
  const flight = useRef(false), form = useRef<HTMLFormElement>(null);
  const locked = busy || pending, editingDisabled = locked || readOnly;
  const amountCents = reverse ? allocation?.amountCents ?? null : creditAmount(amount);
  const previewValid = balances && amountCents && (reverse ? Number.isSafeInteger(balances.creditAvailableCents + amountCents) && Number.isSafeInteger(balances.invoiceBalanceCents + amountCents) : amountCents <= maximum);
  const minimum = [credit?.documentDate || '', invoice?.documentDate || '', reverse ? allocation?.effectiveDate || '' : ''].sort().at(-1)!;
  const key = JSON.stringify([credit?.status, credit?.supplierId, credit?.currency, credit?.documentDate, balances, invoice?.id, invoice?.documentStatus, invoice?.documentDate, invoice?.currency, invoice?.supplierId, allocation, credit?.allocations.filter(row => row.reversesAllocationId === allocationId), amount, date, reason]);
  const changed = review !== null && review !== key;
  const initialKey = useRef(key);
  const [balanceNotice, setBalanceNotice] = useState(false);
  // Updated balances remain visible without changing the amount the user typed.
  const balanceKey = JSON.stringify(balances);
  const previousBalances = useRef(balanceKey);
  useEffect(() => { if (previousBalances.current !== balanceKey) { previousBalances.current = balanceKey; if (key !== initialKey.current) setBalanceNotice(true); } }, [balanceKey, key]);
  function focusProblem(field: CreditProblem['field']) {
    requestAnimationFrame(() => {
      const target = form.current?.querySelector<HTMLElement>(`[name="${field}"]`) || form.current?.querySelector<HTMLElement>('.credit-allocation-alert');
      target?.focus({ preventScroll: true });
      const body = form.current?.closest('.modal__body');
      const anchor = target?.closest('.field') || target;
      if (body && anchor) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
    });
  }
  function explain(value: CreditProblem) { setProblem(value); focusProblem(value.field); }
  useEffect(() => { if (actionError) focusProblem('record'); }, [actionError]);
  async function refresh() {
    if (flight.current || locked) return;
    flight.current = true; setPending(true);
    try { requireCreditAllocationWorkspace(await onRefresh()); setProblem(null); }
    catch { explain({ field: 'record', message: 'Les soldes ne peuvent pas être relus pour le moment. Votre saisie reste présente ; réessayez l’actualisation.' }); }
    finally { flight.current = false; setPending(false); }
  }
  async function submit() {
    if (flight.current || editingDisabled) return;
    const invalid = creditAllocationProblem(credit, invoice, allocation, { amount, date, reason, reverse }, todayIso());
    if (invalid) { if (review) setReview(null); explain(invalid); return; }
    if (review === null || changed) {
      setProblem(null); setReview(key); setBalanceNotice(false); setShowActionError(false);
      requestAnimationFrame(() => { const heading = form.current?.querySelector<HTMLElement>('.credit-allocation-review'); heading?.focus({ preventScroll:true }); form.current?.closest('.modal__body')?.scrollTo({ top:0 }); });
      return;
    }
    if (!balances || !amountCents) return;
    flight.current = true; setPending(true); setProblem(null);
    try { await onConfirm({ invoiceId, amountCents, reason: reason.trim(), date, expectedBalances: balances }); }
    finally { flight.current = false; setPending(false); }
  }
  const rawProblem = /période|exercice|clôtur|clotur|fermée/i.test(visibleActionError)
    ? 'Cette date se trouve dans un exercice fermé. Vérifiez les exercices comptables. Ne changez la date que si elle a été mal saisie.'
    : /solde|balance|changed|changé|insuffis|disponible/i.test(visibleActionError)
      ? 'Les soldes ont changé depuis votre vérification. Actualisez-les, puis relisez les montants avant de confirmer.'
      : /reason|motif/i.test(visibleActionError) ? 'Vérifiez le motif de l’annulation : un texte court suffit, en 500 caractères maximum.'
      : 'Cette opération n’a pas pu être confirmée. Actualisez les soldes pour vérifier son état. Votre saisie est conservée.';
  return <Modal className="credit-allocation-modal" title={reverse ? 'Annuler l’utilisation de cet avoir' : 'Utiliser un avoir sur une facture'} description={`${credit?.supplierName || 'Fournisseur'} · ${credit?.number || credit?.reference || 'Avoir'}`} onClose={locked ? () => {} : onClose}>
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
      <ol className="credit-allocation-steps" aria-label="Étapes"><li aria-current={review === null ? 'step' : undefined}>1 · {reverse ? 'Expliquer' : 'Choisir'}</li><li aria-current={review !== null ? 'step' : undefined}>2 · Vérifier</li></ol>
      {review === null && <p className="credit-allocation-explanation">{reverse ? 'Le montant redevient disponible sur l’avoir et revient dans le reste à payer de la facture. L’historique est conservé.' : 'Un avoir diminue ce que vous devez au fournisseur. Choisissez la facture concernée et le montant à déduire. Aucun virement bancaire n’est envoyé.'}</p>}
      {balanceNotice && review === null && <p role="status" className="credit-allocation-notice">Les soldes ont été actualisés. Votre montant est conservé ; vérifiez-le avant de continuer.</p>}
      {review === null ? <fieldset disabled={editingDisabled} className="credit-allocation-fields">
        {!reverse ? <><Field label="Facture à réduire" required error={problem?.field === 'invoice' ? problem.message : undefined}><select name="invoice" value={invoiceId} onChange={event => { setInvoiceId(event.target.value); setProblem(null); const next = creditBalances(credit, invoices.find(row => row.id === event.target.value)); setAmount(next ? creditAmountInput(Math.min(next.creditAvailableCents, next.invoiceBalanceCents)) : ''); }}><option value="">Choisir une facture…</option>{invoices.map(row => <option key={row.id} value={row.id}>{row.reference || 'Facture sans référence'} · {formatMoney(row.balanceCents, row.currency)} à payer</option>)}</select></Field>
          {!invoices.length && <p className="credit-allocation-notice">Aucune facture validée avec un reste à payer pour ce fournisseur. Retrouvez la facture dans Factures et avoirs pour la valider, puis revenez ici.</p>}
          <Field label={`Montant à déduire (${credit?.currency || 'CHF'})`} required error={problem?.field === 'amount' ? problem.message : undefined} hint="Une virgule ou un point, avec deux décimales maximum."><input name="amount" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setProblem(null); }} aria-invalid={problem?.field === 'amount'} /></Field>
          <Button type="button" variant="secondary" disabled={!maximum} onClick={() => { setAmount(creditAmountInput(maximum)); setProblem(null); }}>Utiliser le maximum · {formatMoney(maximum, credit?.currency)}</Button></> : <Field label="Motif de l’annulation" required error={problem?.field === 'reason' ? problem.message : undefined} hint="Par exemple : Mauvaise facture."><textarea name="reason" rows={3} maxLength={500} value={reason} onChange={event => { setReason(event.target.value); setProblem(null); }} aria-invalid={problem?.field === 'reason'} /></Field>}
        <Field label={reverse ? 'Date de l’annulation' : 'Date d’utilisation de l’avoir'} required error={problem?.field === 'date' ? problem.message : undefined} hint="Le jour réel de cette opération, au plus tard aujourd’hui."><input name="date" type="date" min={minimum} max={todayIso()} value={date} onChange={event => { setDate(event.target.value); setProblem(null); }} aria-invalid={problem?.field === 'date'} /></Field>
      </fieldset> : <section className="credit-allocation-review" tabIndex={-1}><h3>Vérifiez les nouveaux soldes</h3><p>{invoice?.reference || 'Facture'} · {formatDate(date)}</p>{reverse && <p className="credit-allocation-reason">Motif : {reason}</p>}{changed && <p className="credit-allocation-notice" role="alert">Les informations ont changé. Relisez les nouveaux soldes puis choisissez « Reprendre la vérification ».</p>}</section>}
      {balances && previewValid && amountCents && <div className="credit-allocation-balances" aria-label="Soldes avant et après"><div><span>Reste à payer sur la facture</span><strong>{formatMoney(balances.invoiceBalanceCents, credit?.currency)}</strong><small>Après : {formatMoney(balances.invoiceBalanceCents + (reverse ? amountCents : -amountCents), credit?.currency)}</small></div><div><span>Disponible sur l’avoir</span><strong>{formatMoney(balances.creditAvailableCents, credit?.currency)}</strong><small>Après : {formatMoney(balances.creditAvailableCents + (reverse ? amountCents : -amountCents), credit?.currency)}</small></div></div>}
      {(problem?.field === 'record' || visibleActionError) && <div className="credit-allocation-alert" role="alert" tabIndex={-1}><strong>Vérifions ce point</strong><p>{problem?.field === 'record' ? problem.message : rawProblem}</p>{visibleActionError && <details><summary>Voir le message détaillé</summary><p>{visibleActionError}</p></details>}{/période|exercice|clôtur|clotur|fermée/i.test(visibleActionError) && <><p>Retrouvez ensuite cet avoir dans Achats → Factures et avoirs.</p><Button type="button" variant="secondary" disabled={locked} onClick={onOpenAccounting}>Ouvrir les exercices</Button></>}</div>}
      <Button type="button" variant="ghost" disabled={locked} onClick={() => void refresh()}>Actualiser les soldes</Button>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={() => { if (review !== null) { setReview(null); setProblem(null); } else onClose(); }}>{review !== null ? 'Modifier' : 'Retour'}</Button><Button type="submit" variant={reverse && review !== null && !changed ? 'danger' : 'primary'} disabled={editingDisabled}>{pending ? 'Vérification…' : review === null ? 'Vérifier les soldes' : changed ? 'Reprendre la vérification' : reverse ? 'Confirmer l’annulation' : 'Confirmer l’utilisation'}</Button></div>
    </form>
  </Modal>;
}

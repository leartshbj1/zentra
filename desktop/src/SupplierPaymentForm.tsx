import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { desktopApi } from './bridge';
import type { SupplierInvoice, Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { t, useAppLanguage } from './language';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { creditAmountInput } from './creditAllocationWorkflow';
import { requireSupplierPaymentWorkspace, supplierPaymentAmount, supplierPaymentNativeProblem, supplierPaymentProblem, supplierPaymentReviewKey, type SupplierPaymentDraft, type SupplierPaymentProblem, type SupplierPaymentResume } from './supplierPaymentWorkflow';
import './supplier-payment.css';

export function SupplierPaymentForm({ invoice: initialInvoice, workspace, busy, readOnly = false, resume, close, act, onReadWorkspace, onOpenAccounting }: {
  invoice: SupplierInvoice; workspace: Workspace; busy: boolean; readOnly?: boolean; resume?: SupplierPaymentResume; close: () => void;
  act: (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
  onReadWorkspace: () => Promise<Workspace>;
  onOpenAccounting: (section: 'accounts' | 'periods', resume: SupplierPaymentResume) => void;
}) {
  const language = useAppLanguage();
  const invoice = workspace.supplierInvoices.find(row => row.id === initialInvoice.id);
  const [requestId] = useState(() => resume?.requestId ?? createId());
  const [draft, setDraft] = useState<SupplierPaymentDraft>(() => resume?.draft ?? { amount: creditAmountInput(invoice?.balanceCents ?? 0), date: todayIso(), method: 'bank_transfer', reference: '', notes: '' });
  const [baseline] = useState(() => JSON.stringify(draft));
  const [review, setReview] = useState<string | null>(null), [problem, setProblem] = useState<SupplierPaymentProblem | null>(null), [serverError, setServerError] = useState(''), [pending, setPending] = useState(false);
  const flight = useRef(false), form = useRef<HTMLFormElement>(null);
  const locked = busy || pending, disabled = locked || readOnly;
  const bank = workspace.accounts.find(row => row.id === workspace.accountingSettings?.bankAccountId);
  const amount = supplierPaymentAmount(draft.amount), key = supplierPaymentReviewKey(invoice, workspace, draft);
  const changed = review !== null && review !== key;
  const recorded = invoice?.payments.find(row => row.requestId === requestId);
  const balance = invoice?.balanceCents;
  const validPreview = typeof balance === 'number' && amount !== null && amount <= balance;
  const preflight = supplierPaymentProblem(invoice, workspace, draft, todayIso());
  const visibleProblem = problem || (preflight?.field === 'record' ? preflight : null);
  function revealField(target: HTMLElement) {
    if (!target.matches('input, select, textarea')) return;
    requestAnimationFrame(() => {
      const anchor = target.closest('.field'), body = form.current?.closest('.modal__body');
      if (anchor && body) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
    });
  }
  useEffect(() => {
    if (!visibleProblem || locked || recorded) return;
    const frame = requestAnimationFrame(() => {
      const node = form.current?.querySelector<HTMLElement>(`[name="${visibleProblem.field}"]`) ?? form.current?.querySelector<HTMLElement>('.supplier-payment__problem');
      const disclosure = node?.closest('details'); if (disclosure) disclosure.open = true;
      node?.focus({ preventScroll: true });
      const anchor = node?.closest('.field') || node, body = form.current?.closest('.modal__body');
      if (anchor && body) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleProblem?.field, visibleProblem?.message, language, locked, recorded]);
  function update(patch: Partial<SupplierPaymentDraft>) { setDraft(row => ({ ...row, ...patch })); setProblem(null); setServerError(''); }
  function requestClose() { if (!locked && (recorded || (!resume && baseline === JSON.stringify(draft)) || window.confirm(t('Fermer sans enregistrer ce paiement ? Les informations saisies seront perdues.')))) close(); }
  async function refresh() {
    if (locked || flight.current) return;
    flight.current = true; setPending(true);
    try { requireSupplierPaymentWorkspace(await onReadWorkspace()); setProblem(null); setServerError(''); }
    catch (cause) { setProblem({ field: 'record', message: 'Les achats n’ont pas pu être actualisés. Votre saisie est conservée. Réessayez l’actualisation.' }); setServerError(errorMessage(cause, 'Lecture indisponible.')); }
    finally { flight.current = false; setPending(false); }
  }
  async function submit() {
    if (disabled || flight.current || recorded) return;
    const issue = supplierPaymentProblem(invoice, workspace, draft, todayIso());
    if (issue) { setReview(null); setProblem(issue); setServerError(''); return; }
    if (review === null || changed) {
      setReview(key); setProblem(null); setServerError('');
      requestAnimationFrame(() => { form.current?.closest('.modal__body')?.scrollTo({ top: 0 }); form.current?.querySelector<HTMLElement>('.supplier-payment__review')?.focus({ preventScroll: true }); });
      return;
    }
    if (!invoice || amount === null) return;
    flight.current = true; setPending(true); setServerError(''); setProblem(null);
    const failed = (cause: unknown) => { const source = errorMessage(cause, 'Le paiement n’a pas pu être confirmé.'); setServerError(source); setProblem(supplierPaymentNativeProblem(source)); setReview(null); };
    try {
      await act(() => desktopApi.recordSupplierPayment({ requestId, supplierInvoiceId: invoice.id, amountCents: amount, date: draft.date, method: draft.method, reference: draft.reference.trim(), notes: draft.notes.trim() }), t(amount === balance ? 'La facture fournisseur est entièrement payée.' : 'Le paiement partiel a été enregistré.'), true, failed);
    } catch (cause) { failed(cause); }
    finally { flight.current = false; setPending(false); }
  }
  const fieldError = (field: SupplierPaymentProblem['field']) => visibleProblem?.field === field ? t(visibleProblem.message) : undefined;
  return <Modal title={t('Paiement fournisseur')} description={`${invoice?.reference || initialInvoice.reference} · ${invoice?.supplierName || initialInvoice.supplierName}`} className="supplier-payment-modal" onClose={requestClose} dismissible={!locked}>
    {recorded ? <><div className="supplier-payment__success" role="status"><CheckCircle2 size={22} /><p>{t('Le paiement de {amount} du {date} est bien enregistré.', { amount: formatMoney(recorded.amountCents), date: formatDate(recorded.date) })}</p></div><Button onClick={close}>{t('Terminer')}</Button></> : <form ref={form} noValidate onFocusCapture={event => revealField(event.target)} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <ol className="supplier-payment__steps" aria-label={t('Étapes du paiement')}><li aria-current={review === null ? 'step' : undefined}>1 · {t('Paiement effectué')}</li><li aria-current={review !== null ? 'step' : undefined}>2 · {t('Vérifier')}</li></ol>
      {review === null ? <>
        <p className="supplier-payment__intro">{t('Recopiez le paiement déjà effectué au fournisseur. Vous pouvez enregistrer une partie du montant ; le reste demeurera à payer.')}</p>
        <fieldset disabled={disabled}>
          <div className="form-grid">
            <Field label={t('Montant payé (CHF)')} required error={fieldError('amount')} hint={t('Le solde est proposé. Modifiez-le si vous avez payé seulement une partie.')}><input name="amount" inputMode="decimal" value={draft.amount} onChange={event => update({ amount: event.target.value })} aria-invalid={Boolean(fieldError('amount'))} /></Field>
            <Field label={t('Date du paiement')} required error={fieldError('date')} hint={t('Recopiez la date du débit bancaire ou du reçu.')}><input name="date" type="date" min={invoice?.documentDate} max={todayIso()} value={draft.date} onChange={event => update({ date: event.target.value })} aria-invalid={Boolean(fieldError('date'))} /></Field>
          </div>
          {balance !== undefined && balance > 0 && <Button type="button" variant="ghost" onClick={() => update({ amount: creditAmountInput(balance) })}>{t('Utiliser le solde : {amount}', { amount: formatMoney(balance) })}</Button>}
          <Field label={t('Mode de paiement')} required error={fieldError('method')} hint={t('Ce choix décrit le paiement. Le compte comptable utilisé est indiqué dans le résumé.')}><select name="method" value={draft.method} onChange={event => update({ method: event.target.value })}>{[['bank_transfer', 'Virement bancaire'], ['card', 'Carte'], ['cash', 'Espèces'], ['other', 'Autre']].map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></Field>
          <details className="supplier-payment__optional"><summary>{t('Référence et note · facultatif')}</summary><div className="form-grid">
            <Field label={t('Référence')} wide error={fieldError('reference')}><input name="reference" value={draft.reference} maxLength={200} onChange={event => update({ reference: event.target.value })} /></Field>
            <Field label={t('Note')} wide error={fieldError('notes')}><textarea name="notes" rows={3} maxLength={2000} value={draft.notes} onChange={event => update({ notes: event.target.value })} /></Field>
          </div></details>
        </fieldset>
      </> : <section className="supplier-payment__review" tabIndex={-1}>
        <h3>{t('Vérifiez le paiement effectué')}</h3><strong>{amount === null ? t('À vérifier') : formatMoney(amount)}</strong><p>{formatDate(draft.date)} · {t(({ bank_transfer: 'Virement bancaire', card: 'Carte', cash: 'Espèces', other: 'Autre' } as Record<string, string>)[draft.method] || 'Autre')}</p>
        {changed && <p role="alert">{t('La facture ou le compte a changé. Relisez ce résumé puis reprenez la vérification.')}</p>}
      </section>}
      <dl className="supplier-payment__summary">
        <div><dt>{t('Reste à payer')}</dt><dd>{balance === undefined ? t('À vérifier') : formatMoney(balance)}</dd>{validPreview && <small>{t('Après ce paiement : {amount}', { amount: formatMoney(balance! - amount!) })}</small>}</div>
        <div><dt>{t('Compte utilisé')}</dt><dd>{bank ? `${bank.code} · ${bank.name}` : t('À configurer')}</dd></div>
        {invoice && invoice.creditedCents > 0 && <div><dt>{t('Avoirs déjà déduits')}</dt><dd>{formatMoney(invoice.creditedCents)}</dd></div>}
      </dl>
      {review !== null && <div>{draft.reference && <p>{draft.reference}</p>}{draft.notes && <p className="supplier-payment__note">{draft.notes}</p>}</div>}
      <p className="supplier-payment__intro">{t('Zentra enregistre le règlement et l’écriture comptable ensemble. Aucun virement n’est envoyé à la banque.')}</p>
      {visibleProblem?.field === 'record' && <div className="supplier-payment__problem" role="alert" tabIndex={-1}><strong>{t('Vérifions le paiement')}</strong><p>{t(visibleProblem.message)}</p>{serverError && <details><summary>{t('Voir le message détaillé')}</summary><p>{serverError}</p></details>}{visibleProblem.section && <Button type="button" variant="secondary" disabled={locked} onClick={() => onOpenAccounting(visibleProblem.section!, { requestId, draft: { ...draft } })}>{t(visibleProblem.section === 'periods' ? 'Vérifier l’exercice comptable' : 'Ouvrir Plan & liaisons')}</Button>}</div>}
      {readOnly && <p role="status">{t('Mode lecture seule : les modifications ne peuvent pas être enregistrées.')}</p>}
      <Button type="button" variant="ghost" disabled={locked} onClick={() => void refresh()}>{t('Actualiser les achats')}</Button>
      <div className="supplier-payment__actions"><Button type="button" variant="secondary" disabled={locked} onClick={() => review !== null ? setReview(null) : requestClose()}>{t(review !== null ? 'Modifier' : 'Annuler')}</Button><Button type="submit" disabled={disabled || visibleProblem?.field === 'record'}>{t(locked ? 'Vérification…' : review === null ? 'Vérifier le paiement' : changed ? 'Reprendre la vérification' : amount === balance ? 'Enregistrer et solder' : 'Enregistrer le paiement')}</Button></div>
    </form>}
  </Modal>;
}

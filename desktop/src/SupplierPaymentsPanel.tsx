import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { PaymentChecksDialog, PaymentFindings, type FlaggedPayment } from './PaymentSafetyParts';
import { approvalText, findingTitle, reviewFor, type PaymentReview } from './paymentSafety';
import { formatPaymentReference, formatIban } from './swissQrBill';
import { defaultSelection, nextBankDay, payableInvoices, prepareSupplierPaymentOrder, type PayableInvoice } from './supplierPaymentOrder';
import type { Supplier, SupplierInvoice, Workspace } from './types';
import { Button, EmptyState, ErrorPanel } from './ui';
import { usePaymentSafety } from './usePaymentSafety';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import './supplier-payments.css';

type Props = {
  workspace: Workspace;
  busy: boolean;
  readOnly: boolean;
  runAction: (action: () => Promise<Workspace>, successMessage: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
  onOpenSupplierInvoice: (invoice: SupplierInvoice) => void;
  onEditSupplier: (supplier: Supplier) => void;
};

function invoiceCount(count: number, amountCents: number): string {
  return count === 1
    ? t('1 facture · {amount}', { amount: formatMoney(amountCents) })
    : t('{count} factures · {amount}', { count, amount: formatMoney(amountCents) });
}

function paymentSource(row: PayableInvoice): string {
  const details = row.invoice.paymentDetails;
  if (details?.referenceType === 'QRR' || details?.referenceType === 'SCOR') {
    return t('QR-facture · référence {reference}', { reference: formatPaymentReference(details.referenceType, details.reference) });
  }
  if (details) return t('QR-facture · IBAN {iban}', { iban: formatIban(details.creditorIban) });
  return t('IBAN de la fiche · {iban}', { iban: formatIban(row.line?.creditor.iban ?? '') });
}

/** Un paiement au-dessus du seuil attend l'approbation d'une deuxième personne. */
const awaitsApproval = (review: PaymentReview | undefined) => !!review && review.approval.required && !review.approval.covered;

/** « À payer » : choisir les factures, puis enregistrer un ordre pain.001 pour l'e-banking. */
export function SupplierPaymentsPanel({ workspace, busy, readOnly, runAction, onOpenSupplierInvoice, onEditSupplier }: Props) {
  useAppLanguage();
  const today = todayIso();
  const rows = useMemo(() => payableInvoices(workspace), [workspace]);
  const { overview: safety, refresh: refreshSafety } = usePaymentSafety(workspace);
  const [selected, setSelected] = useState<string[]>(() => defaultSelection(rows, today));
  const [executionDate, setExecutionDate] = useState(() => nextBankDay(today));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<{ path: string; warning?: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const chosen = rows.filter((row) => row.line && selected.includes(row.invoice.id) && !awaitsApproval(reviewFor(safety, row.invoice.id)));
  const totalCents = chosen.reduce((sum, row) => sum + row.invoice.balanceCents, 0);
  const companyIban = workspace.settings?.billing.iban ?? '';
  const orders = workspace.supplierPaymentOrders ?? [];
  const disabled = busy || readOnly || working;
  const flagged: FlaggedPayment[] = chosen.flatMap((row) => {
    const review = reviewFor(safety, row.invoice.id);
    return review?.findings.length ? [{ invoice: row.invoice, review }] : [];
  });

  function toggle(id: string) {
    setSaved(null);
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  async function decide(run: () => Promise<unknown>, message: string) {
    if (disabled) return;
    setWorking(true); setError(''); setNotice('');
    try {
      await run();
      await refreshSafety();
      setNotice(message);
    } catch (reason) {
      setError(errorMessage(reason, t('Le paiement n’a pas pu être mis à jour.')));
    } finally { setWorking(false); }
  }

  function generate() {
    if (disabled) return;
    setError(''); setSaved(null);
    if (flagged.length) { setChecking(true); return; }
    void exportOrder([]);
  }

  async function exportOrder(acknowledged: { supplierInvoiceId: string; kinds: string[] }[]) {
    const ids = chosen.map((row) => row.invoice.id);
    const order = prepareSupplierPaymentOrder(workspace, rows, ids, executionDate, new Date(), createId().replace(/-/g, '').slice(0, 6).toUpperCase());
    if (!order.ok) {
      setChecking(false);
      setError(order.reason === 'company_iban'
        ? t('Ajoutez d’abord l’IBAN de l’entreprise dans Réglages, rubrique Facturation.')
        : order.reason === 'nothing_selected'
          ? t('Cochez au moins une facture à payer.')
          : t('Une facture ne peut pas être payée par ordre. Ouvrez-la pour vérifier l’IBAN et la référence.'));
      return;
    }
    setWorking(true);
    try {
      const result = await desktopApi.exportSupplierPaymentOrder({ ...order, acknowledged });
      if (!result) return;
      await runAction(async () => result.workspace, t('L’ordre de paiement est enregistré.'));
      setSaved({ path: result.path, warning: result.deliveryWarning });
      setSelected([]);
      setChecking(false);
    } catch (reason) {
      setChecking(false);
      setError(errorMessage(reason, t('L’ordre de paiement n’a pas pu être enregistré.')));
    } finally {
      setWorking(false);
    }
  }

  if (rows.length === 0) {
    return <EmptyState title={t('Rien à payer')} text={t('Les factures fournisseurs validées et non payées apparaîtront ici.')} />;
  }

  const mayApprove = safety?.actor.mayApprove ?? false;
  return <section className="supplier-payments" aria-labelledby="supplier-payments-title">
    <header className="supplier-payments__header">
      <div>
        <h3 id="supplier-payments-title">{t('Factures à payer')}</h3>
        <p>{t('Cochez les factures, choisissez la date, puis enregistrez l’ordre de paiement.')}</p>
      </div>
    </header>

    <ul className="supplier-payments__list" aria-label={t('Factures à payer')}>
      {rows.map((row) => {
        const { invoice, supplier } = row;
        const late = invoice.dueDate < today;
        const id = `pay-${invoice.id}`;
        const review = reviewFor(safety, invoice.id);
        const approval = review?.approval;
        const waiting = awaitsApproval(review);
        const approvalLine = approval && safety ? approvalText(approval, safety.settings) : '';
        const open = expanded === invoice.id;
        return <li key={invoice.id} className={row.line && !waiting ? '' : 'is-blocked'}>
          <input id={id} type="checkbox" checked={selected.includes(invoice.id) && !waiting} disabled={disabled || !row.line || waiting} onChange={() => toggle(invoice.id)} />
          <label htmlFor={id}>
            <strong>{invoice.supplierName}</strong>
            <span>{invoice.reference || t('Sans numéro')} · {late ? t('échue depuis le {date}', { date: formatDate(invoice.dueDate) }) : t('échéance {date}', { date: formatDate(invoice.dueDate) })}</span>
            <small>{row.line ? paymentSource(row) : t('IBAN manquant : complétez la fiche du fournisseur ou lisez sa QR-facture.')}</small>
            {row.lastOrderDate && <small>{t('Déjà dans l’ordre du {date}', { date: formatDate(row.lastOrderDate) })}</small>}
            {review && review.findings.length > 0 && <small className="supplier-payments__check"><span>{t('À vérifier')}</span> {review.findings.map(findingTitle).join(' · ')}</small>}
            {approvalLine && <small className="supplier-payments__approval">{approvalLine}</small>}
          </label>
          <span className="supplier-payments__amount">{formatMoney(invoice.balanceCents)}</span>
          {open && review && <div className="supplier-payments__detail"><PaymentFindings review={review} /></div>}
          <div className="supplier-payments__actions">
            {!row.line && supplier && <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => onEditSupplier(supplier)}>{t('Compléter la fiche')}</Button>}
            {review && review.findings.length > 0 && <Button type="button" variant="ghost" size="small" aria-expanded={open} onClick={() => setExpanded(open ? null : invoice.id)}>{open ? t('Masquer le détail') : t('Voir le détail')}</Button>}
            {waiting && !approval?.status && <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => void decide(() => desktopApi.prepareSupplierPayment(invoice.id), t('Paiement préparé. Une deuxième personne peut maintenant l’approuver.'))}>{t('Demander l’approbation')}</Button>}
            {approval?.status === 'prepared' && !approval.refusal && <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => void decide(() => desktopApi.approveSupplierPayment(invoice.id), t('Paiement approuvé.'))}>{t('Approuver')}</Button>}
            {approval?.status === 'prepared' && (approval.preparedByMe || mayApprove) && <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => void decide(() => desktopApi.withdrawSupplierPaymentPreparation(invoice.id), t('Demande d’approbation retirée.'))}>{t('Retirer la demande')}</Button>}
            {approval?.status === 'approved' && mayApprove && <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => void decide(() => desktopApi.revokeSupplierPaymentApproval(invoice.id), t('Approbation annulée.'))}>{t('Annuler l’approbation')}</Button>}
            {approval?.status === 'approved' && approval.stale && <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => void decide(() => desktopApi.prepareSupplierPayment(invoice.id), t('Paiement préparé. Une deuxième personne peut maintenant l’approuver.'))}>{t('Demander l’approbation')}</Button>}
            <Button type="button" variant="ghost" size="small" onClick={() => onOpenSupplierInvoice(invoice)}>{t('Voir')}</Button>
          </div>
        </li>;
      })}
    </ul>

    <footer className="supplier-payments__footer">
      <label className="supplier-payments__date">
        <span>{t('Date de paiement')}</span>
        <input type="date" value={executionDate} min={today} disabled={disabled} onChange={(event) => { setSaved(null); setExecutionDate(event.target.value); }} />
      </label>
      <p aria-live="polite">{chosen.length
        ? invoiceCount(chosen.length, totalCents)
        : t('Aucune facture cochée')}</p>
      <Button type="button" disabled={disabled || chosen.length === 0 || !executionDate} onClick={generate}>
        {working ? t('Préparation…') : t('Générer l’ordre de paiement')}
      </Button>
    </footer>
    {!companyIban && <p className="supplier-payments__note">{t('L’ordre débite le compte de l’entreprise : ajoutez son IBAN dans Réglages, rubrique Facturation.')}</p>}
    {notice && <p className="supplier-payments__note" role="status">{notice}</p>}
    {saved && <p className="supplier-payments__note" role="status">{t('Fichier enregistré : {path}. Déposez-le dans votre e-banking.', { path: saved.path })}{saved.warning ? ` ${saved.warning}` : ''}</p>}
    {error && <ErrorPanel title={t('Ordre de paiement à reprendre')} message={error} />}

    {checking && flagged.length > 0 && <PaymentChecksDialog
      flagged={flagged}
      busy={working}
      onCancel={() => setChecking(false)}
      onRemove={(invoiceId) => {
        setSelected((current) => current.filter((value) => value !== invoiceId));
        if (flagged.every((row) => row.invoice.id === invoiceId)) setChecking(false);
      }}
      onConfirm={(acknowledged) => void exportOrder(acknowledged)}
    />}

    {orders.length > 0 && <details className="supplier-payments__history">
      <summary>{t('Ordres préparés ({count})', { count: orders.length })}</summary>
      <ul>
        {orders.slice(0, 20).map((order) => <li key={order.id}>
          <span>{formatDate(order.createdAt.slice(0, 10))} · {order.fileName}</span>
          <span>{invoiceCount(order.transactionCount, order.totalCents)}</span>
        </li>)}
      </ul>
    </details>}
  </section>;
}

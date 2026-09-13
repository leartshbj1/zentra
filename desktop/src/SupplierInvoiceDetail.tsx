import { useId, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote, CheckCircle2, FileText, RefreshCw } from 'lucide-react';
import type { SupplierInvoice, Workspace } from './types';
import { Button, Modal } from './ui';
import { SupplierInvoiceAttachments } from './SupplierInvoiceAttachments';
import { t, useAppLanguage, getAppLocale } from './language';
import { errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { requireSupplierPaymentWorkspace } from './supplierPaymentWorkflow';
import { supplierInvoiceDetailState, supplierPaymentMethodSource } from './supplierInvoiceHistory';
import './supplier-invoice-detail.css';

const sections = ['Résumé', 'Documents', 'Historique'] as const;
export function SupplierInvoiceDetail({ invoice: openedInvoice, workspace, busy, readOnly = false, initialSection = 0, close, onPayment, onReadWorkspace, onOpenCredit }: {
  invoice: SupplierInvoice; workspace: Workspace; busy: boolean; readOnly?: boolean; close: () => void; onPayment: () => void;
  onReadWorkspace: () => Promise<Workspace>; onOpenCredit: (creditId: string) => void;
  initialSection?: number;
}) {
  useAppLanguage();
  const [section, setSection] = useState(initialSection), [pending, setPending] = useState(false), [readError, setReadError] = useState('');
  const [lineLimit, setLineLimit] = useState(20), [historyLimit, setHistoryLimit] = useState(20);
  const flight = useRef(false), tabs = useRef<HTMLDivElement>(null), id = useId();
  const invoice = workspace.supplierInvoices.find(row => row.id === openedInvoice.id);
  const locked = busy || pending;
  async function refresh() {
    if (locked || flight.current) return;
    flight.current = true; setPending(true); setReadError('');
    try { requireSupplierPaymentWorkspace(await onReadWorkspace()); }
    catch (cause) { setReadError(errorMessage(cause, 'Lecture indisponible.')); }
    finally { flight.current = false; setPending(false); }
  }
  const refreshButton = <Button type="button" variant="secondary" disabled={locked} onClick={() => void refresh()}><RefreshCw size={16} className={pending ? 'spin' : undefined} />{t(pending ? 'Actualisation…' : 'Actualiser les achats')}</Button>;
  const refreshProblem = readError && <div className="supplier-file__notice" role="alert"><p>{t('La lecture de cette facture est interrompue. Réessayez l’actualisation ; aucun paiement n’a été créé.')}</p><details><summary>{t('Voir le message détaillé')}</summary><p>{readError}</p></details></div>;
  if (!invoice) return <Modal title={t('Facture fournisseur indisponible')} onClose={close}><p>{t('Cette facture n’est plus dans les données chargées. Actualisez les achats pour retrouver son état actuel.')}</p>{refreshProblem}{refreshButton}<Button variant="ghost" onClick={close}>{t('Fermer')}</Button></Modal>;
  const state = supplierInvoiceDetailState(invoice, workspace.supplierCreditNotes);
  const project = workspace.projects.find(row => row.id === invoice.projectId);
  const overdue = invoice.documentStatus === 'validated' && invoice.balanceCents > 0 && invoice.dueDate < todayIso();
  function select(index: number, focus = false) { setSection(index); if (focus) tabs.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[index]?.focus(); }
  const payAvailable = invoice.documentStatus === 'validated' && state.validBalance && state.historyComplete && invoice.balanceCents > 0;
  return <Modal title={t('Facture fournisseur')} description={invoice.reference || t('Sans référence')} className="supplier-file-modal" onClose={close} dismissible={!locked} wide>
    <div ref={tabs} className="supplier-file__tabs" role="tablist" aria-label={t('Consulter la facture')}>
      {sections.map((label, index) => <button type="button" key={label} role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={index === section} tabIndex={index === section ? 0 : -1} onClick={() => select(index)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null;
        if (next !== null) { event.preventDefault(); select(next, true); }
      }}>{t(label)}</button>)}
    </div>
    {refreshProblem}
    {(!state.validBalance || !state.historyComplete) && <div className="supplier-file__notice" role="alert"><strong>{t('Vérifions les données de cette facture')}</strong><p>{t(!state.validBalance ? 'Le total, les paiements, les avoirs et le solde ne concordent pas. Actualisez les achats avant d’enregistrer un autre paiement.' : 'Une partie des paiements ou des avoirs manque dans l’historique chargé. Actualisez les achats pour retrouver le détail du solde.')}</p>{refreshButton}</div>}
    {sections.map((_label, panel) => <section key={panel} hidden={panel !== section} className="supplier-file__panel" role="tabpanel" tabIndex={0} id={`${id}-panel-${panel}`} aria-labelledby={`${id}-tab-${panel}`}>
      {section === panel && panel === 0 && <>
        <div className={`supplier-file__balance ${overdue ? 'is-overdue' : ''}`}><span>{t(state.settled ? 'Facture soldée' : invoice.documentStatus === 'draft' ? 'Brouillon à vérifier' : 'Reste à payer')}</span><strong>{state.validBalance ? formatMoney(invoice.balanceCents) : t('À vérifier')}</strong><p>{t(state.settled ? 'Les paiements et les avoirs couvrent le total de cette facture.' : invoice.documentStatus === 'draft' ? 'Validez le brouillon avant d’enregistrer un paiement.' : overdue ? 'L’échéance est dépassée. Vérifiez si le fournisseur a déjà été payé.' : 'Enregistrez un paiement seulement après avoir réglé le fournisseur.')}</p></div>
        <dl className="supplier-file__calculation" aria-label={t('Calcul du solde')}><div><dt>{t('Total de la facture')}</dt><dd>{formatMoney(invoice.totalCents)}</dd></div><div><dt>{t('Paiements enregistrés')}</dt><dd>{formatMoney(invoice.paidCents)}</dd></div><div><dt>{t('Avoirs déduits')}</dt><dd>{formatMoney(invoice.creditedCents)}</dd></div><div><dt>{t('Reste à payer')}</dt><dd>{state.validBalance ? formatMoney(invoice.balanceCents) : t('À vérifier')}</dd></div></dl>
        <p className="supplier-file__hint">{t('Total de la facture − paiements − avoirs = reste à payer.')}</p>
        <div className="supplier-file__identity"><h3>{invoice.supplierName}</h3><p>{invoice.reference || t('Sans référence')}</p></div>
        <dl className="supplier-file__facts"><div><dt>{t('Date de facture')}</dt><dd>{formatDate(invoice.documentDate)}</dd></div><div><dt>{t('Échéance')}</dt><dd>{formatDate(invoice.dueDate)}</dd></div><div><dt>{t('Projet')}</dt><dd>{project?.name || t('Aucun projet')}</dd></div></dl>
        {invoice.note && <section className="supplier-file__note"><h3>{t('Note de la facture')}</h3><p>{invoice.note}</p></section>}
      </>}
      {section === panel && panel === 1 && <>
        <SupplierInvoiceAttachments invoice={invoice} canEdit={false} busy={locked} />
        <section className="supplier-file__lines"><h3>{t('Achats de cette facture')}</h3><p>{t('Les montants ci-dessous sont ceux du document enregistré.')}</p>
          {invoice.lines.length ? <><ul>{invoice.lines.slice(0, lineLimit).map(line => <li key={line.id}><div className="supplier-file__line-heading"><strong>{line.description}</strong><strong>{formatMoney(line.totalCents)}</strong></div><p>{(line.quantityMilli / 1000).toLocaleString(getAppLocale())} {line.unit} · {line.category}</p><dl><div><dt>{t('Hors TVA')}</dt><dd>{formatMoney(line.netCents)}</dd></div><div><dt>{t('TVA facturée')}</dt><dd>{formatMoney(line.vatCents)}</dd></div></dl></li>)}</ul>{invoice.lines.length > lineLimit && <Button variant="secondary" onClick={() => setLineLimit(limit => limit + 20)}>{t('Afficher les achats suivants')}</Button>}</> : <p>{t('Les lignes de cette facture ne sont pas disponibles. Actualisez les achats.')}</p>}
        </section>
      </>}
      {section === panel && panel === 2 && <section className="supplier-file__history"><h3>{t('Paiements et avoirs')}</h3><p>{t('Les opérations les plus récentes apparaissent d’abord. Un avoir réduit ce que vous devez ; ce n’est pas un paiement envoyé.')}</p>
        {state.history.length ? <><ol>{state.history.slice(0, historyLimit).map(event => <li key={event.id} data-event-id={event.id}>
          <span className="supplier-file__event-icon" aria-hidden="true">{event.kind === 'payment' ? <Banknote size={19} /> : event.kind === 'credit' ? <ArrowDownLeft size={19} /> : <ArrowUpRight size={19} />}</span>
          <div><div className="supplier-file__event-heading"><strong>{t(event.kind === 'payment' ? 'Paiement enregistré' : event.kind === 'credit' ? 'Avoir utilisé' : 'Utilisation d’avoir annulée')}</strong><strong>{formatMoney(event.amountCents)}</strong></div>
            <p className="supplier-file__event-date">{event.date ? formatDate(event.date) : t('Date de l’opération non renseignée')}</p>
            <small>{t(event.kind === 'credit_reversal' ? 'Ce montant est revenu dans le solde à payer.' : event.kind === 'credit' ? 'Ce montant a été déduit du solde à payer.' : 'Ce montant a été réglé au fournisseur.')}</small>
            {event.method && <p>{supplierPaymentMethodSource(event.method) ? t(supplierPaymentMethodSource(event.method)!) : event.method}</p>}
            {event.reference && <p>{event.reference}</p>}{event.note && <p className="supplier-file__note-text">{event.note}</p>}
            {event.creditId && <Button type="button" variant="ghost" disabled={locked} onClick={() => onOpenCredit(event.creditId!)}><FileText size={15} />{t('Voir cet avoir')}</Button>}
          </div>
        </li>)}</ol>{state.history.length > historyLimit && <Button variant="secondary" onClick={() => setHistoryLimit(limit => limit + 20)}>{t('Afficher les opérations suivantes')}</Button>}</> : <div className="supplier-file__empty"><CheckCircle2 size={24} /><p>{t('Aucun paiement ni avoir n’a encore été enregistré pour cette facture.')}</p></div>}
      </section>}
    </section>)}
    {readOnly && <p className="supplier-file__hint" role="status">{t('Mode lecture seule : les modifications ne peuvent pas être enregistrées.')}</p>}
    <footer className="supplier-file__actions"><Button type="button" variant="secondary" disabled={locked} onClick={close}>{t('Fermer')}</Button>{payAvailable && <Button type="button" disabled={locked || readOnly} onClick={onPayment}><Banknote size={16} />{t('Enregistrer un paiement')}</Button>}{!payAvailable && state.validBalance && state.historyComplete && refreshButton}</footer>
  </Modal>;
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Banknote, CheckCircle2, Paperclip } from 'lucide-react';
import type { SupplierInvoice, Workspace } from './types';
import { Button, Modal } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import { t, getAppLocale, useAppLanguage } from './language';
import { supplierReviewContext, supplierReviewCorrection, supplierReviewKey, supplierReviewPreflight, supplierReviewProblem, type SupplierReviewTarget } from './supplierInvoiceReview';
import './supplier-review.css';

export function SupplierInvoiceReviewDialog({ invoice, workspace, busy, readOnly, close, onConfirm, onResolve, onPayment }: {
  invoice: SupplierInvoice; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void;
  onConfirm: (invoice: SupplierInvoice, reviewKey: string) => Promise<void>; onResolve: (target: SupplierReviewTarget) => void; onPayment: () => void;
}) {
  useAppLanguage();
  const key = supplierReviewKey(invoice, workspace);
  const [reviewedKey, setReviewedKey] = useState(key), [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ key: string; source: string } | null>(null);
  const [consent, setConsent] = useState({ key, withoutAttachment: false, standalone: false });
  const [lineLimit, setLineLimit] = useState(20), [orderLimit, setOrderLimit] = useState(10);
  const inFlight = useRef(false), form = useRef<HTMLFormElement>(null);
  const previousKey = useRef(key);
  useLayoutEffect(() => {
    if (previousKey.current === key) return;
    previousKey.current = key;
    setConsent({ key, withoutAttachment: false, standalone: false });
    setReviewedKey(''); setFailure(null);
  }, [key]);
  const locked = busy || saving, complete = invoice.documentStatus === 'validated';
  const completed = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!complete) return;
    const body = completed.current?.closest('.modal__body');
    if (body) body.scrollTop = 0;
    completed.current?.querySelector<HTMLElement>('.supplier-review__total')?.focus({ preventScroll: true });
  }, [complete]);
  const context = supplierReviewContext(invoice, workspace);
  const preflight = supplierReviewPreflight(invoice, workspace);
  const error = failure?.key === key ? failure.source : '';
  const rawProblem = preflight || (error ? supplierReviewProblem(error) : null);
  const problem = rawProblem && supplierReviewCorrection(rawProblem, context.matches.length > 0);
  const changed = reviewedKey !== key;
  const withoutAttachment = consent.key === key && consent.withoutAttachment;
  const standalone = consent.key === key && consent.standalone;
  const needsAttachmentChoice = !invoice.attachments.length && !withoutAttachment;
  const needsOrderChoice = context.standaloneChoice && !standalone;
  const canConfirm = !preflight && !changed && !needsAttachmentChoice && !needsOrderChoice;
  function approve(patch: Partial<Pick<typeof consent, 'withoutAttachment' | 'standalone'>>) {
    setConsent({ key, withoutAttachment, standalone, ...patch });
  }
  function reveal(selector: string) {
    const node = form.current?.querySelector<HTMLElement>(selector);
    if (!node) return;
    node.style.scrollMarginBlockEnd = String((form.current?.querySelector('.form-actions')?.getBoundingClientRect().height || 0) + 20) + 'px';
    node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'nearest' });
  }
  useEffect(() => { if (error && !locked && !complete) reveal('.supplier-review__problem'); }, [error, locked, complete]);
  const nextAction = preflight && problem ? problem.action : changed ? 'Relire la facture' : needsAttachmentChoice ? 'Vérifier le justificatif' : needsOrderChoice ? 'Vérifier les commandes' : null;
  function next() {
    if (locked || readOnly || inFlight.current) return;
    if (preflight && problem) { onResolve(problem.target); return; }
    if (changed) { setReviewedKey(key); setConsent({ key, withoutAttachment: false, standalone: false }); reveal('.supplier-review__total'); return; }
    reveal(needsAttachmentChoice ? '[name=withoutAttachment]' : '[name=standalone]');
  }
  return <Modal title={t(complete ? 'Facture fournisseur validée' : 'Vérifier la facture fournisseur')} description={(invoice.reference || t('Référence à compléter')) + ' · ' + invoice.supplierName} onClose={close} dismissible={!locked} className="supplier-review-modal">
    {complete ? <div className="supplier-review" ref={completed}>
      <div className="supplier-review__total" tabIndex={-1}><span>{t('Reste à payer')}</span><strong>{formatMoney(invoice.balanceCents)}</strong></div>
      <div className="supplier-review__success" role="status"><CheckCircle2 size={25} /><strong>{t('La facture est enregistrée en comptabilité.')}</strong><p>{t('Le document et ses justificatifs sont verrouillés. Cette validation ne crée aucun paiement.')}</p></div>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={close}>{t('Terminer')}</Button>{invoice.balanceCents > 0 && <Button type="button" disabled={locked || readOnly} onClick={onPayment}><Banknote size={17} />{t('Enregistrer un paiement')}</Button>}</div>
    </div> : <form className="supplier-review" ref={form} onSubmit={async event => {
      event.preventDefault();
      if (locked || readOnly || !canConfirm || inFlight.current) return;
      inFlight.current = true; setSaving(true); setFailure(null);
      try { await onConfirm(invoice, key); } catch (reason) { setFailure({ key, source: errorMessage(reason, 'La validation n’a pas pu être terminée.') }); }
      finally { inFlight.current = false; setSaving(false); }
    }}>
      <div className="supplier-review__total" tabIndex={-1}><span>{t('Total de la facture reçue')}</span><strong>{formatMoney(invoice.totalCents)}</strong><p>{t('Comparez ce total au PDF ou au document papier du fournisseur.')}</p></div>
      {changed && <p className="supplier-review__changed" role="status">{t('Des informations ont changé. Relisez la facture et confirmez à nouveau vos choix avant de la valider.')}</p>}
      {problem && <div className="supplier-review__problem" role="alert" tabIndex={-1}><strong>{t(problem.title)}</strong><p>{t(problem.text)}</p><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve(problem.target)}>{t(problem.action)}</Button>{problem.target === 'periods' && <Button type="button" variant="ghost" disabled={locked} onClick={() => onResolve(context.matches.length ? 'matching' : 'document')}>{t(context.matches.length ? 'Déverrouiller le brouillon' : 'Corriger une date erronée')}</Button>}{error && <details><summary>{t('Voir le message complet')}</summary><p>{error}</p></details>}</div>}
      <dl className="supplier-review__summary"><div><dt>{t('Fournisseur')}</dt><dd>{invoice.supplierName}</dd></div><div><dt>{t('Référence fournisseur')}</dt><dd>{invoice.reference || t('Référence à compléter')}</dd></div><div><dt>{t('Date de facture')}</dt><dd>{formatDate(invoice.documentDate)}</dd></div><div><dt>{t('À payer au plus tard le')}</dt><dd>{formatDate(invoice.dueDate)}</dd></div><div><dt>{t('Hors TVA')}</dt><dd>{formatMoney(invoice.netCents)}</dd></div><div><dt>{t('TVA facturée par le fournisseur')}</dt><dd>{formatMoney(invoice.vatCents)}</dd></div></dl>
      <details className="supplier-review__lines"><summary>{t('Comparer les achats ({count})', { count: invoice.lines.length })}</summary><ul>{invoice.lines.slice(0, lineLimit).map(line => <li key={line.id}><span>{line.description}<small>{(line.quantityMilli / 1000).toLocaleString(getAppLocale())} {line.unit} · {line.category}</small></span><strong>{formatMoney(line.totalCents)}</strong></li>)}</ul>{invoice.lines.length > lineLimit && <Button type="button" variant="secondary" onClick={() => setLineLimit(limit => limit + 20)}>{t('Afficher les achats suivants')}</Button>}</details>
      {invoice.note && <details className="supplier-review__lines"><summary>{t('Note de la facture')}</summary><p className="supplier-review__note-text">{invoice.note}</p></details>}
      <section className="supplier-review__attachments"><h3><Paperclip size={18} />{t('Le document original')}</h3>{invoice.attachments.length ? <><ul>{invoice.attachments.map(file => <li key={file.id}>{file.originalName}</li>)}</ul><p>{t(invoice.attachments.length === 1 ? 'Le justificatif sera conservé avec cette facture.' : '{count} justificatifs seront conservés avec cette facture.', { count: invoice.attachments.length })}</p></> : <><p>{t('Ajoutez le PDF ou une photo de la facture. Si vous conservez l’original ailleurs, vous pouvez continuer sans pièce jointe en le confirmant ci-dessous.')}</p><label><input name="withoutAttachment" type="checkbox" checked={withoutAttachment} disabled={locked || readOnly} onChange={event => approve({ withoutAttachment: event.target.checked })} />{t('Je valide sans justificatif joint.')}</label></>}<Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve('attachments')}>{t(invoice.attachments.length ? 'Voir les justificatifs' : 'Joindre le PDF ou la photo')}</Button></section>
      {context.orders.length > 0 && <section className="supplier-review__matching"><h3>{t(context.standaloneChoice ? 'Une commande correspond-elle à cette facture ?' : 'Les commandes liées à cet achat')}</h3><p>{t(context.standaloneChoice ? 'Ce fournisseur a des commandes ouvertes. Reliez les achats correspondants avant validation, ou confirmez que cette facture reste indépendante.' : 'Les achats de cette facture sont reliés aux commandes ci-dessous. Ces liens seront verrouillés lors de la validation.')}</p><ul>{context.orders.slice(0, orderLimit).map(order => <li key={order.id}>{order.number || order.title}{order.number && order.title ? ' · ' + order.title : ''}</li>)}</ul>{context.orders.length > orderLimit && <Button type="button" variant="ghost" onClick={() => setOrderLimit(limit => limit + 10)}>{t('Afficher les commandes suivantes')}</Button>}<Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve('matching')}>{t('Voir le rapprochement')}</Button>{context.standaloneChoice && <label><input name="standalone" type="checkbox" checked={standalone} disabled={locked || readOnly} onChange={event => approve({ standalone: event.target.checked })} />{t('Je garde cette facture indépendante de la commande.')}</label>}</section>}
      <p className="supplier-review__note">{t('La validation fige le fournisseur, les lignes, les montants et les justificatifs, puis crée l’écriture comptable. Aucun virement n’est envoyé. Vous enregistrerez le paiement après avoir réglé le fournisseur.')}</p>
      {readOnly && <p className="supplier-review__note" role="status">{t('L’application est en lecture seule. La validation demande un accès en écriture.')}</p>}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={close}>{t('Garder en brouillon')}</Button>{nextAction ? <Button key="review-next" type="button" disabled={locked || readOnly} onClick={event => { event.preventDefault(); next(); }}>{t(nextAction)}</Button> : <Button key="review-confirm" type="submit" disabled={locked || readOnly || !canConfirm}>{t(locked ? 'Validation en cours…' : error ? 'Réessayer la validation' : 'Valider et comptabiliser')}</Button>}</div>
    </form>}
  </Modal>;
}

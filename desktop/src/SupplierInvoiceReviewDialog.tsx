import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Banknote, CheckCircle2, Paperclip } from 'lucide-react';
import type { SupplierInvoice, Workspace } from './types';
import { Button, Modal } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import { supplierReviewContext, supplierReviewPreflight, supplierReviewProblem, type SupplierReviewTarget } from './supplierInvoiceReview';
import './supplier-review.css';

export function SupplierInvoiceReviewDialog({ invoice, workspace, busy, readOnly, close, onConfirm, onResolve, onPayment }: {
  invoice: SupplierInvoice; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void;
  onConfirm: (invoice: SupplierInvoice) => Promise<void>; onResolve: (target: SupplierReviewTarget) => void; onPayment: () => void;
}) {
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState({ key: '', withoutAttachment: false, standalone: false });
  const inFlight = useRef(false), problemRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving, complete = invoice.documentStatus === 'validated';
  const context = supplierReviewContext(invoice, workspace);
  const preflight = supplierReviewPreflight(invoice, workspace);
  const problem = preflight || (error ? supplierReviewProblem(error) : null);
  const consentKey = JSON.stringify({ invoice, matches: context.matches, order: context.order });
  useLayoutEffect(() => { setConsent({ key: consentKey, withoutAttachment: false, standalone: false }); }, [consentKey]);
  const withoutAttachment = consent.key === consentKey && consent.withoutAttachment;
  const standalone = consent.key === consentKey && consent.standalone;
  function approve(patch: Partial<Pick<typeof consent, 'withoutAttachment' | 'standalone'>>) {
    setConsent({ key: consentKey, withoutAttachment, standalone, ...patch });
  }
  useEffect(() => {
    if (!error || locked || complete) return;
    const node = problemRef.current;
    if (!node) return;
    const actions = node.closest('form')?.querySelector('.form-actions');
    node.style.scrollMarginBlockEnd = `${(actions?.getBoundingClientRect().height || 0) + 20}px`;
    node.focus(); node.scrollIntoView({ block: 'nearest' });
  }, [error, locked, complete]);
  const canConfirm = !preflight && (invoice.attachments.length > 0 || withoutAttachment) && (!context.standaloneChoice || standalone);
  return <Modal title={complete ? 'Facture fournisseur validée' : 'Vérifier la facture fournisseur'} description={`${invoice.reference || 'Référence à compléter'} · ${invoice.supplierName}`} onClose={close} dismissible={!locked} className="supplier-review-modal">
    {complete ? <div className="supplier-review">
      <div className="supplier-review__total"><span>Reste à payer</span><strong>{formatMoney(invoice.balanceCents)}</strong></div>
      <div className="supplier-review__success" role="status"><CheckCircle2 size={25} /><strong>La facture est enregistrée en comptabilité.</strong><p>Le document et ses justificatifs sont verrouillés. Cette validation ne crée aucun paiement.</p></div>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={close}>Terminer</Button>{invoice.balanceCents > 0 && <Button type="button" disabled={locked || readOnly} onClick={onPayment}><Banknote size={17} /> Enregistrer un paiement</Button>}</div>
    </div> : <form className="supplier-review" onSubmit={async event => {
      event.preventDefault();
      if (locked || readOnly || !canConfirm || inFlight.current) return;
      inFlight.current = true; setSaving(true); setError('');
      try { await onConfirm(invoice); } catch (reason) { setError(errorMessage(reason, 'La validation n’a pas pu être terminée.')); }
      finally { inFlight.current = false; setSaving(false); }
    }}>
      <div className="supplier-review__total"><span>Total de la facture reçue</span><strong>{formatMoney(invoice.totalCents)}</strong><p>Comparez ce total au PDF ou au document papier du fournisseur.</p></div>
      {problem && <div className="supplier-review__problem" role="alert" tabIndex={-1} ref={problemRef}><strong>{problem.title}</strong><p>{problem.text}</p><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve(problem.target)}>{problem.action}</Button>{problem.target === 'periods' && <Button type="button" variant="ghost" disabled={locked} onClick={() => onResolve('document')}>Corriger une date erronée</Button>}{error && <details><summary>Voir le message complet</summary><p>{error}</p></details>}</div>}
      <dl className="supplier-review__summary"><div><dt>Date de facture</dt><dd>{formatDate(invoice.documentDate)}</dd></div><div><dt>À payer au plus tard le</dt><dd>{formatDate(invoice.dueDate)}</dd></div><div><dt>Hors TVA</dt><dd>{formatMoney(invoice.netCents)}</dd></div><div><dt>TVA facturée par le fournisseur</dt><dd>{formatMoney(invoice.vatCents)}</dd></div></dl>
      <details className="supplier-review__lines"><summary>Comparer les achats ({invoice.lines.length} ligne{invoice.lines.length > 1 ? 's' : ''})</summary><ul>{invoice.lines.map(line => <li key={line.id}><span>{line.description}<small>{(line.quantityMilli / 1000).toLocaleString('fr-CH')} {line.unit} · {line.category}</small></span><strong>{formatMoney(line.totalCents)}</strong></li>)}</ul></details>
      <section className="supplier-review__attachments"><h3><Paperclip size={18} /> Le document original</h3>{invoice.attachments.length ? <><ul>{invoice.attachments.map(file => <li key={file.id}>{file.originalName}</li>)}</ul><p>{invoice.attachments.length} justificatif{invoice.attachments.length > 1 ? 's' : ''} {invoice.attachments.length > 1 ? 'seront' : 'sera'} conservé{invoice.attachments.length > 1 ? 's' : ''} avec cette facture.</p></> : <><p>Aucun PDF ni photo n’est joint. Ajoutez l’original avant de verrouiller la facture, ou indiquez que vous souhaitez continuer sans pièce.</p><label><input type="checkbox" checked={withoutAttachment} disabled={locked || readOnly} onChange={event => approve({ withoutAttachment: event.target.checked })} /> Je valide sans justificatif joint.</label></>}<Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve('attachments')}>{invoice.attachments.length ? 'Voir les justificatifs' : 'Joindre le PDF ou la photo'}</Button></section>
      {context.order && <section className="supplier-review__matching"><h3>La commande liée à cet achat</h3><p>{context.standaloneChoice ? `La commande ${context.order.number || context.order.title} est encore ouverte. Vous pouvez la rapprocher de cette facture avant validation.` : `${context.matches.length} ligne${context.matches.length > 1 ? 's sont reliées' : ' est reliée'} à vos commandes. Ces liens seront verrouillés lors de la validation.`}</p><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve('matching')}>Voir le rapprochement</Button>{context.standaloneChoice && <label><input type="checkbox" checked={standalone} disabled={locked || readOnly} onChange={event => approve({ standalone: event.target.checked })} /> Je garde cette facture indépendante de la commande.</label>}</section>}
      <p className="supplier-review__note">La validation fige le fournisseur, les lignes, les montants et les justificatifs, puis crée l’écriture comptable. Aucun virement n’est envoyé. Vous enregistrerez le paiement après avoir réglé le fournisseur.</p>
      {readOnly && <p className="supplier-review__note">L’application est en lecture seule. La validation demande un accès en écriture.</p>}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={close}>Garder en brouillon</Button><Button type="submit" disabled={locked || readOnly || !canConfirm}>{locked ? 'Validation en cours…' : 'Valider et comptabiliser'}</Button></div>
    </form>}
  </Modal>;
}

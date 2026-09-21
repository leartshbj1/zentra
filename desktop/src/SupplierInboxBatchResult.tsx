import { Check, ChevronRight, LoaderCircle } from 'lucide-react';
import { t } from './language';
import { Button } from './ui';
import type { MailboxBatch, MailboxBatchResult } from './supplierInboxBatch';

export function SupplierInboxBatchResult({ batch, busy, onReview, onOpen }: {
  batch: MailboxBatch; busy: boolean; onReview: (id: string) => void; onOpen: (id: string) => void;
}) {
  const reviews = batch.results.filter(row => row.status === 'review' || row.status === 'error');
  const completed = batch.results.filter(row => row.status === 'draft' || row.status === 'posted');
  const ready = completed.length;
  const posted = completed.filter(row => row.status === 'posted').length;
  const preparedSuppliers = batch.results.filter(row => row.supplierId).length;
  const row = (result: MailboxBatchResult) => <li key={result.id}>
    <div><strong>{result.supplierName || result.label}</strong>{result.supplierName && <span>{result.label}</span>}
      {result.message && <p>{t(result.message)}</p>}
      {result.supplierId && result.status === 'review' && <small>{t('Fournisseur déjà renseigné')}</small>}
    </div>
    {result.invoiceId ? <Button variant="ghost" onClick={() => onOpen(result.invoiceId!)}>{t('Ouvrir')}<ChevronRight size={15}/></Button>
      : <Button variant="secondary" disabled={busy} onClick={() => onReview(result.id)}>{t('Compléter')}<ChevronRight size={15}/></Button>}
  </li>;
  return <section className="supplier-inbox__batch-result" aria-label={t('Résultat de la vérification')}>
    <div className="supplier-inbox__batch-summary" role="status" aria-live="polite">
      {busy ? <LoaderCircle size={20} className="supplier-inbox__batch-spinner" aria-hidden="true"/> : <Check size={20} aria-hidden="true"/>}
      <div><strong>{t(busy ? 'Vérification en cours…' : 'Vérification terminée')}</strong>
        <p>{busy ? t('{done} sur {total}', { done: batch.done, total: batch.total })
          : t('{ready} préparées · {review} à compléter', { ready, review: reviews.length })}</p>
        {!busy && preparedSuppliers > 0 && <span>{t('Fournisseur renseigné sur {count} factures', { count: preparedSuppliers })}
          {posted > 0 && ` · ${t('{count} comptabilisées', { count: posted })}`}</span>}
      </div>
    </div>
    {busy && <progress value={batch.done} max={Math.max(1, batch.total)} aria-label={t('Vérification des factures')}/>}
    {reviews.length > 0 && <details className="supplier-inbox__batch-attention">
      <summary>{t('{count} à compléter', { count: reviews.length })}<ChevronRight size={16} aria-hidden="true"/></summary>
      <ul>{reviews.map(row)}</ul>
    </details>}
    {!busy && completed.length > 0 && <details><summary>{t('Voir les factures préparées')}<ChevronRight size={16} aria-hidden="true"/></summary>
      <ul>{completed.map(row)}</ul>
    </details>}
  </section>;
}

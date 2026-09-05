import { useState } from 'react';
import type { VatReturnPreview } from './types';
import { Button } from './ui';
import { formatDate, formatMoney, searchText } from './utils';

export function VatReceivedPayments({ allocations }: {
  allocations: NonNullable<VatReturnPreview['receivedAllocations']>;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [limit, setLimit] = useState(25);
  if (!allocations.length) return null;
  const payments = new Set(allocations.map((row) => `${row.sourceType}:${row.paymentId}`)).size;
  const filtered = allocations.filter((row) => (kind === 'all' || kind === row.sourceType)
    && searchText([row.description, row.date, formatDate(row.date)], query))
    .sort((left, right) => right.date.localeCompare(left.date) || right.paymentId.localeCompare(left.paymentId) || left.sourceId.localeCompare(right.sourceId));
  return <details className="vat-received-payments">
    <summary>Paiements pris en compte <span>{payments} règlement{payments > 1 ? 's' : ''} · {allocations.length} ligne{allocations.length > 1 ? 's' : ''}</span></summary>
    <p>Chaque règlement est réparti entre les lignes de la facture. La TVA déductible dépend de la catégorie d’achat. Le décompte calcule la TVA sur les bases par taux, ce qui peut produire un écart d’arrondi.</p>
    <div className="vat-received-payments__filters">
      <label className="field"><span>Rechercher un paiement</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25); }} /></label>
      <label className="field"><span>Type de règlement</span><select aria-label="Type de règlement" value={kind} onChange={(event) => { setKind(event.target.value); setLimit(25); }}><option value="all">Tous les règlements</option><option value="invoice_item">Encaissements clients</option><option value="supplier_invoice_item">Paiements fournisseurs</option></select></label>
    </div>
    <div className="vat-received-payments__list">{filtered.slice(0, limit).map((row) => <article key={`${row.sourceType}:${row.paymentId}:${row.sourceId}`}>
      <div><small>{row.sourceType === 'invoice_item' ? 'Encaissement client' : 'Paiement fournisseur'} · {formatDate(row.date)}</small><strong>{row.description}</strong></div>
      <dl><div><dt>Part TTC</dt><dd>{formatMoney(row.grossCents, row.currency)}</dd></div><div><dt>Part HT</dt><dd>{formatMoney(row.netCents, row.currency)}</dd></div><div><dt>TVA ventilée</dt><dd>{formatMoney(row.vatCents, row.currency)}</dd></div></dl>
    </article>)}</div>
    {!filtered.length ? <p>Aucun paiement ne correspond à cette recherche.</p> : null}
    {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>Afficher les paiements suivants</Button> : null}
  </details>;
}

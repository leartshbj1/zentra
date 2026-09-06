import { useState } from 'react';
import type { VatReturnPreview } from './types';
import { Button } from './ui';
import { formatDate, formatMoney, searchText } from './utils';

function settlementLabel(kind?: string) {
  switch (kind) {
    case 'credit_refund': return 'Remboursement fournisseur';
    case 'credit_refund_reversal': return 'Correction de remboursement';
    case 'credit_reversal': return 'Extourne';
    case 'credit_application': return 'Compensation';
    default: return 'Paiement';
  }
}

export function VatReceivedPayments({ allocations }: {
  allocations: NonNullable<VatReturnPreview['receivedAllocations']>;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [limit, setLimit] = useState(25);
  if (!allocations.length) return null;
  const payments = new Set(allocations.map((row) => `${row.settlement ? 'credit' : row.sourceType}:${row.paymentId}`)).size;
  const hasSettlements = allocations.some((row) => row.settlement);
  const filtered = allocations.filter((row) => (kind === 'all' || kind === row.sourceType || (kind === 'credits' && row.settlement))
    && searchText([row.description, row.date, formatDate(row.date), row.settlement?.counterpartReference || '', settlementLabel(row.settlement?.kind)], query))
    .sort((left, right) => right.date.localeCompare(left.date) || right.paymentId.localeCompare(left.paymentId) || left.sourceId.localeCompare(right.sourceId));
  return <details className="vat-received-payments">
    <summary>Règlements pris en compte <span>{payments} règlement{payments > 1 ? 's' : ''} · {allocations.length} ligne{allocations.length > 1 ? 's' : ''}</span></summary>
    <p>Chaque règlement est ventilé par ligne. La TVA déductible suit la catégorie d’achat ; le calcul par taux peut créer un écart d’arrondi.</p>
    {hasSettlements ? <p>Une compensation apparaît sur la facture et sur l’avoir avec des signes opposés. Un remboursement règle l’avoir à la date du virement reçu. Une correction reprend les centimes du règlement initial.</p> : null}
    <div className="vat-received-payments__filters">
      <label className="field"><span>Rechercher un règlement</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25); }} /></label>
      <label className="field"><span>Type de règlement</span><select aria-label="Type de règlement" value={kind} onChange={(event) => { setKind(event.target.value); setLimit(25); }}><option value="all">Tous les règlements</option><option value="invoice_item">Encaissements clients</option><option value="supplier_invoice_item">Factures fournisseurs</option><option value="supplier_credit_note_item">Avoirs fournisseurs</option>{hasSettlements ? <option value="credits">Compensations et remboursements</option> : null}</select></label>
    </div>
    <div className="vat-received-payments__list">{filtered.slice(0, limit).map((row) => <article key={`${row.sourceType}:${row.paymentId}:${row.sourceId}`}>
      <div><small>{row.settlement ? `${settlementLabel(row.settlement.kind)} · ${row.sourceType === 'supplier_credit_note_item' ? 'Avoir' : 'Facture'}` : row.sourceType === 'invoice_item' ? 'Encaissement client' : 'Paiement fournisseur'} · {formatDate(row.date)}</small><strong>{row.description}</strong>{row.settlement ? <small>Pièce liée : {row.settlement.counterpartReference}</small> : null}</div>
      <dl><div><dt>Part TTC</dt><dd>{formatMoney(row.grossCents, row.currency)}</dd></div><div><dt>Part HT</dt><dd>{formatMoney(row.netCents, row.currency)}</dd></div><div><dt>TVA ventilée</dt><dd>{formatMoney(row.vatCents, row.currency)}</dd></div></dl>
    </article>)}</div>
    {!filtered.length ? <p>Aucun règlement ne correspond à cette recherche.</p> : null}
    {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>Afficher les règlements suivants</Button> : null}
  </details>;
}

import { useState } from 'react';
import type { VatReturnPreview, Workspace } from './types';
import { vatSourceTarget, type FinancialSourceTarget } from './financialTraceability';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import { formatDate, formatMoney, searchText } from './utils';

function settlementLabel(kind?: string) {
  switch (kind) {
    case 'credit_refund': return t('Remboursement fournisseur');
    case 'credit_refund_reversal': return t('Correction de remboursement');
    case 'credit_reversal': return t('Extourne');
    case 'credit_application': return t('Compensation');
    default: return t('Paiement');
  }
}

export function VatReceivedPayments({ allocations, workspace, onOpenSource, busy = false }: {
  allocations: NonNullable<VatReturnPreview['receivedAllocations']>;
  workspace?: Workspace;
  onOpenSource?: (target: FinancialSourceTarget) => void;
  busy?: boolean;
}) {
  useAppLanguage();
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
    <summary>{t("Règlements pris en compte ")}<span>{t(payments === 1 ? '{count} règlement' : '{count} règlements', { count: payments })} · {t(allocations.length === 1 ? '{count} ligne' : '{count} lignes', { count: allocations.length })}</span></summary>
    <p>{t("Chaque règlement est ventilé par ligne. La TVA déductible suit la catégorie d’achat ; le calcul par taux peut créer un écart d’arrondi.")}</p>
    {hasSettlements ? <p>{t("Une compensation apparaît sur la facture et sur l’avoir avec des signes opposés. Un remboursement règle l’avoir à la date du virement reçu. Une correction reprend les centimes du règlement initial.")}</p> : null}
    <div className="vat-received-payments__filters">
      <label className="field"><span>{t("Rechercher un règlement")}</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25); }} /></label>
      <label className="field"><span>{t("Type de règlement")}</span><select aria-label={t("Type de règlement")} value={kind} onChange={(event) => { setKind(event.target.value); setLimit(25); }}><option value="all">{t("Tous les règlements")}</option><option value="invoice_item">{t("Encaissements clients")}</option><option value="supplier_invoice_item">{t("Factures fournisseurs")}</option><option value="supplier_credit_note_item">{t("Avoirs fournisseurs")}</option>{hasSettlements ? <option value="credits">{t("Compensations et remboursements")}</option> : null}</select></label>
    </div>
    <div className="vat-received-payments__list">{filtered.slice(0, limit).map((row) => <article key={`${row.sourceType}:${row.paymentId}:${row.sourceId}`}>
      <div><small>{row.settlement ? `${settlementLabel(row.settlement.kind)} · ${row.sourceType === 'supplier_credit_note_item' ? t("Avoir") : t("Facture")}` : row.sourceType === 'invoice_item' ? t("Encaissement client") : t("Paiement fournisseur")}  · {formatDate(row.date)}</small><strong>{row.description}</strong>{row.settlement ? <small>{t("Pièce liée : ")}{row.settlement.counterpartReference}</small> : null}</div>
      <dl><div><dt>{t("Part TTC")}</dt><dd>{formatMoney(row.grossCents, row.currency)}</dd></div><div><dt>{t("Part HT")}</dt><dd>{formatMoney(row.netCents, row.currency)}</dd></div><div><dt>{t("TVA ventilée")}</dt><dd>{formatMoney(row.vatCents, row.currency)}</dd></div></dl>
      {workspace && onOpenSource ? vatSourceTarget(row, workspace) ? <Button variant="secondary" size="small" disabled={busy} onClick={() => onOpenSource(vatSourceTarget(row, workspace)!)}>{t('Ouvrir la pièce')}</Button> : <small>{t('Pièce métier indisponible sur cet appareil')}</small> : null}
    </article>)}</div>
    {!filtered.length ? <p>{t("Aucun règlement ne correspond à cette recherche.")}</p> : null}
    {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>{t("Afficher les règlements suivants")}</Button> : null}
  </details>;
}

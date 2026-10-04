import { useState } from 'react';
import type { VatReturnPreview, VatSourceClassification, Workspace } from './types';
import { agreedVatSalesSources, financialSourceTarget, type FinancialSourceTarget, type VatSalesSource } from './financialTraceability';
import { getAppLocale, t, useAppLanguage } from './language';
import { vatTreatmentLabels } from './vatCenterLogic';
import { formatDate, formatMoney, searchText } from './utils';
import { Button } from './ui';

const inclusionLabels: Record<VatSalesSource['inclusion'], string> = {
  included: 'Classée pour ce décompte',
  unclassified: 'Traitement à choisir · export bloqué',
  foreign: 'Devise étrangère · exclue du calcul CHF',
  annual_adjustments_only: 'Concordance annuelle · seuls les ajustements sont déclarés',
  amounts_unavailable: 'Montants enregistrés indisponibles · aucune reconstitution',
  classification_unavailable: 'Traitement enregistré indisponible · actualisez le décompte',
};

export function VatSalesSourceReview({ preview, workspace, classifications, busy, onOpenSource }: {
  preview: VatReturnPreview;
  workspace: Workspace;
  classifications: VatSourceClassification[] | null;
  busy: boolean;
  onOpenSource?: (target: FinancialSourceTarget) => void;
}) {
  useAppLanguage();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  if (preview.profile.formOfReporting !== 'agreed') return null;
  const sources = agreedVatSalesSources(workspace.invoices, preview, classifications);
  const filtered = sources.filter(({ invoice, line, treatment }) => searchText([invoice.number, invoice.title, line.description, invoice.currency, treatment ? t(vatTreatmentLabels[treatment]) : '', invoice.type === 'credit_note' ? t('Avoir client') : t('Facture client')], query));
  const basis = preview.profile.reportingMethod === 'simple_tax_rate' || preview.profile.grossOrNet === 'gross' ? 'TTC' : 'HT';
  return <details className="vat-sales-source-review">
    <summary>{t('Pièces de vente de la période')} <span>{sources.length} {t('lignes')}</span></summary>
    <p>{t('Du {from} au {to} · base du décompte {basis}', { from: formatDate(preview.dateFrom), to: formatDate(preview.dateTo), basis: t(basis) })}</p>
    <p>{t('Montants enregistrés sur les lignes émises, avoirs compris avec leur signe. La TVA par taux du décompte peut différer par arrondi. Les corrections manuelles figurent séparément.')}</p>
    <label className="field"><span>{t('Rechercher une pièce de vente')}</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} /></label>
    <div className="vat-sales-source-review__list">{filtered.slice(0, limit).map(source => {
      const { invoice, line, treatment, inclusion } = source;
      const target = financialSourceTarget('invoice', invoice.id, workspace)!;
      const original = invoice.originalInvoiceId ? financialSourceTarget('invoice', invoice.originalInvoiceId, workspace) : null;
      return <article key={`${invoice.id}:${line.id}`}>
        <div className="vat-sales-source-review__description"><strong>{target.label}</strong><span>{formatDate(invoice.issueDate)} · {invoice.title}</span><span>{line.description}</span><small>{(line.vatRateBp / 100).toLocaleString(getAppLocale())} % · {treatment ? t(vatTreatmentLabels[treatment]) : t('Traitement non disponible')}</small><small className={inclusion === 'included' ? '' : 'vat-sales-source-review__warning'}>{t(inclusionLabels[inclusion])}</small></div>
        {line.recordedAmounts ? <dl><div><dt>{t('HT')}</dt><dd>{formatMoney(line.recordedAmounts.netCents, invoice.currency)}</dd></div><div><dt>{t('TVA')}</dt><dd>{formatMoney(line.recordedAmounts.vatCents, invoice.currency)}</dd></div><div><dt>{t('TTC')}</dt><dd>{formatMoney(line.recordedAmounts.totalCents, invoice.currency)}</dd></div></dl> : null}
        {onOpenSource ? <div className="vat-sales-source-review__actions"><Button variant="secondary" size="small" disabled={busy} onClick={() => onOpenSource(target)} aria-label={t('Ouvrir {piece}', { piece: target.label })}>{t('Ouvrir la pièce')}</Button>{original ? <Button variant="ghost" size="small" disabled={busy} onClick={() => onOpenSource(original)}>{t('Facture d’origine')} · {workspace.invoices.find(item => item.id === original.id)?.number}</Button> : invoice.originalInvoiceId ? <small>{t('Facture d’origine indisponible sur cet appareil')}</small> : null}</div> : null}
      </article>;
    })}</div>
    {!sources.length ? <p>{t('Aucune ligne de vente émise disponible pour cette période.')}</p> : !filtered.length ? <p>{t('Aucune pièce ne correspond à cette recherche.')}</p> : null}
    {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>{t('Afficher les pièces suivantes')}</Button> : null}
  </details>;
}

import { useState } from 'react';
import type { VatReturnPreview, VatSourceTreatment, VatSourceType, Workspace } from './types';
import { vatSourceTarget, type FinancialSourceTarget } from './financialTraceability';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import { formatDate, formatMoney, searchText } from './utils';
import { treatmentsForVatSource, vatTreatmentLabels } from './vatCenterLogic';

const shortLabels: Partial<Record<VatSourceTreatment, string>> = {
  input_materials: 'Achats courants (400)',
  input_investments: 'Autres charges (405)',
  non_deductible: 'Non déductible',
};

export function VatPurchaseReview({ sources, busy, onClassify, refundedExpenseIds, workspace, onOpenSource }: {
  sources: NonNullable<VatReturnPreview['classifiedSources']>;
  busy: boolean;
  refundedExpenseIds?: ReadonlySet<string>;
  workspace?: Workspace;
  onOpenSource?: (target: FinancialSourceTarget) => void;
  onClassify: (id: string, type: VatSourceType, treatment: VatSourceTreatment) => Promise<void>;
}) {
  useAppLanguage();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const filtered = sources.filter((source) => searchText([source.description, source.occurrenceDate, t(vatTreatmentLabels[source.treatment])], query));
  if (!sources.length) return null;
  return <details className="vat-purchase-review">
    <summary>{t("TVA des achats déjà classés ")}<span>{sources.length}</span></summary>
    <p>{t("La catégorie détermine la TVA récupérable et sa comptabilisation. Si une correction manuelle existe déjà, vérifiez-la avant d’appliquer une nouvelle correction automatique.")}</p>
    <label className="field"><span>{t("Rechercher un achat")}</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25); }} /></label>
    <div className="vat-unclassified">{filtered.slice(0, limit).map((source, index) => <article key={`${source.sourceType}:${source.sourceId}:${index}`}>
      <div><strong>{source.description}</strong><span>{formatDate(source.occurrenceDate)}  · {formatMoney(source.amountCents, source.currency)} {t(" HT")}</span><small>{t("TVA : ")}{formatMoney(source.vatCents, source.currency)}</small><small>{t(vatTreatmentLabels[source.treatment])}</small>{workspace && onOpenSource ? vatSourceTarget(source, workspace) ? <Button variant="secondary" size="small" disabled={busy} onClick={() => onOpenSource(vatSourceTarget(source, workspace)!)}>{t('Ouvrir la pièce')}</Button> : <small>{t('Pièce métier indisponible sur cet appareil')}</small> : null}</div>
      {source.sourceType === 'expense_refund' || (source.sourceType === 'expense' && refundedExpenseIds?.has(source.sourceId)) ? <p>{t("Traitement conservé avec le remboursement. Pour corriger une saisie erronée, ouvrez l’historique de la dépense dans Achats & fournisseurs.")}</p> : <div className="vat-purchase-review__actions">
        <select aria-label={t('Traitement enregistré de {description}', { description: source.description })} value={source.treatment} disabled={busy} onChange={(event) => void onClassify(source.sourceId, source.sourceType, event.target.value as VatSourceTreatment)}>
          {treatmentsForVatSource(source.sourceType).map((treatment) => <option key={treatment} value={treatment}>{t(shortLabels[treatment] || vatTreatmentLabels[treatment])}</option>)}
        </select>
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void onClassify(source.sourceId, source.sourceType, source.treatment)}>{t("Appliquer au journal")}</Button>
      </div>}
    </article>)}</div>
    {!filtered.length ? <p>{t("Aucun achat ne correspond à cette recherche.")}</p> : null}
    {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>{t("Afficher les achats suivants")}</Button> : null}
  </details>;
}

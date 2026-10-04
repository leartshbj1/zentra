import { t, useAppLanguage } from './language';
import type { VatReturnPreview } from './types';
import { formatMoney } from './utils';

export function VatOverview({ preview }: { preview: VatReturnPreview }) {
  useAppLanguage();
  const effective = preview.effectiveReportingMethod;
  const method = effective ?? preview.simpleTaxRateMethod;
  const recoverable = effective
    ? effective.inputTaxMaterialAndServicesCents + effective.inputTaxInvestmentsCents + effective.subsequentInputTaxDeductionCents - effective.inputTaxCorrectionsCents - effective.inputTaxReductionsCents
    : null;
  return <section className="vat-overview" aria-label={t("TVA due et récupérable")}>
    <div className="vat-overview__totals">
      <article><span>{t("TVA sur les ventes")}</span><strong>{formatMoney(method?.outputTaxCents)}</strong><small>{effective ? t("Calcul par taux") : t("Taux d’activité AFC")}</small></article>
      <article><span>{t("TVA récupérable nette")}</span><strong>{recoverable === null ? t("Incluse dans le taux") : formatMoney(recoverable)}</strong><small>{effective ? t("Achats, investissements et corrections") : t("Pas de déduction séparée en TDFN / TaF")}</small></article>
      <article><span>{preview.payableTaxCents < 0 ? t("Crédit TVA") : t("Solde TVA à payer")}</span><strong>{formatMoney(Math.abs(preview.payableTaxCents))}</strong><small>{t("Impôt sur les acquisitions compris")}</small></article>
    </div>
    {!preview.exportable ? <p className="vat-overview__pending">{t("Calcul provisoire incomplet : traitez les lignes non classées et les points signalés avant de retenir ce solde.")}</p> : null}
    <details className="vat-practical-guide"><summary>{t("Comment mes achats de marchandises réduisent-ils la TVA ?")}</summary>
      <p>{t("En méthode effective, classez les achats affectés à votre activité imposable dans « Matériel et prestations » (chiffre 400). Les investissements et autres charges d’exploitation relèvent du chiffre 405. La TVA déductible vient réduire celle due sur vos ventes.")}</p>
      <p>{t("Conservez la facture du fournisseur et le taux réellement facturé. Les dépenses privées ou sans droit à déduction restent non déductibles. Les usages mixtes, subventions ou corrections se traitent dans les ajustements avec leur justificatif.")}</p>
      <p>{t("La date de prise en compte dépend du mode déclaré : facturation ou encaissements. En TDFN / TaF, aucune récupération séparée des achats n’est calculée.")}</p>
      <p><a href="https://www.estv.admin.ch/fr/taux-de-la-tva-suisse" target="_blank" rel="noreferrer">{t("Taux et méthodes AFC")}</a>  · <a href="https://www.estv.admin.ch/fr/deroulement-dun-controle-tva" target="_blank" rel="noreferrer">{t("Justificatifs et corrections")}</a></p>
    </details>
  </section>;
}

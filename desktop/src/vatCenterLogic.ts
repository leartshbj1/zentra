import type {
  VatAdjustmentCategory,
  VatReportingMethod,
  VatReportingPeriodicity,
  VatSourceTreatment,
  VatSourceType,
} from './types';

export function vatBlockingIssueTitle(code: string): string {
  if (code === 'vat_reporting_transition_open_balance') return 'Changement de mode TVA à préparer';
  if (code === 'unclassified_sources') return 'Traitements TVA à compléter';
  if (code === 'missing_uid' || code === 'invalid_uid') return 'Numéro IDE / TVA à vérifier';
  if (code === 'foreign_currency_source' || code === 'non_chf_ledger') return 'Conversion en francs suisses à justifier';
  if (code.includes('credit')) return 'Avoirs à vérifier';
  if (code.includes('rate')) return 'Taux TVA à vérifier';
  if (code.includes('received')) return 'Règlements à vérifier';
  return 'Point à vérifier';
}

export const vatTreatmentLabels: Record<VatSourceTreatment, string> = {
  taxable: 'Imposable au taux de la ligne',
  supplies_to_foreign: 'Ch. 220 · prestations à l’étranger / exportations',
  supplies_abroad: 'Ch. 221 · prestations fournies à l’étranger',
  transfer_notification: 'Ch. 225 · procédure de déclaration',
  exempt: 'Ch. 230 · prestations exclues ou exonérées',
  out_of_scope: 'Hors champ du décompte',
  opted: 'Ch. 205 · prestations avec option',
  input_materials: 'Ch. 400 · impôt préalable matériel et prestations',
  input_investments: 'Ch. 405 · investissements et autres charges',
  non_deductible: 'Impôt préalable non déductible',
};

export const vatAdjustmentLabels: Record<VatAdjustmentCategory, string> = {
  supplies_to_foreign: 'Ch. 220 · prestations à l’étranger / exportations',
  supplies_abroad: 'Ch. 221 · prestations fournies à l’étranger',
  transfer_notification: 'Ch. 225 · procédure de déclaration',
  supplies_exempt: 'Ch. 230 · prestations exclues ou exonérées',
  reduction_of_consideration: 'Ch. 235 · diminutions de contre-prestation',
  various_deduction: 'Ch. 280 · autres déductions',
  opted: 'Ch. 205 · prestations avec option',
  acquisition_tax: 'Ch. 38x · impôt sur les acquisitions',
  input_materials: 'Ch. 400 · impôt préalable matériel et prestations',
  input_investments: 'Ch. 405 · investissements et autres charges',
  subsequent_input_tax: 'Ch. 410 · dégrèvement ultérieur',
  input_tax_corrections: 'Ch. 415 · corrections de l’impôt préalable',
  input_tax_reductions: 'Ch. 420 · réductions de l’impôt préalable',
  subsidies: 'Ch. 900 · subventions',
  donations: 'Ch. 910 · dons',
};

export const vatPeriodicityLabels: Record<VatReportingPeriodicity, string> = {
  monthly: 'Mensuelle',
  quarterly: 'Trimestrielle',
  semiannual: 'Semestrielle',
  annual: 'Annuelle',
};

export const vatSourceTypeLabels: Record<VatSourceType, string> = {
  invoice_item: 'Vente',
  supplier_invoice_item: 'Facture fournisseur',
  supplier_credit_note_item: 'Avoir fournisseur',
  expense: 'Dépense',
};

const salesTreatments: VatSourceTreatment[] = [
  'taxable',
  'supplies_to_foreign',
  'supplies_abroad',
  'transfer_notification',
  'exempt',
  'out_of_scope',
  'opted',
];

const inputTreatments: VatSourceTreatment[] = [
  'input_materials',
  'input_investments',
  'non_deductible',
];

export function treatmentsForVatSource(
  sourceType: VatSourceType,
): VatSourceTreatment[] {
  return sourceType === 'invoice_item' ? salesTreatments : inputTreatments;
}

export function vatGrossOrNetForMethod(
  method: VatReportingMethod,
  current: 'net' | 'gross',
): 'net' | 'gross' {
  return method === 'simple_tax_rate' ? 'gross' : current;
}

export function vatProfileRequiresAfcConfirmation({
  method,
  basis,
  periodicity,
}: {
  method: VatReportingMethod;
  basis: 'agreed' | 'received';
  periodicity: VatReportingPeriodicity;
}): boolean {
  return (
    method === 'simple_tax_rate' ||
    basis === 'received' ||
    periodicity === 'monthly' ||
    periodicity === 'annual'
  );
}

export function vatSubmissionLabel(
  submission: 'initial' | 'correction' | 'annual_reconciliation',
): string {
  if (submission === 'correction') return 'Rectificatif complet';
  if (submission === 'annual_reconciliation') return 'Concordance annuelle · différences uniquement';
  return 'Décompte initial complet';
}

export function suggestedVatBusinessReference(
  dateFrom: string,
  dateTo: string,
  submission: 'initial' | 'correction' | 'annual_reconciliation',
): string {
  const clean = (value: string) => value.replace(/[^0-9]/g, '');
  const kind = submission === 'initial' ? 'INIT' : submission === 'correction' ? 'RECT' : 'CONC';
  return `ZENTRA-${clean(dateFrom)}-${clean(dateTo)}-${kind}`.slice(0, 50);
}

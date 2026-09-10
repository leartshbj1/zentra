import type { AppSettings, IncomeStatementReport, PeriodFilter } from './types';

export const billingPresets = [
  {
    id: 'short',
    name: 'Paiement rapide',
    days: 14,
    validity: 30,
    text: 'Un délai court pour vos prochaines factures.',
  },
  {
    id: 'standard',
    name: 'Au quotidien',
    days: 30,
    validity: 30,
    text: '30 jours pour payer et 30 jours pour accepter un devis.',
  },
  {
    id: 'extended',
    name: 'Délai étendu',
    days: 60,
    validity: 60,
    text: 'Pour les clients avec lesquels vous convenez d’un délai plus long.',
  },
] as const;
export type BillingPresetId = (typeof billingPresets)[number]['id'];

/** Commercial defaults only. Never infer VAT registration, a tax method or an insurance contract. */
export function applyBillingPreset(
  settings: AppSettings,
  id: BillingPresetId,
): AppSettings {
  const preset = billingPresets.find((p) => p.id === id);
  if (!preset) throw new Error('Choisissez une configuration de facturation.');
  return {
    ...settings,
    billing: {
      ...settings.billing,
      paymentTermsDays: preset.days,
      quoteValidityDays: preset.validity,
    },
  };
}
export function financeTotalsAvailable(report: IncomeStatementReport | null) {
  return (
    !!report &&
    (report.currency.singleCurrency || report.currency.exchangeRatesApplied) &&
    [report.revenueCents, report.expenseCents, report.profitCents].every(
      Number.isSafeInteger,
    )
  );
}
export function financePeriod(
  kind: 'month' | 'quarter' | 'year' | 'all',
  today: string,
): PeriodFilter {
  if (kind === 'all') return { dateFrom: undefined, dateTo: undefined };
  const [year, month] = today.split('-').map(Number);
  if (!year || !month || month > 12)
    throw new Error('La date de référence est invalide.');
  const startMonth =
    kind === 'year'
      ? 1
      : kind === 'quarter'
        ? Math.floor((month - 1) / 3) * 3 + 1
        : month;
  const endMonth =
    kind === 'year' ? 12 : kind === 'quarter' ? startMonth + 2 : month;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return {
    dateFrom: `${year}-${String(startMonth).padStart(2, '0')}-01`,
    dateTo: `${year}-${String(endMonth).padStart(2, '0')}-${lastDay}`,
  };
}
export const vatSetupPresets = [
  {
    id: 'effective-agreed',
    name: 'TVA sur les factures',
    description:
      'Méthode effective : TVA sur les ventes moins TVA déductible sur les achats. Décompte trimestriel.',
    method: 'effective',
    basis: 'agreed',
    periodicity: 'quarterly',
    grossOrNet: 'net',
  },
  {
    id: 'effective-received',
    name: 'TVA sur les paiements',
    description:
      'Méthode effective lors des encaissements et décaissements. Reprenez le mode autorisé par l’AFC.',
    method: 'effective',
    basis: 'received',
    periodicity: 'quarterly',
    grossOrNet: 'net',
  },
  {
    id: 'tdfn',
    name: 'Taux d’activité AFC',
    description:
      'TDFN / TaF : renseignez le taux approuvé pour votre activité. Les achats ne se déduisent pas séparément.',
    method: 'simple_tax_rate',
    basis: 'agreed',
    periodicity: 'semiannual',
    grossOrNet: 'gross',
  },
] as const;
export const accountingExplanations: Record<
  string,
  { title: string; text: string }
> = {
  journal: {
    title: 'Les opérations, dans l’ordre',
    text: 'Chaque ligne explique une vente, un achat ou un paiement. Pour corriger une opération validée, Zentra conserve l’original et ajoute sa contre-écriture.',
  },
  income: {
    title: 'Est-ce que mon activité gagne de l’argent ?',
    text: 'Les revenus moins les charges donnent le résultat de la période. Un résultat positif est un bénéfice ; négatif, une perte. Les paiements reçus se vérifient dans Banque.',
  },
  balance: {
    title: 'Ce que l’entreprise possède et ce qu’elle doit',
    text: 'Les actifs regroupent notamment l’argent, les créances et les équipements. Les dettes et les fonds propres expliquent leur financement. Le bilan présente cette situation à la date choisie.',
  },
  trial: {
    title: 'Vérifier que les comptes s’équilibrent',
    text: 'La balance reprend les mouvements et le solde de chaque compte. Un équilibre des débits et crédits ne garantit pas, à lui seul, que toutes les pièces ont été enregistrées.',
  },
  ledger: {
    title: 'Retrouver l’histoire d’un compte',
    text: 'Choisissez un compte pour voir les opérations qui expliquent son solde. Chaque montant doit pouvoir être rapproché de son justificatif.',
  },
  closing: {
    title: 'Avancer vers la fin d’année',
    text: 'Choisissez l’exercice, traitez les contrôles, puis exportez le dossier pour la fiduciaire. La clôture verrouille la période : vérifiez les pièces et les corrections avant de confirmer.',
  },
};
export const financeWords = [
  {
    term: 'Acompte',
    text: 'Une partie du prix facturée avant le solde. La facture finale doit présenter les acomptes correspondants et le montant restant.',
  },
  {
    term: 'Avoir',
    text: 'Un document qui réduit ou annule tout ou partie d’une facture. Le remboursement éventuel est un paiement distinct à enregistrer.',
  },
  {
    term: 'Facturé',
    text: 'Le montant des factures émises. Il peut rester une partie à recevoir.',
  },
  {
    term: 'Encaissé',
    text: 'Les paiements enregistrés comme reçus. Une facture partiellement payée garde un solde ouvert.',
  },
  {
    term: 'Charges',
    text: 'Les coûts comptabilisés : achats, salaires, assurances ou amortissements. Leur paiement peut avoir lieu à une autre date.',
  },
  {
    term: 'Résultat',
    text: 'Les revenus moins les charges de la période. Positif : un bénéfice. Négatif : une perte. Consultez la banque pour les paiements effectivement passés.',
  },
  {
    term: 'TVA due',
    text: 'La taxe à déclarer sur les opérations concernées. Le moment de la déclaration dépend du mode de décompte enregistré.',
  },
  {
    term: 'TVA récupérable',
    text: 'En méthode effective, la TVA sur les achats professionnels ouvrant droit à déduction, avec leurs justificatifs. En méthode TDFN, l’impôt préalable ne se déduit pas séparément.',
  },
  {
    term: 'Bilan',
    text: 'À une date précise : les biens et créances de l’entreprise, ses dettes et ses fonds propres.',
  },
  {
    term: 'Rapprocher',
    text: 'Associer un mouvement bancaire à la facture, au paiement ou au justificatif qui l’explique.',
  },
  {
    term: 'Clôturer',
    text: 'Contrôler puis verrouiller une période comptable. Les corrections ultérieures doivent garder une trace.',
  },
  {
    term: 'Salaire brut',
    text: 'La rémunération avant les retenues salariales. Selon leur nature, les compléments n’entrent pas tous dans les mêmes bases de cotisation.',
  },
  {
    term: 'Salaire net',
    text: 'Le montant à verser après les retenues du salarié et les éléments du décompte. Vérifiez les assurances et la situation fiscale propres à la personne.',
  },
  {
    term: 'Cotisations employeur',
    text: 'La part des assurances sociales payée par l’entreprise. Elle s’ajoute au coût salarial et ne se déduit pas du net du salarié.',
  },
] as const;

export const financeSources = [
  {
    title: 'TVA suisse : fonctionnement et taux',
    url: 'https://www.estv.admin.ch/fr/taxe-sur-la-valeur-ajoutee',
  },
  {
    title: 'Méthode des taux de la dette fiscale nette',
    url: 'https://www.estv.admin.ch/fr/tva-taux-de-la-dette-fiscale-nette-et-taux-forfaitaires',
  },
  {
    title: 'Obligations comptables des entreprises',
    url: 'https://www.kmu.admin.ch/fr/comptabilite-obligatoire-lobligation-de-tenir-une-comptabilite',
  },
] as const;

import type { Account, AccountingContinuity, AccountingSettings } from './types';

export type MappingKey = Exclude<keyof AccountingSettings, 'enabled'>;
export type MappingGroup = 'sales' | 'purchases' | 'vat' | 'payroll';
export type MappingField = { key: MappingKey; label: string; hint: string; type: Account['accountType']; group: MappingGroup; required: boolean };
export type MappingIssue = { key: MappingKey; message: string };

export function accountingRequirementsFromRaw(value: unknown): AccountingContinuity['mappingRequirements'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.payroll === 'boolean' && typeof raw.deferred_vat === 'boolean' ? { payroll: raw.payroll, deferredVat: raw.deferred_vat } : undefined;
}

export function accountingMappingFields(requirements: AccountingContinuity['mappingRequirements'], payrollFallback: boolean): MappingField[] {
  const payroll = requirements?.payroll ?? payrollFallback;
  const deferredVat = requirements?.deferredVat ?? true;
  const fields: MappingField[] = [
    { key: 'arAccountId', label: 'Factures clients à encaisser', hint: 'Les montants que vos clients vous doivent encore. Compte de créances clients.', type: 'asset', group: 'sales', required: true },
    { key: 'revenueAccountId', label: 'Chiffre d’affaires', hint: 'Vos ventes et prestations facturées. Compte de produits.', type: 'revenue', group: 'sales', required: true },
    { key: 'bankAccountId', label: 'Banque', hint: 'Le compte comptable utilisé pour les paiements reçus ou effectués.', type: 'asset', group: 'sales', required: true },
    { key: 'expenseAccountId', label: 'Dépenses de l’entreprise', hint: 'Le compte général des charges. Vous pourrez prévoir des comptes plus détaillés selon vos besoins.', type: 'expense', group: 'purchases', required: true },
    { key: 'supplierPayableAccountId', label: 'Factures fournisseurs à payer', hint: 'Les montants que votre entreprise doit à ses fournisseurs.', type: 'liability', group: 'purchases', required: true },
    { key: 'vatPayableAccountId', label: 'TVA sur les ventes', hint: 'La TVA due sur vos ventes. Ce compte ne doit pas être celui de la TVA en attente d’encaissement.', type: 'liability', group: 'vat', required: true },
    { key: 'vatReceivableAccountId', label: 'TVA sur les achats', hint: 'La TVA préalable liée aux achats. Choisissez un compte différent de la banque et des créances clients.', type: 'asset', group: 'vat', required: true },
    { key: 'vatDeferredPayableAccountId', label: 'TVA en attente d’encaissement', hint: deferredVat ? 'Requis par un profil de TVA sur les encaissements présent dans vos données.' : 'Facultatif pour les profils de TVA actuels. Conservez un compte existant ou laissez vide.', type: 'liability', group: 'vat', required: deferredVat },
  ];
  if (payroll) fields.push(
    { key: 'wagesExpenseAccountId', label: 'Coût des salaires', hint: 'Les salaires comptabilisés comme charges.', type: 'expense', group: 'payroll', required: true },
    { key: 'wagesPayableAccountId', label: 'Salaires à verser', hint: 'Les salaires restant à payer aux collaborateurs.', type: 'liability', group: 'payroll', required: true },
    { key: 'socialExpenseAccountId', label: 'Cotisations à la charge de l’entreprise', hint: 'Les charges sociales patronales.', type: 'expense', group: 'payroll', required: true },
    { key: 'socialPayableAccountId', label: 'Cotisations à verser aux caisses', hint: 'Les cotisations dues aux organismes sociaux.', type: 'liability', group: 'payroll', required: true },
  );
  return fields;
}

export function accountingMappingIssues(settings: AccountingSettings, accounts: Account[], fields: MappingField[]): MappingIssue[] {
  if (!settings.enabled) return [];
  const issues: MappingIssue[] = [];
  for (const field of fields) {
    const id = settings[field.key];
    if (!id) { if (field.required) issues.push({ key: field.key, message: `Choisissez le compte pour « ${field.label} ».` }); continue; }
    const account = accounts.find(row => row.id === id);
    if (!account || !account.active || account.accountType !== field.type) issues.push({ key: field.key, message: `Le compte choisi pour « ${field.label} » n’est pas disponible ou n’a pas le bon type. Choisissez un compte proposé dans la liste.` });
  }
  const distinct: MappingKey[][] = [['arAccountId', 'bankAccountId', 'vatReceivableAccountId'], ['vatPayableAccountId', 'vatDeferredPayableAccountId']];
  for (const group of distinct) for (let i = 1; i < group.length; i++) for (let j = 0; j < i; j++) {
    const key = group[i];
    if (settings[key] && settings[key] === settings[group[j]]) {
      const label = fields.find(field => field.key === key)?.label;
      const other = fields.find(field => field.key === group[j])?.label;
      issues.push({ key, message: `« ${label} » et « ${other} » doivent utiliser deux comptes différents.` });
    }
  }
  return issues;
}

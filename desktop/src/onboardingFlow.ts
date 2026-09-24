import type { AppSettings } from './types';
import type { OnboardingIssue } from './onboardingValidation';
import { settingsFromOnboardingDraft } from './onboardingDraft';

export const onboardingDraftKey = 'zentra.onboarding.draft.v2';
export const legacyOnboardingDraftKey = 'elyko.onboarding.draft.v1';
export const setupPages = [
  { id: 'welcome', label: 'Bienvenue', chapter: 0 },
  { id: 'account', label: 'Votre compte', chapter: 0 },
  { id: 'identity', label: 'Votre entreprise', chapter: 1 },
  { id: 'address', label: 'Vos coordonnées', chapter: 1 },
  { id: 'activity', label: 'Votre activité', chapter: 1 },
  { id: 'tax', label: 'Votre TVA', chapter: 2 },
  { id: 'bank', label: 'Vos encaissements', chapter: 2 },
  { id: 'documents', label: 'Vos documents', chapter: 2 },
  { id: 'work', label: 'Votre organisation', chapter: 3 },
  { id: 'payroll', label: 'Vos salaires', chapter: 4 },
  { id: 'insurance', label: 'Vos assurances', chapter: 4 },
  { id: 'contributions', label: 'Vos cotisations', chapter: 4 },
  { id: 'backup', label: 'Vos sauvegardes', chapter: 5 },
  { id: 'assistants', label: 'Vos assistants', chapter: 6 },
  { id: 'review', label: 'Votre récapitulatif', chapter: 6 },
] as const;
export type SetupPageId = typeof setupPages[number]['id'];
export const setupChapters = ['Bienvenue', 'Entreprise', 'Facturation', 'Organisation', 'Salaires', 'Sauvegardes', 'À vous de jouer'] as const;
export function setupPageIndex(id: SetupPageId) { return setupPages.findIndex(page => page.id === id); }
export function enabledSetupPages(settings: AppSettings): number[] {
  return setupPages.flatMap((page, index) => !settings.payroll.enabled && ['insurance','contributions'].includes(page.id) ? [] : [index]);
}
export function setupPageForIssue(issue: Pick<OnboardingIssue, 'field' | 'step'>): number {
  const field = issue.field;
  if (field === 'organization.vatIdentifier' || field === 'organization.vatNumber' || field === 'organization.uidNumber') return setupPageIndex('tax');
  if (field.startsWith('organization.address.')) return setupPageIndex('address');
  if (field.startsWith('organization.')) return setupPageIndex('identity');
  if (field.startsWith('business.')) return setupPageIndex('activity');
  if (['billing.iban','billing.accountHolder'].includes(field)) return setupPageIndex('bank');
  if (field.startsWith('billing.')) return setupPageIndex('documents');
  if (field.startsWith('work.')) return setupPageIndex('work');
  if (field === 'payroll.enabled') return setupPageIndex('payroll');
  if (/^payroll\.(avsFund|accidentInsurer|pensionFund|dailyAllowanceInsurer|familyAllowanceFund|payrollCanton)$/.test(field)) return setupPageIndex('insurance');
  if (field.startsWith('payroll.')) return setupPageIndex('contributions');
  if (field.startsWith('backup.')) return setupPageIndex('backup');
  return [0, 2, 6, 8, 9, 12, 14][issue.step] ?? setupPageIndex('review');
}

export type SetupDraft = {
  version: 2; step: number; highestStep: number; settings: AppSettings;
  categoriesText: string; vatText: string; privacyConfirmed: boolean;
};
/** Read old drafts without losing advanced data or mistaking their page numbers for the new flow. */
export function parseSetupDraft(raw: string | null): SetupDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || ![1,2].includes(parsed.version)) return null;
    const clamp = (value: unknown) => Number.isInteger(value) ? Math.max(0, Math.min(parsed.version === 1 ? 6 : setupPages.length - 1, Number(value))) : 0;
    const migrate = (value: unknown) => parsed.version === 1 ? [0,2,6,8,9,12,14][clamp(value)] : clamp(value);
    const settings = settingsFromOnboardingDraft(parsed.settings);
    const enabled = enabledSetupPages(settings);
    const requested = migrate(parsed.step);
    const step = enabled.includes(requested) ? requested : setupPageIndex('payroll');
    return { version:2, step, highestStep: Math.max(step,migrate(parsed.highestStep)), settings,
      categoriesText: typeof parsed.categoriesText === 'string' ? parsed.categoriesText : settings.work.costCategories.join(', '),
      vatText: typeof parsed.vatText === 'string' ? parsed.vatText : '', privacyConfirmed: parsed.privacyConfirmed === true };
  } catch { return null; }
}

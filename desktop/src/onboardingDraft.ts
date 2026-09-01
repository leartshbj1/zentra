import type { AppSettings, PayrollRate } from './types';
import { createId } from './utils';

export const initialOnboardingSettings: AppSettings = {
  organization: {
    legalName: '',
    legalForm: '',
    contactName: '',
    email: '',
    phone: '',
    website: '',
    uidNumber: '',
    vatNumber: '',
    vatRegistered: false,
    logoPath: '',
    address: { street: '', buildingNumber: '', postalCode: '', city: '', canton: '', country: 'CH' },
  },
  business: { nogaSection: '', nogaDivision: '', activityDescription: '', nogaDetailedCode: '' },
  billing: {
    currency: 'CHF',
    iban: '',
    accountHolder: '',
    quotePrefix: 'D',
    invoicePrefix: 'F',
    creditNotePrefix: 'A',
    nextQuoteNumber: 1,
    nextInvoiceNumber: 1,
    nextCreditNoteNumber: 1,
    paymentTermsDays: 30,
    quoteValidityDays: 30,
    vatRatesBp: [],
    defaultFooter: '',
  },
  work: { workWeekHours: 0, dailyHours: 0, roundingMinutes: 5, breakMinutes: 0, costCategories: [] },
  payroll: {
    enabled: false,
    fiduciaryValidated: false,
    avsFund: '',
    accidentInsurer: '',
    pensionFund: '',
    dailyAllowanceInsurer: '',
    familyAllowanceFund: '',
    payrollCanton: '',
    aanpEmployerCoverage: {
      enabled: false,
      reference: '',
      effectiveFrom: '',
      effectiveTo: '',
    },
    employeeRates: [],
    employerRates: [],
  },
  backup: {
    automatic: false,
    folder: '',
    frequency: 'manual',
    retentionDaily: 0,
    retentionWeekly: 0,
    retentionMonthly: 0,
    recoveryConfirmed: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDraftValue<T>(base: T, value: unknown): T {
  if (Array.isArray(base)) return (Array.isArray(value) ? [...value] : [...base]) as T;
  if (isRecord(base)) {
    const source = isRecord(value) ? value : {};
    return Object.fromEntries(
      Object.entries(base).map(([key, fallback]) => [key, mergeDraftValue(fallback, source[key])]),
    ) as T;
  }
  return typeof value === typeof base ? value as T : base;
}

function safeDraftRates(value: unknown): PayrollRate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const label = typeof candidate.label === 'string' ? candidate.label : '';
    const effectiveFrom = typeof candidate.effectiveFrom === 'string' ? candidate.effectiveFrom : '';
    const rateBp = typeof candidate.rateBp === 'number' && Number.isFinite(candidate.rateBp) ? candidate.rateBp : 0;
    const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    let id = rawId && [...rawId].length <= 500 && !seen.has(rawId) ? rawId : createId();
    while (seen.has(id)) id = createId();
    seen.add(id);
    return [{
      id,
      label,
      effectiveFrom,
      rateBp,
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      ...(typeof candidate.sourceLabel === 'string' ? { sourceLabel: candidate.sourceLabel } : {}),
      ...(typeof candidate.sourceUrl === 'string' ? { sourceUrl: candidate.sourceUrl } : {}),
      ...(typeof candidate.annualCeilingCents === 'number' && Number.isSafeInteger(candidate.annualCeilingCents) && candidate.annualCeilingCents > 0
        ? { annualCeilingCents: candidate.annualCeilingCents }
        : {}),
    }];
  });
}

/**
 * Recharge uniquement la forme de configuration connue. Les champs optionnels
 * autorisés (logo et numéro de bâtiment) font partie du gabarit afin de ne pas
 * disparaître quand Windows relance l'assistant après une interruption.
 */
export function settingsFromOnboardingDraft(value: unknown): AppSettings {
  const merged = mergeDraftValue(initialOnboardingSettings, value);
  const root = isRecord(value) ? value : {};
  const billing = isRecord(root.billing) ? root.billing : {};
  const work = isRecord(root.work) ? root.work : {};
  const payroll = isRecord(root.payroll) ? root.payroll : {};
  return {
    ...merged,
    billing: {
      ...merged.billing,
      vatRatesBp: Array.isArray(billing.vatRatesBp)
        ? billing.vatRatesBp.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
        : [],
    },
    work: {
      ...merged.work,
      costCategories: Array.isArray(work.costCategories)
        ? work.costCategories.filter((item): item is string => typeof item === 'string')
        : [],
    },
    payroll: {
      ...merged.payroll,
      employeeRates: safeDraftRates(payroll.employeeRates),
      employerRates: safeDraftRates(payroll.employerRates),
    },
  };
}

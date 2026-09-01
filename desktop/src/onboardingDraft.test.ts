import { describe, expect, it } from 'vitest';
import { initialOnboardingSettings, settingsFromOnboardingDraft } from './onboardingDraft';

describe('reprise du brouillon de configuration', () => {
  it('conserve le logo local et le numéro de bâtiment après un redémarrage', () => {
    const restored = settingsFromOnboardingDraft({
      ...initialOnboardingSettings,
      organization: {
        ...initialOnboardingSettings.organization,
        logoPath: 'C:\\Profil\\Zentra\\attachments\\branding\\logo-test.png',
        address: {
          ...initialOnboardingSettings.organization.address,
          buildingNumber: '14A',
        },
      },
    });

    expect(restored.organization.logoPath).toBe('C:\\Profil\\Zentra\\attachments\\branding\\logo-test.png');
    expect(restored.organization.address.buildingNumber).toBe('14A');
  });

  it('filtre les collections corrompues tout en conservant les métadonnées autorisées des taux', () => {
    const restored = settingsFromOnboardingDraft({
      ...initialOnboardingSettings,
      billing: { ...initialOnboardingSettings.billing, vatRatesBp: [810, 'faux', Number.NaN] },
      work: { ...initialOnboardingSettings.work, costCategories: ['Matériaux', 42] },
      payroll: {
        ...initialOnboardingSettings.payroll,
        employeeRates: [{
          id: 'avs-employee',
          code: 'AVS',
          label: 'AVS salarié',
          rateBp: 435,
          effectiveFrom: '2026-01-01',
          annualCeilingCents: 14_820_000,
        }],
        employerRates: [],
      },
    });

    expect(restored.billing.vatRatesBp).toEqual([810]);
    expect(restored.work.costCategories).toEqual(['Matériaux']);
    expect(restored.payroll.employeeRates[0]).toMatchObject({
      id: 'avs-employee',
      code: 'AVS',
      annualCeilingCents: 14_820_000,
    });
  });
});

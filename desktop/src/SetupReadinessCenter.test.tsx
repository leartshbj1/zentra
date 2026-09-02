import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SetupReadinessCenter,
  buildSetupReadiness,
  confirmDeferredSetup,
} from './SetupReadinessCenter';
import { backupStatusFromRaw } from './bridge';
import type { Account, AccountingSettings, AppSettings, Workspace } from './types';

const completeAccounting: AccountingSettings = {
  enabled: true,
  arAccountId: '1100',
  revenueAccountId: '3200',
  vatPayableAccountId: '2200',
  vatDeferredPayableAccountId: '2201',
  bankAccountId: '1020',
  expenseAccountId: '4200',
  vatReceivableAccountId: '1170',
  wagesExpenseAccountId: '5000',
  wagesPayableAccountId: '2000',
  socialExpenseAccountId: '5700',
  socialPayableAccountId: '2270',
  supplierPayableAccountId: '2001',
};

const completeAccounts: Account[] = [
  ['1100', 'asset', 'debit', 'current_assets'],
  ['3200', 'revenue', 'credit', 'net_revenue'],
  ['2200', 'liability', 'credit', 'short_term_liabilities'],
  ['2201', 'liability', 'credit', 'short_term_liabilities'],
  ['1020', 'asset', 'debit', 'current_assets'],
  ['4200', 'expense', 'debit', 'other_operating_expense'],
  ['1170', 'asset', 'debit', 'current_assets'],
  ['5000', 'expense', 'debit', 'personnel_expense'],
  ['2000', 'liability', 'credit', 'short_term_liabilities'],
  ['5700', 'expense', 'debit', 'personnel_expense'],
  ['2270', 'liability', 'credit', 'short_term_liabilities'],
  ['2001', 'liability', 'credit', 'short_term_liabilities'],
].map(([id, accountType, normalBalance, reportSection]) => ({
  id,
  code: id,
  name: `Compte ${id}`,
  accountType: accountType as Account['accountType'],
  normalBalance: normalBalance as Account['normalBalance'],
  reportSection: reportSection as Account['reportSection'],
  active: true,
}));

const baseSettings: AppSettings = {
  organization: {
    legalName: 'Atelier Exemple SA',
    legalForm: 'SA',
    contactName: 'Aline Exemple',
    email: 'aline@example.ch',
    phone: '',
    website: '',
    uidNumber: '',
    vatNumber: '',
    vatRegistered: false,
    logoPath: 'C:\\Zentra\\logos\\atelier.png',
    address: {
      street: 'Rue du Lac',
      buildingNumber: '2',
      postalCode: '1000',
      city: 'Lausanne',
      canton: 'VD',
      country: 'CH',
    },
  },
  business: {
    nogaSection: 'M',
    nogaDivision: '69',
    activityDescription: 'Conseil',
    nogaDetailedCode: '',
  },
  billing: {
    currency: 'CHF',
    iban: 'CH9300762011623852957',
    accountHolder: 'Atelier Exemple SA',
    quotePrefix: 'DEV',
    invoicePrefix: 'FAC',
    creditNotePrefix: 'AVO',
    nextQuoteNumber: 1,
    nextInvoiceNumber: 1,
    nextCreditNoteNumber: 1,
    paymentTermsDays: 30,
    quoteValidityDays: 30,
    vatRatesBp: [],
    defaultFooter: '',
  },
  work: {
    workWeekHours: 42,
    dailyHours: 8.4,
    roundingMinutes: 5,
    breakMinutes: 30,
    costCategories: ['Fournitures'],
  },
  payroll: {
    enabled: false,
    fiduciaryValidated: false,
    avsFund: '',
    accidentInsurer: '',
    pensionFund: '',
    dailyAllowanceInsurer: '',
    familyAllowanceFund: '',
    payrollCanton: '',
    employeeRates: [],
    employerRates: [],
  },
  backup: {
    automatic: false,
    folder: 'D:\\Sauvegardes Zentra',
    frequency: 'manual',
    retentionDaily: 0,
    retentionWeekly: 0,
    retentionMonthly: 0,
    recoveryConfirmed: true,
  },
};

function workspace(
  settings: AppSettings = baseSettings,
  accountingSettings: AccountingSettings | null = completeAccounting,
): Workspace {
  return {
    settings,
    accountingSettings,
    accounts: completeAccounts,
    backupStatus: {
      lastSuccessAt: '2026-09-01T08:00:00Z',
      lastPath: 'D:\\Sauvegardes Zentra\\elyko.elyko',
      nextScheduledAt: null,
    },
  } as Workspace;
}

describe('centre de préparation', () => {
  it('calcule cinq étapes prêtes lorsque la paie est désactivée', () => {
    const result = buildSetupReadiness(workspace(), baseSettings);

    expect(result).toMatchObject({ readyCount: 5, totalCount: 5, percent: 100 });
    expect(result.steps.map((item) => item.id)).toEqual([
      'identity',
      'billing',
      'work',
      'accounting',
      'backup',
    ]);
    expect(result.steps.every((item) => item.ready)).toBe(true);
  });

  it('signale précisément les règles de temps différées au premier lancement', () => {
    const settings = {
      ...baseSettings,
      work: {
        ...baseSettings.work,
        workWeekHours: 0,
        dailyHours: 0,
        costCategories: [],
      },
    };
    const result = buildSetupReadiness(workspace(settings), settings);
    const work = result.steps.find((item) => item.id === 'work');

    expect(work).toMatchObject({
      ready: false,
      missing: ['heures hebdomadaires', 'heures journalières', 'catégories de coûts'],
    });
    expect(work?.summary).toContain('heures hebdomadaires, heures journalières, catégories de coûts');
    expect(work?.targetId).toBe('settings-work-rules');
  });

  it('considère le logo client comme facultatif sans masquer son statut', () => {
    const settings = {
      ...baseSettings,
      organization: { ...baseSettings.organization, logoPath: '' },
    };
    const result = buildSetupReadiness(workspace(settings), settings);
    const identity = result.steps.find((item) => item.id === 'identity');

    expect(identity).toMatchObject({ ready: true, missing: [] });
    expect(identity?.summary).toContain('logo reste facultatif');
  });

  it('ne marque pas la comptabilité prête si une liaison manque', () => {
    const accountingSettings = {
      ...completeAccounting,
      supplierPayableAccountId: '',
    };
    const result = buildSetupReadiness(
      workspace(baseSettings, accountingSettings),
      baseSettings,
    );
    const accounting = result.steps.find((item) => item.id === 'accounting');

    expect(accounting).toMatchObject({ ready: false });
    expect(accounting?.missing).toContain('1 liaison comptable');
  });

  it('n’exige pas les liaisons de salaires lorsque la paie est désactivée', () => {
    const accountingSettings = {
      ...completeAccounting,
      wagesExpenseAccountId: '',
      wagesPayableAccountId: '',
      socialExpenseAccountId: '',
      socialPayableAccountId: '',
    };
    const result = buildSetupReadiness(
      workspace(baseSettings, accountingSettings),
      baseSettings,
    );

    expect(result.steps.find((item) => item.id === 'accounting')).toMatchObject({
      ready: true,
    });
  });

  it('conserve les liaisons paie requises si un historique a déjà été comptabilisé', () => {
    const accountingSettings = {
      ...completeAccounting,
      wagesExpenseAccountId: '',
      wagesPayableAccountId: '',
      socialExpenseAccountId: '',
      socialPayableAccountId: '',
    };
    const withPayrollHistory = workspace(baseSettings, accountingSettings);
    withPayrollHistory.payslips = [
      {
        id: 'payslip-1',
        employeeId: 'employee-1',
        period: '2026-08',
        status: 'posted',
        lines: [],
        paymentDate: '',
        notes: '',
        createdAt: '2026-08-31T00:00:00Z',
      },
    ];

    const result = buildSetupReadiness(withPayrollHistory, baseSettings);
    const accounting = result.steps.find((item) => item.id === 'accounting');
    expect(accounting).toMatchObject({ ready: false });
    expect(accounting?.missing).toContain('4 liaisons comptables');
  });

  it('reste incomplet tant qu’aucune sauvegarde n’a réellement réussi', () => {
    const withoutBackup = workspace();
    withoutBackup.backupStatus = {
      ...withoutBackup.backupStatus,
      lastSuccessAt: null,
      lastPath: null,
    };
    const result = buildSetupReadiness(withoutBackup, baseSettings);
    const backup = result.steps.find((item) => item.id === 'backup');

    expect(backup).toMatchObject({ ready: false });
    expect(backup?.missing).toContain('première sauvegarde réussie');
    expect(result.percent).toBe(80);
  });

  it('ne considère jamais les valeurs techniques par défaut comme confirmées', () => {
    const deferred: AppSettings = {
      ...baseSettings,
      setupDeferred: { billing: true, work: true, backup: true },
    };
    const result = buildSetupReadiness(workspace(deferred), deferred);

    expect(result.steps.find((item) => item.id === 'billing')?.missing)
      .toContain('confirmation des réglages de facturation');
    expect(result.steps.find((item) => item.id === 'work')?.missing)
      .toContain('confirmation des règles de temps et de coûts');
    expect(result.steps.find((item) => item.id === 'backup')?.missing)
      .toContain('confirmation de la stratégie de sauvegarde');
    expect(result.readyCount).toBe(2);
  });

  it('retire uniquement le marqueur explicitement confirmé', () => {
    const deferred: AppSettings = {
      ...baseSettings,
      setupDeferred: { billing: true, work: true, backup: true },
    };

    expect(confirmDeferredSetup(deferred, 'work').setupDeferred).toEqual({
      billing: true,
      work: false,
      backup: true,
    });
  });

  it('invalide une ancienne sauvegarde lorsque le dossier configuré a changé', () => {
    const settings = {
      ...baseSettings,
      backup: { ...baseSettings.backup, folder: 'E:\\Nouvelles sauvegardes' },
    };
    const result = buildSetupReadiness(workspace(settings), settings);
    const backup = result.steps.find((item) => item.id === 'backup');

    expect(backup).toMatchObject({ ready: false });
    expect(backup?.missing).toContain('archive réussie dans le dossier configuré');
  });

  it('devient prêt avec la preuve backend rechargée après une sauvegarde réussie', () => {
    const reloaded = workspace();
    reloaded.backupStatus = backupStatusFromRaw({
      last_success_at: '2026-09-01T22:45:00+02:00',
      last_path: 'D:\\Sauvegardes Zentra\\Zentra-sauvegarde-20260901.elyko',
      next_scheduled_at: null,
    });

    const result = buildSetupReadiness(reloaded, baseSettings);

    expect(reloaded.backupStatus).toEqual({
      lastSuccessAt: '2026-09-01T22:45:00+02:00',
      lastPath: 'D:\\Sauvegardes Zentra\\Zentra-sauvegarde-20260901.elyko',
      nextScheduledAt: null,
    });
    expect(result.steps.find((item) => item.id === 'backup')).toMatchObject({
      ready: true,
      missing: [],
    });
  });

  it('ajoute la paie seulement lorsqu’elle est activée et détaille les données manquantes', () => {
    const settings: AppSettings = {
      ...baseSettings,
      payroll: {
        ...baseSettings.payroll,
        enabled: true,
        avsFund: 'Caisse AVS Vaud',
        accidentInsurer: 'Assureur réel',
        payrollCanton: 'VD',
      },
    };
    const result = buildSetupReadiness(workspace(settings), settings);
    const payroll = result.steps.find((item) => item.id === 'payroll');

    expect(result.totalCount).toBe(6);
    expect(payroll).toMatchObject({ ready: false });
    expect(payroll?.missing).toEqual([
      'caisse de pension',
      'assureur indemnités journalières',
      'caisse d’allocations familiales',
      'validation professionnelle',
    ]);
  });

  it('rend des états explicites et rappelle les limites du contrôle', () => {
    const html = renderToStaticMarkup(
      <SetupReadinessCenter
        workspace={workspace()}
        settings={baseSettings}
        onNavigate={() => undefined}
      />,
    );

    expect(html).toContain('5 étapes prêtes sur 5');
    expect(html.match(/Prêt/g)).toHaveLength(5);
    expect(html).toContain('ne remplace ni un contrôle légal');
    expect(html).toContain('aria-valuenow="100"');
  });
});

import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock3,
  Database,
  Landmark,
  ReceiptText,
  Users,
} from 'lucide-react';
import { isValidSwissIban } from './onboardingValidation';
import type { AccountingSettings, AppSettings, Workspace } from './types';

export const SETTINGS_READINESS_TARGETS = {
  identity: 'settings-company-identity',
  billing: 'settings-company-billing',
  work: 'settings-work-rules',
  accounting: 'settings-accounting-links',
  payroll: 'settings-payroll-organizations',
  backup: 'settings-backup',
} as const;

export type SetupReadinessStepId = keyof typeof SETTINGS_READINESS_TARGETS;

export type SetupReadinessStep = {
  id: SetupReadinessStepId;
  title: string;
  targetId: string;
  ready: boolean;
  summary: string;
  missing: string[];
};

export type SetupReadiness = {
  steps: SetupReadinessStep[];
  readyCount: number;
  totalCount: number;
  percent: number;
};

export type DeferredSetupArea = 'billing' | 'work' | 'backup';

export function confirmDeferredSetup(
  settings: AppSettings,
  area: DeferredSetupArea,
): AppSettings {
  return {
    ...settings,
    setupDeferred: {
      billing: settings.setupDeferred?.billing === true,
      work: settings.setupDeferred?.work === true,
      backup: settings.setupDeferred?.backup === true,
      [area]: false,
    },
  };
}

const coreAccountingMappingKeys: Array<Exclude<keyof AccountingSettings, 'enabled'>> = [
  'arAccountId',
  'revenueAccountId',
  'vatPayableAccountId',
  'vatDeferredPayableAccountId',
  'bankAccountId',
  'expenseAccountId',
  'vatReceivableAccountId',
  'supplierPayableAccountId',
];

const payrollAccountingMappingKeys: Array<Exclude<keyof AccountingSettings, 'enabled'>> = [
  'wagesExpenseAccountId',
  'wagesPayableAccountId',
  'socialExpenseAccountId',
  'socialPayableAccountId',
];

const accountingMappingTypes: Record<Exclude<keyof AccountingSettings, 'enabled'>, string> = {
  arAccountId: 'asset',
  revenueAccountId: 'revenue',
  vatPayableAccountId: 'liability',
  vatDeferredPayableAccountId: 'liability',
  bankAccountId: 'asset',
  expenseAccountId: 'expense',
  vatReceivableAccountId: 'asset',
  wagesExpenseAccountId: 'expense',
  wagesPayableAccountId: 'liability',
  socialExpenseAccountId: 'expense',
  socialPayableAccountId: 'liability',
  supplierPayableAccountId: 'liability',
};

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function normalizedWindowsPath(value: string | null | undefined) {
  return value?.trim().replaceAll('/', '\\').replace(/\\+$/, '').toLocaleLowerCase('fr-CH') ?? '';
}

function missingSummary(missing: string[]) {
  if (!missing.length) return '';
  return `À renseigner : ${missing.join(', ')}.`;
}

function step(
  id: SetupReadinessStepId,
  title: string,
  missing: string[],
  readySummary: string,
): SetupReadinessStep {
  return {
    id,
    title,
    targetId: SETTINGS_READINESS_TARGETS[id],
    ready: missing.length === 0,
    summary: missing.length ? missingSummary(missing) : readySummary,
    missing,
  };
}

export function buildSetupReadiness(
  workspace: Workspace,
  settings: AppSettings,
): SetupReadiness {
  const { organization, billing, work, payroll, backup } = settings;
  const identityMissing: string[] = [];
  if (!hasText(organization.legalName)) identityMissing.push('raison sociale');
  if (!hasText(organization.contactName)) identityMissing.push('responsable');
  if (!hasText(organization.email)) identityMissing.push('e-mail');
  if (!hasText(organization.address.street)) identityMissing.push('rue');
  if (!hasText(organization.address.postalCode)) identityMissing.push('NPA');
  if (!hasText(organization.address.city)) identityMissing.push('localité');
  if (!hasText(organization.address.canton)) identityMissing.push('canton');
  if (!/^[A-Z]{2}$/.test(organization.address.country.trim().toUpperCase()))
    identityMissing.push('pays');

  const billingMissing: string[] = [];
  if (settings.setupDeferred?.billing)
    billingMissing.push('confirmation des réglages de facturation');
  if (!isValidSwissIban(billing.iban)) billingMissing.push('IBAN CH/LI valide');
  if (!hasText(billing.accountHolder)) billingMissing.push('titulaire du compte');
  if (!hasText(billing.quotePrefix)) billingMissing.push('préfixe devis');
  if (!hasText(billing.invoicePrefix)) billingMissing.push('préfixe factures');
  if (!hasText(billing.creditNotePrefix)) billingMissing.push('préfixe avoirs');
  if (!Number.isInteger(billing.paymentTermsDays) || billing.paymentTermsDays < 1)
    billingMissing.push('délai de paiement');
  if (!Number.isInteger(billing.quoteValidityDays) || billing.quoteValidityDays < 1)
    billingMissing.push('validité des devis');
  if (organization.vatRegistered) {
    if (!hasText(organization.vatNumber)) billingMissing.push('numéro TVA');
    if (!billing.vatRatesBp.some((rate) => Number.isInteger(rate) && rate > 0))
      billingMissing.push('taux TVA');
  }

  const workMissing: string[] = [];
  if (settings.setupDeferred?.work)
    workMissing.push('confirmation des règles de temps et de coûts');
  if (!Number.isFinite(work.workWeekHours) || work.workWeekHours <= 0 || work.workWeekHours > 168)
    workMissing.push('heures hebdomadaires');
  if (!Number.isFinite(work.dailyHours) || work.dailyHours <= 0 || work.dailyHours > 24)
    workMissing.push('heures journalières');
  else if (work.workWeekHours > 0 && work.dailyHours > work.workWeekHours)
    workMissing.push('durée journalière cohérente');
  if (![0, 1, 5, 10, 15].includes(work.roundingMinutes))
    workMissing.push('règle d’arrondi');
  if (!Number.isInteger(work.breakMinutes) || work.breakMinutes < 0 || work.breakMinutes > 1_440)
    workMissing.push('pause habituelle');
  if (!work.costCategories.length) workMissing.push('catégories de coûts');

  const accountingMissing: string[] = [];
  const accounting = workspace.accountingSettings;
  const payrollMappingsRequired = payroll.enabled
    || (workspace.payslips ?? []).some((payslip) => ['posted', 'paid'].includes(payslip.status));
  const accountingMappingKeys = payrollMappingsRequired
    ? [...coreAccountingMappingKeys, ...payrollAccountingMappingKeys]
    : coreAccountingMappingKeys;
  if (!accounting?.enabled) accountingMissing.push('activation comptable');
  const mappedAccounts = accounting
    ? accountingMappingKeys.filter((key) => hasText(accounting[key])).length
    : 0;
  if (mappedAccounts < accountingMappingKeys.length)
    accountingMissing.push(
      `${accountingMappingKeys.length - mappedAccounts} liaison${accountingMappingKeys.length - mappedAccounts > 1 ? 's' : ''} comptable${accountingMappingKeys.length - mappedAccounts > 1 ? 's' : ''}`,
    );
  const accountsById = new Map((workspace.accounts ?? []).map((account) => [account.id, account]));
  if (accounting) {
    for (const key of accountingMappingKeys) {
      const accountId = accounting[key]?.trim();
      if (!accountId) continue;
      const linked = accountsById.get(accountId);
      if (!linked || !linked.active || linked.accountType !== accountingMappingTypes[key]) {
        accountingMissing.push(`liaison ${key} absente, inactive ou de mauvais type`);
      }
    }
    const distinctAssetRoles = [accounting.arAccountId, accounting.bankAccountId, accounting.vatReceivableAccountId]
      .map((value) => value.trim())
      .filter(Boolean);
    if (new Set(distinctAssetRoles).size !== distinctAssetRoles.length) {
      accountingMissing.push('comptes distincts pour clients, banque et TVA préalable');
    }
    if (accounting.vatPayableAccountId === accounting.vatDeferredPayableAccountId) {
      accountingMissing.push('comptes distincts pour TVA due et TVA à régulariser');
    }
  }

  const steps: SetupReadinessStep[] = [
    step(
      'identity',
      'Identité de l’entreprise',
      identityMissing,
      organization.logoPath
        ? 'Identité et adresse renseignées; logo local configuré.'
        : 'Identité et adresse renseignées; le logo reste facultatif.',
    ),
    step(
      'billing',
      'Facturation',
      billingMissing,
      organization.vatRegistered
        ? 'Coordonnées bancaires, numérotation et TVA sont renseignées.'
        : 'Coordonnées bancaires et numérotation sont renseignées; entreprise déclarée non assujettie.',
    ),
    step(
      'work',
      'Temps et coûts',
      workMissing,
      'Durées, arrondi, pause et catégories de coûts sont renseignés.',
    ),
    step(
      'accounting',
      'Comptabilité',
      accountingMissing,
      `${accountingMappingKeys.length} comptes de liaison sont renseignés et l’automatisation est active.`,
    ),
  ];

  if (payroll.enabled) {
    const payrollMissing: string[] = [];
    if (!hasText(payroll.avsFund)) payrollMissing.push('caisse AVS');
    if (!hasText(payroll.accidentInsurer)) payrollMissing.push('assureur accidents');
    if (!hasText(payroll.pensionFund)) payrollMissing.push('caisse de pension');
    if (!hasText(payroll.dailyAllowanceInsurer))
      payrollMissing.push('assureur indemnités journalières');
    if (!hasText(payroll.familyAllowanceFund))
      payrollMissing.push('caisse d’allocations familiales');
    if (!hasText(payroll.payrollCanton)) payrollMissing.push('canton de paie');
    if (payroll.aanpEmployerCoverage?.enabled) {
      if (!hasText(payroll.aanpEmployerCoverage.reference))
        payrollMissing.push('référence de prise en charge AANP employeur');
      if (!hasText(payroll.aanpEmployerCoverage.effectiveFrom))
        payrollMissing.push('début de prise en charge AANP employeur');
      if (
        hasText(payroll.aanpEmployerCoverage.effectiveTo) &&
        payroll.aanpEmployerCoverage.effectiveTo < payroll.aanpEmployerCoverage.effectiveFrom
      )
        payrollMissing.push('période AANP employeur cohérente');
    }
    if (!payroll.fiduciaryValidated) payrollMissing.push('validation professionnelle');
    steps.push(
      step(
        'payroll',
        'Paie',
        payrollMissing,
        'Organismes de paie renseignés et contrôle professionnel confirmé.',
      ),
    );
  }

  const backupMissing: string[] = [];
  if (settings.setupDeferred?.backup)
    backupMissing.push('confirmation de la stratégie de sauvegarde');
  if (!hasText(backup.folder)) backupMissing.push('dossier de sauvegarde');
  if (!backup.recoveryConfirmed) backupMissing.push('stratégie de récupération confirmée');
  if (!workspace.backupStatus.lastSuccessAt) backupMissing.push('première sauvegarde réussie');
  const backupFolder = normalizedWindowsPath(backup.folder);
  const lastBackupPath = normalizedWindowsPath(workspace.backupStatus.lastPath);
  if (
    workspace.backupStatus.lastSuccessAt &&
    (!lastBackupPath || !backupFolder || !lastBackupPath.startsWith(`${backupFolder}\\`))
  )
    backupMissing.push('archive réussie dans le dossier configuré');
  steps.push(
    step(
      'backup',
      'Sauvegarde',
      backupMissing,
      'Dossier et stratégie configurés; une sauvegarde locale réussie est enregistrée.',
    ),
  );

  const readyCount = steps.filter((item) => item.ready).length;
  return {
    steps,
    readyCount,
    totalCount: steps.length,
    percent: steps.length ? Math.round((readyCount / steps.length) * 100) : 0,
  };
}

function StepIcon({ id }: { id: SetupReadinessStepId }) {
  if (id === 'identity') return <Building2 size={20} aria-hidden="true" />;
  if (id === 'billing') return <ReceiptText size={20} aria-hidden="true" />;
  if (id === 'work') return <Clock3 size={20} aria-hidden="true" />;
  if (id === 'accounting') return <Landmark size={20} aria-hidden="true" />;
  if (id === 'payroll') return <Users size={20} aria-hidden="true" />;
  return <Database size={20} aria-hidden="true" />;
}

export function SetupReadinessCenter({
  workspace,
  settings,
  onNavigate,
}: {
  workspace: Workspace;
  settings: AppSettings;
  onNavigate: (targetId: string) => void;
}) {
  const readiness = buildSetupReadiness(workspace, settings);
  const allReady = readiness.readyCount === readiness.totalCount;

  return (
    <section
      className={`panel settings-card settings-card--wide setup-readiness ${allReady ? 'is-ready' : ''}`}
      aria-labelledby="setup-readiness-title"
    >
      <header className="setup-readiness__header">
        <div>
          <p className="eyebrow">Préparation de votre espace</p>
          <h2 id="setup-readiness-title">
            {allReady ? 'Les réglages essentiels sont prêts' : 'Finalisez votre configuration'}
          </h2>
          <p>
            {readiness.readyCount} étape{readiness.readyCount > 1 ? 's' : ''} prête
            {readiness.readyCount > 1 ? 's' : ''} sur {readiness.totalCount}
          </p>
        </div>
        <div className="setup-readiness__score" aria-label={`${readiness.percent} pour cent des étapes prêtes`}>
          <strong>{readiness.percent}%</strong>
          <span>préparé</span>
        </div>
      </header>

      <div
        className="setup-readiness__progress"
        role="progressbar"
        aria-label="Progression de la préparation"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={readiness.percent}
      >
        <span style={{ width: `${readiness.percent}%` }} />
      </div>

      <ol className="setup-readiness__steps">
        {readiness.steps.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`setup-readiness__step ${item.ready ? 'is-ready' : 'is-incomplete'}`}
              onClick={() => onNavigate(item.targetId)}
              aria-label={`${item.title} — ${item.ready ? 'prêt' : 'à compléter'}. Ouvrir la section.`}
            >
              <span className="setup-readiness__icon">
                <StepIcon id={item.id} />
              </span>
              <span className="setup-readiness__copy">
                <span className="setup-readiness__step-title">
                  <strong>{item.title}</strong>
                  <em>
                    {item.ready ? <CheckCircle2 size={13} aria-hidden="true" /> : null}
                    {item.ready ? 'Prêt' : 'À compléter'}
                  </em>
                </span>
                <small>{item.summary}</small>
              </span>
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>

      <p className="setup-readiness__disclaimer">
        Ce centre vérifie uniquement les réglages enregistrés sur cet ordinateur. Il ne remplace
        ni un contrôle légal, ni la validation d’une fiduciaire ou d’un assureur.
      </p>
    </section>
  );
}

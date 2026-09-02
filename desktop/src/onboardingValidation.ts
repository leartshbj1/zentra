import type { AppSettings, NogaCatalog, PayrollRate } from './types';

export type OnboardingIssue = {
  step: number;
  field: string;
  label: string;
  message: string;
};

export type OnboardingValidationScope = 'essential' | 'complete';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREFIX = /^[A-Z0-9-]{1,12}$/;
const COUNTRY = /^[A-Z]{2}$/;

const clean = (value: string) => value.trim();

export function normalizeIban(value: string) {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function isValidSwissIban(value: string) {
  const iban = normalizeIban(value);
  if (!/^(CH|LI)\d{7}[A-Z0-9]{12}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/.test(character)
      ? character
      : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function normalizeRate(rate: PayrollRate): PayrollRate {
  return {
    ...rate,
    label: clean(rate.label),
    effectiveFrom: clean(rate.effectiveFrom),
    sourceLabel: rate.sourceLabel ? clean(rate.sourceLabel) : rate.sourceLabel,
    sourceUrl: rate.sourceUrl ? clean(rate.sourceUrl) : rate.sourceUrl,
  };
}

export function normalizeOnboardingSettings(settings: AppSettings): AppSettings {
  const uniqueCategories = Array.from(
    new Set(settings.work.costCategories.map(clean).filter(Boolean)),
  );
  const uniqueVatRates = Array.from(
    new Set(settings.billing.vatRatesBp.filter(Number.isFinite).map(Math.round)),
  );
  return {
    organization: {
      ...settings.organization,
      legalName: clean(settings.organization.legalName),
      legalForm: clean(settings.organization.legalForm),
      contactName: clean(settings.organization.contactName),
      email: clean(settings.organization.email),
      phone: clean(settings.organization.phone),
      website: clean(settings.organization.website),
      uidNumber: clean(settings.organization.uidNumber),
      vatNumber: clean(settings.organization.vatNumber),
      address: {
        ...settings.organization.address,
        street: clean(settings.organization.address.street),
        buildingNumber: clean(settings.organization.address.buildingNumber ?? ''),
        postalCode: clean(settings.organization.address.postalCode),
        city: clean(settings.organization.address.city),
        canton: clean(settings.organization.address.canton),
        country: clean(settings.organization.address.country).toUpperCase(),
      },
    },
    business: {
      ...settings.business,
      nogaDivision: clean(settings.business.nogaDivision),
      activityDescription: clean(settings.business.activityDescription),
      nogaDetailedCode: clean(settings.business.nogaDetailedCode),
    },
    billing: {
      ...settings.billing,
      iban: normalizeIban(settings.billing.iban),
      accountHolder: clean(settings.billing.accountHolder),
      quotePrefix: clean(settings.billing.quotePrefix).toUpperCase(),
      invoicePrefix: clean(settings.billing.invoicePrefix).toUpperCase(),
      creditNotePrefix: clean(settings.billing.creditNotePrefix).toUpperCase(),
      vatRatesBp: settings.organization.vatRegistered ? uniqueVatRates : [],
      defaultFooter: clean(settings.billing.defaultFooter),
    },
    work: { ...settings.work, costCategories: uniqueCategories },
    payroll: {
      ...settings.payroll,
      avsFund: clean(settings.payroll.avsFund),
      accidentInsurer: clean(settings.payroll.accidentInsurer),
      pensionFund: clean(settings.payroll.pensionFund),
      dailyAllowanceInsurer: clean(settings.payroll.dailyAllowanceInsurer),
      familyAllowanceFund: clean(settings.payroll.familyAllowanceFund),
      payrollCanton: clean(settings.payroll.payrollCanton),
      aanpEmployerCoverage: {
        enabled: settings.payroll.aanpEmployerCoverage?.enabled === true,
        reference: clean(settings.payroll.aanpEmployerCoverage?.reference ?? ''),
        effectiveFrom: clean(settings.payroll.aanpEmployerCoverage?.effectiveFrom ?? ''),
        effectiveTo: clean(settings.payroll.aanpEmployerCoverage?.effectiveTo ?? ''),
      },
      lppPlanEvidence: settings.payroll.lppPlanEvidence
        ? {
            contractNumber: clean(
              settings.payroll.lppPlanEvidence.contractNumber,
            ),
            regulationReference: clean(
              settings.payroll.lppPlanEvidence.regulationReference,
            ),
            effectiveFrom: clean(
              settings.payroll.lppPlanEvidence.effectiveFrom,
            ),
            effectiveTo: clean(
              settings.payroll.lppPlanEvidence.effectiveTo,
            ),
            employerAggregateShareConfirmed:
              settings.payroll.lppPlanEvidence
                .employerAggregateShareConfirmed === true,
          }
        : undefined,
      employeeRates: settings.payroll.enabled ? settings.payroll.employeeRates.map(normalizeRate) : [],
      employerRates: settings.payroll.enabled ? settings.payroll.employerRates.map(normalizeRate) : [],
    },
    backup: { ...settings.backup, folder: clean(settings.backup.folder) },
  };
}

function isRealDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validateOnboarding(
  rawSettings: AppSettings,
  catalog: NogaCatalog | null,
  privacyConfirmed: boolean,
  scope: OnboardingValidationScope = 'complete',
): OnboardingIssue[] {
  const settings = normalizeOnboardingSettings(rawSettings);
  const issues: OnboardingIssue[] = [];
  const add = (step: number, field: string, label: string, message: string) =>
    issues.push({ step, field, label, message });
  const required = (
    step: number,
    field: string,
    label: string,
    value: string,
    max = 300,
  ) => {
    if (!value) add(step, field, label, `${label} est obligatoire.`);
    else if (value.length > max)
      add(step, field, label, `${label} doit contenir au maximum ${max} caractères.`);
  };

  const org = settings.organization;
  const business = settings.business;
  required(1, 'organization.legalName', 'La raison sociale', org.legalName, 200);
  required(1, 'organization.contactName', 'Le responsable', org.contactName, 200);
  required(1, 'organization.email', 'L’adresse e-mail', org.email, 254);
  if (org.email && !EMAIL.test(org.email))
    add(1, 'organization.email', 'L’adresse e-mail', 'Saisissez une adresse e-mail complète, par exemple nom@entreprise.ch.');
  if (org.website) {
    try {
      const url = new URL(org.website);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    } catch {
      add(1, 'organization.website', 'Le site internet', 'Utilisez une adresse complète commençant par https:// ou http://.');
    }
  }
  required(1, 'organization.address.street', 'La rue ou case postale', org.address.street, 300);
  required(1, 'organization.address.postalCode', 'Le NPA', org.address.postalCode, 24);
  required(1, 'organization.address.city', 'La localité', org.address.city, 120);
  required(1, 'organization.address.canton', 'Le canton', org.address.canton, 80);
  if (!COUNTRY.test(org.address.country))
    add(1, 'organization.address.country', 'Le pays', 'Utilisez exactement deux lettres ISO, par exemple CH.');
  if (org.vatRegistered && !org.uidNumber && !org.vatNumber)
    add(1, 'organization.vatIdentifier', 'L’identifiant TVA', 'Renseignez le numéro IDE/UID ou le numéro TVA de l’entreprise.');

  const section = catalog?.sections.find((item) => item.code === business.nogaSection);
  if (!catalog)
    add(1, 'business.nogaSection', 'La section NOGA', 'Le catalogue NOGA local doit être chargé avant de continuer.');
  else if (!section)
    add(1, 'business.nogaSection', 'La section NOGA', 'Choisissez une section NOGA 2025 dans la liste.');
  if (!section?.divisions.some((division) => division.code === business.nogaDivision))
    add(1, 'business.nogaDivision', 'La division NOGA', 'Choisissez une division appartenant à la section sélectionnée.');
  required(1, 'business.activityDescription', 'L’activité précise', business.activityDescription, 2_000);
  if (
    business.nogaDetailedCode &&
    (!/^(\d{3}|\d{4}|\d{6})$/.test(business.nogaDetailedCode) ||
      !business.nogaDetailedCode.startsWith(business.nogaDivision))
  )
    add(1, 'business.nogaDetailedCode', 'Le code NOGA détaillé', 'Le code doit contenir 3, 4 ou 6 chiffres et commencer par la division choisie.');

  // Le démarrage progressif crée uniquement le socle d'identité et d'activité.
  // Les autres sections restent vides et sont signalées par le centre de
  // préparation, sans inventer de coordonnées bancaires ou de règles métier.
  if (scope === 'essential') return issues;

  const billing = settings.billing;
  if (!billing.iban)
    add(2, 'billing.iban', 'L’IBAN', 'L’IBAN ou le QR-IBAN est obligatoire.');
  else if (billing.iban.length !== 21)
    add(2, 'billing.iban', 'L’IBAN', `${billing.iban.length} caractères détectés : un IBAN CH ou LI doit en contenir exactement 21.`);
  else if (!/^(CH|LI)/.test(billing.iban))
    add(2, 'billing.iban', 'L’IBAN', 'Le compte doit commencer par CH ou LI.');
  else if (!/^(CH|LI)\d{7}[A-Z0-9]{12}$/.test(billing.iban))
    add(2, 'billing.iban', 'L’IBAN', 'Le format contient un caractère inattendu. Recopiez l’IBAN complet tel qu’indiqué par la banque.');
  else if (!isValidSwissIban(billing.iban))
    add(2, 'billing.iban', 'L’IBAN', 'La clé de contrôle de cet IBAN est incorrecte. Vérifiez les chiffres avec votre document bancaire.');
  required(2, 'billing.accountHolder', 'Le titulaire du compte', billing.accountHolder, 200);
  for (const [field, label, value] of [
    ['billing.quotePrefix', 'Le préfixe des devis', billing.quotePrefix],
    ['billing.invoicePrefix', 'Le préfixe des factures', billing.invoicePrefix],
    ['billing.creditNotePrefix', 'Le préfixe des avoirs', billing.creditNotePrefix],
  ] as const) {
    if (!PREFIX.test(value))
      add(2, field, label, `${label} accepte uniquement lettres, chiffres et tirets, sur 12 caractères maximum.`);
  }
  for (const [field, label, value] of [
    ['billing.nextQuoteNumber', 'Le prochain numéro de devis', billing.nextQuoteNumber],
    ['billing.nextInvoiceNumber', 'Le prochain numéro de facture', billing.nextInvoiceNumber],
    ['billing.nextCreditNoteNumber', 'Le prochain numéro d’avoir', billing.nextCreditNoteNumber],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0)
      add(2, field, label, `${label} doit être un nombre entier supérieur à zéro.`);
  }
  for (const [field, label, value] of [
    ['billing.paymentTermsDays', 'Le délai de paiement', billing.paymentTermsDays],
    ['billing.quoteValidityDays', 'La validité des devis', billing.quoteValidityDays],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 365)
      add(2, field, label, `${label} doit être compris entre 1 et 365 jours.`);
  }
  if (org.vatRegistered && billing.vatRatesBp.length === 0)
    add(2, 'billing.vatRatesBp', 'Les taux de TVA', 'Ajoutez au moins un taux de TVA confirmé.');
  if (billing.vatRatesBp.some((rate) => !Number.isInteger(rate) || rate < 1 || rate > 10_000))
    add(2, 'billing.vatRatesBp', 'Les taux de TVA', 'Chaque taux doit être supérieur à 0 % et inférieur ou égal à 100 %.');

  const work = settings.work;
  if (!Number.isFinite(work.workWeekHours) || work.workWeekHours <= 0 || work.workWeekHours > 168)
    add(3, 'work.workWeekHours', 'Les heures par semaine', 'Saisissez une durée supérieure à 0 et inférieure ou égale à 168 heures.');
  if (!Number.isFinite(work.dailyHours) || work.dailyHours <= 0 || work.dailyHours > 24)
    add(3, 'work.dailyHours', 'Les heures par journée', 'Saisissez une durée supérieure à 0 et inférieure ou égale à 24 heures.');
  if (work.dailyHours > work.workWeekHours && work.workWeekHours > 0)
    add(3, 'work.dailyHours', 'Les heures par journée', 'La durée journalière ne peut pas dépasser la durée hebdomadaire.');
  if (![0, 1, 5, 10, 15].includes(work.roundingMinutes))
    add(3, 'work.roundingMinutes', 'L’arrondi des pointages', 'Choisissez une règle d’arrondi dans la liste.');
  if (!Number.isInteger(work.breakMinutes) || work.breakMinutes < 0 || work.breakMinutes > 1_440)
    add(3, 'work.breakMinutes', 'La pause habituelle', 'La pause doit être un nombre entier compris entre 0 et 1 440 minutes.');
  if (!work.costCategories.length)
    add(3, 'work.costCategories', 'Les catégories de dépenses', 'Ajoutez au moins une catégorie de dépenses.');

  const payroll = settings.payroll;
  if (payroll.enabled) {
    required(4, 'payroll.avsFund', 'La caisse AVS', payroll.avsFund, 200);
    required(4, 'payroll.accidentInsurer', 'L’assureur accidents', payroll.accidentInsurer, 200);
    required(4, 'payroll.payrollCanton', 'Le canton de paie', payroll.payrollCanton, 80);
    const aanpCoverage = payroll.aanpEmployerCoverage;
    if (aanpCoverage?.enabled) {
      required(
        4,
        'payroll.aanpEmployerCoverage.reference',
        'La référence de prise en charge AANP',
        aanpCoverage.reference,
        500,
      );
      if (!isRealDate(aanpCoverage.effectiveFrom))
        add(
          4,
          'payroll.aanpEmployerCoverage.effectiveFrom',
          'Le début de prise en charge AANP',
          'Choisissez une date de début valide pour la convention AANP.',
        );
      if (aanpCoverage.effectiveTo && !isRealDate(aanpCoverage.effectiveTo))
        add(
          4,
          'payroll.aanpEmployerCoverage.effectiveTo',
          'La fin de prise en charge AANP',
          'Choisissez une date de fin valide ou laissez ce champ vide.',
        );
      if (
        isRealDate(aanpCoverage.effectiveFrom) &&
        isRealDate(aanpCoverage.effectiveTo) &&
        aanpCoverage.effectiveTo < aanpCoverage.effectiveFrom
      )
        add(
          4,
          'payroll.aanpEmployerCoverage.effectiveTo',
          'La fin de prise en charge AANP',
          'La date de fin ne peut pas précéder la date de début.',
        );
    }
    const lppPlan = payroll.lppPlanEvidence;
    if (lppPlan) {
      required(
        4,
        'payroll.pensionFund',
        'L’institution LPP',
        payroll.pensionFund,
        200,
      );
      required(
        4,
        'payroll.lppPlanEvidence.contractNumber',
        'Le numéro du contrat LPP',
        lppPlan.contractNumber,
        200,
      );
      required(
        4,
        'payroll.lppPlanEvidence.regulationReference',
        'La référence du règlement LPP',
        lppPlan.regulationReference,
        500,
      );
      if (!isRealDate(lppPlan.effectiveFrom))
        add(
          4,
          'payroll.lppPlanEvidence.effectiveFrom',
          'Le début d’effet du règlement LPP',
          'Choisissez une date de début valide pour le règlement LPP.',
        );
      if (!isRealDate(lppPlan.effectiveTo))
        add(
          4,
          'payroll.lppPlanEvidence.effectiveTo',
          'La fin d’effet du règlement LPP',
          'Choisissez la date de fin valide du règlement LPP.',
        );
      if (
        isRealDate(lppPlan.effectiveFrom) &&
        isRealDate(lppPlan.effectiveTo) &&
        lppPlan.effectiveTo < lppPlan.effectiveFrom
      )
        add(
          4,
          'payroll.lppPlanEvidence.effectiveTo',
          'La fin d’effet du règlement LPP',
          'La date de fin du règlement LPP ne peut pas précéder son début.',
        );
      if (!lppPlan.employerAggregateShareConfirmed)
        add(
          4,
          'payroll.lppPlanEvidence.employerAggregateShareConfirmed',
          'La part employeur agrégée LPP',
          'Confirmez la règle agrégée employeur d’après le règlement réel.',
        );
    }
    const validateRates = (rates: PayrollRate[], target: 'employeeRates' | 'employerRates') => {
      const identifiers = new Set<string>();
      rates.forEach((rate, index) => {
        const prefix = `payroll.${target}.${rate.id || index}`;
        if (!rate.label)
          add(4, `${prefix}.label`, 'Le libellé du taux', 'Donnez un libellé à ce taux ou supprimez la ligne.');
        else if (rate.label.length > 200)
          add(4, `${prefix}.label`, 'Le libellé du taux', 'Le libellé doit contenir au maximum 200 caractères.');
        if (!rate.id || identifiers.has(rate.id))
          add(4, `${prefix}.label`, 'Le taux', 'Cette ligne possède un identifiant interne en double. Supprimez-la puis ajoutez-la à nouveau.');
        else identifiers.add(rate.id);
        if (!Number.isInteger(rate.rateBp) || rate.rateBp < 1 || rate.rateBp > 10_000)
          add(4, `${prefix}.rateBp`, 'Le taux', 'Le taux doit être supérieur à 0 % et inférieur ou égal à 100 %.');
        if (!isRealDate(rate.effectiveFrom))
          add(4, `${prefix}.effectiveFrom`, 'La date d’effet', 'Choisissez une date d’effet valide.');
      });
    };
    validateRates(payroll.employeeRates, 'employeeRates');
    validateRates(payroll.employerRates, 'employerRates');
  }

  if (!settings.backup.folder)
    add(5, 'backup.folder', 'Le dossier de sauvegarde', 'Choisissez un dossier local pour vos sauvegardes.');
  if (!privacyConfirmed)
    add(5, 'backup.privacyConfirmed', 'La confidentialité locale', 'Confirmez avoir compris où vos données sont stockées.');
  if (!settings.backup.recoveryConfirmed)
    add(5, 'backup.recoveryConfirmed', 'La stratégie de sauvegarde', 'Confirmez votre stratégie de sauvegarde avant de terminer.');

  return issues;
}

export function backendOnboardingIssue(message: string): OnboardingIssue | null {
  const value = message.toLowerCase();
  if (value.includes('iban')) return { step: 2, field: 'billing.iban', label: 'L’IBAN', message };
  if (value.includes('noga_') || value.includes('division noga'))
    return { step: 1, field: 'business.nogaSection', label: 'Le profil NOGA', message };
  if (value.includes('tva') || value.includes('vat_'))
    return { step: value.includes('taux') ? 2 : 1, field: value.includes('taux') ? 'billing.vatRatesBp' : 'organization.vatIdentifier', label: 'La TVA', message };
  if (value.includes('payroll') || value.includes('taux'))
    return { step: 4, field: 'payroll.enabled', label: 'La configuration de paie', message };
  if (value.includes('prefix') || value.includes('préfixe') || value.includes('start_number') || value.includes('terms_days') || value.includes('validity_days'))
    return { step: 2, field: 'billing.quotePrefix', label: 'La facturation', message };
  if (value.includes('company_name'))
    return { step: 1, field: 'organization.legalName', label: 'La raison sociale', message };
  return null;
}

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Banknote,
  BriefcaseBusiness,
  Building2,
  Check,
  Clock3,
  Database,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { BrandMark } from './BrandMark';
import type { AppSettings, NogaCatalog, NogaSectionCode, PayrollRate } from './types';
import { createId, errorMessage } from './utils';
import { Button, ErrorPanel, Field } from './ui';
import { projectTerminology } from './terminology';
import {
  backendOnboardingIssue,
  normalizeIban,
  normalizeOnboardingSettings,
  validateOnboarding,
  type OnboardingIssue,
} from './onboardingValidation';

const steps = [
  { label: 'Départ', icon: BriefcaseBusiness },
  { label: 'Entreprise', icon: Building2 },
  { label: 'Facturation', icon: Banknote },
  { label: 'Temps & coûts', icon: Clock3 },
  { label: 'Paie', icon: Users },
  { label: 'Sauvegarde', icon: ShieldCheck },
  { label: 'Confirmation', icon: Check },
];

const initialSettings: AppSettings = {
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
    address: { street: '', postalCode: '', city: '', canton: '', country: 'CH' },
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

const ONBOARDING_DRAFT_KEY = 'elyko.onboarding.draft.v1';
type SettingsSetter = Dispatch<SetStateAction<AppSettings>>;
type IssueMap = Record<string, string>;
type DraftStatus = 'saving' | 'saved' | 'failed';
type OnboardingDraft = {
  version: 1;
  step: number;
  highestStep: number;
  settings: AppSettings;
  categoriesText: string;
  vatText: string;
  privacyConfirmed: boolean;
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
      ...(typeof candidate.sourceLabel === 'string' ? { sourceLabel: candidate.sourceLabel } : {}),
      ...(typeof candidate.sourceUrl === 'string' ? { sourceUrl: candidate.sourceUrl } : {}),
      ...(typeof candidate.annualCeilingCents === 'number' && Number.isSafeInteger(candidate.annualCeilingCents) && candidate.annualCeilingCents > 0
        ? { annualCeilingCents: candidate.annualCeilingCents }
        : {}),
    }];
  });
}

function settingsFromDraft(value: unknown): AppSettings {
  const merged = mergeDraftValue(initialSettings, value);
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

function readOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = window.localStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;
    if (parsed.version !== 1) return null;
    const settings = settingsFromDraft(parsed.settings);
    const safeStep = Number.isInteger(parsed.step) ? Math.min(6, Math.max(0, Number(parsed.step))) : 0;
    const safeHighestStep = Number.isInteger(parsed.highestStep)
      ? Math.min(6, Math.max(safeStep, Number(parsed.highestStep)))
      : safeStep;
    return {
      version: 1,
      step: safeStep,
      highestStep: safeHighestStep,
      settings,
      categoriesText: typeof parsed.categoriesText === 'string' ? parsed.categoriesText : settings.work.costCategories.join(', '),
      vatText: typeof parsed.vatText === 'string' ? parsed.vatText : '',
      privacyConfirmed: parsed.privacyConfirmed === true,
    };
  } catch {
    return null;
  }
}

function issuesByField(issues: OnboardingIssue[]): IssueMap {
  return Object.fromEntries(issues.map((issue) => [issue.field, issue.message]));
}

function setDeep<T extends keyof AppSettings>(
  settings: AppSettings,
  section: T,
  patch: Partial<AppSettings[T]>,
): AppSettings {
  return { ...settings, [section]: { ...settings[section], ...patch } };
}

export function Onboarding({
  onComplete,
  onRestore,
}: {
  onComplete: (settings: AppSettings) => Promise<void>;
  onRestore: (path: string) => Promise<void>;
}) {
  const [draft] = useState(readOnboardingDraft);
  const [step, setStep] = useState(() => Math.min(6, Math.max(0, draft?.step ?? 0)));
  const [highestStep, setHighestStep] = useState(() => Math.min(6, Math.max(0, draft?.highestStep ?? draft?.step ?? 0)));
  const [settings, setSettings] = useState<AppSettings>(() => draft?.settings ?? initialSettings);
  const [categoriesText, setCategoriesText] = useState(() => draft?.categoriesText ?? draft?.settings?.work.costCategories.join(', ') ?? '');
  const [vatText, setVatText] = useState(() => draft?.vatText ?? '');
  const [privacyConfirmed, setPrivacyConfirmed] = useState(() => draft?.privacyConfirmed ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [backendIssues, setBackendIssues] = useState<OnboardingIssue[]>([]);
  const [validatedSteps, setValidatedSteps] = useState<number[]>([]);
  const [savePhase, setSavePhase] = useState('');
  const [draftStatus, setDraftStatus] = useState<DraftStatus>(draft ? 'saved' : 'saving');
  const [nogaCatalog, setNogaCatalog] = useState<NogaCatalog | null>(null);
  const [nogaError, setNogaError] = useState('');
  const submitting = useRef(false);

  const loadNogaCatalog = useCallback(async () => {
    setNogaError('');
    try {
      setNogaCatalog(await desktopApi.getNogaCatalog());
    } catch (reason) {
      setNogaCatalog(null);
      setNogaError(errorMessage(reason, 'Le catalogue NOGA 2025 local n’a pas pu être chargé.'));
    }
  }, []);

  useEffect(() => {
    void loadNogaCatalog();
  }, [loadNogaCatalog]);

  const allIssues = useMemo(
    () => validateOnboarding(settings, nogaCatalog, privacyConfirmed),
    [nogaCatalog, privacyConfirmed, settings],
  );
  const visibleIssues = useMemo(
    () => [...allIssues.filter((issue) => validatedSteps.includes(issue.step)), ...backendIssues],
    [allIssues, backendIssues, validatedSteps],
  );
  const currentIssues = visibleIssues.filter((issue) => issue.step === step);
  const currentIssueMap = issuesByField(currentIssues);

  useEffect(() => {
    setDraftStatus('saving');
    const timeout = window.setTimeout(() => {
      const nextDraft: OnboardingDraft = {
        version: 1,
        step,
        highestStep,
        settings,
        categoriesText,
        vatText,
        privacyConfirmed,
      };
      try {
        window.localStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(nextDraft));
        setDraftStatus('saved');
      } catch {
        setDraftStatus('failed');
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [categoriesText, highestStep, privacyConfirmed, settings, step, vatText]);

  function focusIssue(issue: OnboardingIssue) {
    setStep(issue.step);
    setHighestStep((value) => Math.max(value, issue.step));
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const element = Array.from(document.querySelectorAll<HTMLElement>('[data-field]'))
        .find((candidate) => candidate.dataset.field === issue.field);
      const actionContainer = Array.from(document.querySelectorAll<HTMLElement>('[data-field-action]'))
        .find((candidate) => candidate.dataset.fieldAction === issue.field);
      const action = actionContainer?.matches('button, input, select, textarea, [tabindex]')
        ? actionContainer
        : actionContainer?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]');
      const unavailable = element && ('disabled' in element && Boolean((element as HTMLInputElement).disabled));
      const target = unavailable ? action ?? element : element ?? action;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target && !('disabled' in target && Boolean((target as HTMLInputElement).disabled))) {
        target.focus({ preventScroll: true });
      }
    }));
  }

  function next() {
    setError('');
    const normalized = normalizeOnboardingSettings(settings);
    setSettings(normalized);
    setValidatedSteps((values) => Array.from(new Set([...values, step])));
    const issues = validateOnboarding(normalized, nogaCatalog, privacyConfirmed).filter((issue) => issue.step === step);
    if (issues.length) {
      focusIssue(issues[0]);
      return;
    }
    setBackendIssues((values) => values.filter((issue) => issue.step !== step));
    const nextStep = Math.min(steps.length - 1, step + 1);
    setHighestStep((value) => Math.max(value, nextStep));
    setStep(nextStep);
  }

  async function restore() {
    setError('');
    try {
      const path = await desktopApi.chooseRestoreFile();
      if (!path) return;
      if (!window.confirm('La sauvegarde choisie sera contrôlée avant de remplacer les données locales. Continuer ?')) return;
      setBusy(true);
      await onRestore(path);
      try { window.localStorage.removeItem(ONBOARDING_DRAFT_KEY); } catch { /* L’espace restauré reste valide même si le brouillon ne peut pas être supprimé. */ }
    } catch (reason) {
      setError(errorMessage(reason, 'La restauration n’a pas pu être lancée.'));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (submitting.current) return;
    const normalized = normalizeOnboardingSettings(settings);
    setSettings(normalized);
    setValidatedSteps([1, 2, 3, 4, 5]);
    setBackendIssues([]);
    const issues = validateOnboarding(normalized, nogaCatalog, privacyConfirmed);
    if (issues.length) {
      setError('Certaines informations doivent être corrigées avant de créer votre espace.');
      focusIssue(issues[0]);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      setSavePhase('Vérification complète des informations…');
      const preflight = await desktopApi.validateOnboarding(normalized);
      if (!preflight.valid) {
        const serverIssues = preflight.issues.map((issue) => ({ ...issue, step: Number(issue.step) }));
        setBackendIssues(serverIssues);
        setValidatedSteps([1, 2, 3, 4, 5]);
        setError('Elyko a trouvé une information à corriger. Votre brouillon est conservé sur ce PC.');
        if (serverIssues[0]) focusIssue(serverIssues[0]);
        return;
      }
      setSavePhase('Création de votre espace local…');
      await onComplete(normalized);
      try { window.localStorage.removeItem(ONBOARDING_DRAFT_KEY); } catch { /* La transaction est déjà terminée avec succès. */ }
    } catch (reason) {
      const message = errorMessage(reason, 'La configuration n’a pas pu être enregistrée.');
      const issue = backendOnboardingIssue(message);
      if (issue) {
        setBackendIssues([issue]);
        setValidatedSteps((values) => Array.from(new Set([...values, issue.step])));
        focusIssue(issue);
      }
      setError(message);
    } finally {
      submitting.current = false;
      setBusy(false);
      setSavePhase('');
    }
  }

  function addRate(target: 'employeeRates' | 'employerRates') {
    const rate: PayrollRate = { id: createId(), label: '', rateBp: 0, effectiveFrom: '' };
    setSettings((current) => setDeep(current, 'payroll', { [target]: [...current.payroll[target], rate] }));
  }

  function updateRate(target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) {
    setSettings((current) =>
      setDeep(current, 'payroll', {
        [target]: current.payroll[target].map((rate) => (rate.id === id ? { ...rate, ...patch } : rate)),
      }),
    );
  }

  function removeRate(target: 'employeeRates' | 'employerRates', id: string) {
    setSettings((current) => setDeep(current, 'payroll', { [target]: current.payroll[target].filter((rate) => rate.id !== id) }));
  }

  return (
    <div className="onboarding">
      <aside className="onboarding__rail">
        <div className="onboarding__brand">
          <BrandMark size={38} />
          <div><strong>Elyko</strong><small>Application Windows</small></div>
        </div>
        <div className="onboarding__promise">
          <LockKeyhole size={22} />
          <p><strong>Votre entreprise reste chez vous.</strong> Les données métier sont stockées localement sur cet ordinateur.</p>
        </div>
        <nav className="setup-steps" aria-label="Étapes de configuration">
          {steps.map(({ label, icon: Icon }, index) => {
            const hasError = (validatedSteps.includes(index) && allIssues.some((issue) => issue.step === index)) || backendIssues.some((issue) => issue.step === index);
            const done = index < highestStep && !hasError;
            const className = [index === step ? 'is-current' : '', done ? 'is-done' : '', hasError ? 'has-error' : ''].filter(Boolean).join(' ');
            return (
              <button key={label} type="button" className={className} aria-current={index === step ? 'step' : undefined} onClick={() => { if (index <= highestStep) { setError(''); setStep(index); } }} disabled={index > highestStep}>
                <span>{hasError ? <AlertCircle size={15} /> : done ? <Check size={15} /> : <Icon size={15} />}</span>
                <em>{label}</em>
              </button>
            );
          })}
        </nav>
        <div className={`onboarding__draft onboarding__draft--${draftStatus}`}>
          {draftStatus === 'failed' ? <AlertCircle size={15} /> : draftStatus === 'saved' ? <Check size={15} /> : <Save size={15} />}
          <p>
            <strong>{draftStatus === 'failed' ? 'Brouillon non enregistré' : 'Brouillon local'}</strong>
            <span>{draftStatus === 'failed' ? 'Vérifiez les droits de stockage Windows' : draftStatus === 'saved' ? 'Toutes les modifications sont enregistrées' : 'Enregistrement sur ce PC…'}</span>
          </p>
        </div>
      </aside>

      <main className="onboarding__main">
        <div className="onboarding__content">
          <div className="setup-progress-meta"><span>{step === 0 ? 'Bienvenue' : step === 6 ? 'Vérification finale' : `Étape ${step} sur 5`}</span><strong>{Math.round((step / (steps.length - 1)) * 100)} %</strong></div>
          <div className="setup-progress" aria-hidden="true"><span style={{ width: `${(step / (steps.length - 1)) * 100}%` }} /></div>
          <section className="setup-stage" key={step}>
            {step === 0 ? (
              <SetupIntro onCreate={() => { setHighestStep((value) => Math.max(value, 1)); setStep(1); }} onRestore={() => void restore()} busy={busy} />
            ) : null}
            {step === 1 ? <IdentityStep settings={settings} setSettings={setSettings} catalog={nogaCatalog} catalogError={nogaError} onRetryCatalog={() => void loadNogaCatalog()} issues={currentIssueMap} /> : null}
            {step === 2 ? <BillingStep settings={settings} setSettings={setSettings} vatText={vatText} setVatText={setVatText} issues={currentIssueMap} /> : null}
            {step === 3 ? <WorkStep settings={settings} setSettings={setSettings} categoriesText={categoriesText} setCategoriesText={setCategoriesText} issues={currentIssueMap} /> : null}
            {step === 4 ? (
              <PayrollStep settings={settings} setSettings={setSettings} addRate={addRate} updateRate={updateRate} removeRate={removeRate} issues={currentIssueMap} />
            ) : null}
            {step === 5 ? (
              <BackupStep settings={settings} setSettings={setSettings} privacyConfirmed={privacyConfirmed} setPrivacyConfirmed={setPrivacyConfirmed} issues={currentIssueMap} onError={setError} />
            ) : null}
            {step === 6 ? <ConfirmationStep settings={settings} onEdit={(target) => setStep(target)} /> : null}
          </section>

          {currentIssues.length ? <ValidationSummary issues={currentIssues} onSelect={focusIssue} /> : null}
          {busy && savePhase ? <div className="setup-saving" role="status"><span><LoaderCircle className="spin" size={20} /></span><div><strong>{savePhase}</strong><p>Ne fermez pas Elyko. Cette opération reste entièrement locale.</p></div></div> : null}
          {error && !currentIssues.length ? <ErrorPanel title="Configuration non enregistrée" message={error} /> : null}

          {step > 0 ? (
            <footer className="onboarding__actions">
              <Button variant="secondary" onClick={() => { setError(''); setStep((value) => Math.max(0, value - 1)); }} disabled={busy}>
                <ArrowLeft size={17} /> Retour
              </Button>
              {step < steps.length - 1 ? (
                <Button onClick={next} disabled={busy}>Continuer <ArrowRight size={17} /></Button>
              ) : (
                <Button size="large" onClick={() => void finish()} disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}
                  {busy ? 'Finalisation en cours…' : 'Créer mon espace local'}
                </Button>
              )}
            </footer>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StepHeader({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <header className="setup-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{text}</p></header>;
}

function SetupIntro({ onCreate, onRestore, busy }: { onCreate: () => void; onRestore: () => void; busy: boolean }) {
  return (
    <div>
      <StepHeader eyebrow="Bienvenue" title="Votre gestion d’activité commence ici." text="Aucun client, montant ou document fictif ne sera créé. Vous partez uniquement de vos propres informations." />
      <div className="setup-choice-grid">
        <button className="setup-choice setup-choice--primary" onClick={onCreate} disabled={busy}>
          <span><BriefcaseBusiness size={25} /></span><div><strong>Créer mon entreprise</strong><p>Configurer l’identité, la facturation, le temps, la paie et les sauvegardes.</p></div><ArrowRight size={20} />
        </button>
        <button className="setup-choice" onClick={onRestore} disabled={busy}>
          <span><RefreshCw size={25} /></span><div><strong>Restaurer une sauvegarde</strong><p>Reprendre une archive Elyko ou une ancienne sauvegarde .hchantier provenant d’un autre ordinateur.</p></div><FolderOpen size={20} />
        </button>
      </div>
      <div className="local-facts">
        <div><DatabaseIcon /><strong>Base locale sur ce PC</strong><span>Aucun hébergement de vos données métier</span></div>
        <div><FileArchive /><strong>Sauvegardes portables</strong><span>Vous gardez la maîtrise des fichiers</span></div>
        <div><ShieldCheck /><strong>Droits Windows</strong><span>Accès selon les droits de votre session</span></div>
      </div>
    </div>
  );
}

function IdentityStep({ settings, setSettings, catalog, catalogError, onRetryCatalog, issues }: { settings: AppSettings; setSettings: SettingsSetter; catalog: NogaCatalog | null; catalogError: string; onRetryCatalog: () => void; issues: IssueMap }) {
  const org = settings.organization;
  const business = settings.business;
  const patch = (value: Partial<typeof org>) => setSettings((current) => setDeep(current, 'organization', value));
  const patchAddress = (value: Partial<typeof org.address>) => patch({ address: { ...org.address, ...value } });
  const patchBusiness = (value: Partial<typeof business>) => setSettings((current) => setDeep(current, 'business', value));
  const selectedSection = catalog?.sections.find((section) => section.code === business.nogaSection);
  return (
    <div>
      <StepHeader eyebrow="Étape 1 sur 5" title="Identité de l’entreprise" text="Ces informations apparaîtront sur vos devis, factures et documents de salaire." />
      <div className="form-grid setup-form">
        <Field label="Raison sociale" required wide error={issues['organization.legalName']}><input data-field="organization.legalName" aria-invalid={Boolean(issues['organization.legalName'])} value={org.legalName} onChange={(e) => patch({ legalName: e.target.value })} autoFocus /></Field>
        <Field label="Forme juridique"><input value={org.legalForm} onChange={(e) => patch({ legalForm: e.target.value })} /></Field>
        <Field label="Responsable" required error={issues['organization.contactName']}><input data-field="organization.contactName" aria-invalid={Boolean(issues['organization.contactName'])} value={org.contactName} onChange={(e) => patch({ contactName: e.target.value })} /></Field>
        <Field label="E-mail" required error={issues['organization.email']}><input data-field="organization.email" aria-invalid={Boolean(issues['organization.email'])} type="email" value={org.email} onChange={(e) => patch({ email: e.target.value })} /></Field>
        <Field label="Téléphone"><input value={org.phone} onChange={(e) => patch({ phone: e.target.value })} /></Field>
        <Field label="Rue / case postale" required wide error={issues['organization.address.street']}><input data-field="organization.address.street" aria-invalid={Boolean(issues['organization.address.street'])} value={org.address.street} onChange={(e) => patchAddress({ street: e.target.value })} /></Field>
        <Field label="Numéro de bâtiment"><input value={org.address.buildingNumber ?? ''} onChange={(e) => patchAddress({ buildingNumber: e.target.value })} /></Field>
        <Field label="NPA" required error={issues['organization.address.postalCode']}><input data-field="organization.address.postalCode" aria-invalid={Boolean(issues['organization.address.postalCode'])} value={org.address.postalCode} onChange={(e) => patchAddress({ postalCode: e.target.value })} /></Field>
        <Field label="Localité" required error={issues['organization.address.city']}><input data-field="organization.address.city" aria-invalid={Boolean(issues['organization.address.city'])} value={org.address.city} onChange={(e) => patchAddress({ city: e.target.value })} /></Field>
        <Field label="Canton" required error={issues['organization.address.canton']}><input data-field="organization.address.canton" aria-invalid={Boolean(issues['organization.address.canton'])} value={org.address.canton} onChange={(e) => patchAddress({ canton: e.target.value })} /></Field>
        <Field label="Pays (code ISO, 2 lettres)" required error={issues['organization.address.country']}><input data-field="organization.address.country" aria-invalid={Boolean(issues['organization.address.country'])} value={org.address.country} minLength={2} maxLength={2} onChange={(e) => patchAddress({ country: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })} /></Field>
        <Field label="IDE / UID" error={issues['organization.vatIdentifier']}><input data-field="organization.vatIdentifier" aria-invalid={Boolean(issues['organization.vatIdentifier'])} value={org.uidNumber} onChange={(e) => patch({ uidNumber: e.target.value })} /></Field>
        {org.vatRegistered ? <Field label="Numéro TVA" required error={issues['organization.vatIdentifier']}><input aria-invalid={Boolean(issues['organization.vatIdentifier'])} value={org.vatNumber} onChange={(e) => patch({ vatNumber: e.target.value })} required /></Field> : null}
        <Field label="Site internet" error={issues['organization.website']}><input data-field="organization.website" aria-invalid={Boolean(issues['organization.website'])} type="url" placeholder="https://" value={org.website} onChange={(e) => patch({ website: e.target.value })} /></Field>
        <label className="check-card field--wide"><input type="checkbox" checked={org.vatRegistered} onChange={(e) => patch({ vatRegistered: e.target.checked })} /><span><strong>Entreprise assujettie à la TVA</strong><small>Les taux seront saisis explicitement à l’étape suivante.</small></span></label>
        <div className="setup-subsection field--wide"><strong>Secteur d’activité · NOGA 2025</strong><p>La section et la division déterminent uniquement les libellés de navigation. Elles ne créent aucune donnée métier.</p></div>
        <Field label="Section NOGA 2025" required wide error={issues['business.nogaSection']}><select data-field="business.nogaSection" aria-invalid={Boolean(issues['business.nogaSection'])} value={business.nogaSection} onChange={(e) => patchBusiness({ nogaSection: e.target.value as NogaSectionCode | '', nogaDivision: '', nogaDetailedCode: '' })} required disabled={!catalog}><option value="">{catalog ? 'Choisir parmi les 22 sections officielles' : 'Chargement du catalogue officiel…'}</option>{catalog?.sections.map((section) => <option key={section.code} value={section.code}>{section.code} · {section.label}</option>)}</select></Field>
        <Field label="Division NOGA 2025" required wide error={issues['business.nogaDivision']}><select data-field="business.nogaDivision" aria-invalid={Boolean(issues['business.nogaDivision'])} value={business.nogaDivision} onChange={(e) => patchBusiness({ nogaDivision: e.target.value, nogaDetailedCode: '' })} required disabled={!selectedSection}><option value="">{selectedSection ? 'Choisir la division officielle' : 'Choisissez d’abord une section'}</option>{selectedSection?.divisions.map((division) => <option key={division.code} value={division.code}>{division.code} · {division.label}</option>)}</select></Field>
        <Field label="Activité précise" hint="Décrivez votre activité réelle; ce texte reste local." required wide error={issues['business.activityDescription']}><textarea data-field="business.activityDescription" aria-invalid={Boolean(issues['business.activityDescription'])} rows={3} maxLength={2000} value={business.activityDescription} onChange={(e) => patchBusiness({ activityDescription: e.target.value })} required /></Field>
        <Field label="Code NOGA détaillé" hint="Facultatif : code numérique à 3, 4 ou 6 chiffres commençant par la division choisie." wide error={issues['business.nogaDetailedCode']}><input data-field="business.nogaDetailedCode" aria-invalid={Boolean(issues['business.nogaDetailedCode'])} inputMode="numeric" pattern={business.nogaDivision ? `${business.nogaDivision}(?:\\d|\\d{2}|\\d{4})` : '\\d{3}|\\d{4}|\\d{6}'} value={business.nogaDetailedCode} onChange={(e) => patchBusiness({ nogaDetailedCode: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
        {catalogError ? <div className="field--wide" data-field-action="business.nogaSection"><ErrorPanel title="Catalogue NOGA indisponible" message={catalogError} onRetry={onRetryCatalog} /></div> : null}
        <p className="source-note field--wide">Source : <a href={catalog?.source || 'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025'} target="_blank" rel="noreferrer">Office fédéral de la statistique · KUBB NOGA 2025</a>{catalog?.version ? ` · version ${catalog.version}` : ''}</p>
      </div>
    </div>
  );
}

function BillingStep({ settings, setSettings, vatText, setVatText, issues }: { settings: AppSettings; setSettings: SettingsSetter; vatText: string; setVatText: (value: string) => void; issues: IssueMap }) {
  const billing = settings.billing;
  const patch = (value: Partial<typeof billing>) => setSettings((current) => setDeep(current, 'billing', value));
  function addVat() {
    const parsed = Number(vatText.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return;
    patch({ vatRatesBp: [...billing.vatRatesBp, Math.round(parsed * 100)] });
    setVatText('');
  }
  return (
    <div>
      <StepHeader eyebrow="Étape 2 sur 5" title="Facturation suisse" text="Vous décidez des numéros, délais et taux. Elyko n’invente aucune règle comptable." />
      <div className="form-grid setup-form">
        <Field label="IBAN ou QR-IBAN" hint="21 caractères pour un IBAN suisse ou liechtensteinois; les espaces sont retirés automatiquement." required wide error={issues['billing.iban']}><input data-field="billing.iban" aria-invalid={Boolean(issues['billing.iban'])} value={billing.iban} onChange={(e) => patch({ iban: e.target.value.toUpperCase() })} onBlur={() => patch({ iban: normalizeIban(billing.iban) })} autoFocus /></Field>
        <Field label="Titulaire du compte" required wide error={issues['billing.accountHolder']}><input data-field="billing.accountHolder" aria-invalid={Boolean(issues['billing.accountHolder'])} value={billing.accountHolder} onChange={(e) => patch({ accountHolder: e.target.value })} /></Field>
        <Field label="Préfixe devis" hint="Lettres, chiffres ou tirets · 12 caractères max." required error={issues['billing.quotePrefix']}><input data-field="billing.quotePrefix" aria-invalid={Boolean(issues['billing.quotePrefix'])} maxLength={12} value={billing.quotePrefix} onChange={(e) => patch({ quotePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label="Prochain numéro de devis" required error={issues['billing.nextQuoteNumber']}><input data-field="billing.nextQuoteNumber" aria-invalid={Boolean(issues['billing.nextQuoteNumber'])} type="number" min="1" step="1" value={billing.nextQuoteNumber || ''} onChange={(e) => patch({ nextQuoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Préfixe factures" hint="Lettres, chiffres ou tirets · 12 caractères max." required error={issues['billing.invoicePrefix']}><input data-field="billing.invoicePrefix" aria-invalid={Boolean(issues['billing.invoicePrefix'])} maxLength={12} value={billing.invoicePrefix} onChange={(e) => patch({ invoicePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label="Prochain numéro de facture" required error={issues['billing.nextInvoiceNumber']}><input data-field="billing.nextInvoiceNumber" aria-invalid={Boolean(issues['billing.nextInvoiceNumber'])} type="number" min="1" step="1" value={billing.nextInvoiceNumber || ''} onChange={(e) => patch({ nextInvoiceNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Préfixe avoirs" hint="Lettres, chiffres ou tirets · 12 caractères max." required error={issues['billing.creditNotePrefix']}><input data-field="billing.creditNotePrefix" aria-invalid={Boolean(issues['billing.creditNotePrefix'])} maxLength={12} value={billing.creditNotePrefix} onChange={(e) => patch({ creditNotePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label="Prochain numéro d’avoir" required error={issues['billing.nextCreditNoteNumber']}><input data-field="billing.nextCreditNoteNumber" aria-invalid={Boolean(issues['billing.nextCreditNoteNumber'])} type="number" min="1" step="1" value={billing.nextCreditNoteNumber || ''} onChange={(e) => patch({ nextCreditNoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Délai de paiement (jours)" required error={issues['billing.paymentTermsDays']}><input data-field="billing.paymentTermsDays" aria-invalid={Boolean(issues['billing.paymentTermsDays'])} type="number" min="1" max="365" step="1" value={billing.paymentTermsDays || ''} onChange={(e) => patch({ paymentTermsDays: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Validité des devis (jours)" required error={issues['billing.quoteValidityDays']}><input data-field="billing.quoteValidityDays" aria-invalid={Boolean(issues['billing.quoteValidityDays'])} type="number" min="1" max="365" step="1" value={billing.quoteValidityDays || ''} onChange={(e) => patch({ quoteValidityDays: e.target.valueAsNumber || 0 })} /></Field>
        {settings.organization.vatRegistered ? (
          <div className={`field field--wide ${issues['billing.vatRatesBp'] ? 'field--error' : ''}`}><span className="field__label">Taux TVA utilisés <em>obligatoire</em></span><div className="inline-entry"><input data-field="billing.vatRatesBp" aria-invalid={Boolean(issues['billing.vatRatesBp'])} type="number" min="0.01" max="100" step="0.01" value={vatText} onChange={(e) => setVatText(e.target.value)} aria-label="Taux TVA en pour cent" /><span>%</span><Button type="button" variant="secondary" onClick={addVat}><Plus size={16} /> Ajouter</Button></div><div className="chips">{billing.vatRatesBp.map((rate, index) => <button type="button" key={`${rate}-${index}`} onClick={() => patch({ vatRatesBp: billing.vatRatesBp.filter((_, i) => i !== index) })}>{(rate / 100).toLocaleString('fr-CH')} % <Trash2 size={12} /></button>)}</div>{issues['billing.vatRatesBp'] ? <span className="field__error" role="alert">{issues['billing.vatRatesBp']}</span> : null}</div>
        ) : <div className="info-strip field--wide"><ShieldCheck size={18} /><span>Entreprise indiquée non assujettie : les documents seront établis sans TVA.</span></div>}
        <Field label="Pied de page des documents" wide><textarea rows={3} value={billing.defaultFooter} onChange={(e) => patch({ defaultFooter: e.target.value })} /></Field>
      </div>
    </div>
  );
}

function WorkStep({ settings, setSettings, categoriesText, setCategoriesText, issues }: { settings: AppSettings; setSettings: SettingsSetter; categoriesText: string; setCategoriesText: (value: string) => void; issues: IssueMap }) {
  const work = settings.work;
  const terminology = projectTerminology(settings.business.nogaSection);
  const patch = (value: Partial<typeof work>) => setSettings((current) => setDeep(current, 'work', value));
  return (
    <div>
      <StepHeader eyebrow="Étape 3 sur 5" title="Temps et coûts réels" text="Ces règles servent au suivi des heures. Les coûts horaires restent définis salarié par salarié." />
      <div className="form-grid setup-form">
        <Field label="Heures par semaine" required error={issues['work.workWeekHours']}><input data-field="work.workWeekHours" aria-invalid={Boolean(issues['work.workWeekHours'])} type="number" min="0.01" max="168" step="0.01" value={work.workWeekHours || ''} onChange={(e) => patch({ workWeekHours: e.target.valueAsNumber || 0 })} autoFocus /></Field>
        <Field label="Heures par journée" required error={issues['work.dailyHours']}><input data-field="work.dailyHours" aria-invalid={Boolean(issues['work.dailyHours'])} type="number" min="0.01" max="24" step="0.01" value={work.dailyHours || ''} onChange={(e) => patch({ dailyHours: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Arrondi des pointages" required error={issues['work.roundingMinutes']}><select data-field="work.roundingMinutes" aria-invalid={Boolean(issues['work.roundingMinutes'])} value={work.roundingMinutes < 0 ? '' : work.roundingMinutes} onChange={(e) => patch({ roundingMinutes: Number(e.target.value) })} required><option value="">Choisir la règle</option><option value="0">Aucun arrondi</option><option value="1">À la minute</option><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option></select></Field>
        <Field label="Pause habituelle (minutes)" required error={issues['work.breakMinutes']}><input data-field="work.breakMinutes" aria-invalid={Boolean(issues['work.breakMinutes'])} type="number" min="0" max="1440" step="1" value={work.breakMinutes < 0 ? '' : work.breakMinutes} onChange={(e) => patch({ breakMinutes: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : -1 })} required /></Field>
        <Field label="Catégories de dépenses" hint="Séparez chaque catégorie par une virgule." required wide error={issues['work.costCategories']}><textarea data-field="work.costCategories" aria-invalid={Boolean(issues['work.costCategories'])} rows={3} value={categoriesText} onChange={(e) => { setCategoriesText(e.target.value); patch({ costCategories: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) }); }} /></Field>
      </div>
      <div className="definition-grid"><div><strong>Durée prévue</strong><span>Dates et heures planifiées sur le {terminology.singular}</span></div><div><strong>Durée réelle</strong><span>Dates réelles et heures effectivement saisies</span></div><div><strong>Rentabilité</strong><span>Facturé net moins coûts horaires et dépenses nettes</span></div></div>
    </div>
  );
}

function PayrollStep({ settings, setSettings, addRate, updateRate, removeRate, issues }: { settings: AppSettings; setSettings: SettingsSetter; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void; issues: IssueMap }) {
  const payroll = settings.payroll;
  const patch = (value: Partial<typeof payroll>) => setSettings((current) => setDeep(current, 'payroll', value));
  return (
    <div>
      <StepHeader eyebrow="Étape 4 sur 5" title="Préparation des salaires" text="Le module est facultatif. Aucun taux social et aucune retenue ne sont estimés par le logiciel." />
      <label className={`module-toggle ${issues['payroll.enabled'] ? 'field--error' : ''}`}><input data-field="payroll.enabled" type="checkbox" checked={payroll.enabled} onChange={(e) => patch(e.target.checked ? { enabled: true } : { enabled: false, employeeRates: [], employerRates: [] })} /><span><Users size={22} /><strong>Activer Équipe & salaires</strong><small>Créer des fiches à partir de montants explicitement configurés.</small></span></label>
      {payroll.enabled ? (
        <>
          <div className="warning-card"><ShieldCheck size={21} /><div><strong>Validation professionnelle requise</strong><p>Avant d’utiliser une fiche comme document final, faites contrôler les caisses, assurances et taux par votre fiduciaire.</p></div></div>
          <div className="form-grid setup-form">
            <Field label="Caisse AVS" required error={issues['payroll.avsFund']}><input data-field="payroll.avsFund" aria-invalid={Boolean(issues['payroll.avsFund'])} value={payroll.avsFund} onChange={(e) => patch({ avsFund: e.target.value })} /></Field>
            <Field label="Assureur accidents LAA / UVG" required error={issues['payroll.accidentInsurer']}><input data-field="payroll.accidentInsurer" aria-invalid={Boolean(issues['payroll.accidentInsurer'])} value={payroll.accidentInsurer} onChange={(e) => patch({ accidentInsurer: e.target.value })} /></Field>
            <Field label="Institution LPP / BVG"><input value={payroll.pensionFund} onChange={(e) => patch({ pensionFund: e.target.value })} /></Field>
            <Field label="Assurance IJM / KTG"><input value={payroll.dailyAllowanceInsurer} onChange={(e) => patch({ dailyAllowanceInsurer: e.target.value })} /></Field>
            <Field label="Caisse allocations familiales"><input value={payroll.familyAllowanceFund} onChange={(e) => patch({ familyAllowanceFund: e.target.value })} /></Field>
            <Field label="Canton de paie" required error={issues['payroll.payrollCanton']}><input data-field="payroll.payrollCanton" aria-invalid={Boolean(issues['payroll.payrollCanton'])} value={payroll.payrollCanton} onChange={(e) => patch({ payrollCanton: e.target.value })} /></Field>
          </div>
          <RateEditor title="Retenues salarié" rates={payroll.employeeRates} target="employeeRates" addRate={addRate} updateRate={updateRate} removeRate={removeRate} issues={issues} />
          <RateEditor title="Charges employeur" rates={payroll.employerRates} target="employerRates" addRate={addRate} updateRate={updateRate} removeRate={removeRate} issues={issues} />
          <label className="check-card"><input type="checkbox" checked={payroll.fiduciaryValidated} onChange={(e) => patch({ fiduciaryValidated: e.target.checked })} /><span><strong>Configuration contrôlée par une fiduciaire</strong><small>Sans cette confirmation, les fiches restent marquées incomplètes.</small></span></label>
        </>
      ) : <div className="skipped-module"><Check size={19} /><span>Le module restera masqué. Vous pourrez l’activer plus tard dans Paramètres.</span></div>}
    </div>
  );
}

function RateEditor({ title, rates, target, addRate, updateRate, removeRate, issues }: { title: string; rates: PayrollRate[]; target: 'employeeRates' | 'employerRates'; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void; issues: IssueMap }) {
  return <section className="rate-editor"><header><div><strong>{title}</strong><small>Saisissez seulement les taux confirmés.</small></div><Button type="button" variant="secondary" size="small" onClick={() => addRate(target)}><Plus size={15} /> Ajouter un taux</Button></header>{rates.length ? <div className="rate-list">{rates.map((rate) => { const prefix = `payroll.${target}.${rate.id}`; return <div className="rate-row" key={rate.id}><div className="rate-control"><input data-field={`${prefix}.label`} aria-invalid={Boolean(issues[`${prefix}.label`])} aria-label="Libellé" placeholder="Libellé" maxLength={200} value={rate.label} onChange={(e) => updateRate(target, rate.id, { label: e.target.value })} />{issues[`${prefix}.label`] ? <small>{issues[`${prefix}.label`]}</small> : null}</div><div className="rate-control"><label><input data-field={`${prefix}.rateBp`} aria-invalid={Boolean(issues[`${prefix}.rateBp`])} aria-label="Taux en pour cent" type="number" min="0.01" max="100" step="0.01" value={rate.rateBp ? rate.rateBp / 100 : ''} onChange={(e) => updateRate(target, rate.id, { rateBp: Math.round((e.target.valueAsNumber || 0) * 100) })} /><span>%</span></label>{issues[`${prefix}.rateBp`] ? <small>{issues[`${prefix}.rateBp`]}</small> : null}</div><div className="rate-control"><input data-field={`${prefix}.effectiveFrom`} aria-invalid={Boolean(issues[`${prefix}.effectiveFrom`])} aria-label="Date d’effet" type="date" value={rate.effectiveFrom} onChange={(e) => updateRate(target, rate.id, { effectiveFrom: e.target.value })} />{issues[`${prefix}.effectiveFrom`] ? <small>{issues[`${prefix}.effectiveFrom`]}</small> : null}</div><Button type="button" variant="ghost" size="icon" aria-label={`Supprimer le taux ${rate.label || 'sans libellé'}`} onClick={() => removeRate(target, rate.id)}><Trash2 size={16} /></Button></div>; })}</div> : <p className="rate-empty">Aucun taux saisi. Le logiciel n’effectuera aucune déduction correspondante.</p>}</section>;
}

function BackupStep({ settings, setSettings, privacyConfirmed, setPrivacyConfirmed, issues, onError }: { settings: AppSettings; setSettings: SettingsSetter; privacyConfirmed: boolean; setPrivacyConfirmed: (value: boolean) => void; issues: IssueMap; onError: (message: string) => void }) {
  const backup = settings.backup;
  const patch = (value: Partial<typeof backup>) => setSettings((current) => setDeep(current, 'backup', value));
  const [choosing, setChoosing] = useState(false);
  async function chooseFolder() {
    setChoosing(true);
    onError('');
    try {
      const path = await desktopApi.chooseBackupFolder();
      if (path) patch({ folder: path });
    } catch (reason) {
      onError(errorMessage(reason, 'Le dossier de sauvegarde n’a pas pu être sélectionné.'));
    } finally {
      setChoosing(false);
    }
  }
  return (
    <div>
      <StepHeader eyebrow="Étape 5 sur 5" title="Sauvegarde et confidentialité" text="La base active reste sur ce PC. Une sauvegarde externe protège votre entreprise d’une panne ou d’un vol." />
      <div className="privacy-banner"><DatabaseIcon size={24} /><div><strong>Données métier locales</strong><p>Clients, chantiers ou projets, montants, heures, pièces jointes et salaires ne sont pas envoyés au service d’abonnement.</p></div></div>
      <div className="form-grid setup-form"><Field label="Dossier pour les sauvegardes manuelles" hint="Une sauvegarde ne sera créée que lorsque vous utiliserez le bouton Sauvegarder." required wide error={issues['backup.folder']}><div className="path-picker"><input aria-invalid={Boolean(issues['backup.folder'])} readOnly value={backup.folder} /><Button data-field="backup.folder" type="button" variant="secondary" disabled={choosing} onClick={() => void chooseFolder()}>{choosing ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} {choosing ? 'Ouverture…' : 'Choisir'}</Button></div></Field></div>
      <div className="confirmation-checks"><label className={issues['backup.privacyConfirmed'] ? 'has-error' : ''}><input data-field="backup.privacyConfirmed" aria-invalid={Boolean(issues['backup.privacyConfirmed'])} type="checkbox" checked={privacyConfirmed} onChange={(e) => setPrivacyConfirmed(e.target.checked)} /><span>J’ai compris que mes données métier restent locales et que je suis responsable de leur sauvegarde.{issues['backup.privacyConfirmed'] ? <small>{issues['backup.privacyConfirmed']}</small> : null}</span></label><label className={issues['backup.recoveryConfirmed'] ? 'has-error' : ''}><input data-field="backup.recoveryConfirmed" aria-invalid={Boolean(issues['backup.recoveryConfirmed'])} type="checkbox" checked={backup.recoveryConfirmed} onChange={(e) => patch({ recoveryConfirmed: e.target.checked })} /><span>Je conserverai au moins une sauvegarde récente dans un emplacement distinct et sûr.{issues['backup.recoveryConfirmed'] ? <small>{issues['backup.recoveryConfirmed']}</small> : null}</span></label></div>
    </div>
  );
}

function ConfirmationStep({ settings, onEdit }: { settings: AppSettings; onEdit: (step: number) => void }) {
  const org = settings.organization;
  return (
    <div>
      <StepHeader eyebrow="Prêt à démarrer" title="Vérifiez votre configuration" text="Seules les informations ci-dessous seront créées. Toutes les listes métier commenceront vides." />
      <div className="review-grid"><ReviewCard title="Entreprise" onEdit={() => onEdit(1)} rows={[["Raison sociale", org.legalName], ["Responsable", org.contactName], ["Adresse", `${org.address.street}, ${org.address.postalCode} ${org.address.city}`], ["TVA", org.vatRegistered ? `Assujettie · ${org.vatNumber || org.uidNumber}` : 'Non assujettie']]} /><ReviewCard title="Activité" onEdit={() => onEdit(1)} rows={[["Section NOGA", settings.business.nogaSection], ["Division NOGA", settings.business.nogaDivision], ["Activité précise", settings.business.activityDescription], ["Code détaillé", settings.business.nogaDetailedCode || 'Non renseigné']]} /><ReviewCard title="Facturation" onEdit={() => onEdit(2)} rows={[["Compte", settings.billing.iban], ["Numérotation devis", `${settings.billing.quotePrefix} · prochain ${settings.billing.nextQuoteNumber}`], ["Numérotation factures", `${settings.billing.invoicePrefix} · prochain ${settings.billing.nextInvoiceNumber}`], ["TVA", settings.billing.vatRatesBp.length ? settings.billing.vatRatesBp.map((rate) => `${(rate / 100).toLocaleString('fr-CH')} %`).join(', ') : 'Sans TVA'], ["Délais", `${settings.billing.paymentTermsDays} jours · devis ${settings.billing.quoteValidityDays} jours`]]} /><ReviewCard title="Temps & coûts" onEdit={() => onEdit(3)} rows={[["Semaine", `${settings.work.workWeekHours} heures`], ["Journée", `${settings.work.dailyHours} heures · pause ${settings.work.breakMinutes} min`], ["Arrondi", settings.work.roundingMinutes ? `${settings.work.roundingMinutes} min` : 'Aucun'], ["Catégories", settings.work.costCategories.join(', ')]]} /><ReviewCard title="Paie" onEdit={() => onEdit(4)} rows={[["Module", settings.payroll.enabled ? settings.payroll.fiduciaryValidated ? 'Activé · configuration contrôlée' : 'Activé · validation fiduciaire requise' : 'Désactivé'], ["Caisse AVS", settings.payroll.enabled ? settings.payroll.avsFund : '—'], ["Taux saisis", settings.payroll.enabled ? `${settings.payroll.employeeRates.length} salarié · ${settings.payroll.employerRates.length} employeur` : 'Aucun']]} /><ReviewCard title="Données" onEdit={() => onEdit(5)} rows={[["Stockage", 'Uniquement sur cet ordinateur'], ["Sauvegarde", 'Manuelle, à votre initiative'], ["Dossier", settings.backup.folder]]} /></div>
      <div className="zero-data"><Check size={19} /><div><strong>Démarrage propre confirmé</strong><p>0 client · 0 chantier ou projet · 0 devis · 0 facture · 0 salarié · 0 montant simulé</p></div></div>
    </div>
  );
}

function ReviewCard({ title, rows, onEdit }: { title: string; rows: Array<[string, string]>; onEdit: () => void }) {
  return <section className="review-card"><header><h3>{title}</h3><button type="button" onClick={onEdit}>Modifier <ArrowRight size={13} /></button></header><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>;
}

function ValidationSummary({ issues, onSelect }: { issues: OnboardingIssue[]; onSelect: (issue: OnboardingIssue) => void }) {
  return (
    <section className="validation-summary" role="alert" aria-live="polite">
      <span><AlertCircle size={20} /></span>
      <div>
        <strong>{issues.length === 1 ? 'Une information doit être corrigée' : `${issues.length} informations doivent être corrigées`}</strong>
        <p>Votre brouillon est conservé. Sélectionnez un problème pour aller directement au champ.</p>
        <div>{issues.map((issue, index) => <button type="button" key={`${issue.field}-${index}`} onClick={() => onSelect(issue)}><span>{issue.label}</span><small>{issue.message}</small><ArrowRight size={14} /></button>)}</div>
      </div>
    </section>
  );
}

function DatabaseIcon({ size = 20 }: { size?: number }) {
  return <Database size={size} />;
}

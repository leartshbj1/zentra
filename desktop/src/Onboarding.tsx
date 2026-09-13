import { nogaLabel } from './nogaLanguage';
import { t } from './language';
import { useAppLanguage, getAppLocale } from './language';
import { LanguageSetting } from './LanguageSetting';
import { setupIssueText } from './setupLanguage';
import { LocalAssistantSetup } from './LocalAssistantSetup';
import { useAssistantScreen } from './assistantContext';
import { PayrollOrganisationField } from './PayrollOrganisationField';
import { CompanyLogo } from './CompanyLogo';
import { CloudBackupPanel } from './CloudBackupPanel';
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
import { desktopApi, type CloudAccountState } from './bridge';
import { CloudAccountAccess } from './CloudAccountAccess';
import { isMobileRuntime } from './mobileRuntime';
import { BrandWordmark } from './BrandMark';
import type { AppSettings, NogaCatalog, NogaSectionCode, PayrollRate } from './types';
import { createId, errorMessage } from './utils';
import { Button, ErrorPanel, Field } from './ui';
import { projectTerminology } from './terminology';
import {
  hasAdvancedOnboardingInput,
  initialOnboardingSettings,
  settingsFromOnboardingDraft,
} from './onboardingDraft';
import {
  backendOnboardingIssue,
  normalizeIban,
  normalizeOnboardingSettings,
  validateOnboarding,
  type OnboardingIssue,
  type OnboardingValidationScope,
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

function readOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = window.localStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;
    if (parsed.version !== 1) return null;
    const settings = settingsFromOnboardingDraft(parsed.settings);
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
  return Object.fromEntries(issues.map((issue) => [issue.field, setupIssueText(issue)]));
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
  onCloudRestore,
  cloudAccount,
  onCloudAccountChange,
}: {
  onComplete: (settings: AppSettings, scope: OnboardingValidationScope) => Promise<void>;
  onRestore: (path: string) => Promise<void>;
  onCloudRestore?: (backupId: string) => Promise<void>;
  cloudAccount?: CloudAccountState | null;
  onCloudAccountChange?: (account: CloudAccountState) => void;
}) {
  const [draft] = useState(readOnboardingDraft);
  useAppLanguage();
  const [step, setStep] = useState(() => Math.min(6, Math.max(0, draft?.step ?? 0)));
  const [highestStep, setHighestStep] = useState(() => Math.min(6, Math.max(0, draft?.highestStep ?? draft?.step ?? 0)));
  const [settings, setSettings] = useState<AppSettings>(() => draft?.settings ?? initialOnboardingSettings);
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
  const advancedDraftPresent = useMemo(
    () => hasAdvancedOnboardingInput(settings, { privacyConfirmed, vatText }),
    [privacyConfirmed, settings, vatText],
  );
  const visibleIssues = useMemo(
    () => [...allIssues.filter((issue) => validatedSteps.includes(issue.step)), ...backendIssues],
    [allIssues, backendIssues, validatedSteps],
  );
  useAssistantScreen({screen:`Configuration · ${steps[step].label}`,scope:'configuration',facts:{'Étape':steps[step].label,'Canton':settings.organization.address.canton,'Points à corriger':visibleIssues.map(issue=>issue.message).join(' ; ').slice(0,700)}});
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
      if (!window.confirm(t('La sauvegarde choisie sera contrôlée avant de remplacer les données locales. Continuer ?'))) return;
      setBusy(true);
      await onRestore(path);
      try { window.localStorage.removeItem(ONBOARDING_DRAFT_KEY); } catch { /* L’espace restauré reste valide même si le brouillon ne peut pas être supprimé. */ }
    } catch (reason) {
      setError(errorMessage(reason, 'La restauration n’a pas pu être lancée.'));
    } finally {
      setBusy(false);
    }
  }

  async function finish(scope: OnboardingValidationScope = 'complete') {
    if (submitting.current) return;
    const normalized = normalizeOnboardingSettings(settings);
    setSettings(normalized);
    setValidatedSteps(scope === 'essential' ? [1] : [1, 2, 3, 4, 5]);
    setBackendIssues([]);
    const issues = validateOnboarding(normalized, nogaCatalog, privacyConfirmed, scope);
    if (issues.length) {
      setError(scope === 'essential'
        ? 'Complétez l’identité essentielle et le domaine d’activité avant de créer votre espace.'
        : 'Certaines informations doivent être corrigées avant de créer votre espace.');
      focusIssue(issues[0]);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      setSavePhase(scope === 'essential'
        ? 'Vérification de l’identité et du domaine…'
        : 'Vérification complète des informations…');
      const preflight = await desktopApi.validateOnboarding(normalized, scope);
      if (!preflight.valid) {
        const serverIssues = preflight.issues.map((issue) => ({ ...issue, step: Number(issue.step) }));
        setBackendIssues(serverIssues);
        setValidatedSteps([1, 2, 3, 4, 5]);
        setError('Zentra a trouvé une information à corriger. Votre brouillon est conservé sur cet ordinateur.');
        if (serverIssues[0]) focusIssue(serverIssues[0]);
        return;
      }
      setSavePhase(scope === 'essential'
        ? 'Création de votre espace progressif…'
        : 'Création de votre espace local…');
      await onComplete(normalized, scope);
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
    <div className={`onboarding${isMobileRuntime() ? ' onboarding--mobile' : ''}`}>
      <aside className="onboarding__rail">
        <div className="onboarding__brand">
          <div className="onboarding__wordmark">
            <BrandWordmark />
            <small>{isMobileRuntime() ? t("Application mobile") : t("Application Windows + macOS")}</small>
          </div>
        </div>
        <CloudAccountAccess account={cloudAccount} onAccountChange={onCloudAccountChange} />
        <div className="onboarding__promise">
          <LockKeyhole size={22} />
          <p><strong>{t("Votre entreprise reste chez vous.")}</strong>{t(" Les données métier sont stockées localement sur cet ")}{isMobileRuntime() ? t("appareil") : t("ordinateur")}.</p>
        </div>
        <nav className="setup-steps" aria-label={t("Étapes de configuration")}>
          {steps.map(({ label, icon: Icon }, index) => {
            const hasError = (validatedSteps.includes(index) && allIssues.some((issue) => issue.step === index)) || backendIssues.some((issue) => issue.step === index);
            const done = index < highestStep && !hasError;
            const className = [index === step ? 'is-current' : '', done ? 'is-done' : '', hasError ? 'has-error' : ''].filter(Boolean).join(' ');
            return (
              <button key={label} type="button" className={className} aria-current={index === step ? 'step' : undefined} onClick={() => { if (index <= highestStep) { setError(''); setStep(index); } }} disabled={index > highestStep}>
                <span>{hasError ? <AlertCircle size={15} /> : done ? <Check size={15} /> : <Icon size={15} />}</span>
                <em>{t(label)}</em>
              </button>
            );
          })}
        </nav>
        <div className={`onboarding__draft onboarding__draft--${draftStatus}`}>
          {draftStatus === 'failed' ? <AlertCircle size={15} /> : draftStatus === 'saved' ? <Check size={15} /> : <Save size={15} />}
          <p>
            <strong>{draftStatus === 'failed' ? t("Brouillon non enregistré") : t("Brouillon local")}</strong>
            <span>{draftStatus === 'failed' ? t("Vérifiez les droits de stockage du système") : draftStatus === 'saved' ? t("Toutes les modifications sont enregistrées") : isMobileRuntime() ? t("Enregistrement sur cet appareil…") : t("Enregistrement sur cet ordinateur…")}</span>
          </p>
        </div>
      </aside>

      <main className="onboarding__main">
        <div className="onboarding__content">
          <LanguageSetting compact />
          <div className="setup-progress-meta"><span>{step === 0 ? t("Bienvenue") : step === 6 ? t("Vérification finale") : t('Étape {step} sur 5', { step })}</span><strong>{Math.round((step / (steps.length - 1)) * 100)} %</strong></div>
          <div className="setup-progress" aria-hidden="true"><span style={{ width: `${(step / (steps.length - 1)) * 100}%` }} /></div>
          <section className="setup-stage" key={step}>
            {step === 0 ? (
              <SetupIntro onCreate={() => { setHighestStep((value) => Math.max(value, 1)); setStep(1); }} onRestore={() => void restore()} busy={busy} />
            ) : null}
            {step === 0 && cloudAccount?.status === 'connected' && onCloudRestore ? <CloudBackupPanel recoveryOnly disabled={busy} onBusyChange={setBusy} onRestore={async (id) => {
              await onCloudRestore(id);
              try { window.localStorage.removeItem(ONBOARDING_DRAFT_KEY); } catch { /* La restauration reste valide. */ }
            }} /> : null}
            {step === 0 ? <LocalAssistantSetup onboarding /> : null}
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
          {busy && savePhase ? <div className="setup-saving" role="status"><span><LoaderCircle className="spin" size={20} /></span><div><strong>{t(savePhase)}</strong><p>{t("Ne fermez pas Zentra. Cette opération reste entièrement locale.")}</p></div></div> : null}
          {error && !currentIssues.length ? <ErrorPanel title={t("Configuration non enregistrée")} message={error} /> : null}

          {step > 0 ? (
            <footer className="onboarding__actions">
              <Button variant="secondary" onClick={() => { setError(''); setStep((value) => Math.max(0, value - 1)); }} disabled={busy}>
                <ArrowLeft size={17} />{t(" Retour")}</Button>
              {step === 1 ? (
                <div className="onboarding__next-actions">
                  {advancedDraftPresent ? (
                    <p className="onboarding__advanced-draft-note" role="status">{t("Des réglages avancés sont déjà saisis dans ce brouillon. Pour ne rien perdre, poursuivez le parcours complet et vérifiez-les avant création.")}</p>
                  ) : null}
                  <Button variant="secondary" onClick={next} disabled={busy}>{t("Tout configurer maintenant ")}<ArrowRight size={17} />
                  </Button>
                  <Button
                    onClick={() => void finish('essential')}
                    disabled={busy || advancedDraftPresent}
                    title={advancedDraftPresent
                      ? t("Parcours complet requis pour conserver les réglages déjà saisis.")
                      : t("Créer l’espace avec uniquement l’identité et le domaine confirmés.")}
                  >
                    {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                    {busy ? t("Création…") : t("Créer avec l’essentiel")}
                  </Button>
                </div>
              ) : step < steps.length - 1 ? (
                <Button onClick={next} disabled={busy}>{t("Continuer ")}<ArrowRight size={17} /></Button>
              ) : (
                <Button size="large" onClick={() => void finish('complete')} disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}
                  {busy ? t("Finalisation en cours…") : t("Créer mon espace local")}
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
      <StepHeader eyebrow={t("Bienvenue")} title={t("Votre gestion d’activité commence ici.")} text={t("Créez d’abord le socle réel de votre entreprise, puis complétez les réglages à votre rythme. Aucun client, montant ou document fictif ne sera créé.")} />
      <div className="setup-choice-grid">
        <button className="setup-choice setup-choice--primary" onClick={onCreate} disabled={busy}>
          <span><BriefcaseBusiness size={25} /></span><div><strong>{t("Créer mon entreprise")}</strong><p>{t("Commencer par l’identité et le domaine, puis choisir entre un accès rapide et la configuration complète.")}</p></div><ArrowRight size={20} />
        </button>
        <button className="setup-choice" onClick={onRestore} disabled={busy}>
          <span><RefreshCw size={25} /></span><div><strong>{t("Restaurer une sauvegarde")}</strong><p>{isMobileRuntime() ? t("Reprendre vos données depuis un fichier de sauvegarde Zentra.") : t("Reprendre une archive .zentra, .elyko ou .hchantier provenant d’un autre ordinateur.")}</p></div><FolderOpen size={20} />
        </button>
      </div>
      <div className="local-facts">
        <div><DatabaseIcon /><strong>{t("Base locale sur cet ")}{isMobileRuntime() ? t("appareil") : t("ordinateur")}</strong><span>{t("Fonctionne même sans connexion")}</span></div>
        <div><FileArchive /><strong>{t("Sauvegardes portables")}</strong><span>{t("Vous gardez la maîtrise des fichiers")}</span></div>
        <div><ShieldCheck /><strong>{t("Coffre du système")}</strong><span>{isMobileRuntime() ? t("Trousseau iOS · Android Keystore") : t("DPAPI sous Windows · Trousseau sous macOS")}</span></div>
      </div>
    </div>
  );
}

function IdentityStep({ settings, setSettings, catalog, catalogError, onRetryCatalog, issues }: { settings: AppSettings; setSettings: SettingsSetter; catalog: NogaCatalog | null; catalogError: string; onRetryCatalog: () => void; issues: IssueMap }) {
  const org = settings.organization;
  const business = settings.business;
  const [choosingLogo, setChoosingLogo] = useState(false);
  const [logoError, setLogoError] = useState('');
  const patch = (value: Partial<typeof org>) => setSettings((current) => setDeep(current, 'organization', value));
  const patchAddress = (value: Partial<typeof org.address>) => patch({ address: { ...org.address, ...value } });
  const patchBusiness = (value: Partial<typeof business>) => setSettings((current) => setDeep(current, 'business', value));
  const selectedSection = catalog?.sections.find((section) => section.code === business.nogaSection);

  async function chooseLogo() {
    setLogoError('');
    setChoosingLogo(true);
    try {
      const sourcePath = await desktopApi.chooseLogo();
      if (!sourcePath) return;
      const logoPath = await desktopApi.stageCompanyLogo(sourcePath);
      patch({ logoPath });
    } catch (reason) {
      setLogoError(errorMessage(reason, 'Le logo n’a pas pu être vérifié et copié dans les données locales.'));
    } finally {
      setChoosingLogo(false);
    }
  }

  return (
    <div>
      <StepHeader eyebrow={t("Étape essentielle")} title={t("Identité de l’entreprise")} text={t("Ces informations définissent votre entreprise et son domaine. Après cette étape, vous pouvez accéder à Zentra ou continuer immédiatement avec tous les réglages.")} />
      <div className="form-grid setup-form">
        <div className="info-strip field--wide progressive-setup-note">
          <Check size={18} />
          <span><strong>{t("Démarrage progressif")}</strong>{t(" Facturation, temps, coûts et sauvegardes resteront non confirmés dans le centre de préparation. Les valeurs techniques proposées ne seront pas considérées comme vos choix tant que vous ne les aurez pas enregistrées.")}</span>
        </div>
        <div
          className={`company-logo-setting onboarding-logo-setting field--wide ${issues['organization.logoPath'] ? 'field--error' : ''}`}
          data-field-action="organization.logoPath"
        >
          <div className="company-logo-setting__preview">{org.logoPath ? <CompanyLogo path={org.logoPath} alt={t('Logo de {name}', { name: org.legalName || t('l’entreprise') })} /> : <Building2 size={30} />}</div>
          <div className="company-logo-setting__copy">
            <strong>{t("Logo de l’entreprise")}</strong>
            <p>{t("Facultatif · PNG, JPEG ou WebP, de 16 × 16 à 4096 × 4096 px, 8 Mo maximum. Zentra contrôle le contenu et en conserve une copie locale immuable pour vos devis, factures et fiches de salaire.")}</p>
            <div className="settings-inline-actions">
              <Button data-field="organization.logoPath" aria-invalid={Boolean(issues['organization.logoPath'])} type="button" variant="secondary" disabled={choosingLogo} onClick={() => void chooseLogo()}>
                {choosingLogo ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} {choosingLogo ? t("Vérification…") : org.logoPath ? t("Remplacer le logo") : t("Choisir le logo")}
              </Button>
              {org.logoPath ? <Button type="button" variant="ghost" disabled={choosingLogo} onClick={() => { setLogoError(''); patch({ logoPath: '' }); }}><Trash2 size={15} />{t(" Retirer")}</Button> : null}
            </div>
            {org.logoPath ? <span className="path-note"><ShieldCheck size={14} />{t(" Copie locale prête pour les documents")}</span> : <span className="path-note">{t("Vous pourrez aussi l’ajouter plus tard dans Paramètres.")}</span>}
          </div>
        </div>
        {logoError || issues['organization.logoPath'] ? <div className="field--wide"><ErrorPanel title={t("Logo non importé")} message={logoError || issues['organization.logoPath']} /></div> : null}
        <Field label={t("Raison sociale")} required wide error={issues['organization.legalName']}><input data-field="organization.legalName" aria-invalid={Boolean(issues['organization.legalName'])} value={org.legalName} onChange={(e) => patch({ legalName: e.target.value })} autoFocus /></Field>
        <Field label={t("Forme juridique")}><input value={org.legalForm} onChange={(e) => patch({ legalForm: e.target.value })} /></Field>
        <Field label={t("Responsable")} required error={issues['organization.contactName']}><input data-field="organization.contactName" aria-invalid={Boolean(issues['organization.contactName'])} value={org.contactName} onChange={(e) => patch({ contactName: e.target.value })} /></Field>
        <Field label={t("E-mail")} required error={issues['organization.email']}><input data-field="organization.email" aria-invalid={Boolean(issues['organization.email'])} type="email" value={org.email} onChange={(e) => patch({ email: e.target.value })} /></Field>
        <Field label={t("Téléphone")}><input value={org.phone} onChange={(e) => patch({ phone: e.target.value })} /></Field>
        <Field label={t("Rue / case postale")} required wide error={issues['organization.address.street']}><input data-field="organization.address.street" aria-invalid={Boolean(issues['organization.address.street'])} value={org.address.street} onChange={(e) => patchAddress({ street: e.target.value })} /></Field>
        <Field label={t("Numéro de bâtiment")}><input value={org.address.buildingNumber ?? ''} onChange={(e) => patchAddress({ buildingNumber: e.target.value })} /></Field>
        <Field label={t("NPA")} required error={issues['organization.address.postalCode']}><input data-field="organization.address.postalCode" aria-invalid={Boolean(issues['organization.address.postalCode'])} value={org.address.postalCode} onChange={(e) => patchAddress({ postalCode: e.target.value })} /></Field>
        <Field label={t("Localité")} required error={issues['organization.address.city']}><input data-field="organization.address.city" aria-invalid={Boolean(issues['organization.address.city'])} value={org.address.city} onChange={(e) => patchAddress({ city: e.target.value })} /></Field>
        <Field label={t("Canton")} required error={issues['organization.address.canton']}><input data-field="organization.address.canton" aria-invalid={Boolean(issues['organization.address.canton'])} value={org.address.canton} onChange={(e) => patchAddress({ canton: e.target.value })} /></Field>
        <Field label={t("Pays (code ISO, 2 lettres)")} required error={issues['organization.address.country']}><input data-field="organization.address.country" aria-invalid={Boolean(issues['organization.address.country'])} value={org.address.country} minLength={2} maxLength={2} onChange={(e) => patchAddress({ country: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })} /></Field>
        <Field label={t("IDE / UID")} error={issues['organization.vatIdentifier']}><input data-field="organization.vatIdentifier" aria-invalid={Boolean(issues['organization.vatIdentifier'])} value={org.uidNumber} onChange={(e) => patch({ uidNumber: e.target.value })} /></Field>
        {org.vatRegistered ? <Field label={t("Numéro TVA")} required error={issues['organization.vatIdentifier']}><input aria-invalid={Boolean(issues['organization.vatIdentifier'])} value={org.vatNumber} onChange={(e) => patch({ vatNumber: e.target.value })} required /></Field> : null}
        <Field label={t("Site internet")} error={issues['organization.website']}><input data-field="organization.website" aria-invalid={Boolean(issues['organization.website'])} type="url" placeholder={"https://"} value={org.website} onChange={(e) => patch({ website: e.target.value })} /></Field>
        <label className="check-card field--wide"><input type="checkbox" checked={org.vatRegistered} onChange={(e) => patch({ vatRegistered: e.target.checked })} /><span><strong>{t("Entreprise assujettie à la TVA")}</strong><small>{t("Les taux seront saisis explicitement à l’étape suivante.")}</small></span></label>
        <div className="setup-subsection field--wide"><strong>{t("Secteur d’activité · NOGA 2025")}</strong><p>{t("La section et la division déterminent uniquement les libellés de navigation. Elles ne créent aucune donnée métier.")}</p></div>
        <Field label={t("Section NOGA 2025")} hint={selectedSection ? nogaLabel(selectedSection.code, selectedSection.label) : undefined} required wide error={issues['business.nogaSection']}><select data-field="business.nogaSection" aria-invalid={Boolean(issues['business.nogaSection'])} value={business.nogaSection} onChange={(e) => patchBusiness({ nogaSection: e.target.value as NogaSectionCode | '', nogaDivision: '', nogaDetailedCode: '' })} required disabled={!catalog}><option value="">{catalog ? t("Choisir parmi les 22 sections officielles") : t("Chargement du catalogue officiel…")}</option>{catalog?.sections.map((section) => <option key={section.code} value={section.code}>{section.code} · {nogaLabel(section.code, section.label)}</option>)}</select></Field>
        <Field label={t("Division NOGA 2025")} hint={selectedSection?.divisions.filter(division => division.code === business.nogaDivision).map(division => nogaLabel(division.code, division.label)).join('') || undefined} required wide error={issues['business.nogaDivision']}><select data-field="business.nogaDivision" aria-invalid={Boolean(issues['business.nogaDivision'])} value={business.nogaDivision} onChange={(e) => patchBusiness({ nogaDivision: e.target.value, nogaDetailedCode: '' })} required disabled={!selectedSection}><option value="">{selectedSection ? t("Choisir la division officielle") : t("Choisissez d’abord une section")}</option>{selectedSection?.divisions.map((division) => <option key={division.code} value={division.code}>{division.code} · {nogaLabel(division.code, division.label)}</option>)}</select></Field>
        <Field label={t("Activité précise")} hint={t("Décrivez votre activité réelle; ce texte reste local.")} required wide error={issues['business.activityDescription']}><textarea data-field="business.activityDescription" aria-invalid={Boolean(issues['business.activityDescription'])} rows={3} maxLength={2000} value={business.activityDescription} onChange={(e) => patchBusiness({ activityDescription: e.target.value })} required /></Field>
        <Field label={t("Code NOGA détaillé")} hint={t("Facultatif : code numérique à 3, 4 ou 6 chiffres commençant par la division choisie.")} wide error={issues['business.nogaDetailedCode']}><input data-field="business.nogaDetailedCode" aria-invalid={Boolean(issues['business.nogaDetailedCode'])} inputMode="numeric" pattern={business.nogaDivision ? `${business.nogaDivision}(?:\\d|\\d{2}|\\d{4})` : '\\d{3}|\\d{4}|\\d{6}'} value={business.nogaDetailedCode} onChange={(e) => patchBusiness({ nogaDetailedCode: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
        {catalogError ? <div className="field--wide" data-field-action="business.nogaSection"><ErrorPanel title={t("Catalogue NOGA indisponible")} message={catalogError} onRetry={onRetryCatalog} /></div> : null}
        <p className="source-note field--wide">{t("Source : ")}<a href={catalog?.source || 'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025'} target="_blank" rel="noreferrer">{t("Office fédéral de la statistique · KUBB NOGA 2025")}</a>{catalog?.version ? t(" · version {v0}", { v0: catalog.version }) : ''}</p>
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
      <StepHeader eyebrow={t("Étape 2 sur 5")} title={t("Facturation suisse")} text={t("Vous décidez des numéros, délais et taux. Zentra n’invente aucune règle comptable.")} />
      <div className="form-grid setup-form">
        <Field label={t("IBAN ou QR-IBAN")} hint={t("21 caractères pour un IBAN suisse ou liechtensteinois; les espaces sont retirés automatiquement.")} required wide error={issues['billing.iban']}><input data-field="billing.iban" aria-invalid={Boolean(issues['billing.iban'])} value={billing.iban} onChange={(e) => patch({ iban: e.target.value.toUpperCase() })} onBlur={() => patch({ iban: normalizeIban(billing.iban) })} autoFocus /></Field>
        <Field label={t("Titulaire du compte")} required wide error={issues['billing.accountHolder']}><input data-field="billing.accountHolder" aria-invalid={Boolean(issues['billing.accountHolder'])} value={billing.accountHolder} onChange={(e) => patch({ accountHolder: e.target.value })} /></Field>
        <Field label={t("Préfixe devis")} hint={t("Lettres, chiffres ou tirets · 12 caractères max.")} required error={issues['billing.quotePrefix']}><input data-field="billing.quotePrefix" aria-invalid={Boolean(issues['billing.quotePrefix'])} maxLength={12} value={billing.quotePrefix} onChange={(e) => patch({ quotePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label={t("Prochain numéro de devis")} required error={issues['billing.nextQuoteNumber']}><input data-field="billing.nextQuoteNumber" aria-invalid={Boolean(issues['billing.nextQuoteNumber'])} type="number" min="1" step="1" value={billing.nextQuoteNumber || ''} onChange={(e) => patch({ nextQuoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Préfixe factures")} hint={t("Lettres, chiffres ou tirets · 12 caractères max.")} required error={issues['billing.invoicePrefix']}><input data-field="billing.invoicePrefix" aria-invalid={Boolean(issues['billing.invoicePrefix'])} maxLength={12} value={billing.invoicePrefix} onChange={(e) => patch({ invoicePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label={t("Prochain numéro de facture")} required error={issues['billing.nextInvoiceNumber']}><input data-field="billing.nextInvoiceNumber" aria-invalid={Boolean(issues['billing.nextInvoiceNumber'])} type="number" min="1" step="1" value={billing.nextInvoiceNumber || ''} onChange={(e) => patch({ nextInvoiceNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Préfixe avoirs")} hint={t("Lettres, chiffres ou tirets · 12 caractères max.")} required error={issues['billing.creditNotePrefix']}><input data-field="billing.creditNotePrefix" aria-invalid={Boolean(issues['billing.creditNotePrefix'])} maxLength={12} value={billing.creditNotePrefix} onChange={(e) => patch({ creditNotePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label={t("Prochain numéro d’avoir")} required error={issues['billing.nextCreditNoteNumber']}><input data-field="billing.nextCreditNoteNumber" aria-invalid={Boolean(issues['billing.nextCreditNoteNumber'])} type="number" min="1" step="1" value={billing.nextCreditNoteNumber || ''} onChange={(e) => patch({ nextCreditNoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Délai de paiement (jours)")} required error={issues['billing.paymentTermsDays']}><input data-field="billing.paymentTermsDays" aria-invalid={Boolean(issues['billing.paymentTermsDays'])} type="number" min="1" max="365" step="1" value={billing.paymentTermsDays || ''} onChange={(e) => patch({ paymentTermsDays: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Validité des devis (jours)")} required error={issues['billing.quoteValidityDays']}><input data-field="billing.quoteValidityDays" aria-invalid={Boolean(issues['billing.quoteValidityDays'])} type="number" min="1" max="365" step="1" value={billing.quoteValidityDays || ''} onChange={(e) => patch({ quoteValidityDays: e.target.valueAsNumber || 0 })} /></Field>
        {settings.organization.vatRegistered ? (
          <div className={`field field--wide ${issues['billing.vatRatesBp'] ? 'field--error' : ''}`}><span className="field__label">{t("Taux TVA utilisés ")}<em>{t("obligatoire")}</em></span><div className="inline-entry"><input data-field="billing.vatRatesBp" aria-invalid={Boolean(issues['billing.vatRatesBp'])} type="number" min="0.01" max="100" step="0.01" value={vatText} onChange={(e) => setVatText(e.target.value)} aria-label={t("Taux TVA en pour cent")} /><span>%</span><Button type="button" variant="secondary" onClick={addVat}><Plus size={16} />{t(" Ajouter")}</Button></div><div className="chips">{billing.vatRatesBp.map((rate, index) => <button type="button" key={`${rate}-${index}`} onClick={() => patch({ vatRatesBp: billing.vatRatesBp.filter((_, i) => i !== index) })}>{(rate / 100).toLocaleString(getAppLocale())} % <Trash2 size={12} /></button>)}</div>{issues['billing.vatRatesBp'] ? <span className="field__error" role="alert">{issues['billing.vatRatesBp']}</span> : null}</div>
        ) : <div className="info-strip field--wide"><ShieldCheck size={18} /><span>{t("Entreprise indiquée non assujettie : les documents seront établis sans TVA.")}</span></div>}
        <Field label={t("Pied de page des documents")} wide><textarea rows={3} value={billing.defaultFooter} onChange={(e) => patch({ defaultFooter: e.target.value })} /></Field>
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
      <StepHeader eyebrow={t("Étape 3 sur 5")} title={t("Temps et coûts réels")} text={t("Ces règles servent au suivi des heures. Les coûts horaires restent définis salarié par salarié.")} />
      <div className="form-grid setup-form">
        <Field label={t("Heures par semaine")} required error={issues['work.workWeekHours']}><input data-field="work.workWeekHours" aria-invalid={Boolean(issues['work.workWeekHours'])} type="number" min="0.01" max="168" step="0.01" value={work.workWeekHours || ''} onChange={(e) => patch({ workWeekHours: e.target.valueAsNumber || 0 })} autoFocus /></Field>
        <Field label={t("Heures par journée")} required error={issues['work.dailyHours']}><input data-field="work.dailyHours" aria-invalid={Boolean(issues['work.dailyHours'])} type="number" min="0.01" max="24" step="0.01" value={work.dailyHours || ''} onChange={(e) => patch({ dailyHours: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Arrondi des pointages")} required error={issues['work.roundingMinutes']}><select data-field="work.roundingMinutes" aria-invalid={Boolean(issues['work.roundingMinutes'])} value={work.roundingMinutes < 0 ? '' : work.roundingMinutes} onChange={(e) => patch({ roundingMinutes: Number(e.target.value) })} required><option value="">{t("Choisir la règle")}</option><option value="0">{t("Aucun arrondi")}</option><option value="1">{t("À la minute")}</option><option value="5">{t("5 minutes")}</option><option value="10">{t("10 minutes")}</option><option value="15">{t("15 minutes")}</option></select></Field>
        <Field label={t("Pause habituelle (minutes)")} required error={issues['work.breakMinutes']}><input data-field="work.breakMinutes" aria-invalid={Boolean(issues['work.breakMinutes'])} type="number" min="0" max="1440" step="1" value={work.breakMinutes < 0 ? '' : work.breakMinutes} onChange={(e) => patch({ breakMinutes: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : -1 })} required /></Field>
        <Field label={t("Catégories de dépenses")} hint={t("Séparez chaque catégorie par une virgule.")} required wide error={issues['work.costCategories']}><textarea data-field="work.costCategories" aria-invalid={Boolean(issues['work.costCategories'])} rows={3} value={categoriesText} onChange={(e) => { setCategoriesText(e.target.value); patch({ costCategories: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) }); }} /></Field>
      </div>
      <div className="definition-grid"><div><strong>{t("Durée prévue")}</strong><span>{t("Dates et heures planifiées sur le ")}{terminology.singular}</span></div><div><strong>{t("Durée réelle")}</strong><span>{t("Dates réelles et heures effectivement saisies")}</span></div><div><strong>{t("Rentabilité")}</strong><span>{t("Facturé net moins coûts horaires et dépenses nettes")}</span></div></div>
    </div>
  );
}

function PayrollStep({ settings, setSettings, addRate, updateRate, removeRate, issues }: { settings: AppSettings; setSettings: SettingsSetter; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void; issues: IssueMap }) {
  const payroll = settings.payroll;
  const aanpCoverage = payroll.aanpEmployerCoverage ?? { enabled: false, reference: '', effectiveFrom: '', effectiveTo: '' };
  const lppPlan = payroll.lppPlanEvidence;
  const patch = (value: Partial<typeof payroll>) => setSettings((current) => setDeep(current, 'payroll', value));
  const patchAanpCoverage = (value: Partial<typeof aanpCoverage>) => patch({ aanpEmployerCoverage: { ...aanpCoverage, ...value } });
  const patchLppPlan = (value: Partial<NonNullable<typeof lppPlan>>) => patch({ lppPlanEvidence: { contractNumber: '', regulationReference: '', effectiveFrom: '', effectiveTo: '', employerAggregateShareConfirmed: false, ...lppPlan, ...value } });
  return (
    <div>
      <StepHeader eyebrow={t("Étape 4 sur 5")} title={t("Préparation des salaires")} text={t("Le module est facultatif. Aucun taux social et aucune retenue ne sont estimés par le logiciel.")} />
      <label className={`module-toggle ${issues['payroll.enabled'] ? 'field--error' : ''}`}><input data-field="payroll.enabled" type="checkbox" checked={payroll.enabled} onChange={(e) => patch(e.target.checked ? { enabled: true } : { enabled: false, employeeRates: [], employerRates: [] })} /><span><Users size={22} /><strong>{t("Activer Équipe & salaires")}</strong><small>{t("Créer des fiches à partir de montants explicitement configurés.")}</small></span></label>
      {payroll.enabled ? (
        <>
          <div className="warning-card"><ShieldCheck size={21} /><div><strong>{t("Validation professionnelle requise")}</strong><p>{t("Avant d’utiliser une fiche comme document final, faites contrôler les caisses, assurances et taux par votre fiduciaire.")}</p></div></div>
          <div className="form-grid setup-form">
            <PayrollOrganisationField kind="avs" required error={issues['payroll.avsFund']} dataField="payroll.avsFund" value={payroll.avsFund} canton={payroll.payrollCanton} onChange={(avsFund) => patch({ avsFund })} />
            <PayrollOrganisationField kind="accident" required error={issues['payroll.accidentInsurer']} dataField="payroll.accidentInsurer" value={payroll.accidentInsurer} onChange={(accidentInsurer) => patch({ accidentInsurer })} />
            <PayrollOrganisationField kind="pension" value={payroll.pensionFund} onChange={(pensionFund) => patch({ pensionFund })} />
            <PayrollOrganisationField kind="daily" value={payroll.dailyAllowanceInsurer} onChange={(dailyAllowanceInsurer) => patch({ dailyAllowanceInsurer })} />
            <PayrollOrganisationField kind="family" value={payroll.familyAllowanceFund} canton={payroll.payrollCanton} onChange={(familyAllowanceFund) => patch({ familyAllowanceFund })} />
            <Field label={t("Canton de paie")} required error={issues['payroll.payrollCanton']}><input data-field="payroll.payrollCanton" aria-invalid={Boolean(issues['payroll.payrollCanton'])} value={payroll.payrollCanton} onChange={(e) => patch({ payrollCanton: e.target.value })} /></Field>
          </div>
          <label className="check-card"><input type="checkbox" checked={Boolean(lppPlan)} onChange={(e) => patch(e.target.checked ? { lppPlanEvidence: { contractNumber: '', regulationReference: '', effectiveFrom: '', effectiveTo: '', employerAggregateShareConfirmed: false } } : { lppPlanEvidence: undefined })} /><span><strong>{t("Configurer maintenant le règlement LPP")}</strong><small>{t("Facultatif tant qu’aucun plan n’est utilisé. Activez avec le contrat et le règlement réels de la caisse.")}</small></span></label>
          {lppPlan ? <div className="form-grid setup-form lpp-plan-fields">
            <Field label={t("Numéro du contrat LPP")} required error={issues['payroll.lppPlanEvidence.contractNumber']}><input data-field="payroll.lppPlanEvidence.contractNumber" aria-invalid={Boolean(issues['payroll.lppPlanEvidence.contractNumber'])} maxLength={200} value={lppPlan.contractNumber} onChange={(e) => patchLppPlan({ contractNumber: e.target.value })} /></Field>
            <Field label={t("Référence exacte du règlement")} hint={t("Cette référence devra être recopiée comme source de chaque définition LPP.")} required wide error={issues['payroll.lppPlanEvidence.regulationReference']}><input data-field="payroll.lppPlanEvidence.regulationReference" aria-invalid={Boolean(issues['payroll.lppPlanEvidence.regulationReference'])} maxLength={500} value={lppPlan.regulationReference} onChange={(e) => patchLppPlan({ regulationReference: e.target.value })} /></Field>
            <Field label={t("Début d’effet du règlement")} required error={issues['payroll.lppPlanEvidence.effectiveFrom']}><input data-field="payroll.lppPlanEvidence.effectiveFrom" aria-invalid={Boolean(issues['payroll.lppPlanEvidence.effectiveFrom'])} type="date" value={lppPlan.effectiveFrom} onChange={(e) => patchLppPlan({ effectiveFrom: e.target.value })} /></Field>
            <Field label={t("Fin d’effet du règlement")} required error={issues['payroll.lppPlanEvidence.effectiveTo']}><input data-field="payroll.lppPlanEvidence.effectiveTo" aria-invalid={Boolean(issues['payroll.lppPlanEvidence.effectiveTo'])} type="date" value={lppPlan.effectiveTo} onChange={(e) => patchLppPlan({ effectiveTo: e.target.value })} required /></Field>
            <label className={`check-card field--wide ${issues['payroll.lppPlanEvidence.employerAggregateShareConfirmed'] ? 'has-error' : ''}`}><input data-field="payroll.lppPlanEvidence.employerAggregateShareConfirmed" aria-invalid={Boolean(issues['payroll.lppPlanEvidence.employerAggregateShareConfirmed'])} type="checkbox" checked={lppPlan.employerAggregateShareConfirmed} onChange={(e) => patchLppPlan({ employerAggregateShareConfirmed: e.target.checked })} /><span><strong>{t("Part employeur agrégée contrôlée")}</strong><small>{t("Je confirme d’après le règlement que le total employeur est au moins égal au total des contributions des salariés.")}</small>{issues['payroll.lppPlanEvidence.employerAggregateShareConfirmed'] ? <small>{issues['payroll.lppPlanEvidence.employerAggregateShareConfirmed']}</small> : null}</span></label>
          </div> : null}
          <label className="check-card"><input type="checkbox" checked={aanpCoverage.enabled} onChange={(e) => patchAanpCoverage({ enabled: e.target.checked })} /><span><strong>{t("L’employeur prend en charge la prime AANP")}</strong><small>{t("Activez uniquement si un contrat, une CCT ou une décision écrite prévoit cette convention plus favorable au salarié.")}</small></span></label>
          {aanpCoverage.enabled ? <div className="form-grid setup-form">
            <Field label={t("Référence de la convention AANP")} hint={t("Ex. contrat LAA n° 12345, clause 8 ou décision employeur datée.")} required wide error={issues['payroll.aanpEmployerCoverage.reference']}><input data-field="payroll.aanpEmployerCoverage.reference" aria-invalid={Boolean(issues['payroll.aanpEmployerCoverage.reference'])} maxLength={500} value={aanpCoverage.reference} onChange={(e) => patchAanpCoverage({ reference: e.target.value })} /></Field>
            <Field label={t("Début de prise en charge")} required error={issues['payroll.aanpEmployerCoverage.effectiveFrom']}><input data-field="payroll.aanpEmployerCoverage.effectiveFrom" aria-invalid={Boolean(issues['payroll.aanpEmployerCoverage.effectiveFrom'])} type="date" value={aanpCoverage.effectiveFrom} onChange={(e) => patchAanpCoverage({ effectiveFrom: e.target.value })} /></Field>
            <Field label={t("Fin de prise en charge")} hint={t("Facultatif si la convention reste ouverte.")} error={issues['payroll.aanpEmployerCoverage.effectiveTo']}><input data-field="payroll.aanpEmployerCoverage.effectiveTo" aria-invalid={Boolean(issues['payroll.aanpEmployerCoverage.effectiveTo'])} type="date" value={aanpCoverage.effectiveTo} onChange={(e) => patchAanpCoverage({ effectiveTo: e.target.value })} /></Field>
          </div> : null}
          <RateEditor title={t("Retenues salarié")} rates={payroll.employeeRates} target="employeeRates" addRate={addRate} updateRate={updateRate} removeRate={removeRate} issues={issues} />
          <RateEditor title={t("Charges employeur")} rates={payroll.employerRates} target="employerRates" addRate={addRate} updateRate={updateRate} removeRate={removeRate} issues={issues} />
          <label className="check-card"><input type="checkbox" checked={payroll.fiduciaryValidated} onChange={(e) => patch({ fiduciaryValidated: e.target.checked })} /><span><strong>{t("Configuration contrôlée par une fiduciaire")}</strong><small>{t("Sans cette confirmation, les fiches restent marquées incomplètes.")}</small></span></label>
        </>
      ) : <div className="skipped-module"><Check size={19} /><span>{t("Le module restera masqué. Vous pourrez l’activer plus tard dans Paramètres.")}</span></div>}
    </div>
  );
}

function RateEditor({ title, rates, target, addRate, updateRate, removeRate, issues }: { title: string; rates: PayrollRate[]; target: 'employeeRates' | 'employerRates'; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void; issues: IssueMap }) {
  return <section className="rate-editor"><header><div><strong>{title}</strong><small>{t("Saisissez seulement les taux confirmés.")}</small></div><Button type="button" variant="secondary" size="small" onClick={() => addRate(target)}><Plus size={15} />{t(" Ajouter un taux")}</Button></header>{rates.length ? <div className="rate-list">{rates.map((rate) => { const prefix = `payroll.${target}.${rate.id}`; return <div className="rate-row" key={rate.id}><div className="rate-control"><input data-field={`${prefix}.label`} aria-invalid={Boolean(issues[`${prefix}.label`])} aria-label={t("Libellé")} placeholder={t("Libellé")} maxLength={200} value={rate.label} onChange={(e) => updateRate(target, rate.id, { label: e.target.value })} />{issues[`${prefix}.label`] ? <small>{issues[`${prefix}.label`]}</small> : null}</div><div className="rate-control"><label><input data-field={`${prefix}.rateBp`} aria-invalid={Boolean(issues[`${prefix}.rateBp`])} aria-label={t("Taux en pour cent")} type="number" min="0.01" max="100" step="0.01" value={rate.rateBp ? rate.rateBp / 100 : ''} onChange={(e) => updateRate(target, rate.id, { rateBp: Math.round((e.target.valueAsNumber || 0) * 100) })} /><span>%</span></label>{issues[`${prefix}.rateBp`] ? <small>{issues[`${prefix}.rateBp`]}</small> : null}</div><div className="rate-control"><input data-field={`${prefix}.effectiveFrom`} aria-invalid={Boolean(issues[`${prefix}.effectiveFrom`])} aria-label={t("Date d’effet")} type="date" value={rate.effectiveFrom} onChange={(e) => updateRate(target, rate.id, { effectiveFrom: e.target.value })} />{issues[`${prefix}.effectiveFrom`] ? <small>{issues[`${prefix}.effectiveFrom`]}</small> : null}</div><Button type="button" variant="ghost" size="icon" aria-label={t("Supprimer le taux {v0}", { v0: rate.label || t('sans libellé') })} onClick={() => removeRate(target, rate.id)}><Trash2 size={16} /></Button></div>; })}</div> : <p className="rate-empty">{t("Aucun taux saisi. Le logiciel n’effectuera aucune déduction correspondante.")}</p>}</section>;
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
      <StepHeader eyebrow={t("Étape 5 sur 5")} title={t("Sauvegarde et confidentialité")} text={isMobileRuntime() ? t("La base reste sur cet appareil. Enregistrez une copie de sauvegarde dans un emplacement distinct grâce au partage du système.") : t("La base active reste sur cet ordinateur. Une sauvegarde externe protège votre entreprise d’une panne ou d’un vol.")} />
      <div className="privacy-banner"><DatabaseIcon size={24} /><div><strong>{t("Données métier locales")}</strong><p>{t("Clients, projets, temps, pièces jointes et salaires restent dans la base locale. Si vous reliez un compte, les PDF des factures émises sont aussi conservés dans le coffre Zentra pendant dix ans.")}</p></div></div>
      {isMobileRuntime() ? <div className="privacy-banner"><FolderOpen size={24} /><div><strong>{t("Enregistrer ou partager une sauvegarde")}</strong><p>{t("Depuis les paramètres, créez une sauvegarde puis choisissez Fichiers, votre espace cloud ou une application compatible. Aucun dossier système n’est à configurer ici.")}</p></div></div> : <div className="form-grid setup-form"><Field label={t("Dossier pour les sauvegardes manuelles")} hint={t("Une sauvegarde ne sera créée que lorsque vous utiliserez le bouton Sauvegarder.")} required wide error={issues['backup.folder']}><div className="path-picker"><input aria-invalid={Boolean(issues['backup.folder'])} readOnly value={backup.folder} /><Button data-field="backup.folder" type="button" variant="secondary" disabled={choosing} onClick={() => void chooseFolder()}>{choosing ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} {choosing ? t("Ouverture…") : t("Choisir")}</Button></div></Field></div>}
      <div className="confirmation-checks"><label className={issues['backup.privacyConfirmed'] ? 'has-error' : ''}><input data-field="backup.privacyConfirmed" aria-invalid={Boolean(issues['backup.privacyConfirmed'])} type="checkbox" checked={privacyConfirmed} onChange={(e) => setPrivacyConfirmed(e.target.checked)} /><span>{t("J’ai compris que mes données métier restent locales et que je suis responsable de leur sauvegarde.")}{issues['backup.privacyConfirmed'] ? <small>{issues['backup.privacyConfirmed']}</small> : null}</span></label><label className={issues['backup.recoveryConfirmed'] ? 'has-error' : ''}><input data-field="backup.recoveryConfirmed" aria-invalid={Boolean(issues['backup.recoveryConfirmed'])} type="checkbox" checked={backup.recoveryConfirmed} onChange={(e) => patch({ recoveryConfirmed: e.target.checked })} /><span>{t("Je conserverai au moins une sauvegarde récente dans un emplacement distinct et sûr.")}{issues['backup.recoveryConfirmed'] ? <small>{issues['backup.recoveryConfirmed']}</small> : null}</span></label></div>
    </div>
  );
}

function ConfirmationStep({ settings, onEdit }: { settings: AppSettings; onEdit: (step: number) => void }) {
  const org = settings.organization;
  const lppPlan = settings.payroll.lppPlanEvidence;
  return (
    <div>
      <StepHeader eyebrow={t("Profil initial")} title={t("Vérifiez votre configuration")} text={t("Seules les informations ci-dessous seront enregistrées. Après cette étape, le centre de préparation vous guidera pour activer la comptabilité et créer votre première sauvegarde.")} />
      <div className="review-grid"><ReviewCard title={t("Entreprise")} onEdit={() => onEdit(1)} rows={[[t("Raison sociale"), org.legalName], [t("Responsable"), org.contactName], [t("Adresse"), `${org.address.street}${org.address.buildingNumber ? ` ${org.address.buildingNumber}` : ''}, ${org.address.postalCode} ${org.address.city}`], [t("Logo"), org.logoPath ? t("Copie locale configurée") : t("Non configuré")], [t("TVA"), org.vatRegistered ? t("Assujettie · {v0}", { v0: org.vatNumber || org.uidNumber }) : t("Non assujettie")]]} /><ReviewCard title={t("Activité")} onEdit={() => onEdit(1)} rows={[[t("Section NOGA"), settings.business.nogaSection], [t("Division NOGA"), settings.business.nogaDivision], [t("Activité précise"), settings.business.activityDescription], [t("Code détaillé"), settings.business.nogaDetailedCode || t("Non renseigné")]]} /><ReviewCard title={t("Facturation")} onEdit={() => onEdit(2)} rows={[[t("Compte"), settings.billing.iban], [t("Numérotation devis"), t("{v0} · prochain {v1}", { v0: settings.billing.quotePrefix, v1: settings.billing.nextQuoteNumber })], [t("Numérotation factures"), t("{v0} · prochain {v1}", { v0: settings.billing.invoicePrefix, v1: settings.billing.nextInvoiceNumber })], [t("TVA"), settings.billing.vatRatesBp.length ? settings.billing.vatRatesBp.map((rate) => `${(rate / 100).toLocaleString(getAppLocale())} %`).join(', ') : t("Sans TVA")], [t("Délais"), t("{v0} jours · devis {v1} jours", { v0: settings.billing.paymentTermsDays, v1: settings.billing.quoteValidityDays })]]} /><ReviewCard title={t("Temps & coûts")} onEdit={() => onEdit(3)} rows={[[t("Semaine"), t("{v0} heures", { v0: settings.work.workWeekHours })], [t("Journée"), t("{v0} heures · pause {v1} min", { v0: settings.work.dailyHours, v1: settings.work.breakMinutes })], [t("Arrondi"), settings.work.roundingMinutes ? t("{v0} min", { v0: settings.work.roundingMinutes }) : t("Aucun")], [t("Catégories"), settings.work.costCategories.join(', ')]]} /><ReviewCard title={t("Paie")} onEdit={() => onEdit(4)} rows={[[t("Module"), settings.payroll.enabled ? settings.payroll.fiduciaryValidated ? t("Activé · configuration contrôlée") : t("Activé · validation fiduciaire requise") : t("Désactivé")], [t("Caisse AVS"), settings.payroll.enabled ? settings.payroll.avsFund : '—'], [t("AANP"), settings.payroll.aanpEmployerCoverage?.enabled ? t("Prise en charge employeur · {v0}", { v0: settings.payroll.aanpEmployerCoverage.reference }) : t("Prime salarié par défaut")], [t("LPP"), lppPlan ? t("{v0} · contrat {v1}", { v0: settings.payroll.pensionFund || t('Caisse à confirmer'), v1: lppPlan.contractNumber || t('à compléter') }) : t("Règlement non configuré")], [t("Taux saisis"), settings.payroll.enabled ? t("{v0} salarié · {v1} employeur", { v0: settings.payroll.employeeRates.length, v1: settings.payroll.employerRates.length }) : t("Aucun")]]} /><ReviewCard title={t("Données")} onEdit={() => onEdit(5)} rows={[[t("Stockage"), isMobileRuntime() ? t("Uniquement sur cet appareil") : t("Uniquement sur cet ordinateur")], [t("Sauvegarde"), t("Manuelle, à votre initiative")], [t("Dossier"), isMobileRuntime() ? t("Choisi au moment du partage") : settings.backup.folder]]} /></div>
      <div className="zero-data"><Check size={19} /><div><strong>{t("Démarrage propre confirmé")}</strong><p>{t("0 client · 0 projet · 0 devis · 0 facture · 0 salarié · 0 montant simulé")}</p></div></div>
    </div>
  );
}

function ReviewCard({ title, rows, onEdit }: { title: string; rows: Array<[string, string]>; onEdit: () => void }) {
  return <section className="review-card"><header><h3>{title}</h3><button type="button" onClick={onEdit}>{t("Modifier ")}<ArrowRight size={13} /></button></header><dl>{rows.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}</dl></section>;
}

function ValidationSummary({ issues, onSelect }: { issues: OnboardingIssue[]; onSelect: (issue: OnboardingIssue) => void }) {
  return (
    <section className="validation-summary" role="alert" aria-live="polite">
      <span><AlertCircle size={20} /></span>
      <div>
        <strong>{issues.length === 1 ? t("Une information doit être corrigée") : t('{count} informations doivent être corrigées', { count: issues.length })}</strong>
        <p>{t("Votre brouillon est conservé. Sélectionnez un problème pour aller directement au champ.")}</p>
        <div>{issues.map((issue, index) => <button type="button" key={`${issue.field}-${index}`} onClick={() => onSelect(issue)}><span>{t(issue.label)}</span><small>{setupIssueText(issue)}</small><ArrowRight size={14} /></button>)}</div>
      </div>
    </section>
  );
}

function DatabaseIcon({ size = 20 }: { size?: number }) {
  return <Database size={size} />;
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, ChevronDown, FolderOpen, LoaderCircle, Save, Users } from 'lucide-react';
import { desktopApi, type CloudAccountState } from './bridge';
import type { AppSettings, NogaCatalog, PayrollRate, Workspace } from './types';
import { t, useAppLanguage, appLanguages, languageNames, setAppLanguage, type AppLanguage } from './language';
import { setAppearance, useAppearance, type Appearance } from './appearance';
import { BrandWordmark } from './BrandMark';
import { OnboardingIntro } from './OnboardingIntro';
import { CompanyLogo } from './CompanyLogo';
import { CloudAccountPanel } from './CloudAccountPanel';
import { CloudBackupPanel } from './CloudBackupPanel';
import { JoinCompany } from './JoinCompany';
import { ResetRecovery } from './ResetRecovery';
import { LocalAssistantSetup } from './LocalAssistantSetup';
import { AutomationSetup } from './AutomationControls';
import { AssistantHelpButton, useAssistantScreen } from './assistantContext';
import { Button, ErrorPanel } from './ui';
import { createId, errorMessage } from './utils';
import { initialOnboardingSettings } from './onboardingDraft';
import { backendOnboardingIssue, normalizeOnboardingSettings, validateOnboarding, type OnboardingIssue, type OnboardingValidationScope } from './onboardingValidation';
import { setupIssueText } from './setupLanguage';
import { setupPages, setupChapters, setupPageForIssue, enabledSetupPages, parseSetupDraft, onboardingDraftKey, legacyOnboardingDraftKey, type SetupDraft } from './onboardingFlow';
import { StepHeader, IdentityStep, BillingStep, WorkStep, PayrollStep, BackupStep, ConfirmationStep, ValidationSummary, type SettingsSetter } from './OnboardingSteps';

function readDraft() {
  try { return parseSetupDraft(localStorage.getItem(onboardingDraftKey)) ?? parseSetupDraft(localStorage.getItem(legacyOnboardingDraftKey)); }
  catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(onboardingDraftKey); localStorage.removeItem(legacyOnboardingDraftKey); } catch { /* A successful native operation remains valid. */ }
}

export function Onboarding({ onComplete, onRestore, onCloudRestore, cloudAccount, onCloudAccountChange, onJoined, accountNotice }: {
  onComplete: (settings: AppSettings, scope: OnboardingValidationScope) => Promise<void>;
  onRestore: (path: string) => Promise<void>;
  onCloudRestore?: (backupId: string) => Promise<void>;
  cloudAccount?: CloudAccountState | null;
  onCloudAccountChange?: (account: CloudAccountState) => void;
  onJoined?: (workspace: Workspace) => void;
  accountNotice?: ReactNode;
}) {
  const language = useAppLanguage();
  const appearance = useAppearance();
  const [draft] = useState(readDraft);
  const [step, setStep] = useState(draft?.step ?? 0);
  const [highestStep, setHighestStep] = useState(draft?.highestStep ?? 0);
  const [settings, updateSettings] = useState<AppSettings>(() => draft?.settings ?? structuredClone(initialOnboardingSettings));
  const [categoriesText, setCategoriesText] = useState(draft?.categoriesText ?? '');
  const [vatText, setVatText] = useState(draft?.vatText ?? '');
  const [privacyConfirmed, setPrivacyConfirmed] = useState(draft?.privacyConfirmed ?? false);
  const [joining, setJoining] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savePhase, setSavePhase] = useState('');
  const [draftStatus, setDraftStatus] = useState<'saving'|'saved'|'failed'>('saved');
  const [backendIssues, setBackendIssues] = useState<OnboardingIssue[]>([]);
  const [validatedPages, setValidatedPages] = useState<number[]>([]);
  const [catalog, setCatalog] = useState<NogaCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const submitting = useRef(false);
  const completed = useRef(false);
  const mounted = useRef(true);
  const stageRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const direction = useRef<'forward'|'back'>('forward');
  const latestDraft = useRef<SetupDraft>(null!);
  latestDraft.current = { version:2, step, highestStep, settings, categoriesText, vatText, privacyConfirmed };
  const setSettings: SettingsSetter = useCallback(value => { setError(''); setBackendIssues([]); updateSettings(value); }, []);
  const pages = enabledSetupPages(settings);
  const page = setupPages[step];
  const position = pages.indexOf(step);
  const allIssues = useMemo(() => validateOnboarding(settings, catalog, privacyConfirmed), [settings, catalog, privacyConfirmed]);
  const visibleIssues = [...allIssues.filter(issue => validatedPages.includes(setupPageForIssue(issue))), ...backendIssues];
  const currentIssues = visibleIssues.filter(issue => setupPageForIssue(issue) === step);
  const issueMap = Object.fromEntries(currentIssues.map(issue => [issue.field, setupIssueText(issue)]));
  useAssistantScreen({screen:`Configuration · ${page.label}`,scope:'configuration',facts:{'Étape':page.label,'Canton':settings.organization.address.canton,'Points à corriger':currentIssues.map(issue=>issue.message).join(' ; ').slice(0,700)}});

  const loadCatalog = useCallback(async () => {
    setCatalogError('');
    try { setCatalog(await desktopApi.getNogaCatalog()); }
    catch (reason) { setCatalogError(errorMessage(reason,'Le catalogue NOGA 2025 local n’a pas pu être chargé.')); }
  }, []);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  // Debounce typing, flush before suspension, never resurrect a completed draft.
  useEffect(() => {
    setDraftStatus('saving');
    const timer = window.setTimeout(() => {
      if (completed.current) return;
      try { localStorage.setItem(onboardingDraftKey, JSON.stringify(latestDraft.current)); setDraftStatus('saved'); }
      catch { setDraftStatus('failed'); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settings, step, highestStep, categoriesText, vatText, privacyConfirmed]);
  useEffect(() => {
    mounted.current = true;
    const flush = () => {
      if (completed.current) return;
      try { localStorage.setItem(onboardingDraftKey, JSON.stringify(latestDraft.current)); } catch { /* The next write reports storage failure. */ }
    };
    const suspend = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', suspend);
    return () => { mounted.current = false; flush(); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', suspend); };
  }, []);

  const focusField = useCallback((field: string) => {
    const root = stageRef.current;
    const target = Array.from(root?.querySelectorAll<HTMLElement>('[data-field]') ?? []).find(node => node.dataset.field === field);
    const action = Array.from(root?.querySelectorAll<HTMLElement>('[data-field-action]') ?? []).find(node => node.dataset.fieldAction === field);
    const fallback = action?.querySelector<HTMLElement>('button, input, select, textarea');
    const focusable = target && !(target as HTMLInputElement).disabled ? target : fallback ?? target;
    let parent = focusable?.parentElement;
    while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    focusable?.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    focusable?.focus({preventScroll:true});
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (pendingFocus.current) { focusField(pendingFocus.current); pendingFocus.current = null; }
      else {
        if (step !== 0) stageRef.current?.querySelector<HTMLElement>('h1')?.focus({preventScroll:true});
        document.querySelector('.first-run__main')?.scrollTo({top:0});
        window.scrollTo({top:0});
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [step, focusField]);
  function goTo(target: number) {
    if (busy) return;
    direction.current = target < step ? 'back' : 'forward';
    setMenuOpen(false); setError(''); setStep(target); setHighestStep(value => Math.max(value,target));
  }
  function focusIssue(issue: OnboardingIssue) {
    const target = setupPageForIssue(issue);
    if (target === step) requestAnimationFrame(() => focusField(issue.field));
    else { pendingFocus.current = issue.field; goTo(target); }
  }
  function next() {
    if (busy) return;
    setValidatedPages(values => Array.from(new Set([...values, step])));
    const issues = allIssues.filter(issue => setupPageForIssue(issue) === step);
    if (issues.length) { focusIssue(issues[0]); return; }
    setBackendIssues(values => values.filter(issue => setupPageForIssue(issue) !== step));
    goTo(pages[Math.min(position + 1, pages.length - 1)]);
  }
  async function restore() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const path = await desktopApi.chooseRestoreFile();
      if (!path || !window.confirm(t('La sauvegarde choisie sera contrôlée avant de remplacer les données locales. Continuer ?'))) return;
      await onRestore(path); completed.current = true; clearDraft();
    } catch (reason) { setError(errorMessage(reason,'La restauration n’a pas pu être lancée.')); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function finish() {
    if (submitting.current) return;
    const normalized = normalizeOnboardingSettings(settings);
    setValidatedPages(pages); setBackendIssues([]);
    const issues = validateOnboarding(normalized,catalog,privacyConfirmed,'complete');
    if (issues.length) { focusIssue(issues[0]); return; }
    submitting.current = true; setBusy(true); setError('');
    try {
      setSavePhase('Vérification de vos réglages…');
      const result = await desktopApi.validateOnboarding(normalized,'complete');
      if (!mounted.current) return;
      if (!result.valid) {
        const serverIssues = result.issues.map(issue => ({...issue,step:Number(issue.step)}));
        setBackendIssues(serverIssues);
        if (serverIssues[0]) {
          const target = setupPageForIssue(serverIssues[0]); pendingFocus.current = serverIssues[0].field;
          setStep(target); setHighestStep(value=>Math.max(value,target));
        } else setError(t('La vérification n’a pas abouti. Réessayez. Votre brouillon est conservé.'));
        return;
      }
      setSavePhase('Création de votre espace…');
      await onComplete(normalized,'complete');
      completed.current = true; clearDraft();
    } catch (reason) {
      const message = errorMessage(reason,'La configuration n’a pas pu être enregistrée.');
      const issue = backendOnboardingIssue(message);
      if (issue) { setBackendIssues([issue]); pendingFocus.current = issue.field; setStep(setupPageForIssue(issue)); }
      setError(message);
    } finally { submitting.current = false; setBusy(false); setSavePhase(''); }
  }
  const rateActions = {
    addRate: (target:'employeeRates'|'employerRates') => setSettings(current=>({...current,payroll:{...current.payroll,[target]:[...current.payroll[target],{id:createId(),label:'',rateBp:0,effectiveFrom:''}]}})),
    updateRate: (target:'employeeRates'|'employerRates', id:string, patch:Partial<PayrollRate>) => setSettings(current=>({...current,payroll:{...current.payroll,[target]:current.payroll[target].map(rate=>rate.id===id?{...rate,...patch}:rate)}})),
    removeRate: (target:'employeeRates'|'employerRates',id:string) => setSettings(current=>({...current,payroll:{...current.payroll,[target]:current.payroll[target].filter(rate=>rate.id!==id)}})),
  };
  const joined = (workspace:Workspace) => { completed.current = true; clearDraft(); onJoined?.(workspace); setJoining(false); };
  const chapterPages = pages.filter(index => setupPages[index].chapter === page.chapter);

  const preferences = <header className="first-run__preferences">
        <label><span className="sr-only">{t('Langue de l’application')}</span><select value={language} onChange={event=>setAppLanguage(event.target.value as AppLanguage)}>{appLanguages.map(value=><option key={value} value={value}>{languageNames[value]}</option>)}</select></label>
        <label><span className="sr-only">{t('Apparence')}</span><select value={appearance} onChange={event=>setAppearance(event.target.value as Appearance)}><option value="system">{t('Automatique')}</option><option value="light">{t('Clair')}</option><option value="dark">{t('Sombre')}</option></select></label>
      </header>;
  if (step === 0) return <div className="first-run first-run--welcome">
    {preferences}
    <section className="first-run__stage first-run__stage--welcome" ref={stageRef}>
      <OnboardingIntro onStart={next}/>
    </section>
  </div>;
  const guideCopy = [
    ['Un espace à vous.', 'Retrouvez votre entreprise. Ou préparez son premier jour.'],
    ['Faisons connaissance.', 'Votre identité, pour des documents qui vous ressemblent.'],
    ['Prêt à facturer.', 'Des documents clairs. Des paiements bien organisés.'],
    ['Votre façon de travailler.', 'Quelques réglages pour suivre votre quotidien.'],
    ['Prenons soin de votre équipe.', 'Vos assurances et vos cotisations, réunies au même endroit.'],
    ['Tout reste entre de bonnes mains.', 'Choisissez comment protéger votre travail.'],
    ['Bientôt chez vous.', 'Un dernier regard, et votre espace est prêt.'],
  ][page.chapter];
  return <div className={`first-run${step === 1 ? ' first-run--account' : ''}`}>
    <aside className={`first-run__guide${menuOpen ? ' is-open' : ''}`}>
      <div className="first-run__brand"><BrandWordmark/>{step!==1 && <AssistantHelpButton compact/>}</div>
      <button className="first-run__mobile-index" type="button" aria-expanded={menuOpen} aria-controls="first-run-index" onClick={()=>setMenuOpen(value=>!value)}><span>{t(setupChapters[page.chapter])}</span><span>{page.chapter+1} / {setupChapters.length}<ChevronDown size={16}/></span></button>
      <div className="first-run__guidance"><p>{t(guideCopy[0])}</p><span>{t(guideCopy[1])}</span></div>
      <nav id="first-run-index" className="first-run__index" aria-label={t('Étapes de configuration')}>
        {setupChapters.map((label,chapter) => {
          const members = pages.filter(index=>setupPages[index].chapter === chapter), start = members[0];
          const done = highestStep > members[members.length-1] && !allIssues.some(issue=>members.includes(setupPageForIssue(issue)));
          const attention = visibleIssues.some(issue=>members.includes(setupPageForIssue(issue)));
          return <button key={label} type="button" aria-current={chapter===page.chapter?'step':undefined} disabled={busy || start>highestStep} onClick={()=>goTo(start)}><span className="first-run__step-mark">{attention ? <AlertCircle size={17}/> : done ? <Check size={17}/> : chapter+1}</span><span>{t(label)}</span></button>;
        })}
      </nav>
      <div className="first-run__guide-bottom">
        {settings.organization.legalName && <div className="first-run__company">{settings.organization.logoPath && <CompanyLogo path={settings.organization.logoPath} alt=""/>}<span>{settings.organization.legalName}</span></div>}
        <p className={`first-run__draft${draftStatus==='failed'?' is-error':''}`} role={draftStatus==='failed'?'alert':undefined}>{draftStatus==='failed'?<AlertCircle size={15}/>:draftStatus==='saved'?<Check size={15}/>:<Save size={15}/>}<span>{t(draftStatus==='failed'?'Brouillon non enregistré. Gardez l’app ouverte.':draftStatus==='saved'?'Brouillon enregistré sur cet appareil':'Enregistrement…')}</span></p>
      </div>
    </aside>
    <main className="first-run__main">
      {preferences}
      <div className="first-run__paper">
        {step>0 && <div className="first-run__progress"><span>{t(page.label)}</span><span>{chapterPages.indexOf(step)+1} / {chapterPages.length}</span><progress max={chapterPages.length} value={chapterPages.indexOf(step)+1} aria-label={`${t('Progression de la configuration')} · ${t(setupChapters[page.chapter])}`}/></div>}
        <section ref={stageRef} className={`first-run__stage first-run__stage--${page.id}`} key={step} data-direction={direction.current} aria-busy={busy}>
          <fieldset className="first-run__fields" disabled={busy}>
            {page.id==='account' && <>
              <StepHeader title={t('Tout commence avec vous.')} text={t('Retrouvez votre entreprise sur tous vos appareils avec votre compte Zentra.')}/>
              <CloudAccountPanel onAccountChange={onCloudAccountChange} joining setup/>
              {accountNotice && <details className="first-run__license"><summary>{t('Compte et licence')}</summary>{accountNotice}</details>}
              <div className="first-run__recovery"><button type="button" onClick={()=>setJoining(true)}><Users size={18}/>{t('J’ai une invitation')}<ArrowRight size={17}/></button>
                <details><summary>{t('Reprendre une sauvegarde')}</summary><Button variant="secondary" onClick={()=>void restore()}><FolderOpen size={17}/>{t('Choisir un fichier .zentra')}</Button>
                  {onJoined && <ResetRecovery onRestored={joined}/>}
                  {cloudAccount?.status==='connected' && onCloudRestore && <CloudBackupPanel recoveryOnly disabled={busy} onBusyChange={setBusy} onRestore={async id=>{await onCloudRestore(id);completed.current=true;clearDraft();}}/>}
                </details>
              </div>
            </>}
            {(['identity','address','activity','tax'] as string[]).includes(page.id) && <IdentityStep part={page.id as 'identity'|'address'|'activity'|'tax'} settings={settings} setSettings={setSettings} catalog={catalog} catalogError={catalogError} onRetryCatalog={()=>void loadCatalog()} issues={issueMap}/>}
            {(page.id==='bank'||page.id==='documents') && <BillingStep part={page.id} settings={settings} setSettings={setSettings} vatText={vatText} setVatText={setVatText} issues={issueMap}/>}
            {page.id==='work' && <WorkStep settings={settings} setSettings={setSettings} categoriesText={categoriesText} setCategoriesText={setCategoriesText} issues={issueMap}/>}
            {(page.id==='payroll'||page.id==='insurance'||page.id==='contributions') && <PayrollStep part={page.id} settings={settings} setSettings={setSettings} {...rateActions} issues={issueMap}/>}
            {page.id==='backup' && <BackupStep settings={settings} setSettings={setSettings} privacyConfirmed={privacyConfirmed} setPrivacyConfirmed={setPrivacyConfirmed} issues={issueMap} onError={setError}/>}
            {page.id==='assistants' && <><StepHeader title={t('Un coup de main, à votre façon.')} text={t('Choisissez les aides utiles à votre entreprise. Ces options restent facultatives.')}/><AutomationSetup/><details className="first-run__local-assistant"><summary>{t('Installer un assistant sur cet appareil')}</summary><LocalAssistantSetup onboarding/></details></>}
            {page.id==='review' && <ConfirmationStep settings={settings} onEdit={goTo}/>}
          </fieldset>
          {currentIssues.length>0 && <ValidationSummary issues={currentIssues} onSelect={focusIssue}/>}
          {error && !currentIssues.length && <ErrorPanel title={t('Reprenons ce point ensemble')} message={error}/>}
          {busy && savePhase && <p className="first-run__saving" role="status"><LoaderCircle size={20} className="spin"/>{t(savePhase)}</p>}
        </section>
        <footer className="first-run__actions">
          {step>0 && <Button variant="ghost" onClick={()=>goTo(pages[Math.max(0,position-1)])} disabled={busy}><ArrowLeft size={17}/>{t('Retour')}</Button>}
          <Button size="large" disabled={busy} onClick={()=>page.id==='review'?void finish():next()}>{busy?<LoaderCircle size={18} className="spin"/>:null}{t(busy?'Enregistrement…':page.id==='review'?'Créer mon espace':page.id==='account'?'Créer une entreprise':'Continuer')}{!busy && <ArrowRight size={18}/>}</Button>
        </footer>
        {page.id==='account' && cloudAccount?.status!=='connected' && <p className="first-run__footnote">{t('Vous débutez ? Configurez votre entreprise, puis reliez votre compte.')}</p>}
        {page.id==='account' && <div className="first-run__account-help"><AssistantHelpButton/></div>}
        {draftStatus==='failed' && <p className="first-run__draft-message" role="alert">{t('Brouillon non enregistré. Gardez l’app ouverte.')}</p>}
      </div>
    </main>
    {joining && <JoinCompany onClose={()=>setJoining(false)} onAccountChange={onCloudAccountChange} onJoined={joined}/>}
  </div>;
}

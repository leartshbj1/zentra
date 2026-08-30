import { useEffect, useMemo, useState } from 'react';
import {
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
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { BrandMark } from './BrandMark';
import type { AppSettings, NogaCatalog, NogaSectionCode, PayrollRate } from './types';
import { createId } from './utils';
import { Button, ErrorPanel, Field } from './ui';
import { projectTerminology } from './terminology';

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
    address: { street: '', postalCode: '', city: '', canton: '', country: '' },
  },
  business: { nogaSection: '', nogaDivision: '', activityDescription: '', nogaDetailedCode: '' },
  billing: {
    currency: 'CHF',
    iban: '',
    accountHolder: '',
    quotePrefix: '',
    invoicePrefix: '',
    creditNotePrefix: '',
    nextQuoteNumber: 0,
    nextInvoiceNumber: 0,
    nextCreditNoteNumber: 0,
    paymentTermsDays: 0,
    quoteValidityDays: 0,
    vatRatesBp: [],
    defaultFooter: '',
  },
  work: { workWeekHours: 0, dailyHours: 0, roundingMinutes: -1, breakMinutes: -1, costCategories: [] },
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
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [categoriesText, setCategoriesText] = useState('');
  const [vatText, setVatText] = useState('');
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nogaCatalog, setNogaCatalog] = useState<NogaCatalog | null>(null);
  const [nogaError, setNogaError] = useState('');

  useEffect(() => {
    let active = true;
    void desktopApi.getNogaCatalog()
      .then((catalog) => { if (active) setNogaCatalog(catalog); })
      .catch((reason) => { if (active) setNogaError(reason instanceof Error ? reason.message : 'Le catalogue NOGA 2025 local n’a pas pu être chargé.'); });
    return () => { active = false; };
  }, []);

  const stepValid = useMemo(() => {
    if (step === 1) {
      const org = settings.organization;
      const business = settings.business;
      const detailedCodeValid = !business.nogaDetailedCode || ((business.nogaDetailedCode.length === 3 || business.nogaDetailedCode.length === 4 || business.nogaDetailedCode.length === 6) && /^\d+$/.test(business.nogaDetailedCode) && business.nogaDetailedCode.startsWith(business.nogaDivision));
      const catalogSelectionValid = Boolean(nogaCatalog?.sections.find((section) => section.code === business.nogaSection)?.divisions.some((division) => division.code === business.nogaDivision));
      return Boolean(org.legalName && org.contactName && org.email && org.address.street && org.address.postalCode && org.address.city && org.address.canton && org.address.country && (!org.vatRegistered || org.vatNumber.trim()) && catalogSelectionValid && business.activityDescription.trim() && detailedCodeValid);
    }
    if (step === 2) {
      const billing = settings.billing;
      return Boolean(
        billing.iban &&
          billing.accountHolder &&
          billing.quotePrefix &&
          billing.invoicePrefix &&
          billing.creditNotePrefix &&
          billing.nextQuoteNumber > 0 &&
          billing.nextInvoiceNumber > 0 &&
          billing.nextCreditNoteNumber > 0 &&
          billing.paymentTermsDays > 0 &&
          billing.quoteValidityDays > 0 &&
          (!settings.organization.vatRegistered || billing.vatRatesBp.length > 0),
      );
    }
    if (step === 3) return settings.work.workWeekHours > 0 && settings.work.dailyHours > 0 && settings.work.roundingMinutes >= 0 && settings.work.breakMinutes >= 0 && categoriesText.split(',').some((value) => value.trim());
    if (step === 4 && settings.payroll.enabled) {
      return Boolean(settings.payroll.avsFund && settings.payroll.accidentInsurer && settings.payroll.payrollCanton);
    }
    if (step === 5) {
      return privacyConfirmed && settings.backup.recoveryConfirmed && Boolean(settings.backup.folder);
    }
    return true;
  }, [categoriesText, nogaCatalog, privacyConfirmed, settings, step]);

  function next() {
    setError('');
    if (!stepValid) {
      setError('Complétez les champs obligatoires de cette étape avant de continuer.');
      return;
    }
    setStep((value) => Math.min(steps.length - 1, value + 1));
  }

  async function restore() {
    setError('');
    try {
      const path = await desktopApi.chooseRestoreFile();
      if (!path) return;
      if (!window.confirm('La sauvegarde choisie sera contrôlée avant de remplacer les données locales. Continuer ?')) return;
      setBusy(true);
      await onRestore(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'La restauration n’a pas pu être lancée.');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError('');
    try {
      await onComplete(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'La configuration n’a pas pu être enregistrée.');
    } finally {
      setBusy(false);
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
          {steps.map(({ label, icon: Icon }, index) => (
            <button key={label} type="button" className={index === step ? 'is-current' : index < step ? 'is-done' : ''} onClick={() => index < step && setStep(index)} disabled={index > step}>
              <span>{index < step ? <Check size={15} /> : <Icon size={15} />}</span>
              <em>{label}</em>
            </button>
          ))}
        </nav>
        <p className="onboarding__price"><strong>50 CHF</strong> / mois · données locales</p>
      </aside>

      <main className="onboarding__main">
        <div className="onboarding__content">
          <div className="setup-progress"><span style={{ width: `${(step / (steps.length - 1)) * 100}%` }} /></div>
          {step === 0 ? (
            <SetupIntro onCreate={() => setStep(1)} onRestore={() => void restore()} busy={busy} />
          ) : null}
          {step === 1 ? <IdentityStep settings={settings} setSettings={setSettings} catalog={nogaCatalog} catalogError={nogaError} /> : null}
          {step === 2 ? <BillingStep settings={settings} setSettings={setSettings} vatText={vatText} setVatText={setVatText} /> : null}
          {step === 3 ? <WorkStep settings={settings} setSettings={setSettings} categoriesText={categoriesText} setCategoriesText={setCategoriesText} /> : null}
          {step === 4 ? (
            <PayrollStep settings={settings} setSettings={setSettings} addRate={addRate} updateRate={updateRate} removeRate={removeRate} />
          ) : null}
          {step === 5 ? (
            <BackupStep settings={settings} setSettings={setSettings} privacyConfirmed={privacyConfirmed} setPrivacyConfirmed={setPrivacyConfirmed} />
          ) : null}
          {step === 6 ? <ConfirmationStep settings={settings} /> : null}

          {error ? <ErrorPanel message={error} /> : null}

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
                  {busy ? 'Création de votre espace…' : 'Créer mon espace local'}
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

function IdentityStep({ settings, setSettings, catalog, catalogError }: { settings: AppSettings; setSettings: (value: AppSettings | ((current: AppSettings) => AppSettings)) => void; catalog: NogaCatalog | null; catalogError: string }) {
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
        <Field label="Raison sociale" required wide><input value={org.legalName} onChange={(e) => patch({ legalName: e.target.value })} autoFocus /></Field>
        <Field label="Forme juridique"><input value={org.legalForm} onChange={(e) => patch({ legalForm: e.target.value })} /></Field>
        <Field label="Responsable" required><input value={org.contactName} onChange={(e) => patch({ contactName: e.target.value })} /></Field>
        <Field label="E-mail" required><input type="email" value={org.email} onChange={(e) => patch({ email: e.target.value })} /></Field>
        <Field label="Téléphone"><input value={org.phone} onChange={(e) => patch({ phone: e.target.value })} /></Field>
        <Field label="Rue / case postale" required wide><input value={org.address.street} onChange={(e) => patchAddress({ street: e.target.value })} /></Field>
        <Field label="Numéro de bâtiment"><input value={org.address.buildingNumber ?? ''} onChange={(e) => patchAddress({ buildingNumber: e.target.value })} /></Field>
        <Field label="NPA" required><input value={org.address.postalCode} onChange={(e) => patchAddress({ postalCode: e.target.value })} /></Field>
        <Field label="Localité" required><input value={org.address.city} onChange={(e) => patchAddress({ city: e.target.value })} /></Field>
        <Field label="Canton" required><input value={org.address.canton} onChange={(e) => patchAddress({ canton: e.target.value })} /></Field>
        <Field label="Pays (code ISO, 2 lettres)" required><input value={org.address.country} minLength={2} maxLength={2} onChange={(e) => patchAddress({ country: e.target.value.toUpperCase() })} /></Field>
        <Field label="IDE / UID"><input value={org.uidNumber} onChange={(e) => patch({ uidNumber: e.target.value })} /></Field>
        {org.vatRegistered ? <Field label="Numéro TVA" required><input value={org.vatNumber} onChange={(e) => patch({ vatNumber: e.target.value })} required /></Field> : null}
        <Field label="Site internet"><input type="url" value={org.website} onChange={(e) => patch({ website: e.target.value })} /></Field>
        <label className="check-card field--wide"><input type="checkbox" checked={org.vatRegistered} onChange={(e) => patch({ vatRegistered: e.target.checked })} /><span><strong>Entreprise assujettie à la TVA</strong><small>Les taux seront saisis explicitement à l’étape suivante.</small></span></label>
        <div className="setup-subsection field--wide"><strong>Secteur d’activité · NOGA 2025</strong><p>La section et la division déterminent uniquement les libellés de navigation. Elles ne créent aucune donnée métier.</p></div>
        <Field label="Section NOGA 2025" required wide><select value={business.nogaSection} onChange={(e) => patchBusiness({ nogaSection: e.target.value as NogaSectionCode | '', nogaDivision: '', nogaDetailedCode: '' })} required disabled={!catalog}><option value="">{catalog ? 'Choisir parmi les 22 sections officielles' : 'Chargement du catalogue officiel…'}</option>{catalog?.sections.map((section) => <option key={section.code} value={section.code}>{section.code} · {section.label}</option>)}</select></Field>
        <Field label="Division NOGA 2025" required wide><select value={business.nogaDivision} onChange={(e) => patchBusiness({ nogaDivision: e.target.value, nogaDetailedCode: '' })} required disabled={!selectedSection}><option value="">{selectedSection ? 'Choisir la division officielle' : 'Choisissez d’abord une section'}</option>{selectedSection?.divisions.map((division) => <option key={division.code} value={division.code}>{division.code} · {division.label}</option>)}</select></Field>
        <Field label="Activité précise" hint="Décrivez votre activité réelle; ce texte reste local." required wide><textarea rows={3} maxLength={2000} value={business.activityDescription} onChange={(e) => patchBusiness({ activityDescription: e.target.value })} required /></Field>
        <Field label="Code NOGA détaillé" hint="Facultatif : code numérique à 3, 4 ou 6 chiffres commençant par la division choisie." wide><input inputMode="numeric" pattern={business.nogaDivision ? `${business.nogaDivision}(?:\\d|\\d{2}|\\d{4})` : '\\d{3}|\\d{4}|\\d{6}'} value={business.nogaDetailedCode} onChange={(e) => patchBusiness({ nogaDetailedCode: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
        {catalogError ? <div className="field--wide"><ErrorPanel message={catalogError} /></div> : null}
        <p className="source-note field--wide">Source : <a href={catalog?.source || 'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025'} target="_blank" rel="noreferrer">Office fédéral de la statistique · KUBB NOGA 2025</a>{catalog?.version ? ` · version ${catalog.version}` : ''}</p>
      </div>
    </div>
  );
}

function BillingStep({ settings, setSettings, vatText, setVatText }: { settings: AppSettings; setSettings: (value: AppSettings | ((current: AppSettings) => AppSettings)) => void; vatText: string; setVatText: (value: string) => void }) {
  const billing = settings.billing;
  const patch = (value: Partial<typeof billing>) => setSettings((current) => setDeep(current, 'billing', value));
  function addVat() {
    const parsed = Number(vatText.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed < 0) return;
    patch({ vatRatesBp: [...billing.vatRatesBp, Math.round(parsed * 100)] });
    setVatText('');
  }
  return (
    <div>
      <StepHeader eyebrow="Étape 2 sur 5" title="Facturation suisse" text="Vous décidez des numéros, délais et taux. Elyko n’invente aucune règle comptable." />
      <div className="form-grid setup-form">
        <Field label="IBAN ou QR-IBAN" required wide><input value={billing.iban} onChange={(e) => patch({ iban: e.target.value })} autoFocus /></Field>
        <Field label="Titulaire du compte" required wide><input value={billing.accountHolder} onChange={(e) => patch({ accountHolder: e.target.value })} /></Field>
        <Field label="Préfixe devis" required><input value={billing.quotePrefix} onChange={(e) => patch({ quotePrefix: e.target.value })} /></Field>
        <Field label="Prochain numéro de devis" required><input type="number" min="1" value={billing.nextQuoteNumber || ''} onChange={(e) => patch({ nextQuoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Préfixe factures" required><input value={billing.invoicePrefix} onChange={(e) => patch({ invoicePrefix: e.target.value })} /></Field>
        <Field label="Prochain numéro de facture" required><input type="number" min="1" value={billing.nextInvoiceNumber || ''} onChange={(e) => patch({ nextInvoiceNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Préfixe avoirs" required><input value={billing.creditNotePrefix} onChange={(e) => patch({ creditNotePrefix: e.target.value })} /></Field>
        <Field label="Prochain numéro d’avoir" required><input type="number" min="1" value={billing.nextCreditNoteNumber || ''} onChange={(e) => patch({ nextCreditNoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Délai de paiement (jours)" required><input type="number" min="1" value={billing.paymentTermsDays || ''} onChange={(e) => patch({ paymentTermsDays: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Validité des devis (jours)" required><input type="number" min="1" value={billing.quoteValidityDays || ''} onChange={(e) => patch({ quoteValidityDays: e.target.valueAsNumber || 0 })} /></Field>
        {settings.organization.vatRegistered ? (
          <div className="field field--wide"><span className="field__label">Taux TVA utilisés <em>obligatoire</em></span><div className="inline-entry"><input type="number" min="0" step="0.01" value={vatText} onChange={(e) => setVatText(e.target.value)} aria-label="Taux TVA en pour cent" /><span>%</span><Button type="button" variant="secondary" onClick={addVat}><Plus size={16} /> Ajouter</Button></div><div className="chips">{billing.vatRatesBp.map((rate, index) => <button type="button" key={`${rate}-${index}`} onClick={() => patch({ vatRatesBp: billing.vatRatesBp.filter((_, i) => i !== index) })}>{(rate / 100).toLocaleString('fr-CH')} % <Trash2 size={12} /></button>)}</div></div>
        ) : <div className="info-strip field--wide"><ShieldCheck size={18} /><span>Entreprise indiquée non assujettie : les documents seront établis sans TVA.</span></div>}
        <Field label="Pied de page des documents" wide><textarea rows={3} value={billing.defaultFooter} onChange={(e) => patch({ defaultFooter: e.target.value })} /></Field>
      </div>
    </div>
  );
}

function WorkStep({ settings, setSettings, categoriesText, setCategoriesText }: { settings: AppSettings; setSettings: (value: AppSettings | ((current: AppSettings) => AppSettings)) => void; categoriesText: string; setCategoriesText: (value: string) => void }) {
  const work = settings.work;
  const terminology = projectTerminology(settings.business.nogaSection);
  const patch = (value: Partial<typeof work>) => setSettings((current) => setDeep(current, 'work', value));
  return (
    <div>
      <StepHeader eyebrow="Étape 3 sur 5" title="Temps et coûts réels" text="Ces règles servent au suivi des heures. Les coûts horaires restent définis salarié par salarié." />
      <div className="form-grid setup-form">
        <Field label="Heures par semaine" required><input type="number" min="0.01" step="0.01" value={work.workWeekHours || ''} onChange={(e) => patch({ workWeekHours: e.target.valueAsNumber || 0 })} autoFocus /></Field>
        <Field label="Heures par journée" required><input type="number" min="0.01" step="0.01" value={work.dailyHours || ''} onChange={(e) => patch({ dailyHours: e.target.valueAsNumber || 0 })} /></Field>
        <Field label="Arrondi des pointages" required><select value={work.roundingMinutes < 0 ? '' : work.roundingMinutes} onChange={(e) => patch({ roundingMinutes: Number(e.target.value) })} required><option value="">Choisir la règle</option><option value="0">Aucun arrondi</option><option value="1">À la minute</option><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option></select></Field>
        <Field label="Pause habituelle (minutes)" required><input type="number" min="0" value={work.breakMinutes < 0 ? '' : work.breakMinutes} onChange={(e) => patch({ breakMinutes: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : -1 })} required /></Field>
        <Field label="Catégories de dépenses" hint="Séparez chaque catégorie par une virgule." required wide><textarea rows={3} value={categoriesText} onChange={(e) => { setCategoriesText(e.target.value); patch({ costCategories: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) }); }} /></Field>
      </div>
      <div className="definition-grid"><div><strong>Durée prévue</strong><span>Dates et heures planifiées sur le {terminology.singular}</span></div><div><strong>Durée réelle</strong><span>Dates réelles et heures effectivement saisies</span></div><div><strong>Rentabilité</strong><span>Facturé net moins coûts horaires et dépenses nettes</span></div></div>
    </div>
  );
}

function PayrollStep({ settings, setSettings, addRate, updateRate, removeRate }: { settings: AppSettings; setSettings: (value: AppSettings | ((current: AppSettings) => AppSettings)) => void; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void }) {
  const payroll = settings.payroll;
  const patch = (value: Partial<typeof payroll>) => setSettings((current) => setDeep(current, 'payroll', value));
  return (
    <div>
      <StepHeader eyebrow="Étape 4 sur 5" title="Préparation des salaires" text="Le module est facultatif. Aucun taux social et aucune retenue ne sont estimés par le logiciel." />
      <label className="module-toggle"><input type="checkbox" checked={payroll.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /><span><Users size={22} /><strong>Activer Équipe & salaires</strong><small>Créer des fiches à partir de montants explicitement configurés.</small></span></label>
      {payroll.enabled ? (
        <>
          <div className="warning-card"><ShieldCheck size={21} /><div><strong>Validation professionnelle requise</strong><p>Avant d’utiliser une fiche comme document final, faites contrôler les caisses, assurances et taux par votre fiduciaire.</p></div></div>
          <div className="form-grid setup-form">
            <Field label="Caisse AVS" required><input value={payroll.avsFund} onChange={(e) => patch({ avsFund: e.target.value })} /></Field>
            <Field label="Assureur accidents LAA / UVG" required><input value={payroll.accidentInsurer} onChange={(e) => patch({ accidentInsurer: e.target.value })} /></Field>
            <Field label="Institution LPP / BVG"><input value={payroll.pensionFund} onChange={(e) => patch({ pensionFund: e.target.value })} /></Field>
            <Field label="Assurance IJM / KTG"><input value={payroll.dailyAllowanceInsurer} onChange={(e) => patch({ dailyAllowanceInsurer: e.target.value })} /></Field>
            <Field label="Caisse allocations familiales"><input value={payroll.familyAllowanceFund} onChange={(e) => patch({ familyAllowanceFund: e.target.value })} /></Field>
            <Field label="Canton de paie" required><input value={payroll.payrollCanton} onChange={(e) => patch({ payrollCanton: e.target.value })} /></Field>
          </div>
          <RateEditor title="Retenues salarié" rates={payroll.employeeRates} target="employeeRates" addRate={addRate} updateRate={updateRate} removeRate={removeRate} />
          <RateEditor title="Charges employeur" rates={payroll.employerRates} target="employerRates" addRate={addRate} updateRate={updateRate} removeRate={removeRate} />
          <label className="check-card"><input type="checkbox" checked={payroll.fiduciaryValidated} onChange={(e) => patch({ fiduciaryValidated: e.target.checked })} /><span><strong>Configuration contrôlée par une fiduciaire</strong><small>Sans cette confirmation, les fiches restent marquées incomplètes.</small></span></label>
        </>
      ) : <div className="skipped-module"><Check size={19} /><span>Le module restera masqué. Vous pourrez l’activer plus tard dans Paramètres.</span></div>}
    </div>
  );
}

function RateEditor({ title, rates, target, addRate, updateRate, removeRate }: { title: string; rates: PayrollRate[]; target: 'employeeRates' | 'employerRates'; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void }) {
  return <section className="rate-editor"><header><div><strong>{title}</strong><small>Saisissez seulement les taux confirmés.</small></div><Button type="button" variant="secondary" size="small" onClick={() => addRate(target)}><Plus size={15} /> Ajouter un taux</Button></header>{rates.length ? <div className="rate-list">{rates.map((rate) => <div className="rate-row" key={rate.id}><input aria-label="Libellé" value={rate.label} onChange={(e) => updateRate(target, rate.id, { label: e.target.value })} /><label><input aria-label="Taux en pour cent" type="number" min="0" step="0.001" value={rate.rateBp ? rate.rateBp / 100 : ''} onChange={(e) => updateRate(target, rate.id, { rateBp: Math.round((e.target.valueAsNumber || 0) * 100) })} /><span>%</span></label><input aria-label="Date d’effet" type="date" value={rate.effectiveFrom} onChange={(e) => updateRate(target, rate.id, { effectiveFrom: e.target.value })} /><Button type="button" variant="ghost" size="icon" onClick={() => removeRate(target, rate.id)}><Trash2 size={16} /></Button></div>)}</div> : <p className="rate-empty">Aucun taux saisi. Le logiciel n’effectuera aucune déduction correspondante.</p>}</section>;
}

function BackupStep({ settings, setSettings, privacyConfirmed, setPrivacyConfirmed }: { settings: AppSettings; setSettings: (value: AppSettings | ((current: AppSettings) => AppSettings)) => void; privacyConfirmed: boolean; setPrivacyConfirmed: (value: boolean) => void }) {
  const backup = settings.backup;
  const patch = (value: Partial<typeof backup>) => setSettings((current) => setDeep(current, 'backup', value));
  async function chooseFolder() {
    const path = await desktopApi.chooseBackupFolder();
    if (path) patch({ folder: path });
  }
  return (
    <div>
      <StepHeader eyebrow="Étape 5 sur 5" title="Sauvegarde et confidentialité" text="La base active reste sur ce PC. Une sauvegarde externe protège votre entreprise d’une panne ou d’un vol." />
      <div className="privacy-banner"><DatabaseIcon size={24} /><div><strong>Données métier locales</strong><p>Clients, chantiers ou projets, montants, heures, pièces jointes et salaires ne sont pas envoyés au service d’abonnement.</p></div></div>
      <div className="form-grid setup-form"><Field label="Dossier pour les sauvegardes manuelles" hint="Une sauvegarde ne sera créée que lorsque vous utiliserez le bouton Sauvegarder." required wide><div className="path-picker"><input readOnly value={backup.folder} /><Button type="button" variant="secondary" onClick={() => void chooseFolder()}><FolderOpen size={16} /> Choisir</Button></div></Field></div>
      <div className="confirmation-checks"><label><input type="checkbox" checked={privacyConfirmed} onChange={(e) => setPrivacyConfirmed(e.target.checked)} /><span>J’ai compris que mes données métier restent locales et que je suis responsable de leur sauvegarde.</span></label><label><input type="checkbox" checked={backup.recoveryConfirmed} onChange={(e) => patch({ recoveryConfirmed: e.target.checked })} /><span>Je conserverai au moins une sauvegarde récente dans un emplacement distinct et sûr.</span></label></div>
    </div>
  );
}

function ConfirmationStep({ settings }: { settings: AppSettings }) {
  const org = settings.organization;
  return (
    <div>
      <StepHeader eyebrow="Prêt à démarrer" title="Vérifiez votre configuration" text="Seules les informations ci-dessous seront créées. Toutes les listes métier commenceront vides." />
      <div className="review-grid"><ReviewCard title="Entreprise" rows={[["Raison sociale", org.legalName], ["Responsable", org.contactName], ["Adresse", `${org.address.street}, ${org.address.postalCode} ${org.address.city}`], ["TVA", org.vatRegistered ? 'Assujettie' : 'Non assujettie']]} /><ReviewCard title="Activité" rows={[["Section NOGA", settings.business.nogaSection], ["Division NOGA", settings.business.nogaDivision], ["Activité précise", settings.business.activityDescription], ["Code détaillé", settings.business.nogaDetailedCode || 'Non renseigné']]} /><ReviewCard title="Facturation" rows={[["Compte", settings.billing.iban], ["Numérotation devis", `${settings.billing.quotePrefix} · prochain ${settings.billing.nextQuoteNumber}`], ["Numérotation factures", `${settings.billing.invoicePrefix} · prochain ${settings.billing.nextInvoiceNumber}`], ["Délais", `${settings.billing.paymentTermsDays} jours · devis ${settings.billing.quoteValidityDays} jours`]]} /><ReviewCard title="Temps & paie" rows={[["Semaine", `${settings.work.workWeekHours} heures`], ["Catégories", settings.work.costCategories.join(', ')], ["Paie", settings.payroll.enabled ? settings.payroll.fiduciaryValidated ? 'Activée · configuration contrôlée' : 'Activée · validation requise' : 'Désactivée']]} /><ReviewCard title="Données" rows={[["Stockage", 'Uniquement sur cet ordinateur'], ["Sauvegarde", 'Manuelle, à votre initiative'], ["Dossier", settings.backup.folder]]} /></div>
      <div className="zero-data"><Check size={19} /><div><strong>Démarrage propre confirmé</strong><p>0 client · 0 chantier ou projet · 0 devis · 0 facture · 0 salarié · 0 montant simulé</p></div></div>
    </div>
  );
}

function ReviewCard({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return <section className="review-card"><h3>{title}</h3><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>;
}

function DatabaseIcon({ size = 20 }: { size?: number }) {
  return <Database size={size} />;
}

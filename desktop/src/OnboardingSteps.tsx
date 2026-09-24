import { useState, type Dispatch, type SetStateAction } from 'react';
import { AlertCircle, ArrowRight, BriefcaseBusiness, Building2, Check, Database, FolderOpen, LoaderCircle, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { t, getAppLocale } from './language';
import { nogaLabel } from './nogaLanguage';
import { setupIssueText } from './setupLanguage';
import { PayrollOrganisationField } from './PayrollOrganisationField';
import { CompanyLogo } from './CompanyLogo';
import { desktopApi } from './bridge';
import { isMobileRuntime } from './mobileRuntime';
import type { AppSettings, NogaCatalog, NogaSectionCode, PayrollRate } from './types';
import { errorMessage } from './utils';
import { Button, ErrorPanel, Field } from './ui';
import { normalizeIban, type OnboardingIssue } from './onboardingValidation';
export type SettingsSetter = Dispatch<SetStateAction<AppSettings>>;
export type IssueMap = Record<string, string>;
function setDeep<T extends keyof AppSettings>(settings: AppSettings, section: T, patch: Partial<AppSettings[T]>): AppSettings {
  return { ...settings, [section]: { ...settings[section], ...patch } };
}
export function StepHeader({ title, text }: { eyebrow?: string; title: string; text: string }) {
  return <header className="setup-header"><h1 tabIndex={-1}>{title}</h1><p>{text}</p></header>;
}
export function IdentityStep({ settings, setSettings, catalog, catalogError, onRetryCatalog, issues, part }: { settings: AppSettings; setSettings: SettingsSetter; part: 'identity' | 'address' | 'activity' | 'tax'; catalog: NogaCatalog | null; catalogError: string; onRetryCatalog: () => void; issues: IssueMap }) {
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
      <StepHeader title={t({identity:'Donnons un nom à votre espace.',address:'Où se trouve votre entreprise ?',activity:'Que faites-vous au quotidien ?',tax:'Comment facturez-vous la TVA ?'}[part])} text={t({identity:'Ces informations apparaîtront sur vos documents.',address:'L’adresse utilisée sur vos devis et vos factures.',activity:'Choisissez votre domaine. Zentra adaptera les libellés à votre activité.',tax:'Reprenez la situation actuelle de votre entreprise.'}[part])} />
      <div className="form-grid setup-form">
        {part === 'identity' && <>
        <div
          className={`company-logo-setting onboarding-logo-setting field--wide ${issues['organization.logoPath'] ? 'field--error' : ''}`}
          data-field-action="organization.logoPath"
        >
          <div className="company-logo-setting__preview">{org.logoPath ? <CompanyLogo path={org.logoPath} alt={t('Logo de {name}', { name: org.legalName || t('l’entreprise') })} /> : <Building2 size={30} />}</div>
          <div className="company-logo-setting__copy">
            <strong>{t("Logo de l’entreprise")}</strong>
            <p>{t("Facultatif · PNG, JPEG ou WebP · 8 Mo maximum.")}</p>
            <div className="settings-inline-actions">
              <Button data-field="organization.logoPath" aria-invalid={Boolean(issues['organization.logoPath'])} type="button" variant="secondary" disabled={choosingLogo} onClick={() => void chooseLogo()}>
                {choosingLogo ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} {choosingLogo ? t("Vérification…") : org.logoPath ? t("Remplacer le logo") : t("Choisir le logo")}
              </Button>
              {org.logoPath ? <Button type="button" variant="ghost" disabled={choosingLogo} onClick={() => { setLogoError(''); patch({ logoPath: '' }); }}><Trash2 size={15} />{t(" Retirer")}</Button> : null}
            </div>
            {org.logoPath ? <span className="path-note"><ShieldCheck size={14} />{t(" Copie locale prête pour les documents")}</span> : <span className="path-note">{t("Votre logo sera repris sur vos documents.")}</span>}
          </div>
        </div>
        {logoError || issues['organization.logoPath'] ? <div className="field--wide"><ErrorPanel title={t("Logo non importé")} message={logoError || issues['organization.logoPath']} /></div> : null}
        <Field label={t("Raison sociale")} required wide error={issues['organization.legalName']}><input data-field="organization.legalName" aria-invalid={Boolean(issues['organization.legalName'])} autoComplete="organization" value={org.legalName} onChange={(e) => patch({ legalName: e.target.value })} /></Field>
        <Field label={t("Forme juridique")}><input value={org.legalForm} onChange={(e) => patch({ legalForm: e.target.value })} /></Field>
        <Field label={t("Responsable")} required error={issues['organization.contactName']}><input data-field="organization.contactName" aria-invalid={Boolean(issues['organization.contactName'])} value={org.contactName} onChange={(e) => patch({ contactName: e.target.value })} /></Field>
        <Field label={t("E-mail")} required error={issues['organization.email']}><input data-field="organization.email" aria-invalid={Boolean(issues['organization.email'])} type="email" value={org.email} onChange={(e) => patch({ email: e.target.value })} /></Field>
        <Field label={t("Téléphone")}><input value={org.phone} onChange={(e) => patch({ phone: e.target.value })} /></Field>
        <Field label={t("Site internet")} error={issues['organization.website']}><input data-field="organization.website" aria-invalid={Boolean(issues['organization.website'])} type="url" placeholder={"https://"} value={org.website} onChange={(e) => patch({ website: e.target.value })} /></Field>
        </>}
        {part === 'address' && <>
        <Field label={t("Rue / case postale")} required wide error={issues['organization.address.street']}><input data-field="organization.address.street" aria-invalid={Boolean(issues['organization.address.street'])} value={org.address.street} onChange={(e) => patchAddress({ street: e.target.value })} /></Field>
        <Field label={t("Numéro de bâtiment")}><input value={org.address.buildingNumber ?? ''} onChange={(e) => patchAddress({ buildingNumber: e.target.value })} /></Field>
        <Field label={t("NPA")} required error={issues['organization.address.postalCode']}><input data-field="organization.address.postalCode" aria-invalid={Boolean(issues['organization.address.postalCode'])} value={org.address.postalCode} onChange={(e) => patchAddress({ postalCode: e.target.value })} /></Field>
        <Field label={t("Localité")} required error={issues['organization.address.city']}><input data-field="organization.address.city" aria-invalid={Boolean(issues['organization.address.city'])} value={org.address.city} onChange={(e) => patchAddress({ city: e.target.value })} /></Field>
        <Field label={t("Canton")} required error={issues['organization.address.canton']}><input data-field="organization.address.canton" aria-invalid={Boolean(issues['organization.address.canton'])} value={org.address.canton} onChange={(e) => patchAddress({ canton: e.target.value })} /></Field>
        <Field label={t("Pays (code ISO, 2 lettres)")} required error={issues['organization.address.country']}><input data-field="organization.address.country" aria-invalid={Boolean(issues['organization.address.country'])} value={org.address.country} minLength={2} maxLength={2} onChange={(e) => patchAddress({ country: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })} /></Field>
        </>}
        {part === 'tax' && <>
        <label className="check-card field--wide"><input type="checkbox" checked={org.vatRegistered} onChange={(e) => patch({ vatRegistered: e.target.checked })} /><span><strong>{t("Entreprise assujettie à la TVA")}</strong><small>{t("Activez si votre entreprise est inscrite au registre TVA.")}</small></span></label>
        <Field label={t("IDE / UID")} error={issues['organization.vatIdentifier']}><input data-field="organization.vatIdentifier" aria-invalid={Boolean(issues['organization.vatIdentifier'])} value={org.uidNumber} onChange={(e) => patch({ uidNumber: e.target.value })} /></Field>
        {org.vatRegistered ? <Field label={t("Numéro TVA")} required error={issues['organization.vatIdentifier']}><input aria-invalid={Boolean(issues['organization.vatIdentifier'])} value={org.vatNumber} onChange={(e) => patch({ vatNumber: e.target.value })} required /></Field> : null}


        </>}
        {part === 'activity' && <>
        <Field label={t("Secteur d’activité")} hint={selectedSection ? nogaLabel(selectedSection.code, selectedSection.label) : undefined} required wide error={issues['business.nogaSection']}><select data-field="business.nogaSection" aria-invalid={Boolean(issues['business.nogaSection'])} value={business.nogaSection} onChange={(e) => patchBusiness({ nogaSection: e.target.value as NogaSectionCode | '', nogaDivision: '', nogaDetailedCode: '' })} required disabled={!catalog}><option value="">{catalog ? t("Choisir parmi les 22 sections officielles") : t("Chargement du catalogue officiel…")}</option>{catalog?.sections.map((section) => <option key={section.code} value={section.code}>{section.code} · {nogaLabel(section.code, section.label)}</option>)}</select></Field>
        <Field label={t("Domaine d’activité")} hint={selectedSection?.divisions.filter(division => division.code === business.nogaDivision).map(division => nogaLabel(division.code, division.label)).join('') || undefined} required wide error={issues['business.nogaDivision']}><select data-field="business.nogaDivision" aria-invalid={Boolean(issues['business.nogaDivision'])} value={business.nogaDivision} onChange={(e) => patchBusiness({ nogaDivision: e.target.value, nogaDetailedCode: '' })} required disabled={!selectedSection}><option value="">{selectedSection ? t("Choisir la division officielle") : t("Choisissez d’abord une section")}</option>{selectedSection?.divisions.map((division) => <option key={division.code} value={division.code}>{division.code} · {nogaLabel(division.code, division.label)}</option>)}</select></Field>
        <Field label={t("Activité précise")} hint={t("Décrivez simplement ce que votre entreprise propose.")} required wide error={issues['business.activityDescription']}><textarea data-field="business.activityDescription" aria-invalid={Boolean(issues['business.activityDescription'])} rows={3} maxLength={2000} value={business.activityDescription} onChange={(e) => patchBusiness({ activityDescription: e.target.value })} required /></Field>
        <Field label={t("Code NOGA détaillé")} hint={t("Facultatif : code numérique à 3, 4 ou 6 chiffres commençant par la division choisie.")} wide error={issues['business.nogaDetailedCode']}><input data-field="business.nogaDetailedCode" aria-invalid={Boolean(issues['business.nogaDetailedCode'])} inputMode="numeric" pattern={business.nogaDivision ? `${business.nogaDivision}(?:\\d|\\d{2}|\\d{4})` : '\\d{3}|\\d{4}|\\d{6}'} value={business.nogaDetailedCode} onChange={(e) => patchBusiness({ nogaDetailedCode: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
        {catalogError ? <div className="field--wide" data-field-action="business.nogaSection"><ErrorPanel title={t("Catalogue NOGA indisponible")} message={catalogError} onRetry={onRetryCatalog} /></div> : null}
        <p className="source-note field--wide">{t("Source : ")}<a href={catalog?.source || 'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025'} target="_blank" rel="noreferrer">{t("Office fédéral de la statistique · KUBB NOGA 2025")}</a>{catalog?.version ? t(" · version {v0}", { v0: catalog.version }) : ''}</p>
        </>}
      </div>
    </div>
  );
}

export function BillingStep({ settings, setSettings, vatText, setVatText, issues, part }: { settings: AppSettings; setSettings: SettingsSetter; vatText: string; setVatText: (value: string) => void; issues: IssueMap; part: 'bank' | 'documents' }) {
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
      <StepHeader title={t(part === "bank" ? "Sur quel compte serez-vous payé ?" : "Des documents à votre façon.")} text={t(part === "bank" ? "Copiez les coordonnées indiquées par votre banque." : "Vérifiez les délais et la numérotation proposés, puis adaptez-les si besoin.")} />
      <div className="form-grid setup-form">
        {part === 'bank' && <>
        <Field label={t("IBAN ou QR-IBAN")} hint={t("IBAN suisse ou liechtensteinois · les espaces sont acceptés.")} required wide error={issues['billing.iban']}><input data-field="billing.iban" aria-invalid={Boolean(issues['billing.iban'])} value={billing.iban} onChange={(e) => patch({ iban: e.target.value.toUpperCase() })} onBlur={() => patch({ iban: normalizeIban(billing.iban) })}  /></Field>
        <Field label={t("Titulaire du compte")} required wide error={issues['billing.accountHolder']}><input data-field="billing.accountHolder" aria-invalid={Boolean(issues['billing.accountHolder'])} value={billing.accountHolder} onChange={(e) => patch({ accountHolder: e.target.value })} /></Field>
        </>}
        {part === 'documents' && <>
        <Field label={t("Délai de paiement (jours)")} required error={issues['billing.paymentTermsDays']}><input data-field="billing.paymentTermsDays" aria-invalid={Boolean(issues['billing.paymentTermsDays'])} type="number" min="1" max="365" step="1" value={billing.paymentTermsDays || ''} onChange={(e) => patch({ paymentTermsDays: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Validité des devis (jours)")} required error={issues['billing.quoteValidityDays']}><input data-field="billing.quoteValidityDays" aria-invalid={Boolean(issues['billing.quoteValidityDays'])} type="number" min="1" max="365" step="1" value={billing.quoteValidityDays || ''} onChange={(e) => patch({ quoteValidityDays: e.target.valueAsNumber || 0 })} /></Field>
        {settings.organization.vatRegistered ? (
          <div className={`field field--wide ${issues['billing.vatRatesBp'] ? 'field--error' : ''}`}><span className="field__label">{t("Taux TVA utilisés ")}<em>{t("obligatoire")}</em></span><div className="inline-entry"><input data-field="billing.vatRatesBp" aria-invalid={Boolean(issues['billing.vatRatesBp'])} type="number" min="0.01" max="100" step="0.01" value={vatText} onChange={(e) => setVatText(e.target.value)} aria-label={t("Taux TVA en pour cent")} /><span>%</span><Button type="button" variant="secondary" onClick={addVat}><Plus size={16} />{t(" Ajouter")}</Button></div><div className="chips">{billing.vatRatesBp.map((rate, index) => <button type="button" key={`${rate}-${index}`} onClick={() => patch({ vatRatesBp: billing.vatRatesBp.filter((_, i) => i !== index) })}>{(rate / 100).toLocaleString(getAppLocale())} % <Trash2 size={12} /></button>)}</div>{issues['billing.vatRatesBp'] ? <span className="field__error" role="alert">{issues['billing.vatRatesBp']}</span> : null}</div>
        ) : <div className="info-strip field--wide"><ShieldCheck size={18} /><span>{t("Entreprise indiquée non assujettie : les documents seront établis sans TVA.")}</span></div>}
        <details className="first-run__numbering field--wide"><summary>{t('Personnaliser la numérotation')}</summary><div className="form-grid">        <Field label={t("Préfixe devis")} hint={t("Lettres, chiffres ou tirets · 12 caractères max.")} required error={issues['billing.quotePrefix']}><input data-field="billing.quotePrefix" aria-invalid={Boolean(issues['billing.quotePrefix'])} maxLength={12} value={billing.quotePrefix} onChange={(e) => patch({ quotePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label={t("Prochain numéro de devis")} required error={issues['billing.nextQuoteNumber']}><input data-field="billing.nextQuoteNumber" aria-invalid={Boolean(issues['billing.nextQuoteNumber'])} type="number" min="1" step="1" value={billing.nextQuoteNumber || ''} onChange={(e) => patch({ nextQuoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Préfixe factures")} hint={t("Lettres, chiffres ou tirets · 12 caractères max.")} required error={issues['billing.invoicePrefix']}><input data-field="billing.invoicePrefix" aria-invalid={Boolean(issues['billing.invoicePrefix'])} maxLength={12} value={billing.invoicePrefix} onChange={(e) => patch({ invoicePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label={t("Prochain numéro de facture")} required error={issues['billing.nextInvoiceNumber']}><input data-field="billing.nextInvoiceNumber" aria-invalid={Boolean(issues['billing.nextInvoiceNumber'])} type="number" min="1" step="1" value={billing.nextInvoiceNumber || ''} onChange={(e) => patch({ nextInvoiceNumber: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Préfixe avoirs")} hint={t("Lettres, chiffres ou tirets · 12 caractères max.")} required error={issues['billing.creditNotePrefix']}><input data-field="billing.creditNotePrefix" aria-invalid={Boolean(issues['billing.creditNotePrefix'])} maxLength={12} value={billing.creditNotePrefix} onChange={(e) => patch({ creditNotePrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label={t("Prochain numéro d’avoir")} required error={issues['billing.nextCreditNoteNumber']}><input data-field="billing.nextCreditNoteNumber" aria-invalid={Boolean(issues['billing.nextCreditNoteNumber'])} type="number" min="1" step="1" value={billing.nextCreditNoteNumber || ''} onChange={(e) => patch({ nextCreditNoteNumber: e.target.valueAsNumber || 0 })} /></Field>
        </div></details>
        <Field label={t("Pied de page des documents")} wide><textarea rows={3} value={billing.defaultFooter} onChange={(e) => patch({ defaultFooter: e.target.value })} /></Field>
        </>}
      </div>
    </div>
  );
}

export function WorkStep({ settings, setSettings, categoriesText, setCategoriesText, issues }: { settings: AppSettings; setSettings: SettingsSetter; categoriesText: string; setCategoriesText: (value: string) => void; issues: IssueMap }) {
  const work = settings.work;
  const patch = (value: Partial<typeof work>) => setSettings((current) => setDeep(current, 'work', value));
  return (
    <div>
      <StepHeader title={t("Votre rythme de travail.")} text={t("Définissez une semaine habituelle et les catégories de vos achats.")} />
      <div className="form-grid setup-form">
        <Field label={t("Heures par semaine")} required error={issues['work.workWeekHours']}><input data-field="work.workWeekHours" aria-invalid={Boolean(issues['work.workWeekHours'])} type="number" min="0.01" max="168" step="0.01" value={work.workWeekHours || ''} onChange={(e) => patch({ workWeekHours: e.target.valueAsNumber || 0 })}  /></Field>
        <Field label={t("Heures par journée")} required error={issues['work.dailyHours']}><input data-field="work.dailyHours" aria-invalid={Boolean(issues['work.dailyHours'])} type="number" min="0.01" max="24" step="0.01" value={work.dailyHours || ''} onChange={(e) => patch({ dailyHours: e.target.valueAsNumber || 0 })} /></Field>
        <Field label={t("Arrondi des pointages")} required error={issues['work.roundingMinutes']}><select data-field="work.roundingMinutes" aria-invalid={Boolean(issues['work.roundingMinutes'])} value={work.roundingMinutes < 0 ? '' : work.roundingMinutes} onChange={(e) => patch({ roundingMinutes: Number(e.target.value) })} required><option value="">{t("Choisir la règle")}</option><option value="0">{t("Aucun arrondi")}</option><option value="1">{t("À la minute")}</option><option value="5">{t("5 minutes")}</option><option value="10">{t("10 minutes")}</option><option value="15">{t("15 minutes")}</option></select></Field>
        <Field label={t("Pause habituelle (minutes)")} required error={issues['work.breakMinutes']}><input data-field="work.breakMinutes" aria-invalid={Boolean(issues['work.breakMinutes'])} type="number" min="0" max="1440" step="1" value={work.breakMinutes < 0 ? '' : work.breakMinutes} onChange={(e) => patch({ breakMinutes: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : -1 })} required /></Field>
        <Field label={t("Catégories de dépenses")} hint={t("Séparez chaque catégorie par une virgule.")} required wide error={issues['work.costCategories']}><textarea data-field="work.costCategories" aria-invalid={Boolean(issues['work.costCategories'])} rows={3} value={categoriesText} onChange={(e) => { setCategoriesText(e.target.value); patch({ costCategories: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) }); }} /></Field>
      </div>

    </div>
  );
}

export function PayrollStep({ settings, setSettings, addRate, updateRate, removeRate, issues, part }: { settings: AppSettings; setSettings: SettingsSetter; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void; issues: IssueMap; part: 'payroll' | 'insurance' | 'contributions' }) {
  const payroll = settings.payroll;
  const aanpCoverage = payroll.aanpEmployerCoverage ?? { enabled: false, reference: '', effectiveFrom: '', effectiveTo: '' };
  const lppPlan = payroll.lppPlanEvidence;
  const patch = (value: Partial<typeof payroll>) => setSettings((current) => setDeep(current, 'payroll', value));
  const patchAanpCoverage = (value: Partial<typeof aanpCoverage>) => patch({ aanpEmployerCoverage: { ...aanpCoverage, ...value } });
  const patchLppPlan = (value: Partial<NonNullable<typeof lppPlan>>) => patch({ lppPlanEvidence: { contractNumber: '', regulationReference: '', effectiveFrom: '', effectiveTo: '', employerAggregateShareConfirmed: false, ...lppPlan, ...value } });
  return (
    <div>
      <StepHeader title={t({payroll:"Préparez-vous des salaires ?",insurance:"Vos partenaires pour les salaires.",contributions:"Les règles de votre entreprise."}[part])} text={t({payroll:"Activez la paie si vous souhaitez préparer vos fiches dans Zentra.",insurance:"Reprenez les organismes indiqués sur vos contrats.",contributions:"Ajoutez uniquement les conditions et les taux confirmés par vos contrats."}[part])} />
      {part === 'payroll' && <div className="setup-answer-list" role="group" aria-label={t('Équipe et paie')}>
        <button type="button" aria-pressed={payroll.enabled} onClick={() => patch({enabled:true})}><Users size={22}/><span><strong>{t('Oui, je prépare des salaires')}</strong><small>{t('Nous allons configurer vos assurances et cotisations.')}</small></span>{payroll.enabled && <Check size={20}/>}</button>
        <button type="button" aria-pressed={!payroll.enabled} onClick={() => patch({enabled:false})}><BriefcaseBusiness size={22}/><span><strong>{t('Non, je n’utilise pas la paie')}</strong><small>{t('Vous pourrez activer ce module dans les paramètres.')}</small></span>{!payroll.enabled && <Check size={20}/>}</button>
      </div>}
      {payroll.enabled && part !== 'payroll' ? (
        <>
          {part === 'insurance' && <>
          <div className="form-grid setup-form">
            <PayrollOrganisationField kind="avs" required error={issues['payroll.avsFund']} dataField="payroll.avsFund" value={payroll.avsFund} canton={payroll.payrollCanton} onChange={(avsFund) => patch({ avsFund })} />
            <PayrollOrganisationField kind="accident" required error={issues['payroll.accidentInsurer']} dataField="payroll.accidentInsurer" value={payroll.accidentInsurer} onChange={(accidentInsurer) => patch({ accidentInsurer })} />
            <PayrollOrganisationField kind="pension" dataField="payroll.pensionFund" error={issues['payroll.pensionFund']} value={payroll.pensionFund} onChange={(pensionFund) => patch({ pensionFund })} />
            <PayrollOrganisationField kind="daily" value={payroll.dailyAllowanceInsurer} onChange={(dailyAllowanceInsurer) => patch({ dailyAllowanceInsurer })} />
            <PayrollOrganisationField kind="family" value={payroll.familyAllowanceFund} canton={payroll.payrollCanton} onChange={(familyAllowanceFund) => patch({ familyAllowanceFund })} />
            <Field label={t("Canton de paie")} required error={issues['payroll.payrollCanton']}><input data-field="payroll.payrollCanton" aria-invalid={Boolean(issues['payroll.payrollCanton'])} value={payroll.payrollCanton} onChange={(e) => patch({ payrollCanton: e.target.value })} /></Field>
          </div>
          </>}
          {part === 'contributions' && <>
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
          </>}
        </>
      ) : null}
    </div>
  );
}

function RateEditor({ title, rates, target, addRate, updateRate, removeRate, issues }: { title: string; rates: PayrollRate[]; target: 'employeeRates' | 'employerRates'; addRate: (target: 'employeeRates' | 'employerRates') => void; updateRate: (target: 'employeeRates' | 'employerRates', id: string, patch: Partial<PayrollRate>) => void; removeRate: (target: 'employeeRates' | 'employerRates', id: string) => void; issues: IssueMap }) {
  return <section className="rate-editor"><header><div><strong>{title}</strong><small>{t("Saisissez seulement les taux confirmés.")}</small></div><Button type="button" variant="secondary" size="small" onClick={() => addRate(target)}><Plus size={15} />{t(" Ajouter un taux")}</Button></header>{rates.length ? <div className="rate-list">{rates.map((rate) => { const prefix = `payroll.${target}.${rate.id}`; return <div className="rate-row" key={rate.id}><div className="rate-control"><input data-field={`${prefix}.label`} aria-invalid={Boolean(issues[`${prefix}.label`])} aria-label={t("Libellé")} placeholder={t("Libellé")} maxLength={200} value={rate.label} onChange={(e) => updateRate(target, rate.id, { label: e.target.value })} />{issues[`${prefix}.label`] ? <small>{issues[`${prefix}.label`]}</small> : null}</div><div className="rate-control"><label><input data-field={`${prefix}.rateBp`} aria-invalid={Boolean(issues[`${prefix}.rateBp`])} aria-label={t("Taux en pour cent")} type="number" min="0.01" max="100" step="0.01" value={rate.rateBp ? rate.rateBp / 100 : ''} onChange={(e) => updateRate(target, rate.id, { rateBp: Math.round((e.target.valueAsNumber || 0) * 100) })} /><span>%</span></label>{issues[`${prefix}.rateBp`] ? <small>{issues[`${prefix}.rateBp`]}</small> : null}</div><div className="rate-control"><input data-field={`${prefix}.effectiveFrom`} aria-invalid={Boolean(issues[`${prefix}.effectiveFrom`])} aria-label={t("Date d’effet")} type="date" value={rate.effectiveFrom} onChange={(e) => updateRate(target, rate.id, { effectiveFrom: e.target.value })} />{issues[`${prefix}.effectiveFrom`] ? <small>{issues[`${prefix}.effectiveFrom`]}</small> : null}</div><Button type="button" variant="ghost" size="icon" aria-label={t("Supprimer le taux {v0}", { v0: rate.label || t('sans libellé') })} onClick={() => removeRate(target, rate.id)}><Trash2 size={16} /></Button></div>; })}</div> : <p className="rate-empty">{t("Aucun taux saisi. Le logiciel n’effectuera aucune déduction correspondante.")}</p>}</section>;
}

export function BackupStep({ settings, setSettings, privacyConfirmed, setPrivacyConfirmed, issues, onError }: { settings: AppSettings; setSettings: SettingsSetter; privacyConfirmed: boolean; setPrivacyConfirmed: (value: boolean) => void; issues: IssueMap; onError: (message: string) => void }) {
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
      <StepHeader eyebrow={t("Étape 5 sur 5")} title={t("Sauvegarde et confidentialité")} text={isMobileRuntime() ? t("Vos copies de sécurité pourront être enregistrées avec le menu de partage de votre appareil.") : t("Choisissez où conserver une copie de sécurité de votre entreprise.")} />
      <div className="privacy-banner"><DatabaseIcon size={24} /><div><strong>{t("Données métier locales")}</strong><p>{t("Une copie de travail est conservée sur cet appareil. Avec un compte relié, votre espace est aussi partagé avec les appareils et collaborateurs autorisés.")}</p></div></div>
      {isMobileRuntime() ? <div className="privacy-banner"><FolderOpen size={24} /><div><strong>{t("Enregistrer ou partager une sauvegarde")}</strong><p>{t("Depuis les paramètres, créez une sauvegarde puis choisissez Fichiers, votre espace cloud ou une application compatible. Aucun dossier système n’est à configurer ici.")}</p></div></div> : <div className="form-grid setup-form"><Field label={t("Dossier pour les sauvegardes manuelles")} hint={t("Une sauvegarde ne sera créée que lorsque vous utiliserez le bouton Sauvegarder.")} required wide error={issues['backup.folder']}><div className="path-picker"><input aria-invalid={Boolean(issues['backup.folder'])} readOnly value={backup.folder} /><Button data-field="backup.folder" type="button" variant="secondary" disabled={choosing} onClick={() => void chooseFolder()}>{choosing ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} {choosing ? t("Ouverture…") : t("Choisir")}</Button></div></Field></div>}
      <div className="confirmation-checks"><label className={issues['backup.privacyConfirmed'] ? 'has-error' : ''}><input data-field="backup.privacyConfirmed" aria-invalid={Boolean(issues['backup.privacyConfirmed'])} type="checkbox" checked={privacyConfirmed} onChange={(e) => setPrivacyConfirmed(e.target.checked)} /><span>{t("J’ai compris le stockage sur cet appareil et la synchronisation lorsque mon compte est relié.")}{issues['backup.privacyConfirmed'] ? <small>{issues['backup.privacyConfirmed']}</small> : null}</span></label><label className={issues['backup.recoveryConfirmed'] ? 'has-error' : ''}><input data-field="backup.recoveryConfirmed" aria-invalid={Boolean(issues['backup.recoveryConfirmed'])} type="checkbox" checked={backup.recoveryConfirmed} onChange={(e) => patch({ recoveryConfirmed: e.target.checked })} /><span>{t("Je conserverai au moins une sauvegarde récente dans un emplacement distinct et sûr.")}{issues['backup.recoveryConfirmed'] ? <small>{issues['backup.recoveryConfirmed']}</small> : null}</span></label></div>
    </div>
  );
}

export function ConfirmationStep({ settings, onEdit }: { settings: AppSettings; onEdit: (step: number) => void }) {
  const org = settings.organization;
  const lppPlan = settings.payroll.lppPlanEvidence;
  return (
    <div>
      <StepHeader eyebrow={t("Profil initial")} title={t("Vérifiez votre configuration")} text={t("Tout est réuni. Relisez vos choix avant de créer votre espace.")} />
      <div className="review-grid"><ReviewCard title={t("Entreprise")} onEdit={() => onEdit(2)} rows={[[t("Raison sociale"), org.legalName], [t("Responsable"), org.contactName], [t("Adresse"), `${org.address.street}${org.address.buildingNumber ? ` ${org.address.buildingNumber}` : ''}, ${org.address.postalCode} ${org.address.city}`], [t("Logo"), org.logoPath ? t("Copie locale configurée") : t("Non configuré")], [t("TVA"), org.vatRegistered ? t("Assujettie · {v0}", { v0: org.vatNumber || org.uidNumber }) : t("Non assujettie")]]} /><ReviewCard title={t("Activité")} onEdit={() => onEdit(4)} rows={[[t("Section NOGA"), settings.business.nogaSection], [t("Division NOGA"), settings.business.nogaDivision], [t("Activité précise"), settings.business.activityDescription], [t("Code détaillé"), settings.business.nogaDetailedCode || t("Non renseigné")]]} /><ReviewCard title={t("Facturation")} onEdit={() => onEdit(6)} rows={[[t("Compte"), settings.billing.iban], [t("Numérotation devis"), t("{v0} · prochain {v1}", { v0: settings.billing.quotePrefix, v1: settings.billing.nextQuoteNumber })], [t("Numérotation factures"), t("{v0} · prochain {v1}", { v0: settings.billing.invoicePrefix, v1: settings.billing.nextInvoiceNumber })], [t("TVA"), settings.billing.vatRatesBp.length ? settings.billing.vatRatesBp.map((rate) => `${(rate / 100).toLocaleString(getAppLocale())} %`).join(', ') : t("Sans TVA")], [t("Délais"), t("{v0} jours · devis {v1} jours", { v0: settings.billing.paymentTermsDays, v1: settings.billing.quoteValidityDays })]]} /><ReviewCard title={t("Temps & coûts")} onEdit={() => onEdit(8)} rows={[[t("Semaine"), t("{v0} heures", { v0: settings.work.workWeekHours })], [t("Journée"), t("{v0} heures · pause {v1} min", { v0: settings.work.dailyHours, v1: settings.work.breakMinutes })], [t("Arrondi"), settings.work.roundingMinutes ? t("{v0} min", { v0: settings.work.roundingMinutes }) : t("Aucun")], [t("Catégories"), settings.work.costCategories.join(', ')]]} /><ReviewCard title={t("Paie")} onEdit={() => onEdit(9)} rows={[[t("Module"), settings.payroll.enabled ? settings.payroll.fiduciaryValidated ? t("Activé · configuration contrôlée") : t("Activé · validation fiduciaire requise") : t("Désactivé")], [t("Caisse AVS"), settings.payroll.enabled ? settings.payroll.avsFund : '—'], [t("AANP"), settings.payroll.aanpEmployerCoverage?.enabled ? t("Prise en charge employeur · {v0}", { v0: settings.payroll.aanpEmployerCoverage.reference }) : t("Prime salarié par défaut")], [t("LPP"), lppPlan ? t("{v0} · contrat {v1}", { v0: settings.payroll.pensionFund || t('Caisse à confirmer'), v1: lppPlan.contractNumber || t('à compléter') }) : t("Règlement non configuré")], [t("Taux saisis"), settings.payroll.enabled ? t("{v0} salarié · {v1} employeur", { v0: settings.payroll.employeeRates.length, v1: settings.payroll.employerRates.length }) : t("Aucun")]]} /><ReviewCard title={t("Données")} onEdit={() => onEdit(12)} rows={[[t("Stockage"), isMobileRuntime() ? t("Sur cet appareil et, si relié, dans votre espace partagé") : t("Sur cet appareil et, si relié, dans votre espace partagé")], [t("Sauvegarde"), t("Manuelle, à votre initiative")], [t("Dossier"), isMobileRuntime() ? t("Choisi au moment du partage") : settings.backup.folder]]} /></div>
      <div className="zero-data"><Check size={19} /><div><strong>{t("Démarrage propre confirmé")}</strong><p>{t("Votre espace démarrera avec vos réglages, sans document d’exemple.")}</p></div></div>
    </div>
  );
}

function ReviewCard({ title, rows, onEdit }: { title: string; rows: Array<[string, string]>; onEdit: () => void }) {
  return <section className="review-card"><header><h3>{title}</h3><button type="button" onClick={onEdit}>{t("Modifier ")}<ArrowRight size={13} /></button></header><dl>{rows.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}</dl></section>;
}

export function ValidationSummary({ issues, onSelect }: { issues: OnboardingIssue[]; onSelect: (issue: OnboardingIssue) => void }) {
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

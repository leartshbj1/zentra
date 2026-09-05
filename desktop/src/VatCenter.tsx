import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCode2,
  Fingerprint,
  ListChecks,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { SectionTabs } from './SectionTabs';
import { VatOverview } from './VatOverview';
import { VatPurchaseReview } from './VatPurchaseReview';
import { VatReceivedPayments } from './VatReceivedPayments';
import { VatPreClosingReview } from './VatPreClosingReview';
import type {
  PeriodFilter,
  VatAdjustment,
  VatAdjustmentCategory,
  VatProfile,
  VatReportingBasis,
  VatReportingMethod,
  VatReportingPeriodicity,
  VatReturnExport,
  VatReturnPreview,
  VatSourceTreatment,
  VatSubmissionType,
  Workspace,
} from './types';
import { Button, EmptyState, ErrorPanel, Field, SectionHeading, submitForm } from './ui';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import {
  suggestedVatBusinessReference,
  treatmentsForVatSource,
  vatAdjustmentLabels,
  vatBlockingIssueTitle,
  vatGrossOrNetForMethod,
  vatPeriodicityLabels,
  vatProfileRequiresAfcConfirmation,
  vatSourceTypeLabels,
  vatSubmissionLabel,
  vatTreatmentLabels,
} from './vatCenterLogic';
import './VatCenter.css';

type VatTab = 'return' | 'profile' | 'adjustments' | 'history';

export function VatCenter({
  filter,
  workspace,
  onAccountingChanged,
}: {
  filter: PeriodFilter;
  workspace: Workspace;
  onAccountingChanged?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<VatTab>('return');
  const [profiles, setProfiles] = useState<VatProfile[]>([]);
  const [adjustments, setAdjustments] = useState<VatAdjustment[]>([]);
  const [exports, setExports] = useState<VatReturnExport[]>([]);
  const [preview, setPreview] = useState<VatReturnPreview | null>(null);
  const [submissionType, setSubmissionType] = useState<VatSubmissionType>('initial');
  const [profileMethod, setProfileMethod] = useState<VatReportingMethod>('effective');
  const [profileBasis, setProfileBasis] = useState<VatReportingBasis>('agreed');
  const [profilePeriodicity, setProfilePeriodicity] = useState<VatReportingPeriodicity>('quarterly');
  const [profileGrossOrNet, setProfileGrossOrNet] = useState<'net' | 'gross'>('net');
  const [adjustmentCategory, setAdjustmentCategory] = useState<VatAdjustmentCategory>('input_materials');
  const [adjustmentFormVersion, setAdjustmentFormVersion] = useState(0);
  const [adjustmentRequestId, setAdjustmentRequestId] = useState(createId);
  const [reversalTarget, setReversalTarget] = useState<VatAdjustment | null>(null);
  const [reversalRequestId, setReversalRequestId] = useState('');
  const [lastExport, setLastExport] = useState<VatReturnExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const hasDates = Boolean(filter.dateFrom && filter.dateTo);
  const invalidPeriod = Boolean(
    filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo,
  );
  const hasPeriod = hasDates && !invalidPeriod;
  const periodKey = `${filter.dateFrom || ''}:${filter.dateTo || ''}`;
  const profileRequiresConfirmation = vatProfileRequiresAfcConfirmation({
    method: profileMethod,
    basis: profileBasis,
    periodicity: profilePeriodicity,
  });
  const actor = workspace.settings?.organization.contactName
    || workspace.settings?.organization.legalName
    || 'Utilisateur local';
  const reversedAdjustmentIds = useMemo(
    () => new Set(adjustments.map((item) => item.reversesAdjustmentId).filter(Boolean)),
    [adjustments],
  );

  async function load(showNotice = false) {
    const current = ++request.current;
    let fullyLoaded = true;
    setBusy(true);
    setError('');
    if (!showNotice) setNotice('');
    try {
      const [nextProfiles, nextAdjustments, nextExports] = await Promise.all([
        desktopApi.listVatProfiles(),
        hasPeriod ? desktopApi.listVatAdjustments(filter) : Promise.resolve([]),
        hasPeriod ? desktopApi.listVatReturnExports(filter) : Promise.resolve([]),
      ]);
      if (current !== request.current) return;
      setProfiles(nextProfiles);
      setAdjustments(nextAdjustments);
      setExports(nextExports);
      if (hasPeriod && nextProfiles.length) {
        try {
          const nextPreview = await desktopApi.previewVatReturn({
            dateFrom: filter.dateFrom!,
            dateTo: filter.dateTo!,
            submissionType,
          });
          if (current === request.current) setPreview(nextPreview);
        } catch (reason) {
          fullyLoaded = false;
          if (current === request.current) {
            setPreview(null);
            setError(errorMessage(reason, 'Le décompte TVA n’a pas pu être préparé.'));
          }
        }
      } else {
        setPreview(null);
      }
      if (showNotice && fullyLoaded && current === request.current) setNotice('Les données TVA ont été actualisées.');
    } catch (reason) {
      if (current === request.current) {
        setProfiles([]);
        setAdjustments([]);
        setExports([]);
        setPreview(null);
        setError(errorMessage(reason, 'L’assistant TVA local n’a pas pu être chargé.'));
      }
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  useEffect(() => {
    setLastExport(null);
    setReversalTarget(null);
    setReversalRequestId('');
    void load();
  }, [filter.dateFrom, filter.dateTo, submissionType]);

  async function saveProfile(form: FormData) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const rate = Number(form.get('tdfnRate'));
      await desktopApi.createVatProfile({
        effectiveFrom: String(form.get('effectiveFrom')),
        effectiveTo: String(form.get('effectiveTo') || ''),
        reportingMethod: profileMethod,
        formOfReporting: profileBasis,
        periodicity: profilePeriodicity,
        grossOrNet: profileGrossOrNet,
        tdfnActivityId: profileMethod === 'simple_tax_rate' ? String(form.get('activityId')) : undefined,
        tdfnRateBp: profileMethod === 'simple_tax_rate' && Number.isFinite(rate) ? Math.round(rate * 100) : undefined,
        afcAuthorizationConfirmed: form.get('authorization') === 'on',
        notes: String(form.get('notes') || ''),
        closePreviousOpenProfile: form.get('closePrevious') === 'on',
      });
      setTab('return');
      await onAccountingChanged?.();
      await load();
      setNotice('Le nouveau profil TVA daté a été enregistré. Les anciens décomptes restent liés à leur profil d’origine.');
    } catch (reason) {
      setError(errorMessage(reason, 'Le profil TVA a été refusé.'));
      setBusy(false);
    }
  }

  async function classifySource(sourceId: string, sourceType: VatReturnPreview['unclassifiedSources'][number]['sourceType'], treatment: VatSourceTreatment) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await desktopApi.setVatSourceClassification({ sourceId, sourceType, treatment });
      await onAccountingChanged?.();
      await load();
      setNotice('Le traitement TVA est enregistré.');
    } catch (reason) {
      setError(errorMessage(reason, 'La classification n’a pas pu être enregistrée.'));
      setBusy(false);
    }
  }

  async function saveAdjustment(form: FormData) {
    const amount = Number(form.get('amount'));
    const taxRate = Number(form.get('taxRate'));
    const amountCents = Math.round(amount * 100);
    setError('');
    setNotice('');
    if (!Number.isFinite(amount) || amountCents === 0) {
      setError('Saisissez un montant non nul, avec au maximum deux décimales.');
      return;
    }
    if (
      adjustmentCategory === 'acquisition_tax' &&
      (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
    ) {
      setError('Le taux légal doit être compris entre 0 et 100 %.');
      return;
    }
    setBusy(true);
    try {
      await desktopApi.createVatAdjustment({
        requestId: adjustmentRequestId,
        adjustmentDate: String(form.get('adjustmentDate')),
        category: adjustmentCategory,
        amountCents,
        taxRateBp: adjustmentCategory === 'acquisition_tax' && Number.isFinite(taxRate) ? Math.round(taxRate * 100) : undefined,
        description: String(form.get('description')),
        evidenceReference: String(form.get('evidenceReference') || ''),
        createdBy: actor,
      });
      await load();
      setAdjustmentRequestId(createId());
      setAdjustmentFormVersion((current) => current + 1);
      setNotice('L’ajustement a été ajouté au registre append-only. Une correction future passera par une extourne.');
    } catch (reason) {
      setError(errorMessage(reason, 'L’ajustement TVA n’a pas pu être enregistré.'));
      setBusy(false);
    }
  }

  async function reverseAdjustment(form: FormData) {
    if (!reversalTarget || !reversalRequestId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await desktopApi.reverseVatAdjustment({
        requestId: reversalRequestId,
        originalAdjustmentId: reversalTarget.id,
        adjustmentDate: String(form.get('adjustmentDate')),
        description: String(form.get('description')),
        evidenceReference: String(form.get('evidenceReference') || ''),
        createdBy: actor,
      });
      await load();
      setReversalTarget(null);
      setReversalRequestId('');
      setNotice('L’ajustement original reste visible et une ligne inverse lui a été liée.');
    } catch (reason) {
      setError(errorMessage(reason, 'L’extourne TVA a été refusée.'));
      setBusy(false);
    }
  }

  async function exportXml(form: FormData) {
    if (!preview || !filter.dateFrom || !filter.dateTo) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await desktopApi.exportVatReturnXml({
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        submissionType,
        profileId: preview.profile.id,
        businessReferenceId: String(form.get('businessReferenceId')).trim(),
      });
      await load();
      setLastExport(result);
      setNotice(`XML eCH-0217 v2.0.0 créé localement : ${result.filePath}`);
    } catch (reason) {
      setError(errorMessage(reason, 'L’export XML a été refusé.'));
      setBusy(false);
    }
  }

  const tabItems: Array<[VatTab, string, React.ReactNode]> = [
    ['return', 'Décompte', <ListChecks size={15} />],
    ['profile', 'Méthode & autorisation', <Settings2 size={15} />],
    ['adjustments', 'Ajustements', <Plus size={15} />],
    ['history', 'Exports', <FileCode2 size={15} />],
  ];

  return <div className="vat-center stack-layout" aria-busy={busy}>
    <section className="panel vat-hero">
      <div><span>TVA suisse</span><h2>TVA due et récupérable</h2><p>Préparez et contrôlez votre décompte avant de le transmettre à l’AFC.</p></div>
      <div className="vat-standard"><FileCode2 size={20} /><div><strong>Export XML</strong><small>À importer dans Décompte TVA pro</small></div></div>
    </section>
    <section className="panel vat-navigation"><SectionTabs items={tabItems} value={tab} onChange={setTab} label="Section TVA" /><Button size="small" variant="secondary" disabled={busy} onClick={() => void load(true)}>Actualiser</Button></section>
    {error ? <ErrorPanel message={error} /> : null}
    {notice ? <div className="notice notice--success" role="status" aria-live="polite"><CheckCircle2 size={17} />{notice}</div> : null}

    {tab === 'profile' ? <section id="vat-panel-profile" role="tabpanel" className="panel vat-profile-panel">
      <SectionHeading eyebrow="Configuration TVA" title="Méthode déclarée par votre entreprise" description="Créez une version à la date d’effet convenue avec l’AFC. Un changement entre facturation et encaissements nécessite une reprise des factures encore ouvertes; cette reprise n’est pas encore automatisée." />
      <form key={`vat-profile:${periodKey}`} className="vat-profile-form" onSubmit={submitForm(saveProfile)}>
        <div className="form-grid">
          <Field label="Début d’effet" required><input name="effectiveFrom" type="date" defaultValue={filter.dateFrom || `${new Date().getFullYear()}-01-01`} required /></Field>
          <Field label="Fin d’effet"><input name="effectiveTo" type="date" /></Field>
          <Field label="Méthode" required><select value={profileMethod} onChange={(event) => { const method = event.target.value as VatReportingMethod; setProfileMethod(method); setProfilePeriodicity(method === 'simple_tax_rate' ? 'semiannual' : 'quarterly'); setProfileGrossOrNet((current) => vatGrossOrNetForMethod(method, current)); }}><option value="effective">Méthode effective</option><option value="simple_tax_rate">TDFN / TaF · méthode simplifiée</option></select></Field>
          <Field label="Mode de décompte" required><select value={profileBasis} onChange={(event) => setProfileBasis(event.target.value as VatReportingBasis)}><option value="agreed">Factures · contre-prestations convenues</option><option value="received">Encaissements · contre-prestations reçues</option></select></Field>
          <Field label="Périodicité" required><select value={profilePeriodicity} onChange={(event) => setProfilePeriodicity(event.target.value as VatReportingPeriodicity)}><option value="monthly">Mensuelle · sur autorisation</option><option value="quarterly">Trimestrielle</option><option value="semiannual">Semestrielle</option><option value="annual">Annuelle · sur autorisation</option></select></Field>
          <Field label="Présentation" hint={profileMethod === 'simple_tax_rate' ? 'Brut obligatoire pour l’export eCH-0217 TDFN/TaF.' : undefined} required><select value={profileGrossOrNet} disabled={profileMethod === 'simple_tax_rate'} onChange={(event) => setProfileGrossOrNet(event.target.value as 'net' | 'gross')}><option value="net">Net · recommandé</option><option value="gross">Brut</option></select></Field>
          {profileBasis === 'received' ? <div className="info-strip field--wide"><Settings2 size={18} /><span>Ce mode exige, dans Comptabilité &gt; Plan &amp; liaisons, deux comptes de passif actifs et distincts : « TVA à régulariser » à l’émission puis « TVA due » lors des encaissements. L’enregistrement sera bloqué si la chaîne ou l’historique est incohérent.</span></div> : null}
          {profileMethod === 'simple_tax_rate' ? <><Field label="ActivityID AFC · 5 chiffres" required><input name="activityId" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} required /></Field><Field label="Taux TDFN/TaF confirmé (%)" hint="Saisissez uniquement le taux communiqué ou accepté pour votre activité." required><input name="tdfnRate" type="number" min="0" max="100" step="0.01" required /></Field></> : null}
          <Field label="Note / référence de décision" wide><textarea name="notes" rows={3} placeholder="Date et référence de l’autorisation, personne ayant validé la méthode…" /></Field>
        </div>
        <label className="check-card"><input name="authorization" type="checkbox" required={profileRequiresConfirmation} /><span><strong>J’ai vérifié cette méthode et, lorsque requis, son autorisation AFC</strong><small>{profileRequiresConfirmation ? 'Cette confirmation est obligatoire pour ce choix.' : 'Zentra enregistre votre confirmation; il ne remplace pas la décision de l’AFC.'}</small></span></label>
        {profiles.some((profile) => !profile.effectiveTo) ? <label className="check-card"><input name="closePrevious" type="checkbox" /><span><strong>Fermer le profil actuellement ouvert la veille</strong><small>La nouvelle version commence sans chevauchement; les anciens exports restent intacts.</small></span></label> : null}
        <div className="form-actions"><Button type="submit" disabled={busy}>Enregistrer cette version</Button></div>
      </form>
      {profiles.length ? <div className="vat-profile-list">{profiles.map((profile) => <article key={profile.id}><div><strong>{profile.reportingMethod === 'effective' ? 'Méthode effective' : 'TDFN / TaF'}</strong><span>{formatDate(profile.effectiveFrom)} → {profile.effectiveTo ? formatDate(profile.effectiveTo) : 'profil ouvert'}</span><small>{profile.formOfReporting === 'agreed' ? 'Contre-prestations convenues' : 'Contre-prestations reçues'} · {vatPeriodicityLabels[profile.periodicity]} · présentation {profile.grossOrNet === 'gross' ? 'brute' : 'nette'}{profile.tdfnActivityId ? ` · activité ${profile.tdfnActivityId}` : ''}{profile.tdfnRateBp !== null ? ` · ${(profile.tdfnRateBp / 100).toLocaleString('fr-CH')} %` : ''}</small></div><span className="vat-profile-status">Version figée</span></article>)}</div> : <EmptyState title="Aucun profil TVA" text="Renseignez la méthode réellement appliquée avant de produire un décompte." />}
    </section> : null}

    {tab === 'return' ? <section id="vat-panel-return" role="tabpanel" className="panel vat-return-panel">
      <SectionHeading eyebrow={hasPeriod ? `${formatDate(filter.dateFrom)} → ${formatDate(filter.dateTo)}` : 'Période requise'} title="Décompte à contrôler" description="Un initial et un rectificatif sont complets. Une concordance annuelle ne contient que les différences à déclarer." action={<select value={submissionType} disabled={busy} onChange={(event) => setSubmissionType(event.target.value as VatSubmissionType)} aria-label="Type de décompte"><option value="initial">Décompte initial</option><option value="correction">Rectificatif</option><option value="annual_reconciliation">Concordance annuelle</option></select>} />
      {!hasPeriod ? <EmptyState title={invalidPeriod ? 'Dates incohérentes' : 'Choisissez des dates'} text={invalidPeriod ? 'La date de début doit précéder ou être égale à la date de fin.' : 'Sélectionnez un exercice enregistré ou saisissez une période explicite dans la barre comptable.'} /> : !profiles.length ? <div className="vat-onboarding"><Settings2 size={22} /><div><strong>Configurez d’abord la méthode TVA</strong><p>La méthode, le mode et la périodicité doivent être datés avant tout calcul.</p></div><Button onClick={() => setTab('profile')}>Configurer</Button></div> : preview ? <>
        <div className={`vat-readiness ${preview.exportable ? 'is-ready' : 'is-blocked'}`}>{preview.exportable ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}<div><strong>{preview.exportable ? 'Prêt pour export contrôlé' : `${preview.blockingIssues.length} point${preview.blockingIssues.length > 1 ? 's' : ''} à traiter`}</strong><p>{vatSubmissionLabel(submissionType)} · {preview.profile.reportingMethod === 'effective' ? 'méthode effective' : 'TDFN / TaF'} · {preview.profile.formOfReporting === 'agreed' ? 'convenues' : 'reçues'}</p></div></div>
        <div className="vat-summary"><article><span>Ch. 200</span><strong>{formatMoney(preview.turnoverComputation.totalConsiderationCents)}</strong><small>Total des contre-prestations</small></article><article><span>Ch. 299</span><strong>{formatMoney(preview.turnoverComputation.taxableTurnoverCents)}</strong><small>Chiffre d’affaires imposable</small></article><article><span>Ch. {preview.payableCode}</span><strong>{formatMoney(preview.payableTaxCents)}</strong><small>{preview.payableCode === '500' ? 'Montant dû' : 'Avoir estimé'}</small></article><article><span>Sources</span><strong>{preview.sourceCount}</strong><small>{preview.adjustmentCount} ajustement{preview.adjustmentCount > 1 ? 's' : ''}</small></article></div>
        <VatOverview preview={preview} />
        <details className="vat-calculation-details">
          <summary>Détail du calcul TVA <span>Taux, achats et corrections</span></summary>
          <VatRateTable preview={preview} />
          <VatCalculationBreakdown preview={preview} />
        </details>
        <VatReceivedPayments key={`payments:${periodKey}`} allocations={preview.receivedAllocations ?? []} />
        <VatPurchaseReview sources={preview.classifiedSources ?? []} busy={busy} onClassify={classifySource} />
        <VatPreClosingReview key={`pre-close:${periodKey}`} sources={preview.preClosingSources ?? []} busy={busy} onClassify={classifySource} />
        {preview.unclassifiedSources.length ? <section className="vat-unclassified"><header><div><strong>Décisions nécessaires</strong><p>Ces lignes ne sont pas devinées. Choisissez leur traitement réel; l’export reste bloqué jusque-là.</p></div><span>{preview.unclassifiedSources.length}</span></header>{preview.unclassifiedSources.map((source) => <article key={`${source.sourceType}:${source.sourceId}`}><div><strong>{source.description}</strong><span>{formatDate(source.occurrenceDate)} · {formatMoney(source.amountCents)}{source.vatRateBp !== null ? ` · ${(source.vatRateBp / 100).toLocaleString('fr-CH')} %` : ''}</span><small>{vatSourceTypeLabels[source.sourceType]}</small></div><select defaultValue="" disabled={busy} aria-label={`Traitement TVA de ${source.description}`} onChange={(event) => { const treatment = event.currentTarget.value as VatSourceTreatment; event.currentTarget.value = ''; if (treatment) void classifySource(source.sourceId, source.sourceType, treatment); }}><option value="">Choisir le traitement</option>{treatmentsForVatSource(source.sourceType).map((treatment) => <option key={treatment} value={treatment}>{vatTreatmentLabels[treatment]}</option>)}</select></article>)}</section> : null}
        {preview.blockingIssues.length ? <div className="vat-issues" aria-label="Points à vérifier avant export">{preview.blockingIssues.map((issue, index) => <article key={`${issue.code}:${issue.sourceId || index}`}><AlertTriangle size={17} /><div><strong>{vatBlockingIssueTitle(issue.code)}</strong><p>{issue.message}</p></div></article>)}</div> : null}
        {preview.warnings.length ? <div className="vat-warnings">{preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
        <form key={`vat-export:${periodKey}:${submissionType}`} className="vat-export-form" onSubmit={submitForm(exportXml)}><div><FileCode2 size={21} /><div><strong>Créer le fichier XML</strong><p>Vous l’importez ensuite manuellement dans Décompte TVA pro, contrôlez les champs, ajoutez les annexes nécessaires et soumettez vous-même.</p></div></div><Field label="Référence métier" hint="Identifiant unique de ce dépôt, 50 caractères maximum." required><input name="businessReferenceId" defaultValue={suggestedVatBusinessReference(filter.dateFrom!, filter.dateTo!, submissionType)} maxLength={50} required /></Field><Button type="submit" disabled={busy || !preview.exportable}><Download size={16} /> Générer l’XML</Button></form>
        {lastExport ? <div className="vat-export-success"><Fingerprint size={19} /><div><strong>{lastExport.fileName}</strong><p>Empreinte XML {lastExport.xmlSha256.slice(0, 16)}… · non transmis</p><small>{lastExport.filePath}</small></div></div> : null}
        <div className="closing-limitation"><ShieldCheck size={18} /><p><strong>Périmètre honnête.</strong> {preview.transmissionWording}</p></div>
      </> : <EmptyState title="Calcul indisponible" text="Actualisez l’assistant ou corrigez le profil indiqué dans le message d’erreur." />}
    </section> : null}

    {tab === 'adjustments' ? <section id="vat-panel-adjustments" role="tabpanel" className="panel vat-adjustments-panel">
      <SectionHeading eyebrow="Registre append-only" title="Ajustements manuels justifiés" description="Utilisez ces lignes seulement pour les chiffres non dérivables des documents. Une correction crée une extourne; elle n’efface jamais l’original." />
      {!hasPeriod ? <EmptyState title={invalidPeriod ? 'Dates incohérentes' : 'Période requise'} text={invalidPeriod ? 'La date de début doit précéder ou être égale à la date de fin.' : 'Choisissez d’abord la période du décompte.'} /> : <>
        <form key={`vat-adjustment:${periodKey}:${adjustmentFormVersion}`} className="vat-adjustment-form" onSubmit={submitForm(saveAdjustment)}>
          <div className="form-grid">
            <Field label="Date" required><input name="adjustmentDate" type="date" min={filter.dateFrom} max={filter.dateTo} defaultValue={filter.dateTo || todayIso()} required /></Field>
            <Field label="Chiffre" required><select value={adjustmentCategory} onChange={(event) => setAdjustmentCategory(event.target.value as VatAdjustmentCategory)}>{Object.entries(vatAdjustmentLabels).map(([category, label]) => <option key={category} value={category}>{label}</option>)}</select></Field>
            <Field label="Montant CHF" hint="Utilisez un montant négatif uniquement si le chiffre concerné doit diminuer." required><input name="amount" type="number" inputMode="decimal" step="0.01" required /></Field>
            {adjustmentCategory === 'acquisition_tax' ? <Field label="Taux légal (%)" required><input name="taxRate" type="number" inputMode="decimal" min="0" max="100" step="0.01" required /></Field> : null}
            <Field label="Motif" required wide><input name="description" maxLength={500} required /></Field>
            <Field label="Référence de preuve" wide><input name="evidenceReference" maxLength={500} placeholder="Pièce, décision, calcul ou dossier de travail" /></Field>
          </div>
          <Button type="submit" disabled={busy}><Plus size={15} /> Ajouter l’ajustement</Button>
        </form>
        {reversalTarget ? <form key={`vat-reversal:${reversalTarget.id}`} className="vat-reversal-form" onSubmit={submitForm(reverseAdjustment)}>
          <div><strong>Extourner {vatAdjustmentLabels[reversalTarget.category]}</strong><p>L’original de {formatMoney(reversalTarget.amountCents)} restera intact.</p></div>
          <div className="form-grid">
            <Field label="Date" required><input name="adjustmentDate" type="date" min={filter.dateFrom} max={filter.dateTo} defaultValue={filter.dateTo || todayIso()} required /></Field>
            <Field label="Motif de l’extourne" required wide><input name="description" maxLength={500} required /></Field>
            <Field label="Référence"><input name="evidenceReference" maxLength={500} /></Field>
          </div>
          <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => { setReversalTarget(null); setReversalRequestId(''); }}>Annuler</Button><Button type="submit" disabled={busy}><RotateCcw size={15} /> Créer la ligne inverse</Button></div>
        </form> : null}
        {adjustments.length ? <div className="vat-adjustment-list">{adjustments.map((item) => <article key={item.id}><div><strong>{vatAdjustmentLabels[item.category]}</strong><span>{formatDate(item.adjustmentDate)} · {item.description}</span><small>{item.reversesAdjustmentId ? 'Extourne liée' : item.evidenceReference || 'Aucune référence documentaire'} · saisi par {item.createdBy}</small></div><strong className={item.amountCents < 0 ? 'is-negative' : ''}>{formatMoney(item.amountCents)}</strong>{!item.reversesAdjustmentId && !reversedAdjustmentIds.has(item.id) ? <Button variant="ghost" size="small" disabled={busy} onClick={() => { setReversalTarget(item); setReversalRequestId(createId()); }}><RotateCcw size={14} /> Extourner</Button> : <span className="vat-locked">Immuable</span>}</article>)}</div> : <EmptyState title="Aucun ajustement" text="Les calculs reposent uniquement sur les documents de la période tant qu’aucun ajustement justifié n’est ajouté." />}
      </>}
    </section> : null}

    {tab === 'history' ? <section id="vat-panel-history" role="tabpanel" className="panel vat-history-panel"><SectionHeading eyebrow="Traçabilité locale" title="Exports XML enregistrés" description="Chaque export conserve le profil, la période, l’empreinte des sources et l’empreinte du fichier. Aucun statut ne prétend qu’il a été transmis." />{!hasPeriod ? <EmptyState title={invalidPeriod ? 'Dates incohérentes' : 'Période requise'} text={invalidPeriod ? 'La date de début doit précéder ou être égale à la date de fin.' : 'Choisissez une période pour afficher ses exports.'} /> : exports.length ? <div className="vat-history-list">{exports.map((item) => <article key={item.id}><FileCode2 size={20} /><div><strong>{item.fileName}</strong><span>{formatDate(item.dateFrom)} → {formatDate(item.dateTo)} · {vatSubmissionLabel(item.submissionType)}</span><small>Créé le {formatDate(item.createdAt)} · XML {item.xmlSha256.slice(0, 16)}… · sources {item.sourceSha256.slice(0, 16)}…</small></div><span>Non transmis</span></article>)}</div> : <EmptyState title="Aucun export" text="Les fichiers créés pour la période apparaîtront ici avec leurs empreintes." />}</section> : null}
  </div>;
}

function VatRateTable({ preview }: { preview: VatReturnPreview }) {
  const method = preview.effectiveReportingMethod ?? preview.simpleTaxRateMethod;
  if (!method) return null;
  const lines = [
    ...method.suppliesPerTaxRate.map((line) => ({ ...line, kind: 'Chiffre d’affaires' })),
    ...method.acquisitionTax.map((line) => ({ ...line, kind: 'Acquisitions' })),
  ];
  if (!lines.length) return null;
  return <div className="table-panel vat-rate-table"><table><caption className="sr-only">Détail du calcul TVA par nature et par taux</caption><thead><tr><th>Nature</th><th>Activité / taux</th><th>Base</th><th>TVA calculée</th></tr></thead><tbody>{lines.map((line) => <tr key={`${line.kind}:${line.activityId || 'effective'}:${line.taxRateBp}`}><td>{line.kind}</td><td>{line.activityId ? `Activité ${line.activityId} · ` : ''}{(line.taxRateBp / 100).toLocaleString('fr-CH')} %</td><td>{formatMoney(line.turnoverCents)}</td><td>{formatMoney(line.calculatedTaxCents)}</td></tr>)}</tbody></table></div>;
}

function VatCalculationBreakdown({ preview }: { preview: VatReturnPreview }) {
  const effective = preview.effectiveReportingMethod;
  const simple = preview.simpleTaxRateMethod;
  const lines: Array<[string, string, number]> = effective ? [
    ['TVA sur le chiffre d’affaires', 'Ch. 399', effective.outputTaxCents],
    ['Impôt sur les acquisitions', 'Ch. 38x', effective.acquisitionTaxCents],
    ['Impôt préalable matériel et prestations', 'Ch. 400', effective.inputTaxMaterialAndServicesCents],
    ['Impôt préalable investissements et autres charges', 'Ch. 405', effective.inputTaxInvestmentsCents],
    ['Dégrèvement ultérieur', 'Ch. 410', effective.subsequentInputTaxDeductionCents],
    ['Corrections de l’impôt préalable', 'Ch. 415', effective.inputTaxCorrectionsCents],
    ['Réductions de l’impôt préalable', 'Ch. 420', effective.inputTaxReductionsCents],
  ] : simple ? [
    ['TVA selon les taux d’activité', 'Ch. 399', simple.outputTaxCents],
    ['Impôt sur les acquisitions', 'Ch. 38x', simple.acquisitionTaxCents],
    ['Corrections de l’impôt préalable', 'Ch. 415', simple.inputTaxCorrectionsCents],
  ] : [];
  if (preview.otherFlowsOfFunds.subsidiesCents) {
    lines.push(['Subventions', 'Ch. 900', preview.otherFlowsOfFunds.subsidiesCents]);
  }
  if (preview.otherFlowsOfFunds.donationsCents) {
    lines.push(['Dons', 'Ch. 910', preview.otherFlowsOfFunds.donationsCents]);
  }
  if (!lines.length) return null;
  return <section className="vat-calculation" aria-labelledby="vat-calculation-title"><header><div><strong id="vat-calculation-title">Détail du calcul</strong><p>Les montants restent contrôlables avant la génération du XML.</p></div><span>{lines.length} ligne{lines.length > 1 ? 's' : ''}</span></header><div>{lines.map(([label, code, amount]) => <article key={code}><div><strong>{label}</strong><small>{code}</small></div><span>{formatMoney(amount)}</span></article>)}</div></section>;
}

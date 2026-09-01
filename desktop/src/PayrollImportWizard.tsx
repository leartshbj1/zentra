import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  FileSearch,
  Files,
  HardDrive,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { prepareImageForAnalysis, renderPdfPages } from './localPdfPreview';
import {
  mergePayrollImportDraft,
  reconcilePayrollAiPasses,
  type PayrollImportConfirmedAiFields,
} from './payrollImportAiDraft';
import { findStrongEmployeeMatch } from './payrollEmployeeMatching';
import { payrollLocalAi, type PayrollAiMode, type PayrollAiProgress } from './payrollLocalAi';
import { assessPayrollDraft, payrollImportTotals } from './payrollImportQuality';
import type {
  PayrollAiIdentityEvidence,
  PayrollDocumentImport,
  PayrollImportDraft,
  PayrollImportEmployeeDraft,
  PayrollImportLineDraft,
  Workspace,
} from './types';
import { createId, errorMessage, formatMoney } from './utils';
import { Button, ErrorPanel, Field, Modal } from './ui';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;
type AiState = 'checking' | 'available' | 'unavailable' | 'loading' | 'ready' | 'analyzing' | 'error';

function cloneDraft(draft: PayrollImportDraft): PayrollImportDraft {
  return {
    ...draft,
    employee: { ...draft.employee },
    lines: draft.lines.map((line) => ({ ...line, id: line.id || createId() })),
    warnings: [...draft.warnings],
    review: draft.review ? {
      ...draft.review,
      aiIdentityEvidence: draft.review.aiIdentityEvidence ? {
        ...draft.review.aiIdentityEvidence,
        conflicts: [...draft.review.aiIdentityEvidence.conflicts],
      } : undefined,
    } : undefined,
  };
}

function normalizedIdentity(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function confidenceLabel(value: number) {
  if (value >= 8_500) return 'forte';
  if (value >= 6_000) return 'moyenne';
  return 'à contrôler';
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function PayrollImportWizard({ workspace, close, act }: { workspace: Workspace; close: () => void; act: ActionRunner }) {
  const initial = useMemo(() => workspace.payrollImports.filter((item) => item.status === 'needs_review'), [workspace.payrollImports]);
  const [imports, setImports] = useState<PayrollDocumentImport[]>(initial);
  const [activeIndex, setActiveIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, PayrollImportDraft>>(() => Object.fromEntries(initial.map((item) => [item.id, cloneDraft(item.draft)])));
  const [confirmedAiFields, setConfirmedAiFields] = useState<Record<string, PayrollImportConfirmedAiFields>>({});
  const [employeeLinks, setEmployeeLinks] = useState<Record<string, string>>(() => Object.fromEntries(initial.map((item) => [item.id, item.draft.review?.employeeId ?? ''])));
  const [employeeLinkSources, setEmployeeLinkSources] = useState<Record<string, 'auto' | 'manual'>>(() => Object.fromEntries(initial.flatMap((item) => item.draft.review?.employeeLinkSource === 'auto' || item.draft.review?.employeeLinkSource === 'manual' ? [[item.id, item.draft.review.employeeLinkSource]] : [])));
  const [employeeMatchNotes, setEmployeeMatchNotes] = useState<Record<string, string>>(() => Object.fromEntries(initial.flatMap((item) => item.draft.review?.employeeLinkSource ? [[item.id, item.draft.review.employeeLinkSource === 'manual' ? 'Choix manuel restauré.' : 'Rattachement automatique restauré; contrôlez les identifiants.']] : [])));
  const [aiIdentityEvidence, setAiIdentityEvidence] = useState<Record<string, PayrollAiIdentityEvidence>>(() => Object.fromEntries(initial.flatMap((item) => item.draft.review?.aiIdentityEvidence ? [[item.id, item.draft.review.aiIdentityEvidence]] : [])));
  const [replaceTemplates, setReplaceTemplates] = useState<Record<string, boolean>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [staging, setStaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savingDrafts, setSavingDrafts] = useState(false);
  const dirtyDraftIds = useRef(new Set<string>());
  const [aiState, setAiState] = useState<AiState>('checking');
  const [aiMode, setAiMode] = useState<PayrollAiMode>('unavailable');
  const [aiProgress, setAiProgress] = useState<PayrollAiProgress>({ label: 'Vérification de WebGPU…', percent: null });
  const [localError, setLocalError] = useState('');
  const [documentDataUrl, setDocumentDataUrl] = useState('');
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [selectedPdfPage, setSelectedPdfPage] = useState(0);
  const [pdfPreviewError, setPdfPreviewError] = useState('');
  const active = imports[Math.min(activeIndex, Math.max(0, imports.length - 1))];
  const draft = active ? drafts[active.id] ?? cloneDraft(active.draft) : null;

  useEffect(() => {
    let alive = true;
    void payrollLocalAi.check().then((mode) => { if (alive) { setAiMode(mode); setAiState(mode === 'unavailable' ? 'unavailable' : 'available'); } });
    const unsubscribe = payrollLocalAi.onProgress((progress) => { if (alive) setAiProgress(progress); });
    return () => { alive = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!active || employeeLinkSources[active.id] === 'manual') return;
    const evidence = aiIdentityEvidence[active.id];
    if (!evidence) return;
    const match = findStrongEmployeeMatch(evidence, workspace.employees);
    setEmployeeLinks((current) => current[active.id] === (match.employeeId ?? '') ? current : { ...current, [active.id]: match.employeeId ?? '' });
    setEmployeeLinkSources((current) => current[active.id] === 'auto' ? current : { ...current, [active.id]: 'auto' });
    setEmployeeMatchNotes((current) => current[active.id] === match.reason ? current : { ...current, [active.id]: match.reason });
  }, [active, aiIdentityEvidence, employeeLinkSources, workspace.employees]);

  useEffect(() => {
    let cancelled = false;
    setDocumentDataUrl('');
    setPdfPages([]);
    setPdfPageCount(0);
    setSelectedPdfPage(0);
    setPdfPreviewError('');
    if (!active) return () => { cancelled = true; };
    void desktopApi.getPayrollDocumentPreview(active.id)
      .then(async ({ mimeType, dataBase64 }) => {
        if (cancelled) return;
        const dataUrl = `data:${mimeType};base64,${dataBase64}`;
        setDocumentDataUrl(dataUrl);
        if (active.mediaKind === 'pdf') {
          const preview = await renderPdfPages(base64ToBytes(dataBase64));
          if (!cancelled) { setPdfPages(preview.pages); setPdfPageCount(preview.pageCount); }
        }
      })
      .catch((reason) => { if (!cancelled) setPdfPreviewError(errorMessage(reason, "L’aperçu local du PDF n’a pas pu être rendu.")); });
    return () => { cancelled = true; };
  }, [active?.id, active?.mediaKind]);

  function updateDraft(mutator: (current: PayrollImportDraft) => PayrollImportDraft) {
    if (!active || !draft) return;
    dirtyDraftIds.current.add(active.id);
    setDrafts((current) => ({ ...current, [active.id]: mutator(cloneDraft(current[active.id] ?? draft)) }));
    setReviewed((current) => ({ ...current, [active.id]: false }));
  }

  function patchEmployee(patch: Partial<PayrollImportEmployeeDraft>) {
    const invalidatesAutomaticLink = Boolean(active
      && employeeLinkSources[active.id] === 'auto'
      && ['employeeNumber', 'birthDate', 'avsNumber', 'iban'].some((field) => Object.hasOwn(patch, field)));
    if (active && invalidatesAutomaticLink) {
      setEmployeeLinks((current) => ({ ...current, [active.id]: '' }));
      setEmployeeLinkSources((current) => ({ ...current, [active.id]: 'manual' }));
      setAiIdentityEvidence((current) => {
        const next = { ...current };
        delete next[active.id];
        return next;
      });
      setEmployeeMatchNotes((current) => ({ ...current, [active.id]: 'Identité modifiée : le rattachement automatique a été retiré. Choisissez explicitement le collaborateur.' }));
    }
    updateDraft((current) => ({
      ...current,
      employee: { ...current.employee, ...patch },
      review: invalidatesAutomaticLink ? {
        aiIdentityEvidence: undefined,
        employeeId: '',
        employeeLinkSource: 'manual',
      } : current.review,
    }));
  }

  async function chooseDocuments() {
    setLocalError('');
    try {
      const paths = await desktopApi.choosePayrollDocuments();
      if (!paths.length) return;
      setStaging(true);
      let staged: PayrollDocumentImport[] = [];
      const ok = await act(async () => {
        staged = await desktopApi.stagePayrollDocuments(paths);
        return desktopApi.loadWorkspace();
      }, `${paths.length} document(s) préparé(s) localement.`, false);
      if (!ok) return;
      setImports((current) => {
        const map = new Map(current.map((item) => [item.id, item]));
        staged.filter((item) => item.status === 'needs_review').forEach((item) => map.set(item.id, item));
        return [...map.values()];
      });
      setDrafts((current) => ({ ...current, ...Object.fromEntries(staged.map((item) => [item.id, cloneDraft(item.draft)])) }));
      setActiveIndex(0);
    } catch (reason) {
      setLocalError(errorMessage(reason, "Les fiches n'ont pas pu être préparées localement."));
    } finally {
      setStaging(false);
    }
  }

  async function ensureAiLoaded() {
    if (aiState === 'ready') return;
    if (aiState === 'unavailable') throw new Error('Ni WebGPU ni le repli CPU WebAssembly ne sont disponibles sur ce PC.');
    setAiState('loading');
    setAiProgress({ label: 'Téléchargement unique du pack SmolVLM local…', percent: null });
    await payrollLocalAi.load();
    setAiState('ready');
  }

  async function analyzeCurrent() {
    if (!active || !draft) return;
    setLocalError('');
    setReviewed((current) => ({ ...current, [active.id]: false }));
    try {
      await ensureAiLoaded();
      setAiState('analyzing');
      setAiProgress({ label: `Analyse locale de ${active.sourceName}`, percent: null });
      let imageUrls = active.mediaKind === 'pdf' ? pdfPages : documentDataUrl ? [await prepareImageForAnalysis(documentDataUrl)] : [];
      if (!imageUrls.length) {
        const { mimeType, dataBase64 } = await desktopApi.getPayrollDocumentPreview(active.id);
        imageUrls = active.mediaKind === 'pdf'
          ? (await renderPdfPages(base64ToBytes(dataBase64))).pages
          : [await prepareImageForAnalysis(`data:${mimeType};base64,${dataBase64}`)];
      }
      const result = await payrollLocalAi.analyze({ imageUrls, extractedText: active.extractedText });
      setAiMode(result.mode);
      const aiDraft = reconcilePayrollAiPasses(
        result.primaryRawOutput || (result.passes === 1 ? result.rawOutput : ''),
        result.verifiedRawOutput,
      );
      const match = findStrongEmployeeMatch(aiDraft.identity, workspace.employees);
      const preserveManualLink = employeeLinkSources[active.id] === 'manual';
      const employeeId = preserveManualLink ? employeeLinks[active.id] ?? '' : match.employeeId ?? '';
      const employeeLinkSource: 'manual' | 'auto' = preserveManualLink ? 'manual' : 'auto';
      const merged = {
        ...mergePayrollImportDraft(draft, aiDraft, confirmedAiFields[active.id]),
        review: { aiIdentityEvidence: aiDraft.identity, employeeId, employeeLinkSource },
      };
      const confidenceBp = assessPayrollDraft(merged).scoreBp;
      const saved = await desktopApi.updatePayrollImportDraft(active.id, merged, `smolvlm-500m-${result.mode}-double-read-${aiDraft.identity.passes}`, result.modelVersion, confidenceBp);
      setAiIdentityEvidence((current) => ({ ...current, [saved.id]: aiDraft.identity }));
      setEmployeeLinks((current) => ({ ...current, [saved.id]: employeeId }));
      setEmployeeLinkSources((current) => ({ ...current, [saved.id]: employeeLinkSource }));
      setEmployeeMatchNotes((current) => ({ ...current, [saved.id]: preserveManualLink ? 'Collaborateur choisi manuellement; ce choix ne sera jamais remplacé par l’IA.' : match.reason }));
      setImports((current) => current.map((item) => item.id === saved.id ? saved : item));
      setDrafts((current) => ({ ...current, [saved.id]: cloneDraft(saved.draft) }));
      dirtyDraftIds.current.delete(saved.id);
      setReviewed((current) => ({ ...current, [saved.id]: false }));
      setAiState('ready');
      setAiProgress({ label: `Double lecture terminée · ${aiDraft.identity.passes === 2 ? 'consensus comparé' : 'une lecture seulement'} · contrôle humain requis`, percent: 100 });
    } catch (reason) {
      setAiState(aiState === 'unavailable' ? 'unavailable' : 'error');
      setLocalError(errorMessage(reason, "L'analyse SmolVLM locale a échoué."));
    }
  }

  async function confirmCurrent() {
    if (!active || !draft || !reviewed[active.id]) return;
    setLocalError('');
    const linkedEmployee = employeeLinks[active.id] || undefined;
    const linkedEmployeeRecord = linkedEmployee
      ? workspace.employees.find((employee) => employee.id === linkedEmployee)
      : undefined;
    const importedAvs = normalizedIdentity(draft.employee.avsNumber);
    const storedAvs = normalizedIdentity(linkedEmployeeRecord?.avsNumber ?? '');
    const importedEmployeeNumber = normalizedIdentity(draft.employee.employeeNumber);
    const storedEmployeeNumber = normalizedIdentity(linkedEmployeeRecord?.employeeNumber ?? '');
    const avsMismatch = Boolean(importedAvs && storedAvs && importedAvs !== storedAvs);
    const employeeNumberMismatch = Boolean(importedEmployeeNumber && storedEmployeeNumber && importedEmployeeNumber !== storedEmployeeNumber);
    const birthMismatch = Boolean(draft.employee.birthDate && linkedEmployeeRecord?.birthDate && draft.employee.birthDate !== linkedEmployeeRecord.birthDate);
    const existingIdentityOwner = !linkedEmployee ? workspace.employees.find((employee) => {
      const candidateAvs = normalizedIdentity(employee.avsNumber);
      const candidateNumber = normalizedIdentity(employee.employeeNumber);
      return Boolean((importedAvs && candidateAvs === importedAvs) || (importedEmployeeNumber && candidateNumber === importedEmployeeNumber));
    }) : undefined;
    if (existingIdentityOwner) {
      setLocalError(`Un collaborateur existant (${existingIdentityOwner.name}) possède déjà ce numéro AVS ou ce numéro employé. Sélectionnez son profil au lieu de créer un doublon.`);
      return;
    }
    if (avsMismatch || employeeNumberMismatch || birthMismatch) {
      setLocalError('Un identifiant fort du document (AVS, numéro employé ou naissance) ne correspond pas au collaborateur sélectionné. Choisissez le bon profil avant de confirmer.');
      return;
    }
    setConfirming(true);
    const hadExistingTemplate = Boolean(linkedEmployee && workspace.employeePayrollTemplates.some((template) => template.employeeId === linkedEmployee));
    const hasReviewedRecurringEarnings = draft.lines.some((line) => line.kind === 'earning' && line.recurring && line.amountCents > 0);
    const replaceExistingTemplate = Boolean(
      linkedEmployee
      && hadExistingTemplate
      && replaceTemplates[active.id]
      && hasReviewedRecurringEarnings,
    );
    const ok = await act(
      () => desktopApi.confirmPayrollDocumentImport(active.id, draft, linkedEmployee, replaceExistingTemplate),
      linkedEmployee
        ? replaceExistingTemplate
          ? 'La fiche a été rattachée et le modèle salarial existant a été remplacé explicitement.'
          : hadExistingTemplate
            ? 'La fiche a été rattachée; le modèle salarial existant a été préservé.'
            : hasReviewedRecurringEarnings
              ? 'La fiche a été rattachée et un premier modèle salarial contrôlé a été créé.'
              : 'La fiche a été rattachée sans inventer de modèle salarial; aucun gain récurrent n’était confirmé.'
        : hasReviewedRecurringEarnings
          ? 'Le collaborateur, son modèle contrôlé et la fiche à contrôler ont été créés.'
          : 'Le collaborateur et la fiche à contrôler ont été créés sans déduire un salaire contractuel du brut historique.',
      false,
    );
    if (ok) {
      const remaining = imports.filter((item) => item.id !== active.id);
      dirtyDraftIds.current.delete(active.id);
      setImports(remaining);
      setActiveIndex((index) => Math.min(index, Math.max(0, remaining.length - 1)));
      if (!remaining.length) close();
    }
    setConfirming(false);
  }

  async function rejectCurrent() {
    if (!active || !window.confirm(`Écarter « ${active.sourceName} » de la file de contrôle ? Le fichier local restera dans la sauvegarde Elyko.`)) return;
    const ok = await act(() => desktopApi.rejectPayrollDocumentImport(active.id), 'Le document a été écarté de la file de contrôle.', false);
    if (ok) {
      const remaining = imports.filter((item) => item.id !== active.id);
      dirtyDraftIds.current.delete(active.id);
      setImports(remaining);
      setActiveIndex((index) => Math.min(index, Math.max(0, remaining.length - 1)));
    }
  }

  async function persistAndClose() {
    if (savingDrafts) return;
    const pending = [...dirtyDraftIds.current]
      .map((id) => ({ id, draft: drafts[id], source: imports.find((item) => item.id === id) }))
      .filter((item): item is { id: string; draft: PayrollImportDraft; source: PayrollDocumentImport } => Boolean(item.draft && item.source));
    if (!pending.length) {
      close();
      return;
    }
    setLocalError('');
    setSavingDrafts(true);
    const ok = await act(async () => {
      for (const item of pending) {
        await desktopApi.updatePayrollImportDraft(
          item.id,
          item.draft,
          item.source.extractionEngine || 'manual_review',
          item.source.engineVersion,
          assessPayrollDraft(item.draft).scoreBp,
        );
      }
      return desktopApi.loadWorkspace();
    }, pending.length === 1 ? 'Les corrections ont été enregistrées.' : `${pending.length} brouillons corrigés ont été enregistrés.`, false);
    setSavingDrafts(false);
    if (ok) {
      pending.forEach((item) => dirtyDraftIds.current.delete(item.id));
      close();
    }
  }

  const calculated = draft ? payrollImportTotals(draft.lines) : null;
  const assessment = draft ? assessPayrollDraft(draft) : null;
  const arithmeticOk = Boolean(assessment && !assessment.blockers.length);
  const aiBusy = aiState === 'loading' || aiState === 'analyzing';
  const linkedEmployeeId = active ? employeeLinks[active.id] || '' : '';
  const linkedEmployee = linkedEmployeeId ? workspace.employees.find((employee) => employee.id === linkedEmployeeId) : undefined;
  const importedAvs = normalizedIdentity(draft?.employee.avsNumber ?? '');
  const linkedAvs = normalizedIdentity(linkedEmployee?.avsNumber ?? '');
  const linkedAvsMismatch = Boolean(importedAvs && linkedAvs && importedAvs !== linkedAvs);
  const importedEmployeeNumber = normalizedIdentity(draft?.employee.employeeNumber ?? '');
  const linkedEmployeeNumber = normalizedIdentity(linkedEmployee?.employeeNumber ?? '');
  const linkedEmployeeNumberMismatch = Boolean(importedEmployeeNumber && linkedEmployeeNumber && importedEmployeeNumber !== linkedEmployeeNumber);
  const linkedBirthMismatch = Boolean(draft?.employee.birthDate && linkedEmployee?.birthDate && draft.employee.birthDate !== linkedEmployee.birthDate);
  const linkedIdentityMismatch = linkedAvsMismatch || linkedEmployeeNumberMismatch || linkedBirthMismatch;
  const existingIdentityOwner = !linkedEmployeeId ? workspace.employees.find((employee) => {
    const candidateAvs = normalizedIdentity(employee.avsNumber);
    const candidateNumber = normalizedIdentity(employee.employeeNumber);
    return Boolean((importedAvs && candidateAvs === importedAvs) || (importedEmployeeNumber && candidateNumber === importedEmployeeNumber));
  }) : undefined;
  const duplicateCreationRisk = Boolean(existingIdentityOwner);
  const existingTemplate = linkedEmployeeId ? workspace.employeePayrollTemplates.find((template) => template.employeeId === linkedEmployeeId) : undefined;
  const hasRecurringEarnings = Boolean(draft?.lines.some((line) => line.kind === 'earning' && line.recurring && line.amountCents > 0));
  const interactionBusy = confirming || aiBusy || savingDrafts;

  return <Modal title="Importer des fiches de salaire" description="Elyko effectue deux lectures locales indépendantes, compare leur consensus puis attend votre validation champ par champ." onClose={() => { if (!interactionBusy) void persistAndClose(); }} wide>
    <div className="payroll-import-shell">
      <section className="payroll-import-privacy"><ShieldCheck size={21} /><div><strong>Les salaires ne quittent jamais cet ordinateur</strong><p>Seul le modèle public est téléchargé une fois. Le PDF, l’image, le texte OCR et le résultat restent dans les données locales Elyko.</p></div><span><HardDrive size={14} /> local</span></section>
      <div className="payroll-import-toolbar">
        <Button type="button" onClick={() => void chooseDocuments()} disabled={staging || aiBusy}>{staging ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} Ajouter PDF ou images</Button>
        <div className={`ai-engine-state ai-engine-state--${aiState}`}><BrainCircuit size={17} /><span><strong>SmolVLM 500M · double lecture locale</strong><small>{aiState === 'checking' ? 'Vérification du PC' : aiState === 'unavailable' ? 'Moteur local indisponible' : aiState === 'available' ? `Pack disponible · ${aiMode === 'webgpu' ? 'GPU' : 'CPU lent'}` : aiState === 'loading' ? `Installation locale · ${aiMode === 'webgpu' ? 'GPU' : 'CPU'}` : aiState === 'analyzing' ? `Deux lectures en cours · ${aiMode === 'webgpu' ? 'GPU' : 'CPU lent'}` : aiState === 'ready' ? `Prêt sur ce PC · ${aiMode === 'webgpu' ? 'GPU' : 'CPU'}` : 'Contrôle nécessaire'}</small></span></div>
      </div>
      {aiBusy ? <div className="ai-progress"><span><i style={{ width: aiProgress.percent === null ? '24%' : `${Math.max(2, Math.min(100, aiProgress.percent))}%` }} /></span><small>{aiProgress.label}{aiProgress.percent === null ? '' : ` · ${Math.round(aiProgress.percent)} %`}</small></div> : null}
      {localError ? <ErrorPanel message={localError} /> : null}
      {!imports.length ? <section className="payroll-import-empty"><div><Files size={30} /></div><h3>Ajoutez les anciennes fiches de vos employés</h3><p>PDF natifs, scans, PNG, JPG et WEBP. Elyko détecte les doublons, lit d’abord le texte exact puis utilise SmolVLM pour comprendre la mise en page.</p><Button onClick={() => void chooseDocuments()} disabled={staging}><Upload size={16} /> Choisir les documents</Button></section> : active && draft && calculated ? <>
        <div className="payroll-import-queue">
          <Button variant="ghost" size="icon" disabled={activeIndex === 0} onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}><ArrowLeft size={17} /></Button>
          <div><strong>{activeIndex + 1} / {imports.length} · {active.sourceName}</strong><small>{(active.fileSize / 1024 / 1024).toLocaleString('fr-CH', { maximumFractionDigits: 1 })} Mo · {active.extractionEngine === 'pdf_text' ? 'texte PDF lu localement' : 'analyse visuelle requise'} · confiance {confidenceLabel(active.confidenceBp)}</small></div>
          <Button variant="ghost" size="icon" disabled={activeIndex >= imports.length - 1} onClick={() => setActiveIndex((index) => Math.min(imports.length - 1, index + 1))}><ArrowRight size={17} /></Button>
        </div>
        <div className="payroll-review-grid">
          <section className="payroll-source-pane">
            <header><span><FileSearch size={17} /> Document original</span><strong>copie locale SHA‑256</strong></header>
            {active.mediaKind === 'image' && documentDataUrl ? <img src={documentDataUrl} alt={`Fiche importée ${active.sourceName}`} /> : active.mediaKind === 'pdf' && pdfPages.length ? <><img src={pdfPages[selectedPdfPage] ?? pdfPages[0]} alt={`Page ${selectedPdfPage + 1} de ${active.sourceName}`} />{pdfPages.length > 1 ? <div className="payroll-page-picker" aria-label="Pages du document">{pdfPages.map((page, index) => <button key={index} type="button" aria-current={selectedPdfPage === index ? 'page' : undefined} onClick={() => setSelectedPdfPage(index)}><img src={page} alt="" /><span>{index + 1}</span></button>)}</div> : null}{pdfPageCount > pdfPages.length ? <p className="payroll-page-note">{pdfPageCount} pages au total · les {pdfPages.length} premières sont analysées visuellement; la couche texte complète reste utilisée.</p> : null}</> : <div className="payroll-pdf-loading">{pdfPreviewError ? <><AlertTriangle size={18} /><span>{pdfPreviewError}</span></> : <><LoaderCircle className="spin" size={18} /><span>Rendu local des pages…</span></>}</div>}
            <div className="source-hash">{active.fileSha256.slice(0, 20)}…</div>
          </section>
          <section className="payroll-review-pane">
            <header><div><span>1</span><div><strong>Identité et période</strong><small>Valeurs proposées, toutes modifiables</small></div></div><Button type="button" variant="secondary" size="small" disabled={aiBusy || aiState === 'unavailable'} onClick={() => void analyzeCurrent()}>{aiBusy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} {active.extractionEngine.startsWith('smolvlm') ? 'Relancer l’IA locale' : 'Analyser avec l’IA locale'}</Button></header>
            {aiState === 'unavailable' ? <div className="inline-warning"><AlertTriangle size={16} /><span>Le moteur local n’est pas disponible. Vous pouvez quand même contrôler et compléter les données extraites du PDF.</span></div> : aiMode === 'wasm' ? <div className="inline-warning"><AlertTriangle size={16} /><span>Mode CPU local actif : l’analyse peut prendre plusieurs minutes, mais aucun document ne quitte ce PC.</span></div> : null}
            <div className="form-grid payroll-review-fields"><Field label="Collaborateur" required><input value={draft.employee.name} onChange={(event) => patchEmployee({ name: event.target.value })} /></Field><Field label="N° employé"><input value={draft.employee.employeeNumber} onChange={(event) => patchEmployee({ employeeNumber: event.target.value })} /></Field><Field label="Fonction"><input value={draft.employee.role} onChange={(event) => patchEmployee({ role: event.target.value })} /></Field><Field label="Taux d’activité (%)" required><input type="number" min="1" max="100" value={draft.employee.employmentRate} onChange={(event) => { setConfirmedAiFields((current) => ({ ...current, [active.id]: { ...current[active.id], employmentRate: true } })); patchEmployee({ employmentRate: Math.min(100, Math.max(1, event.target.valueAsNumber || 100)) }); }} /></Field><Field label="Période" required><input type="month" value={draft.period} onChange={(event) => updateDraft((current) => ({ ...current, period: event.target.value }))} /></Field><Field label="Date de paiement"><input type="date" value={draft.paymentDate} onChange={(event) => updateDraft((current) => ({ ...current, paymentDate: event.target.value }))} /></Field><Field label="N° AVS"><input value={draft.employee.avsNumber} onChange={(event) => patchEmployee({ avsNumber: event.target.value })} /></Field><Field label="IBAN de l’employé"><input value={draft.employee.iban} onChange={(event) => patchEmployee({ iban: event.target.value })} /></Field><Field label="Rue" wide><input value={draft.employee.addressLine1} onChange={(event) => patchEmployee({ addressLine1: event.target.value })} /></Field><Field label="Complément"><input value={draft.employee.addressLine2} onChange={(event) => patchEmployee({ addressLine2: event.target.value })} /></Field><Field label="NPA"><input value={draft.employee.postalCode} onChange={(event) => patchEmployee({ postalCode: event.target.value })} /></Field><Field label="Localité"><input value={draft.employee.city} onChange={(event) => patchEmployee({ city: event.target.value })} /></Field><Field label="Canton"><input maxLength={2} value={draft.employee.canton} onChange={(event) => patchEmployee({ canton: event.target.value.toUpperCase() })} /></Field><Field label="Mode de salaire"><select value={draft.employee.salaryMode} onChange={(event) => { setConfirmedAiFields((current) => ({ ...current, [active.id]: { ...current[active.id], salaryMode: true } })); patchEmployee({ salaryMode: event.target.value as PayrollImportEmployeeDraft['salaryMode'] }); }}><option value="monthly">Mensuel</option><option value="hourly">Horaire</option></select></Field></div>
            <header className="payroll-lines-heading"><div><span>2</span><div><strong>Rubriques et montants</strong><small>L’IA ne choisit aucun taux légal à votre place</small></div></div><Button type="button" variant="secondary" size="small" onClick={() => updateDraft((current) => ({ ...current, lines: [...current.lines, { id: createId(), label: '', kind: 'earning', amountCents: 0, recurring: false, confidenceBp: 10_000 }] }))}><Plus size={14} /> Ajouter</Button></header>
            <div className="imported-pay-lines">{draft.lines.map((line) => <div key={line.id}><select value={line.kind} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, kind: event.target.value as PayrollImportLineDraft['kind'], recurring: event.target.value === 'earning' ? candidate.recurring : false } : candidate) }))}><option value="earning">Gain soumis au brut</option><option value="deduction">Retenue employé</option><option value="reimbursement">Remboursement hors brut</option><option value="employer">Charge employeur</option></select><input value={line.label} placeholder="Libellé" onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, label: event.target.value } : candidate) }))} /><label className="money-input"><input type="number" min="0" step="0.01" value={line.amountCents ? line.amountCents / 100 : ''} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, amountCents: Math.round((event.target.valueAsNumber || 0) * 100) } : candidate) }))} /><span>CHF</span></label><label className="recurring-check"><input type="checkbox" checked={line.recurring} disabled={line.kind !== 'earning'} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, recurring: event.target.checked } : candidate) }))} /><span>Récurrent</span></label><Button type="button" variant="ghost" size="icon" onClick={() => updateDraft((current) => ({ ...current, lines: current.lines.filter((candidate) => candidate.id !== line.id) }))}><Trash2 size={15} /></Button></div>)}</div>
            <div className={`payroll-import-equation ${arithmeticOk ? 'is-valid' : 'is-error'}`}><div><span>Brut</span><strong>{formatMoney(calculated.gross)}</strong></div><i>−</i><div><span>Retenues</span><strong>{formatMoney(calculated.deductions)}</strong></div><i>+</i><div><span>Remboursements</span><strong>{formatMoney(calculated.reimbursements)}</strong></div><i>=</i><div><span>Net recalculé</span><strong>{formatMoney(calculated.net)}</strong></div><div className="printed-values"><span>Imprimé · brut {draft.grossCents ? formatMoney(draft.grossCents) : 'non détecté'}</span><span>Imprimé · net {draft.netCents ? formatMoney(draft.netCents) : 'non détecté'}</span></div>{arithmeticOk ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</div>
            {assessment ? <div className="payroll-quality"><header><div><strong>Contrôles déterministes</strong><small>Score d’extraction {Math.round(assessment.scoreBp / 100)} % · ce score ne remplace pas votre vérification</small></div><span>{assessment.blockers.length ? `${assessment.blockers.length} correction${assessment.blockers.length > 1 ? 's' : ''}` : 'Contrôles passés'}</span></header><div className="payroll-quality__checks">{assessment.checks.map((check) => <div className={check.ok ? 'is-valid' : 'is-error'} key={check.label}>{check.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>{assessment.blockers.length ? <div className="payroll-quality__blockers"><strong>À corriger avant confirmation</strong>{assessment.blockers.map((blocker) => <p key={blocker}><AlertTriangle size={14} /> {blocker}</p>)}</div> : null}</div> : null}
            {draft.warnings.length || assessment?.warnings.length ? <div className="payroll-import-warnings"><strong>Points à vérifier</strong>{[...new Set([...draft.warnings, ...(assessment?.warnings ?? [])])].map((warning, index) => <p key={`${warning}-${index}`}><AlertTriangle size={14} /> {warning}</p>)}</div> : null}
            <header className="payroll-lines-heading"><div><span>3</span><div><strong>Rattachement et confirmation</strong><small>La fiche créée restera « à contrôler »</small></div></div></header>
            <Field label="Rattacher à un collaborateur"><select value={employeeLinks[active.id] ?? ''} onChange={(event) => { const employeeId = event.target.value; setEmployeeLinks((current) => ({ ...current, [active.id]: employeeId })); setEmployeeLinkSources((current) => ({ ...current, [active.id]: 'manual' })); setEmployeeMatchNotes((current) => ({ ...current, [active.id]: employeeId ? 'Collaborateur choisi manuellement; ce choix ne sera jamais remplacé par l’IA.' : 'Création d’un nouveau collaborateur choisie manuellement.' })); setReplaceTemplates((current) => ({ ...current, [active.id]: false })); updateDraft((current) => ({ ...current, review: { aiIdentityEvidence: current.review?.aiIdentityEvidence, employeeId, employeeLinkSource: 'manual' } })); }}><option value="">Créer un nouveau collaborateur avec les champs ci-dessus</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select></Field>
            {employeeMatchNotes[active.id] ? <p className={linkedIdentityMismatch ? 'link-note link-note--error' : 'link-note'}>{employeeMatchNotes[active.id]}</p> : null}
            {duplicateCreationRisk ? <p className="link-note link-note--error">Création bloquée : {existingIdentityOwner?.name} possède déjà ce numéro AVS ou ce numéro employé. Sélectionnez ce profil dans la liste.</p> : null}
            {linkedEmployeeId ? <p className={linkedIdentityMismatch ? 'link-note link-note--error' : 'link-note'}>{linkedIdentityMismatch ? 'Rattachement bloqué : au moins un identifiant fort du document (AVS, numéro employé ou naissance) diffère du collaborateur sélectionné.' : 'Le profil et le modèle salarial actuels du collaborateur sont préservés par défaut. La fiche historique sera seulement ajoutée à la période indiquée.'}</p> : null}
            {existingTemplate && hasRecurringEarnings ? <label className={`review-confirmation ${replaceTemplates[active.id] ? 'is-checked' : ''}`}><input type="checkbox" checked={Boolean(replaceTemplates[active.id])} onChange={(event) => { setReplaceTemplates((current) => ({ ...current, [active.id]: event.target.checked })); setReviewed((current) => ({ ...current, [active.id]: false })); }} /><span><strong>Remplacer explicitement le modèle salarial actuel</strong><small>Les gains marqués « Récurrent » dans cette fiche historique deviendront le nouveau modèle. Cette action est facultative et ne se fera jamais automatiquement.</small></span></label> : existingTemplate ? <p className="link-note">Aucun gain récurrent contrôlé n’a été identifié : le modèle salarial actuel ne peut pas être remplacé depuis cette fiche.</p> : null}
            <label className={`review-confirmation ${reviewed[active.id] ? 'is-checked' : ''}`}><input type="checkbox" checked={Boolean(reviewed[active.id])} onChange={(event) => setReviewed((current) => ({ ...current, [active.id]: event.target.checked }))} /><span><strong>J’ai comparé les champs et montants au document original</strong><small>Je comprends que SmolVLM peut se tromper et qu’aucune cotisation manquante ne sera inventée.</small></span></label>
          </section>
        </div>
        <footer className="payroll-import-actions"><Button type="button" variant="ghost" onClick={() => void rejectCurrent()} disabled={interactionBusy}><Trash2 size={15} /> Écarter ce document</Button><span /><Button type="button" variant="secondary" onClick={() => void persistAndClose()} disabled={interactionBusy}>{savingDrafts ? <LoaderCircle className="spin" size={16} /> : null} Continuer plus tard</Button><Button type="button" onClick={() => void confirmCurrent()} disabled={!reviewed[active.id] || !arithmeticOk || linkedIdentityMismatch || duplicateCreationRisk || interactionBusy}>{confirming ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />} Confirmer et créer à contrôler</Button></footer>
      </> : null}
    </div>
  </Modal>;
}

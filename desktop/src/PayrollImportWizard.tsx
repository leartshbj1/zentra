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
  combinePayrollAiPageBatches,
  markPayrollAiContributions,
  mergePayrollImportDraft,
  payrollAiProvenanceForFinalDraft,
  preparePayrollDraftForAiRerun,
  reconcilePayrollAiPasses,
  recordPayrollManualChanges,
  type PayrollAiProvenance,
  type PayrollImportConfirmedAiFields,
} from './payrollImportAiDraft';
import { findStrongEmployeeMatch } from './payrollEmployeeMatching';
import { payrollLocalAi, type PayrollAiMode, type PayrollAiProgress } from './payrollLocalAi';
import {
  assertPayrollAnalysisDraftUnchanged,
  payrollAnalysisDraftSnapshot,
} from './payrollAnalysisGuard';
import {
  calibratePayrollAiDraftConfidence,
  payrollAiProvenanceFromManifest,
  payrollAnalysisManifestFromAi,
  reconcilePayrollAnalysisManifest,
} from './payrollAnalysisManifest';
import { extractPayrollPdfTextByPage } from './payrollPdfText';
import { payrollTextForPageBatch } from './payrollPdfTextUtils';
import { hasCompletedLocalPayrollAiAnalysis, pendingLocalPayrollAiImports } from './payrollImportQueue';
import { assessPayrollDraft, payrollControlQualityLabel, payrollImportTotals } from './payrollImportQuality';
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
type BatchAnalysisState = {
  status: 'idle' | 'running' | 'complete' | 'cancelled';
  processed: number;
  completed: number;
  total: number;
  currentName: string;
  failures: Array<{ id: string; sourceName: string; message: string }>;
};
const MAX_VISUAL_PAYROLL_PAGES = 12;
const AI_PAGE_BATCH_SIZE = 3;

function cloneDraft(draft: PayrollImportDraft): PayrollImportDraft {
  return {
    ...draft,
    employee: { ...draft.employee },
    lines: draft.lines.map((line) => ({ ...line, id: line.id || createId() })),
    warnings: [...draft.warnings],
    review: draft.review ? {
      ...draft.review,
      aiFields: [...(draft.review.aiFields ?? [])],
      aiLineKeys: [...(draft.review.aiLineKeys ?? [])],
      aiWarnings: [...(draft.review.aiWarnings ?? [])],
      manualFields: [...(draft.review.manualFields ?? [])],
      manualLineKeys: [...(draft.review.manualLineKeys ?? [])],
      suppressedLineKeys: [...(draft.review.suppressedLineKeys ?? [])],
      confirmedRecurringLines: (draft.review.confirmedRecurringLines ?? []).map((line) => ({ ...line })),
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

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isExplicitlyConfirmedRecurringLine(
  draft: PayrollImportDraft,
  line: PayrollImportLineDraft,
) {
  return line.kind === 'earning'
    && line.recurring
    && Boolean(draft.review?.confirmedRecurringLines?.some((confirmed) => (
      confirmed.kind === 'earning'
      && confirmed.label === line.label
      && confirmed.amountCents === line.amountCents
      && (confirmed.lineId
        ? confirmed.lineId === line.id
        : draft.lines.filter((candidate) => (
          candidate.kind === 'earning'
          && candidate.label === line.label
          && candidate.amountCents === line.amountCents
        )).length === 1)
    )));
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
  const [aiProvenance, setAiProvenance] = useState<Record<string, PayrollAiProvenance>>(() => Object.fromEntries(initial.flatMap((item) => {
    const provenance = payrollAiProvenanceFromManifest(item.analysisManifest);
    return provenance ? [[item.id, provenance]] : [];
  })));
  const [replaceTemplates, setReplaceTemplates] = useState<Record<string, boolean>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [staging, setStaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savingDrafts, setSavingDrafts] = useState(false);
  const dirtyDraftIds = useRef(new Set<string>());
  const draftRevisions = useRef<Record<string, number>>({});
  const aiLoadedRef = useRef(false);
  const batchCancelRequested = useRef(false);
  const [aiState, setAiState] = useState<AiState>('checking');
  const [aiMode, setAiMode] = useState<PayrollAiMode>('unavailable');
  const [aiProgress, setAiProgress] = useState<PayrollAiProgress>({ label: 'Vérification de WebGPU…', percent: null });
  const [batchAnalysis, setBatchAnalysis] = useState<BatchAnalysisState>({ status: 'idle', processed: 0, completed: 0, total: 0, currentName: '', failures: [] });
  const [localError, setLocalError] = useState('');
  const [documentDataUrl, setDocumentDataUrl] = useState('');
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const [pdfTextPages, setPdfTextPages] = useState<string[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [selectedPdfPage, setSelectedPdfPage] = useState(0);
  const [pdfPreviewError, setPdfPreviewError] = useState('');
  const active = imports[Math.min(activeIndex, Math.max(0, imports.length - 1))];
  const activeIdRef = useRef(active?.id ?? '');
  const draft = active ? drafts[active.id] ?? cloneDraft(active.draft) : null;
  const pendingAiImports = useMemo(() => pendingLocalPayrollAiImports(imports), [imports]);
  const aiBusy = aiState === 'loading' || aiState === 'analyzing';

  useEffect(() => {
    activeIdRef.current = active?.id ?? '';
  }, [active?.id]);

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
    setPdfTextPages([]);
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
          const [previewResult, textResult] = await Promise.allSettled([
            renderPdfPages(base64ToBytes(dataBase64), MAX_VISUAL_PAYROLL_PAGES),
            extractPayrollPdfTextByPage(base64ToBytes(dataBase64), MAX_VISUAL_PAYROLL_PAGES),
          ]);
          if (previewResult.status === 'rejected') throw previewResult.reason;
          if (!cancelled) {
            setPdfPages(previewResult.value.pages);
            setPdfPageCount(previewResult.value.pageCount);
            setPdfTextPages(textResult.status === 'fulfilled' ? textResult.value.pages : []);
          }
        }
      })
      .catch((reason) => { if (!cancelled) setPdfPreviewError(errorMessage(reason, "L’aperçu local du PDF n’a pas pu être rendu.")); });
    return () => { cancelled = true; };
  }, [active?.id, active?.mediaKind]);

  function updateDraft(mutator: (current: PayrollImportDraft) => PayrollImportDraft) {
    if (!active || !draft || aiBusy || confirming || savingDrafts) return;
    const importId = active.id;
    const before = cloneDraft(drafts[importId] ?? draft);
    const edit = recordPayrollManualChanges(before, mutator(cloneDraft(before)));
    const source = imports.find((item) => item.id === importId);
    const reconciledManifest = source?.analysisManifest && edit.contentChanged
      ? reconcilePayrollAnalysisManifest(source.analysisManifest, before, edit.draft)
      : source?.analysisManifest ?? null;
    draftRevisions.current[importId] = (draftRevisions.current[importId] ?? 0) + 1;
    dirtyDraftIds.current.add(importId);
    const next = edit.draft;
    setDrafts((current) => ({ ...current, [importId]: next }));
    if (source?.analysisManifest && edit.contentChanged) {
      const reconciledProvenance = payrollAiProvenanceFromManifest(reconciledManifest);
      setAiProvenance((current) => reconciledProvenance
        ? { ...current, [importId]: reconciledProvenance }
        : current);
      setImports((current) => current.map((item) => (
        item.id === importId ? { ...item, analysisManifest: reconciledManifest } : item
      )));
    } else if (edit.contentChanged && aiProvenance[importId]) {
      // Une provenance seulement en mémoire n'a pas de valeurs signées à
      // réconcilier. La retirer évite d'afficher une indication devenue
      // ambiguë, sans toucher à un manifeste persistant.
      setAiProvenance((current) => {
        const remaining = { ...current };
        delete remaining[importId];
        return remaining;
      });
    }
    setReviewed((current) => ({ ...current, [importId]: false }));
  }

  function patchEmployee(patch: Partial<PayrollImportEmployeeDraft>) {
    if (!active || !draft || aiBusy || confirming || savingDrafts) return;
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
        ...current.review,
        aiIdentityEvidence: undefined,
        employeeId: '',
        employeeLinkSource: 'manual',
      } : current.review,
    }));
  }

  async function chooseDocuments() {
    setLocalError('');
    setBatchAnalysis({ status: 'idle', processed: 0, completed: 0, total: 0, currentName: '', failures: [] });
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
      setAiProvenance((current) => ({
        ...current,
        ...Object.fromEntries(staged.flatMap((item) => {
          const provenance = payrollAiProvenanceFromManifest(item.analysisManifest);
          return provenance ? [[item.id, provenance]] : [];
        })),
      }));
      setActiveIndex(0);
    } catch (reason) {
      setLocalError(errorMessage(reason, "Les fiches n'ont pas pu être préparées localement."));
    } finally {
      setStaging(false);
    }
  }

  async function ensureAiLoaded() {
    if (aiLoadedRef.current) return;
    if (aiState === 'unavailable') throw new Error('Ni WebGPU ni le repli CPU WebAssembly ne sont disponibles sur ce PC.');
    setAiState('loading');
    setAiProgress({ label: 'Téléchargement unique du pack SmolVLM local…', percent: null });
    await payrollLocalAi.load();
    aiLoadedRef.current = true;
    setAiState('ready');
  }

  async function analyzeImport(
    target: PayrollDocumentImport,
    targetDraft: PayrollImportDraft,
    queuePosition?: { current: number; total: number },
  ) {
    const analysisSnapshot = payrollAnalysisDraftSnapshot(
      target.id,
      draftRevisions.current[target.id] ?? 0,
    );
    const mergeBase = target.extractionEngine.startsWith('smolvlm-500m-')
      ? preparePayrollDraftForAiRerun(targetDraft)
      : cloneDraft(targetDraft);
    await ensureAiLoaded();
    setAiState('analyzing');
    const queuePrefix = queuePosition ? `Fiche ${queuePosition.current}/${queuePosition.total} · ` : '';
    setAiProgress({ label: `${queuePrefix}analyse locale de ${target.sourceName}`, percent: null });

    const { mimeType, dataBase64 } = await desktopApi.getPayrollDocumentPreview(target.id);
    let visualPageCount = 1;
    let imageUrls: string[] = [];
    let textPages: string[] = [];
    if (target.mediaKind === 'pdf') {
      const [preview, pageText] = await Promise.all([
        renderPdfPages(base64ToBytes(dataBase64), MAX_VISUAL_PAYROLL_PAGES),
        extractPayrollPdfTextByPage(base64ToBytes(dataBase64), MAX_VISUAL_PAYROLL_PAGES)
          .catch(() => ({ pageCount: 0, pages: [] as string[] })),
      ]);
      imageUrls = preview.pages;
      visualPageCount = preview.pageCount;
      textPages = pageText.pages;
      if (activeIdRef.current === target.id) {
        setPdfPages(preview.pages);
        setPdfPageCount(preview.pageCount);
        setPdfTextPages(pageText.pages);
      }
    } else {
      const sourceDataUrl = `data:${mimeType};base64,${dataBase64}`;
      imageUrls = [await prepareImageForAnalysis(sourceDataUrl)];
      if (activeIdRef.current === target.id) setDocumentDataUrl(sourceDataUrl);
    }
    if (target.mediaKind === 'pdf' && visualPageCount > imageUrls.length) {
      throw new Error(`Ce PDF contient ${visualPageCount} pages, au-delà de la limite sûre de ${MAX_VISUAL_PAYROLL_PAGES} pages par fiche. Séparez-le en un document par fiche afin qu’aucune page ne soit ignorée.`);
    }
    if (!imageUrls.length) throw new Error('Aucune page visuelle exploitable n’a été préparée.');

    const pageBatches: Parameters<typeof combinePayrollAiPageBatches>[0] = [];
    let latestResult: Awaited<ReturnType<typeof payrollLocalAi.analyze>> | null = null;
    const totalBatches = Math.ceil(imageUrls.length / AI_PAGE_BATCH_SIZE);
    for (let offset = 0; offset < imageUrls.length; offset += AI_PAGE_BATCH_SIZE) {
      if (batchCancelRequested.current) throw new Error('Analyse locale annulée. Aucun brouillon IA incomplet n’a été enregistré.');
      const batchImages = imageUrls.slice(offset, offset + AI_PAGE_BATCH_SIZE);
      const pageStart = offset + 1;
      const pageEnd = offset + batchImages.length;
      const batchNumber = Math.floor(offset / AI_PAGE_BATCH_SIZE) + 1;
      setAiProgress({ label: `${queuePrefix}lot ${batchNumber}/${totalBatches} · pages ${pageStart}–${pageEnd} · deux passages du même modèle`, percent: Math.round(((batchNumber - 1) / totalBatches) * 100) });
      latestResult = await payrollLocalAi.analyze({
        imageUrls: batchImages,
        // PDF.js restitue la couche texte page par page : chaque lot ne voit
        // que ses pages et ne peut donc attribuer une valeur lointaine au lot.
        extractedText: target.mediaKind === 'pdf'
          ? payrollTextForPageBatch(textPages, pageStart, pageEnd) || (imageUrls.length === 1 ? target.extractedText : '')
          : target.extractedText,
        pageStart,
        pageEnd,
      });
      setAiMode(latestResult.mode);
      pageBatches.push({
        pageStart,
        pageEnd,
        analysis: reconcilePayrollAiPasses(
          latestResult.primaryRawOutput,
          latestResult.verifiedRawOutput,
        ),
      });
    }
    if (!latestResult) throw new Error('Aucun lot de pages n’a pu être analysé.');

    const combinedAiDraft = combinePayrollAiPageBatches(pageBatches);
    const analysisPasses = combinedAiDraft.validatedPasses;
    const aiDraft = {
      ...combinedAiDraft,
      draft: calibratePayrollAiDraftConfidence(combinedAiDraft.draft, combinedAiDraft.provenance, analysisPasses),
    };
    const match = findStrongEmployeeMatch(aiDraft.identity, workspace.employees);
    const preserveManualLink = employeeLinkSources[target.id] === 'manual';
    const employeeId = preserveManualLink ? employeeLinks[target.id] ?? '' : match.employeeId ?? '';
    const employeeLinkSource: 'manual' | 'auto' = preserveManualLink ? 'manual' : 'auto';
    const mergedDraft = mergePayrollImportDraft(mergeBase, aiDraft, confirmedAiFields[target.id]);
    const merged = markPayrollAiContributions(mergeBase, {
      ...mergedDraft,
      review: {
        ...mergedDraft.review,
        aiIdentityEvidence: aiDraft.identity,
        employeeId,
        employeeLinkSource,
      },
    });
    assertPayrollAnalysisDraftUnchanged(
      analysisSnapshot,
      draftRevisions.current[target.id] ?? 0,
    );
    const finalProvenance = payrollAiProvenanceForFinalDraft(
      merged,
      aiDraft.draft,
      aiDraft.provenance,
    );
    const confidenceBp = assessPayrollDraft(merged).scoreBp;
    const analysisManifest = payrollAnalysisManifestFromAi({
      draft: merged,
      provenance: finalProvenance,
      modelId: latestResult.modelId,
      modelRevision: latestResult.modelVersion,
      inputSha256: target.fileSha256,
      analyzedPageCount: imageUrls.length,
      passes: analysisPasses,
    });
    const saved = await desktopApi.updatePayrollImportDraft(target.id, merged, `smolvlm-500m-${latestResult.mode}-multipage-double-read-${analysisPasses}`, latestResult.modelVersion, confidenceBp, analysisManifest);
    setAiIdentityEvidence((current) => ({ ...current, [saved.id]: aiDraft.identity }));
    setAiProvenance((current) => ({ ...current, [saved.id]: payrollAiProvenanceFromManifest(saved.analysisManifest) ?? finalProvenance }));
    setEmployeeLinks((current) => ({ ...current, [saved.id]: employeeId }));
    setEmployeeLinkSources((current) => ({ ...current, [saved.id]: employeeLinkSource }));
    setEmployeeMatchNotes((current) => ({ ...current, [saved.id]: preserveManualLink ? 'Collaborateur choisi manuellement; ce choix ne sera jamais remplacé par l’IA.' : match.reason }));
    setImports((current) => current.map((item) => item.id === saved.id ? saved : item));
    setDrafts((current) => ({ ...current, [saved.id]: cloneDraft(saved.draft) }));
    dirtyDraftIds.current.delete(saved.id);
    setReviewed((current) => ({ ...current, [saved.id]: false }));
    setAiState('ready');
    setAiProgress({ label: `${queuePrefix}${imageUrls.length} page${imageUrls.length > 1 ? 's' : ''} analysée${imageUrls.length > 1 ? 's' : ''} · ${pageBatches.length} lot${pageBatches.length > 1 ? 's' : ''} · contrôle humain requis`, percent: 100 });
    return saved;
  }

  function cancelAiAnalysis() {
    batchCancelRequested.current = true;
    aiLoadedRef.current = false;
    payrollLocalAi.cancel();
  }

  async function analyzeCurrent() {
    if (!active || !draft) return;
    setLocalError('');
    batchCancelRequested.current = false;
    setReviewed((current) => ({ ...current, [active.id]: false }));
    try {
      await analyzeImport(active, draft);
    } catch (reason) {
      aiLoadedRef.current = false;
      setAiState(aiMode === 'unavailable' ? 'unavailable' : 'error');
      setLocalError(errorMessage(reason, "L'analyse SmolVLM locale a échoué."));
    }
  }

  async function analyzePendingQueue() {
    const queue = pendingLocalPayrollAiImports(imports);
    if (!queue.length) return;
    setLocalError('');
    batchCancelRequested.current = false;
    setBatchAnalysis({ status: 'running', processed: 0, completed: 0, total: queue.length, currentName: queue[0].sourceName, failures: [] });
    let processed = 0;
    let completed = 0;
    const failures: BatchAnalysisState['failures'] = [];

    try {
      await ensureAiLoaded();
      for (let index = 0; index < queue.length; index += 1) {
        if (batchCancelRequested.current) break;
        const target = queue[index];
        const queueIndex = imports.findIndex((item) => item.id === target.id);
        if (queueIndex >= 0) {
          activeIdRef.current = target.id;
          setActiveIndex(queueIndex);
        }
        setBatchAnalysis({ status: 'running', processed, completed, total: queue.length, currentName: target.sourceName, failures: [...failures] });
        try {
          await analyzeImport(target, cloneDraft(drafts[target.id] ?? target.draft), { current: index + 1, total: queue.length });
          completed += 1;
        } catch (reason) {
          if (batchCancelRequested.current) break;
          aiLoadedRef.current = false;
          failures.push({ id: target.id, sourceName: target.sourceName, message: errorMessage(reason, "L'analyse locale a échoué.") });
          setAiState('ready');
        }
        processed += 1;
        setBatchAnalysis({ status: 'running', processed, completed, total: queue.length, currentName: queue[index + 1]?.sourceName ?? '', failures: [...failures] });
      }
    } catch (reason) {
      aiLoadedRef.current = false;
      setAiState(aiMode === 'unavailable' ? 'unavailable' : 'error');
      const message = errorMessage(reason, "La file d'analyse locale n'a pas pu démarrer.");
      failures.push({ id: 'local-ai-engine', sourceName: 'Moteur IA local', message });
      setLocalError(message);
    }

    const cancelled = batchCancelRequested.current;
    setBatchAnalysis({ status: cancelled ? 'cancelled' : 'complete', processed, completed, total: queue.length, currentName: '', failures });
    if (cancelled) {
      setAiState(aiMode === 'unavailable' ? 'unavailable' : 'available');
      setAiProgress({ label: `Analyse arrêtée après ${completed}/${queue.length} fiche${queue.length > 1 ? 's' : ''}. Les brouillons terminés sont enregistrés.`, percent: Math.round((completed / queue.length) * 100) });
    } else if (!failures.length) {
      setAiState('ready');
      setAiProgress({ label: `${completed}/${queue.length} fiches analysées localement · contrôle humain requis`, percent: 100 });
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
    const hasReviewedRecurringEarnings = draft.lines.some((line) => (
      line.amountCents > 0 && isExplicitlyConfirmedRecurringLine(draft, line)
    ));
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
    if (!active || !window.confirm(`Écarter « ${active.sourceName} » de la file de contrôle ? Le fichier local restera dans la sauvegarde Zentra.`)) return;
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
          item.source.analysisManifest ?? undefined,
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
  const visualCoverageBlocker = !active
    ? ''
    : active.mediaKind === 'image'
      ? documentDataUrl ? '' : pdfPreviewError ? 'L’aperçu de l’image est indisponible : corrigez ou réimportez le document avant de confirmer.' : 'Attendez que l’image originale soit chargée avant de confirmer.'
      : !pdfPageCount
        ? pdfPreviewError ? 'L’aperçu du PDF est indisponible : corrigez ou réimportez le document avant de confirmer.' : 'Attendez que toutes les pages du PDF soient rendues localement avant de confirmer.'
        : pdfPageCount > pdfPages.length
          ? `Le document dépasse ${MAX_VISUAL_PAYROLL_PAGES} pages : séparez-le pour contrôler toutes les pages.`
          : '';
  const reviewBlockers = assessment ? [
    ...assessment.blockers,
    ...(!draft?.grossCents ? ['Saisissez le total brut exactement comme il est imprimé.'] : []),
    ...(!draft?.netCents ? ['Saisissez le net à payer exactement comme il est imprimé.'] : []),
    ...(visualCoverageBlocker ? [visualCoverageBlocker] : []),
  ] : [];
  const arithmeticOk = Boolean(assessment && !reviewBlockers.length);
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
  const hasRecurringEarnings = Boolean(draft?.lines.some((line) => (
    isExplicitlyConfirmedRecurringLine(draft, line)
  )));
  const interactionBusy = confirming || aiBusy || savingDrafts;
  const currentProvenance = active ? aiProvenance[active.id] : undefined;
  const currentAnalysisPasses = active?.analysisManifest?.passes ?? 0;
  const provenancePages = currentProvenance
    ? [...new Set([
      ...Object.values(currentProvenance.fields).flat(),
      ...currentProvenance.lines.flatMap((line) => line.pages),
    ])].sort((left, right) => left - right)
    : [];
  const evidencePagesForLine = (line: PayrollImportLineDraft, lineIndex: number) => {
    const matchesLine = (evidence: { label: string; kind: PayrollImportLineDraft['kind']; amountCents: number }) => (
      evidence.kind === line.kind
      && evidence.amountCents === line.amountCents
      && normalizedIdentity(evidence.label) === normalizedIdentity(line.label)
    );
    const manifestEvidence = active?.analysisManifest?.lineProvenance.find((evidence) => (
      evidence.lineIndex === lineIndex && matchesLine(evidence)
    ));
    if (manifestEvidence) return manifestEvidence.pages;
    const occurrenceIndex = (draft?.lines.slice(0, lineIndex + 1).filter((candidate) => (
      candidate.kind === line.kind
      && candidate.amountCents === line.amountCents
      && normalizedIdentity(candidate.label) === normalizedIdentity(line.label)
    )).length ?? 1) - 1;
    return currentProvenance?.lines.filter(matchesLine)[occurrenceIndex]?.pages ?? [];
  };
  const traceableLineCount = draft?.lines.filter((line) => line.label.trim()).length ?? 0;
  const sourcedLineCount = draft?.lines.filter((line, lineIndex) => (
    line.label.trim() && evidencePagesForLine(line, lineIndex).length
  )).length ?? 0;

  return <Modal title="Importer des fiches de salaire" description="Zentra effectue deux passages locaux du même modèle, affiche des indications de pages puis attend votre validation champ par champ." onClose={() => { if (!interactionBusy) void persistAndClose(); }} wide>
    <div className="payroll-import-shell">
      <section className="payroll-import-privacy"><ShieldCheck size={21} /><div><strong>Les salaires ne quittent jamais cet ordinateur</strong><p>Seul le modèle public est téléchargé une fois. Le PDF, l’image, la couche texte et le résultat restent dans les données locales Zentra.</p></div><span><HardDrive size={14} /> local</span></section>
      <div className="payroll-import-toolbar">
        <div className="payroll-import-toolbar__actions">
          <Button type="button" onClick={() => void chooseDocuments()} disabled={staging || aiBusy}>{staging ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} Ajouter PDF ou images</Button>
          {imports.length > 1 && pendingAiImports.length ? <Button type="button" variant="secondary" onClick={() => void analyzePendingQueue()} disabled={aiBusy || aiState === 'unavailable'}><Sparkles size={16} /> {batchAnalysis.status === 'cancelled' || batchAnalysis.failures.length ? 'Reprendre la file' : 'Analyser la file'} ({pendingAiImports.length})</Button> : null}
        </div>
        <div className={`ai-engine-state ai-engine-state--${aiState}`}><BrainCircuit size={17} /><span><strong>SmolVLM 500M · deux passages locaux</strong><small>{aiState === 'checking' ? 'Vérification du PC' : aiState === 'unavailable' ? 'Moteur local indisponible' : aiState === 'available' ? `Pack disponible · ${aiMode === 'webgpu' ? 'GPU' : 'CPU lent'}` : aiState === 'loading' ? `Installation locale · ${aiMode === 'webgpu' ? 'GPU' : 'CPU'}` : aiState === 'analyzing' ? `Deux passages du même modèle en cours · ${aiMode === 'webgpu' ? 'GPU' : 'CPU lent'}` : aiState === 'ready' ? `Prêt sur ce PC · ${aiMode === 'webgpu' ? 'GPU' : 'CPU'}` : 'Contrôle nécessaire'}</small></span></div>
      </div>
      {aiBusy ? <div className="ai-progress"><span><i style={{ width: aiProgress.percent === null ? '24%' : `${Math.max(2, Math.min(100, aiProgress.percent))}%` }} /></span><small>{aiProgress.label}{aiProgress.percent === null ? '' : ` · ${Math.round(aiProgress.percent)} %`}</small><Button type="button" variant="ghost" size="small" onClick={cancelAiAnalysis}>Annuler l’analyse</Button></div> : null}
      {batchAnalysis.status !== 'idle' && batchAnalysis.total ? <section className={`payroll-batch-status payroll-batch-status--${batchAnalysis.status}${batchAnalysis.failures.length ? ' has-failures' : ''}`}>
        <div><span><Files size={17} /><strong>Analyse groupée locale</strong></span><b>{batchAnalysis.processed}/{batchAnalysis.total} traités · {batchAnalysis.completed} réussis</b></div>
        <span className="payroll-batch-status__progress"><i style={{ width: `${Math.max(batchAnalysis.processed ? 4 : 0, (batchAnalysis.processed / batchAnalysis.total) * 100)}%` }} /></span>
        <p>{batchAnalysis.status === 'running' ? `Traitement séquentiel de « ${batchAnalysis.currentName} » pour protéger la mémoire du PC.` : batchAnalysis.status === 'cancelled' ? 'Analyse arrêtée. Chaque brouillon entièrement terminé avant l’arrêt a été enregistré.' : batchAnalysis.failures.length ? `${batchAnalysis.completed} fiche${batchAnalysis.completed > 1 ? 's ont' : ' a'} été préparée${batchAnalysis.completed > 1 ? 's' : ''}; ${batchAnalysis.failures.length} document${batchAnalysis.failures.length > 1 ? 's demandent' : ' demande'} une intervention.` : 'Toute la file a été préparée. Comparez maintenant chaque proposition au document original avant confirmation.'}</p>
        {batchAnalysis.failures.length ? <ul>{batchAnalysis.failures.map((failure) => <li key={failure.id}><strong>{failure.sourceName}</strong><span>{failure.message}</span></li>)}</ul> : null}
      </section> : null}
      {localError ? <ErrorPanel message={localError} /> : null}
      {!imports.length ? <section className="payroll-import-empty"><div><Files size={30} /></div><h3>Ajoutez les anciennes fiches de vos employés</h3><p>PDF natifs, scans, PNG, JPG et WEBP. Zentra détecte les doublons, lit d’abord le texte exact puis utilise SmolVLM pour comprendre la mise en page.</p><Button onClick={() => void chooseDocuments()} disabled={staging}><Upload size={16} /> Choisir les documents</Button></section> : active && draft && calculated ? <>
        <div className="payroll-import-queue">
          <Button variant="ghost" size="icon" disabled={interactionBusy || activeIndex === 0} onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}><ArrowLeft size={17} /></Button>
          <div><strong>{activeIndex + 1} / {imports.length} · {active.sourceName}</strong><small>{(active.fileSize / 1024 / 1024).toLocaleString('fr-CH', { maximumFractionDigits: 1 })} Mo · {hasCompletedLocalPayrollAiAnalysis(active) ? 'IA locale terminée · à vérifier' : active.extractionEngine === 'pdf_text' ? 'texte PDF lu localement' : 'analyse visuelle requise'} · qualité des contrôles {payrollControlQualityLabel(assessment?.scoreBp ?? 0)}</small></div>
          <Button variant="ghost" size="icon" disabled={interactionBusy || activeIndex >= imports.length - 1} onClick={() => setActiveIndex((index) => Math.min(imports.length - 1, index + 1))}><ArrowRight size={17} /></Button>
        </div>
        <div className="payroll-review-grid" inert={interactionBusy ? true : undefined} aria-busy={interactionBusy}>
          <section className="payroll-source-pane">
            <header><span><FileSearch size={17} /> Document original</span><strong>copie locale SHA‑256</strong></header>
            {active.mediaKind === 'image' && documentDataUrl ? <img src={documentDataUrl} alt={`Fiche importée ${active.sourceName}`} /> : active.mediaKind === 'pdf' && pdfPages.length ? <><img src={pdfPages[selectedPdfPage] ?? pdfPages[0]} alt={`Page ${selectedPdfPage + 1} de ${active.sourceName}`} />{pdfPages.length > 1 ? <div className="payroll-page-picker" aria-label="Pages du document">{pdfPages.map((page, index) => <button key={index} type="button" aria-current={selectedPdfPage === index ? 'page' : undefined} onClick={() => setSelectedPdfPage(index)}><img src={page} alt="" /><span>{index + 1}</span></button>)}</div> : null}{pdfPageCount > pdfPages.length ? <p className="payroll-page-note">{pdfPageCount} pages au total · analyse bloquée pour éviter d’ignorer les pages après la {pdfPages.length}. Séparez le fichier.</p> : <p className="payroll-page-note">{pdfPages.length} page{pdfPages.length > 1 ? 's' : ''} · couverture visuelle complète par lots de trois · texte local disponible sur {pdfTextPages.filter(Boolean).length}/{pdfPages.length} page{pdfPages.length > 1 ? 's' : ''}.</p>}</> : <div className="payroll-pdf-loading">{pdfPreviewError ? <><AlertTriangle size={18} /><span>{pdfPreviewError}</span></> : <><LoaderCircle className="spin" size={18} /><span>Rendu local des pages…</span></>}</div>}
            <div className="source-hash">{active.fileSha256.slice(0, 20)}…</div>
          </section>
          <section className="payroll-review-pane">
            <header><div><span>1</span><div><strong>Identité et période</strong><small>Valeurs proposées, toutes modifiables</small></div></div><Button type="button" variant="secondary" size="small" disabled={aiBusy || aiState === 'unavailable'} onClick={() => void analyzeCurrent()}>{aiBusy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} {active.extractionEngine.startsWith('smolvlm') ? 'Relancer l’IA locale' : 'Analyser avec l’IA locale'}</Button></header>
            {aiState === 'unavailable' ? <div className="inline-warning"><AlertTriangle size={16} /><span>Le moteur local n’est pas disponible. Vous pouvez quand même contrôler et compléter les données extraites du PDF.</span></div> : aiMode === 'wasm' ? <div className="inline-warning"><AlertTriangle size={16} /><span>Mode CPU local actif : l’analyse peut prendre plusieurs minutes, mais aucun document ne quitte ce PC.</span></div> : null}
            {currentProvenance ? <div className="payroll-evidence-summary"><div><ShieldCheck size={16} /><span><strong>{provenancePages.length} indication{provenancePages.length > 1 ? 's' : ''} de page</strong><small>{currentAnalysisPasses >= 2 ? 'Pages proposées par deux passages du même modèle' : 'Pages proposées par un seul passage JSON exploitable'}</small></span></div><div><FileSearch size={16} /><span><strong>{sourcedLineCount}/{traceableLineCount} rubrique{sourcedLineCount > 1 ? 's' : ''} avec indication</strong><small>Un clic sur « p. » ouvre la page originale à contrôler</small></span></div></div> : null}
            <div className="form-grid payroll-review-fields"><Field label="Collaborateur" required><input value={draft.employee.name} onChange={(event) => patchEmployee({ name: event.target.value })} /></Field><Field label="N° employé"><input value={draft.employee.employeeNumber} onChange={(event) => patchEmployee({ employeeNumber: event.target.value })} /></Field><Field label="Fonction"><input value={draft.employee.role} onChange={(event) => patchEmployee({ role: event.target.value })} /></Field><Field label="Taux d’activité (%)" required><input type="number" min="1" max="100" value={draft.employee.employmentRate} onChange={(event) => { setConfirmedAiFields((current) => ({ ...current, [active.id]: { ...current[active.id], employmentRate: true } })); patchEmployee({ employmentRate: Math.min(100, Math.max(1, event.target.valueAsNumber || 100)) }); }} /></Field><Field label="Période" required><input type="month" value={draft.period} onChange={(event) => updateDraft((current) => ({ ...current, period: event.target.value }))} /></Field><Field label="Date de paiement"><input type="date" value={draft.paymentDate} onChange={(event) => updateDraft((current) => ({ ...current, paymentDate: event.target.value }))} /></Field><Field label="N° AVS"><input value={draft.employee.avsNumber} onChange={(event) => patchEmployee({ avsNumber: event.target.value })} /></Field><Field label="IBAN de l’employé"><input value={draft.employee.iban} onChange={(event) => patchEmployee({ iban: event.target.value })} /></Field><Field label="Rue" wide><input value={draft.employee.addressLine1} onChange={(event) => patchEmployee({ addressLine1: event.target.value })} /></Field><Field label="Complément"><input value={draft.employee.addressLine2} onChange={(event) => patchEmployee({ addressLine2: event.target.value })} /></Field><Field label="NPA"><input value={draft.employee.postalCode} onChange={(event) => patchEmployee({ postalCode: event.target.value })} /></Field><Field label="Localité"><input value={draft.employee.city} onChange={(event) => patchEmployee({ city: event.target.value })} /></Field><Field label="Canton"><input maxLength={2} value={draft.employee.canton} onChange={(event) => patchEmployee({ canton: event.target.value.toUpperCase() })} /></Field><Field label="Mode de salaire"><select value={draft.employee.salaryMode} onChange={(event) => { setConfirmedAiFields((current) => ({ ...current, [active.id]: { ...current[active.id], salaryMode: true } })); patchEmployee({ salaryMode: event.target.value as PayrollImportEmployeeDraft['salaryMode'] }); }}><option value="monthly">Mensuel</option><option value="hourly">Horaire</option></select></Field></div>
            <header className="payroll-lines-heading"><div><span>2</span><div><strong>Rubriques et montants</strong><small>L’IA ne choisit aucun taux légal à votre place</small></div></div><Button type="button" variant="secondary" size="small" onClick={() => updateDraft((current) => ({ ...current, lines: [...current.lines, { id: createId(), label: '', kind: 'earning', amountCents: 0, recurring: false, confidenceBp: 10_000 }] }))}><Plus size={14} /> Ajouter</Button></header>
            <div className="imported-pay-lines">{draft.lines.map((line, lineIndex) => { const pages = evidencePagesForLine(line, lineIndex); return <div key={line.id}><select value={line.kind} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, kind: event.target.value as PayrollImportLineDraft['kind'], recurring: event.target.value === 'earning' ? candidate.recurring : false, confidenceBp: 10_000 } : candidate) }))}><option value="earning">Gain soumis au brut</option><option value="deduction">Retenue employé</option><option value="reimbursement">Remboursement hors brut</option><option value="employer">Charge employeur</option></select><input value={line.label} placeholder="Libellé" onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, label: event.target.value, confidenceBp: 10_000 } : candidate) }))} /><label className="money-input"><input type="number" min="0" step="0.01" value={line.amountCents ? line.amountCents / 100 : ''} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, amountCents: Math.round((event.target.valueAsNumber || 0) * 100), confidenceBp: 10_000 } : candidate) }))} /><span>CHF</span></label><div className={`payroll-line-evidence ${pages.length ? 'has-source' : ''}`} title="Catégorie de traçabilité indicative, sans effet sur votre validation humaine"><span>{pages.length ? `Traçabilité ${payrollControlQualityLabel(line.confidenceBp)}` : line.confidenceBp === 10_000 ? 'Saisi manuellement' : `Traçabilité ${payrollControlQualityLabel(line.confidenceBp)} · sans page`}</span>{pages.map((page) => <button type="button" key={page} onClick={() => setSelectedPdfPage(Math.max(0, page - 1))} aria-label={`Afficher la page ${page} du document original`}>p. {page}</button>)}</div><label className="recurring-check"><input type="checkbox" checked={isExplicitlyConfirmedRecurringLine(draft, line)} disabled={line.kind !== 'earning'} onChange={(event) => updateDraft((current) => { const currentLine = current.lines.find((candidate) => candidate.id === line.id); const retained = (current.review?.confirmedRecurringLines ?? []).filter((confirmed) => confirmed.lineId ? confirmed.lineId !== line.id : !(confirmed.label === currentLine?.label && confirmed.kind === 'earning' && confirmed.amountCents === currentLine?.amountCents)); const confirmedRecurringLines = event.target.checked && currentLine ? [...retained, { lineId: currentLine.id, label: currentLine.label, kind: 'earning' as const, amountCents: currentLine.amountCents }] : retained; return { ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, recurring: event.target.checked } : candidate), review: { employeeId: '', employeeLinkSource: '', ...current.review, confirmedRecurringLines } }; })} /><span>Récurrent</span></label><Button type="button" variant="ghost" size="icon" onClick={() => updateDraft((current) => ({ ...current, lines: current.lines.filter((candidate) => candidate.id !== line.id) }))}><Trash2 size={15} /></Button></div>; })}</div>
            <div className="form-grid payroll-review-fields"><Field label="Total brut imprimé" required><label className="money-input"><input type="number" min="0" step="0.01" value={draft.grossCents ? draft.grossCents / 100 : ''} onChange={(event) => updateDraft((current) => ({ ...current, grossCents: Math.round((event.target.valueAsNumber || 0) * 100) }))} /><span>CHF</span></label></Field><Field label="Net à payer imprimé" required><label className="money-input"><input type="number" min="0" step="0.01" value={draft.netCents ? draft.netCents / 100 : ''} onChange={(event) => updateDraft((current) => ({ ...current, netCents: Math.round((event.target.valueAsNumber || 0) * 100) }))} /><span>CHF</span></label></Field></div>
            <div className={`payroll-import-equation ${arithmeticOk ? 'is-valid' : 'is-error'}`}><div><span>Brut</span><strong>{formatMoney(calculated.gross)}</strong></div><i>−</i><div><span>Retenues</span><strong>{formatMoney(calculated.deductions)}</strong></div><i>+</i><div><span>Remboursements</span><strong>{formatMoney(calculated.reimbursements)}</strong></div><i>=</i><div><span>Net recalculé</span><strong>{formatMoney(calculated.net)}</strong></div><div className="printed-values"><span>Imprimé · brut {draft.grossCents ? formatMoney(draft.grossCents) : 'non détecté'}</span><span>Imprimé · net {draft.netCents ? formatMoney(draft.netCents) : 'non détecté'}</span></div>{arithmeticOk ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</div>
            {assessment ? <div className="payroll-quality"><header><div><strong>Contrôles déterministes</strong><small>Qualité des contrôles {payrollControlQualityLabel(assessment.scoreBp)} · cette catégorie ne remplace pas votre vérification</small></div><span>{reviewBlockers.length ? `${reviewBlockers.length} correction${reviewBlockers.length > 1 ? 's' : ''}` : 'Contrôles passés'}</span></header><div className="payroll-quality__checks">{assessment.checks.map((check) => <div className={check.ok ? 'is-valid' : 'is-error'} key={check.label}>{check.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>{reviewBlockers.length ? <div className="payroll-quality__blockers"><strong>À corriger avant confirmation</strong>{reviewBlockers.map((blocker) => <p key={blocker}><AlertTriangle size={14} /> {blocker}</p>)}</div> : null}</div> : null}
            {draft.warnings.length || assessment?.warnings.length ? <div className="payroll-import-warnings"><strong>Points à vérifier</strong>{[...new Set([...draft.warnings, ...(assessment?.warnings ?? [])])].map((warning, index) => <p key={`${warning}-${index}`}><AlertTriangle size={14} /> {warning}</p>)}</div> : null}
            <header className="payroll-lines-heading"><div><span>3</span><div><strong>Rattachement et confirmation</strong><small>La fiche créée restera « à contrôler »</small></div></div></header>
            <Field label="Rattacher à un collaborateur"><select value={employeeLinks[active.id] ?? ''} onChange={(event) => { const employeeId = event.target.value; setEmployeeLinks((current) => ({ ...current, [active.id]: employeeId })); setEmployeeLinkSources((current) => ({ ...current, [active.id]: 'manual' })); setEmployeeMatchNotes((current) => ({ ...current, [active.id]: employeeId ? 'Collaborateur choisi manuellement; ce choix ne sera jamais remplacé par l’IA.' : 'Création d’un nouveau collaborateur choisie manuellement.' })); setReplaceTemplates((current) => ({ ...current, [active.id]: false })); updateDraft((current) => ({ ...current, review: { ...current.review, employeeId, employeeLinkSource: 'manual' } })); }}><option value="">Créer un nouveau collaborateur avec les champs ci-dessus</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select></Field>
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

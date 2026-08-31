import { useEffect, useMemo, useState } from 'react';
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
import { renderFirstPdfPage } from './localPdfPreview';
import { payrollLocalAi, type PayrollAiMode, type PayrollAiProgress } from './payrollLocalAi';
import type {
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
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const numberValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;

function parseAiJson(raw: string): PayrollImportDraft {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const starts = [...cleaned.matchAll(/\{/g)].map((match) => match.index ?? 0).reverse();
  let parsed: Record<string, unknown> | null = null;
  for (const start of starts) {
    for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
      try {
        const candidate = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
        const row = recordValue(candidate);
        if (Object.keys(row).length) { parsed = row; break; }
      } catch {
        // Continue with the previous closing brace; model output can contain a short prefix.
      }
    }
    if (parsed) break;
  }
  if (!parsed) throw new Error("SmolVLM n'a pas renvoyé le JSON strict attendu. Relancez l'analyse ou saisissez les champs manuellement.");
  const employee = recordValue(parsed.employee);
  const lines = Array.isArray(parsed.lines) ? parsed.lines.map(recordValue) : [];
  const salaryMode = textValue(employee.salary_mode ?? employee.salaryMode);
  const normalized: PayrollImportDraft = {
    employee: {
      employeeNumber: textValue(employee.employee_number ?? employee.employeeNumber),
      name: textValue(employee.name),
      role: textValue(employee.role),
      addressLine1: textValue(employee.address_line1 ?? employee.addressLine1),
      addressLine2: textValue(employee.address_line2 ?? employee.addressLine2),
      postalCode: textValue(employee.postal_code ?? employee.postalCode),
      city: textValue(employee.city),
      canton: textValue(employee.canton).toUpperCase(),
      birthDate: textValue(employee.birth_date ?? employee.birthDate),
      avsNumber: textValue(employee.avs_number ?? employee.avsNumber),
      iban: textValue(employee.iban).replace(/\s/g, '').toUpperCase(),
      employmentRate: Math.min(100, Math.max(1, numberValue(employee.employment_rate ?? employee.employmentRate) || 100)),
      salaryMode: salaryMode === 'hourly' ? 'hourly' : 'monthly',
    },
    period: textValue(parsed.period),
    paymentDate: textValue(parsed.payment_date ?? parsed.paymentDate),
    grossCents: Math.max(0, numberValue(parsed.gross_cents ?? parsed.grossCents)),
    netCents: Math.max(0, numberValue(parsed.net_cents ?? parsed.netCents)),
    lines: lines.slice(0, 80).map((line): PayrollImportLineDraft => {
      const kind = textValue(line.kind);
      return {
        id: createId(),
        label: textValue(line.label),
        kind: kind === 'deduction' || kind === 'employer' ? kind : 'earning',
        amountCents: Math.max(0, numberValue(line.amount_cents ?? line.amountCents)),
        recurring: line.recurring === true,
        confidenceBp: Math.min(10_000, Math.max(0, numberValue(line.confidence_bp ?? line.confidenceBp))),
      };
    }).filter((line) => line.label && line.amountCents > 0),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(textValue).filter(Boolean).slice(0, 30) : [],
  };
  return normalized;
}

function mergeDraft(current: PayrollImportDraft, ai: PayrollImportDraft): PayrollImportDraft {
  const pick = (existing: string, detected: string) => existing.trim() || detected.trim();
  const employee: PayrollImportEmployeeDraft = {
    employeeNumber: pick(current.employee.employeeNumber, ai.employee.employeeNumber),
    name: pick(current.employee.name, ai.employee.name),
    role: pick(current.employee.role, ai.employee.role),
    addressLine1: pick(current.employee.addressLine1, ai.employee.addressLine1),
    addressLine2: pick(current.employee.addressLine2, ai.employee.addressLine2),
    postalCode: pick(current.employee.postalCode, ai.employee.postalCode),
    city: pick(current.employee.city, ai.employee.city),
    canton: pick(current.employee.canton, ai.employee.canton),
    birthDate: pick(current.employee.birthDate, ai.employee.birthDate),
    avsNumber: pick(current.employee.avsNumber, ai.employee.avsNumber),
    iban: pick(current.employee.iban, ai.employee.iban),
    employmentRate: current.employee.employmentRate || ai.employee.employmentRate || 100,
    salaryMode: current.employee.salaryMode || ai.employee.salaryMode,
  };
  const grossCents = current.grossCents || ai.grossCents;
  const netCents = current.netCents || ai.netCents;
  const lines = ai.lines.length ? ai.lines : current.lines;
  const warnings = [...new Set([
    ...current.warnings,
    ...ai.warnings,
    ...(current.grossCents && ai.grossCents && current.grossCents !== ai.grossCents ? ['Le brut lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
    ...(current.netCents && ai.netCents && current.netCents !== ai.netCents ? ['Le net lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
  ])];
  return { employee, period: pick(current.period, ai.period), paymentDate: pick(current.paymentDate, ai.paymentDate), grossCents, netCents, lines, warnings };
}

function totals(draft: PayrollImportDraft) {
  const gross = draft.lines.filter((line) => line.kind === 'earning').reduce((sum, line) => sum + line.amountCents, 0);
  const deductions = draft.lines.filter((line) => line.kind === 'deduction').reduce((sum, line) => sum + line.amountCents, 0);
  const employer = draft.lines.filter((line) => line.kind === 'employer').reduce((sum, line) => sum + line.amountCents, 0);
  return { gross, deductions, employer, net: gross - deductions };
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
  const [employeeLinks, setEmployeeLinks] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [staging, setStaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [aiState, setAiState] = useState<AiState>('checking');
  const [aiMode, setAiMode] = useState<PayrollAiMode>('unavailable');
  const [aiProgress, setAiProgress] = useState<PayrollAiProgress>({ label: 'Vérification de WebGPU…', percent: null });
  const [localError, setLocalError] = useState('');
  const [documentDataUrl, setDocumentDataUrl] = useState('');
  const [pdfPreview, setPdfPreview] = useState('');
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
    if (!active || employeeLinks[active.id] !== undefined) return;
    const avs = normalizedIdentity(draft?.employee.avsNumber ?? '');
    const name = normalizedIdentity(draft?.employee.name ?? '');
    const match = workspace.employees.find((employee) => avs && normalizedIdentity(employee.avsNumber) === avs)
      ?? workspace.employees.find((employee) => name && normalizedIdentity(employee.name) === name);
    setEmployeeLinks((current) => ({ ...current, [active.id]: match?.id ?? '' }));
  }, [active, draft?.employee.avsNumber, draft?.employee.name, employeeLinks, workspace.employees]);

  useEffect(() => {
    let cancelled = false;
    setDocumentDataUrl('');
    setPdfPreview('');
    setPdfPreviewError('');
    if (!active) return () => { cancelled = true; };
    void desktopApi.getPayrollDocumentPreview(active.id)
      .then(async ({ mimeType, dataBase64 }) => {
        if (cancelled) return;
        const dataUrl = `data:${mimeType};base64,${dataBase64}`;
        setDocumentDataUrl(dataUrl);
        if (active.mediaKind === 'pdf') {
          const preview = await renderFirstPdfPage(base64ToBytes(dataBase64));
          if (!cancelled) setPdfPreview(preview);
        }
      })
      .catch((reason) => { if (!cancelled) setPdfPreviewError(errorMessage(reason, "L’aperçu local du PDF n’a pas pu être rendu.")); });
    return () => { cancelled = true; };
  }, [active?.id, active?.mediaKind]);

  function updateDraft(mutator: (current: PayrollImportDraft) => PayrollImportDraft) {
    if (!active || !draft) return;
    setDrafts((current) => ({ ...current, [active.id]: mutator(cloneDraft(current[active.id] ?? draft)) }));
    setReviewed((current) => ({ ...current, [active.id]: false }));
  }

  function patchEmployee(patch: Partial<PayrollImportEmployeeDraft>) {
    updateDraft((current) => ({ ...current, employee: { ...current.employee, ...patch } }));
  }

  async function chooseDocuments() {
    setLocalError('');
    const paths = await desktopApi.choosePayrollDocuments();
    if (!paths.length) return;
    setStaging(true);
    try {
      const staged = await desktopApi.stagePayrollDocuments(paths);
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
    try {
      await ensureAiLoaded();
      setAiState('analyzing');
      setAiProgress({ label: `Analyse locale de ${active.sourceName}`, percent: null });
      let imageUrl = active.mediaKind === 'pdf' ? pdfPreview : documentDataUrl;
      if (!imageUrl) {
        const { mimeType, dataBase64 } = await desktopApi.getPayrollDocumentPreview(active.id);
        imageUrl = active.mediaKind === 'pdf'
          ? await renderFirstPdfPage(base64ToBytes(dataBase64))
          : `data:${mimeType};base64,${dataBase64}`;
      }
      const result = await payrollLocalAi.analyze({ imageUrl, extractedText: active.extractedText });
      setAiMode(result.mode);
      const aiDraft = parseAiJson(result.rawOutput);
      const merged = mergeDraft(draft, aiDraft);
      const values = [aiDraft.grossCents > 0, aiDraft.netCents > 0, Boolean(aiDraft.period), Boolean(aiDraft.employee.name), aiDraft.lines.length > 0];
      const confidenceBp = Math.round(values.filter(Boolean).length / values.length * 10_000);
      const saved = await desktopApi.updatePayrollImportDraft(active.id, merged, 'smolvlm-500m-webgpu', result.modelVersion, confidenceBp);
      setImports((current) => current.map((item) => item.id === saved.id ? saved : item));
      setDrafts((current) => ({ ...current, [saved.id]: cloneDraft(saved.draft) }));
      setAiState('ready');
      setAiProgress({ label: 'Analyse terminée — contrôle humain requis', percent: 100 });
    } catch (reason) {
      setAiState(aiState === 'unavailable' ? 'unavailable' : 'error');
      setLocalError(errorMessage(reason, "L'analyse SmolVLM locale a échoué."));
    }
  }

  async function confirmCurrent() {
    if (!active || !draft || !reviewed[active.id]) return;
    setLocalError('');
    setConfirming(true);
    const linkedEmployee = employeeLinks[active.id] || undefined;
    const ok = await act(
      () => desktopApi.confirmPayrollDocumentImport(active.id, draft, linkedEmployee),
      linkedEmployee ? 'La fiche importée a été rattachée au collaborateur et reste à contrôler.' : 'Le collaborateur, son modèle et la fiche à contrôler ont été créés.',
      false,
    );
    if (ok) {
      const remaining = imports.filter((item) => item.id !== active.id);
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
      setImports(remaining);
      setActiveIndex((index) => Math.min(index, Math.max(0, remaining.length - 1)));
    }
  }

  const calculated = draft ? totals(draft) : null;
  const arithmeticOk = Boolean(draft && calculated && (!draft.grossCents || Math.abs(draft.grossCents - calculated.gross) <= 2) && (!draft.netCents || Math.abs(draft.netCents - calculated.net) <= 2));
  const aiBusy = aiState === 'loading' || aiState === 'analyzing';

  return <Modal title="Importer des fiches de salaire" description="Elyko lit les documents sur ce PC, propose un brouillon puis attend votre validation champ par champ." onClose={close} wide>
    <div className="payroll-import-shell">
      <section className="payroll-import-privacy"><ShieldCheck size={21} /><div><strong>Les salaires ne quittent jamais cet ordinateur</strong><p>Seul le modèle public est téléchargé une fois. Le PDF, l’image, le texte OCR et le résultat restent dans les données locales Elyko.</p></div><span><HardDrive size={14} /> local</span></section>
      <div className="payroll-import-toolbar">
        <Button type="button" onClick={() => void chooseDocuments()} disabled={staging || aiBusy}>{staging ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} Ajouter PDF ou images</Button>
        <div className={`ai-engine-state ai-engine-state--${aiState}`}><BrainCircuit size={17} /><span><strong>SmolVLM 500M local</strong><small>{aiState === 'checking' ? 'Vérification du PC' : aiState === 'unavailable' ? 'Moteur local indisponible' : aiState === 'available' ? `Pack disponible · ${aiMode === 'webgpu' ? 'GPU' : 'CPU lent'}` : aiState === 'loading' ? `Installation locale · ${aiMode === 'webgpu' ? 'GPU' : 'CPU'}` : aiState === 'analyzing' ? `Analyse locale · ${aiMode === 'webgpu' ? 'GPU' : 'CPU lent'}` : aiState === 'ready' ? `Prêt sur ce PC · ${aiMode === 'webgpu' ? 'GPU' : 'CPU'}` : 'Contrôle nécessaire'}</small></span></div>
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
            {active.mediaKind === 'image' && documentDataUrl ? <img src={documentDataUrl} alt={`Fiche importée ${active.sourceName}`} /> : active.mediaKind === 'pdf' && pdfPreview ? <img src={pdfPreview} alt={`Première page de ${active.sourceName}`} /> : <div className="payroll-pdf-loading">{pdfPreviewError ? <><AlertTriangle size={18} /><span>{pdfPreviewError}</span></> : <><LoaderCircle className="spin" size={18} /><span>Rendu local de la première page…</span></>}</div>}
            <div className="source-hash">{active.fileSha256.slice(0, 20)}…</div>
          </section>
          <section className="payroll-review-pane">
            <header><div><span>1</span><div><strong>Identité et période</strong><small>Valeurs proposées, toutes modifiables</small></div></div><Button type="button" variant="secondary" size="small" disabled={aiBusy || aiState === 'unavailable'} onClick={() => void analyzeCurrent()}>{aiBusy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} {active.extractionEngine.startsWith('smolvlm') ? 'Relancer l’IA locale' : 'Analyser avec l’IA locale'}</Button></header>
            {aiState === 'unavailable' ? <div className="inline-warning"><AlertTriangle size={16} /><span>Le moteur local n’est pas disponible. Vous pouvez quand même contrôler et compléter les données extraites du PDF.</span></div> : aiMode === 'wasm' ? <div className="inline-warning"><AlertTriangle size={16} /><span>Mode CPU local actif : l’analyse peut prendre plusieurs minutes, mais aucun document ne quitte ce PC.</span></div> : null}
            <div className="form-grid payroll-review-fields"><Field label="Collaborateur" required><input value={draft.employee.name} onChange={(event) => patchEmployee({ name: event.target.value })} /></Field><Field label="N° employé"><input value={draft.employee.employeeNumber} onChange={(event) => patchEmployee({ employeeNumber: event.target.value })} /></Field><Field label="Fonction"><input value={draft.employee.role} onChange={(event) => patchEmployee({ role: event.target.value })} /></Field><Field label="Taux d’activité (%)" required><input type="number" min="1" max="100" value={draft.employee.employmentRate} onChange={(event) => patchEmployee({ employmentRate: Math.min(100, Math.max(1, event.target.valueAsNumber || 100)) })} /></Field><Field label="Période" required><input type="month" value={draft.period} onChange={(event) => updateDraft((current) => ({ ...current, period: event.target.value }))} /></Field><Field label="Date de paiement"><input type="date" value={draft.paymentDate} onChange={(event) => updateDraft((current) => ({ ...current, paymentDate: event.target.value }))} /></Field><Field label="N° AVS"><input value={draft.employee.avsNumber} onChange={(event) => patchEmployee({ avsNumber: event.target.value })} /></Field><Field label="IBAN de l’employé"><input value={draft.employee.iban} onChange={(event) => patchEmployee({ iban: event.target.value })} /></Field><Field label="Rue" wide><input value={draft.employee.addressLine1} onChange={(event) => patchEmployee({ addressLine1: event.target.value })} /></Field><Field label="Complément"><input value={draft.employee.addressLine2} onChange={(event) => patchEmployee({ addressLine2: event.target.value })} /></Field><Field label="NPA"><input value={draft.employee.postalCode} onChange={(event) => patchEmployee({ postalCode: event.target.value })} /></Field><Field label="Localité"><input value={draft.employee.city} onChange={(event) => patchEmployee({ city: event.target.value })} /></Field><Field label="Canton"><input maxLength={2} value={draft.employee.canton} onChange={(event) => patchEmployee({ canton: event.target.value.toUpperCase() })} /></Field><Field label="Mode de salaire"><select value={draft.employee.salaryMode} onChange={(event) => patchEmployee({ salaryMode: event.target.value as PayrollImportEmployeeDraft['salaryMode'] })}><option value="monthly">Mensuel</option><option value="hourly">Horaire</option></select></Field></div>
            <header className="payroll-lines-heading"><div><span>2</span><div><strong>Rubriques et montants</strong><small>L’IA ne choisit aucun taux légal à votre place</small></div></div><Button type="button" variant="secondary" size="small" onClick={() => updateDraft((current) => ({ ...current, lines: [...current.lines, { id: createId(), label: '', kind: 'earning', amountCents: 0, recurring: false, confidenceBp: 10_000 }] }))}><Plus size={14} /> Ajouter</Button></header>
            <div className="imported-pay-lines">{draft.lines.map((line) => <div key={line.id}><select value={line.kind} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, kind: event.target.value as PayrollImportLineDraft['kind'] } : candidate) }))}><option value="earning">Gain</option><option value="deduction">Retenue employé</option><option value="employer">Charge employeur</option></select><input value={line.label} placeholder="Libellé" onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, label: event.target.value } : candidate) }))} /><label className="money-input"><input type="number" min="0" step="0.01" value={line.amountCents ? line.amountCents / 100 : ''} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, amountCents: Math.round((event.target.valueAsNumber || 0) * 100) } : candidate) }))} /><span>CHF</span></label><label className="recurring-check"><input type="checkbox" checked={line.recurring} disabled={line.kind !== 'earning'} onChange={(event) => updateDraft((current) => ({ ...current, lines: current.lines.map((candidate) => candidate.id === line.id ? { ...candidate, recurring: event.target.checked } : candidate) }))} /><span>Récurrent</span></label><Button type="button" variant="ghost" size="icon" onClick={() => updateDraft((current) => ({ ...current, lines: current.lines.filter((candidate) => candidate.id !== line.id) }))}><Trash2 size={15} /></Button></div>)}</div>
            <div className={`payroll-import-equation ${arithmeticOk ? 'is-valid' : 'is-error'}`}><div><span>Gains</span><strong>{formatMoney(calculated.gross)}</strong></div><i>−</i><div><span>Retenues</span><strong>{formatMoney(calculated.deductions)}</strong></div><i>=</i><div><span>Net recalculé</span><strong>{formatMoney(calculated.net)}</strong></div><div className="printed-values"><span>Imprimé · brut {draft.grossCents ? formatMoney(draft.grossCents) : 'non détecté'}</span><span>Imprimé · net {draft.netCents ? formatMoney(draft.netCents) : 'non détecté'}</span></div>{arithmeticOk ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</div>
            {draft.warnings.length ? <div className="payroll-import-warnings"><strong>Points à vérifier</strong>{draft.warnings.map((warning, index) => <p key={`${warning}-${index}`}><AlertTriangle size={14} /> {warning}</p>)}</div> : null}
            <header className="payroll-lines-heading"><div><span>3</span><div><strong>Rattachement et confirmation</strong><small>La fiche créée restera « à contrôler »</small></div></div></header>
            <Field label="Rattacher à un collaborateur"><select value={employeeLinks[active.id] ?? ''} onChange={(event) => setEmployeeLinks((current) => ({ ...current, [active.id]: event.target.value }))}><option value="">Créer un nouveau collaborateur avec les champs ci-dessus</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select></Field>
            {employeeLinks[active.id] ? <p className="link-note">Le profil du collaborateur existant ne sera pas écrasé. Seule la fiche et un modèle de gains récurrents contrôlé seront ajoutés.</p> : null}
            <label className={`review-confirmation ${reviewed[active.id] ? 'is-checked' : ''}`}><input type="checkbox" checked={Boolean(reviewed[active.id])} onChange={(event) => setReviewed((current) => ({ ...current, [active.id]: event.target.checked }))} /><span><strong>J’ai comparé les champs et montants au document original</strong><small>Je comprends que SmolVLM peut se tromper et qu’aucune cotisation manquante ne sera inventée.</small></span></label>
          </section>
        </div>
        <footer className="payroll-import-actions"><Button type="button" variant="ghost" onClick={() => void rejectCurrent()} disabled={confirming || aiBusy}><Trash2 size={15} /> Écarter ce document</Button><span /><Button type="button" variant="secondary" onClick={close} disabled={confirming || aiBusy}>Continuer plus tard</Button><Button type="button" onClick={() => void confirmCurrent()} disabled={!reviewed[active.id] || !arithmeticOk || confirming || aiBusy}>{confirming ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />} Confirmer et créer à contrôler</Button></footer>
      </> : null}
    </div>
  </Modal>;
}

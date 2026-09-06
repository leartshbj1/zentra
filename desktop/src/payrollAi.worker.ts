/// <reference lib="webworker" />
import { PayslipQwen } from './payrollQwen';
import { readPayslipImages } from './payrollOcr';
import { employeeDocumentDraft } from './employeeDocumentDraft';
import { payrollCoreFromLocalText, payrollLinesFromLocalText } from './payrollAiTextFallback';
import { PAYROLL_AI_MODEL_ID, PAYROLL_AI_MODEL_REVISION } from './payrollAiModel';

type Request = { type: 'check' | 'load' | 'analyze'; requestId?: string; imageUrls?: string[]; extractedText?: string; pageStart?: number; assetBase?: string };
let engine: PayslipQwen | null = null;
let busy = false;
const post = (value: Record<string, unknown>) => self.postMessage(value);
self.onmessage = async ({ data }: MessageEvent<Request>) => {
  if (data.type === 'check') { post({ type: 'check', mode: typeof WebAssembly === 'undefined' ? 'unavailable' : 'wasm' }); return; }
  if (busy) { post({ type: data.type === 'load' ? 'load_error' : 'analysis_error', requestId: data.requestId, error: 'Une lecture est déjà en cours. Patientez ou annulez-la.' }); return; }
  busy = true;
  const progress = (label: string, percent: number | null) => post({ type: 'analysis_stage', requestId: data.requestId, label, percent });
  try {
    let text = data.extractedText?.trim() ?? '';
    let corroboratingText: string | undefined;
    if (data.type === 'analyze' && text.replace(/\s/g, '').length < 80) {
      // OCR is released before loading the language model to limit peak memory.
      const ocr = await readPayslipImages(data.imageUrls?.slice(0, 3) ?? [], data.assetBase ?? new URL('../', self.location.href).href, progress);
      text = ocr.text; corroboratingText = ocr.corroboratingText;
    }
    if (data.type === 'analyze' && text.replace(/\s/g, '').length < 30) throw new Error('Le document est illisible. Choisissez une photo plus nette ou un PDF.');
    engine ??= new PayslipQwen();
    await engine.load(progress);
    if (data.type === 'load') { post({ type: 'ready', mode: engine.mode }); return; }
    const raw = await engine.extract(text, progress);
    const employeeDraft = employeeDocumentDraft(raw, text);
    if (corroboratingText !== undefined) {
      const confirmation = employeeDocumentDraft('{}', corroboratingText);
      for (const field of ['grossSalary', 'employmentRate'] as const) {
        if (employeeDraft.fields[field] && employeeDraft.fields[field] !== confirmation.fields[field]) {
          delete employeeDraft.fields[field];
          if (field === 'grossSalary') delete employeeDraft.fields.salaryMode;
          employeeDraft.warnings.push(field === 'grossSalary' ? 'Le salaire mensuel doit être vérifié : les deux lectures de l’image diffèrent.' : 'Le taux d’activité doit être vérifié : les deux lectures de l’image diffèrent.');
        }
      }
    }
    const fields = employeeDraft.fields;
    const page = data.pageStart ?? 1;
    const core = payrollCoreFromLocalText(text, page);
    const lines = payrollLinesFromLocalText(text, page)?.lines ?? [];
    const mapping: Record<string, string> = { name: 'name', employeeNumber: 'employee_number', addressLine1: 'address_line1', postalCode: 'postal_code', city: 'city', birthDate: 'birth_date', avsNumber: 'avs_number', iban: 'iban', role: 'role', employmentRate: 'employment_rate', salaryMode: 'salary_mode' };
    const employee = Object.fromEntries(Object.entries(fields).filter(([key]) => key in mapping).map(([key, value]) => [mapping[key], key === 'employmentRate' ? Number(value) : value]));
    const output = JSON.stringify({ employee,
      ...(core ? { gross_cents: core.grossCents, net_cents: core.netCents } : {}),
      field_pages: Object.fromEntries(Object.keys(employee).map(key => [`employee.${key === 'address_line1' ? 'address' : key}`, [page]])),
      lines: lines.map(line => ({ label: line.label, kind: line.kind, amount_cents: line.amountCents, source_page: page, recurring: false, confidence_bp: 0 })),
      warnings: [...employeeDraft.warnings, 'L’identité est préremplie depuis le document. Contrôlez les rubriques et montants imprimés avant toute reprise de paie.'],
    });
    post({ type: 'analysis', requestId: data.requestId, primaryOutput: output, verifiedOutput: '', employeeDraft, extractedText: text, modelId: PAYROLL_AI_MODEL_ID, modelVersion: PAYROLL_AI_MODEL_REVISION, mode: engine.mode });
  } catch (error) {
    post({ type: data.type === 'load' ? 'load_error' : 'analysis_error', requestId: data.requestId, error: error instanceof Error ? error.message : 'La lecture locale a échoué. Réessayez avec une seule fiche.' });
  } finally { busy = false; }
};

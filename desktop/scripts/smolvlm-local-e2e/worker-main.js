import { PAYROLL_AI_MODEL_ID, PAYROLL_AI_MODEL_REVISION } from '../../src/payrollAiModel.ts';
import { reconcilePayrollAiPasses } from '../../src/payrollImportAiDraft.ts';
import { payrollLocalAi } from '../../src/payrollLocalAi.ts';

const params = new URLSearchParams(location.search);
const imageUrl = params.get('image');
const omitTextLayer = params.get('text') === 'none';
const expected = {
  employee_name: params.get('name') ?? 'Élodie Exemple',
  gross_cents: Number(params.get('gross') ?? 650000),
  net_cents: Number(params.get('net') ?? 628400),
};
const identity = document.querySelector('#identity');
const status = document.querySelector('#status');
const details = document.querySelector('#details');
const progress = document.querySelector('#progress');

function normalizeName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function publish(state, payload = {}) {
  window.__ZENTRA_SMOLVLM_E2E__ = {
    state,
    modelId: PAYROLL_AI_MODEL_ID,
    modelRevision: PAYROLL_AI_MODEL_REVISION,
    expected,
    path: 'production-worker',
    textLayer: omitTextLayer ? 'absent' : 'synthetic-local',
    ...payload,
  };
  document.documentElement.dataset.e2eState = state;
  status.className = state === 'passed' ? 'pass' : state === 'failed' ? 'fail' : '';
}

async function localImageDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image de contrôle introuvable (${response.status}).`);
  const source = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Lecture de l'image impossible."));
    reader.readAsDataURL(source);
  });
}

const stopProgress = payrollLocalAi.onProgress((update) => {
  status.textContent = update.label;
  if (update.percent !== null) progress.value = update.percent;
});

async function main() {
  if (!imageUrl) throw new Error('Ajoutez ?image=<URL PNG> pour lancer le contrôle.');
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('Worker ou WebAssembly indisponible dans ce navigateur.');
  }
  publish('checking');
  let mode = await payrollLocalAi.check();
  if (mode === 'unavailable') throw new Error('Aucun runtime local disponible.');
  identity.textContent = `${PAYROLL_AI_MODEL_ID} @ ${PAYROLL_AI_MODEL_REVISION} · Worker de production · ${mode}`;

  publish('loading', { runtime: mode });
  mode = await payrollLocalAi.load();
  const imageDataUrl = await localImageDataUrl(imageUrl);
  const initiallyExpectedPasses = mode === 'wasm' ? 1 : 2;
  status.textContent = initiallyExpectedPasses === 2
    ? 'Deux lectures locales WebGPU de production en cours…'
    : 'Lecture locale CPU/WASM bornée en cours…';
  progress.value = 45;
  publish('generating', { runtime: mode });

  const extractedText = omitTextLayer ? '' : [
    'Fiche de salaire août 2026.',
    'Collaboratrice: Élodie Exemple. Numéro E-0042. Fonction: Cheffe de projet. Taux: 80%.',
    "Salaire mensuel brut CHF 6'500.00. Remboursement de frais CHF 200.00.",
    "Retenues employée: AVS/AI/APG CHF 344.50; assurance-chômage CHF 71.50.",
    "Net à payer CHF 6'284.00. Paiement 25.08.2026.",
  ].join(' ');
  const analysis = await payrollLocalAi.analyze({
    imageUrls: [imageDataUrl],
    extractedText,
    pageStart: 1,
    pageEnd: 1,
  });
  const reconciled = reconcilePayrollAiPasses(
    analysis.primaryRawOutput,
    analysis.verifiedRawOutput,
    { expectedPasses: analysis.mode === 'wasm' ? 1 : 2 },
  );
  const expectedPasses = analysis.mode === 'wasm' ? 1 : 2;
  const draft = reconciled.draft;
  const expectedLineKeys = new Set([
    'earning:650000',
    'reimbursement:20000',
    'deduction:34450',
    'deduction:7150',
  ]);
  const actualLineKeys = draft.lines.map((line) => `${line.kind}:${line.amountCents}`);
  const matches = {
    employee_name: normalizeName(draft.employee.name) === normalizeName(expected.employee_name),
    gross_cents: draft.grossCents === expected.gross_cents,
    net_cents: draft.netCents === expected.net_cents,
    runtime_pass_strategy: analysis.passes === expectedPasses
      && reconciled.validatedPasses === expectedPasses,
    all_expected_lines: expectedLineKeys.size === actualLineKeys.length
      && [...expectedLineKeys].every((key) => actualLineKeys.includes(key)),
    no_structural_line_invented: actualLineKeys.every((key) => expectedLineKeys.has(key)),
  };
  const passed = Object.values(matches).every(Boolean);
  const result = {
    runtime: analysis.mode,
    passes: analysis.passes,
    validatedPasses: reconciled.validatedPasses,
    matches,
    draft,
    primaryRawOutput: analysis.primaryRawOutput,
    verifiedRawOutput: analysis.verifiedRawOutput,
    partialError: analysis.partialError,
  };
  progress.value = 100;
  status.textContent = passed
    ? 'PASS - Worker de production conforme'
    : 'FAIL - Worker terminé, valeurs ou stratégie de lecture différentes';
  details.textContent = JSON.stringify(result, null, 2);
  publish(passed ? 'passed' : 'failed', result);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  status.textContent = 'FAIL - Worker de production interrompu';
  details.textContent = message;
  publish('failed', { error: message });
}).finally(() => {
  stopProgress();
});

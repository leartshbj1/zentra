import type { PayrollAiRuntimeDevice } from './payrollAiRuntimePolicy';

export type PayrollAiGenerationPlan = {
  maxNewTokens: number;
  phaseTokenBudgets?: { core: number; lines: number };
  passes: 1 | 2;
  pagesPerBatch: number;
  progressEveryTokens: number;
  splitImagesWhenTextAvailable: boolean;
};

const GENERATION_PLANS: Record<PayrollAiRuntimeDevice, PayrollAiGenerationPlan> = {
  webgpu: {
    // WebGPU keeps the independent second reading and the generous ceiling.
    // The JSON completion criterion normally stops well before this ceiling.
    maxNewTokens: 1_100,
    passes: 2,
    pagesPerBatch: 3,
    progressEveryTokens: 8,
    splitImagesWhenTextAvailable: true,
  },
  wasm: {
    // On ordinary CPUs, 1 100 tokens followed by a second pass can take well
    // over the UI watchdog. Keep every visible payroll line, but omit empty
    // output fields and stop after one deliberately weak, human-reviewed pass.
    maxNewTokens: 384,
    phaseTokenBudgets: { core: 96, lines: 288 },
    passes: 1,
    pagesPerBatch: 1,
    progressEveryTokens: 4,
    splitImagesWhenTextAvailable: false,
  },
};


/**
 * A WebGPU request may fall back inside the same Worker call. The batch must
 * therefore fit both the initial runtime and every automatic fallback, not
 * just the runtime reported by the initial capability check.
 */
export function payrollAiSafePageBatchSize(initialDevice: PayrollAiRuntimeDevice) {
  if (initialDevice === 'wasm') return GENERATION_PLANS.wasm.pagesPerBatch;
  return Math.min(
    GENERATION_PLANS.webgpu.pagesPerBatch,
    GENERATION_PLANS.wasm.pagesPerBatch,
  );
}




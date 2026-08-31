/// <reference lib="webworker" />

import {
  AutoModelForVision2Seq,
  AutoProcessor,
  Tensor,
  load_image,
} from '@huggingface/transformers';
import type { ProgressInfo } from '@huggingface/transformers';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-500M-Instruct';
const MODEL_VERSION = 'a7da5b986cb59b408707209984f360a5f4ad7e47';

type WorkerRequest =
  | { type: 'check' }
  | { type: 'load' }
  | { type: 'analyze'; requestId: string; imageUrls?: string[]; extractedText?: string };

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> };
};

let processorPromise: ReturnType<typeof AutoProcessor.from_pretrained> | null = null;
let modelPromise: ReturnType<typeof AutoModelForVision2Seq.from_pretrained> | null = null;
let runtimeDevice: 'webgpu' | 'wasm' | null = null;

function resetEngine() {
  processorPromise = null;
  modelPromise = null;
}

function post(payload: Record<string, unknown>) {
  self.postMessage(payload);
}

async function checkWebGpu() {
  try {
    const gpu = (navigator as GpuNavigator).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    runtimeDevice = adapter ? 'webgpu' : typeof WebAssembly !== 'undefined' ? 'wasm' : null;
    post({ type: 'check', available: Boolean(runtimeDevice), mode: runtimeDevice ?? 'unavailable', modelId: MODEL_ID, modelVersion: MODEL_VERSION });
  } catch (error) {
    runtimeDevice = typeof WebAssembly !== 'undefined' ? 'wasm' : null;
    post({ type: 'check', available: Boolean(runtimeDevice), mode: runtimeDevice ?? 'unavailable', error: String(error), modelId: MODEL_ID, modelVersion: MODEL_VERSION });
  }
}

async function getEngine() {
  if (!runtimeDevice) {
    const gpu = (navigator as GpuNavigator).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    runtimeDevice = adapter ? 'webgpu' : typeof WebAssembly !== 'undefined' ? 'wasm' : null;
  }
  if (!runtimeDevice) throw new Error('Ni WebGPU ni WebAssembly ne sont disponibles dans cette installation Windows.');
  processorPromise ??= AutoProcessor.from_pretrained(MODEL_ID, {
    revision: MODEL_VERSION,
    progress_callback: (progress: ProgressInfo) => post({ type: 'progress', progress }),
  });
  modelPromise ??= AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
    revision: MODEL_VERSION,
    dtype: {
      embed_tokens: 'fp32',
      vision_encoder: 'q4',
      decoder_model_merged: 'q4',
    },
    device: runtimeDevice,
    progress_callback: (progress: ProgressInfo) => post({ type: 'progress', progress }),
  });
  return Promise.all([processorPromise, modelPromise]);
}

function extractionPrompt(extractedText: string) {
  const text = extractedText.slice(0, 24_000);
  return `You are a strict document transcription engine for Swiss payslips in French, German, Italian or English. Inspect every supplied page and the OCR text twice: first transcribe, then verify arithmetic and classification.
Return exactly one JSON object, with no Markdown and no commentary, using this schema:
{"employee":{"employee_number":"","name":"","role":"","address_line1":"","address_line2":"","postal_code":"","city":"","canton":"","birth_date":"","avs_number":"","iban":"","employment_rate":null,"salary_mode":null},"period":"YYYY-MM","payment_date":"YYYY-MM-DD","gross_cents":0,"net_cents":0,"lines":[{"label":"","kind":"earning|deduction|reimbursement|employer","amount_cents":0,"recurring":false,"confidence_bp":0}],"warnings":[]}
Rules: transcribe only information visibly present in the pages or OCR text. Never guess a missing value, legal rate, contribution or employee identity. Set employment_rate and salary_mode to null unless each value is explicitly printed; salary_mode is monthly or hourly only. All CHF amounts must be integer cents. Keep a printed minus sign out of amount_cents and express employee deductions as positive amounts with kind deduction. Employer-only contributions use kind employer and must never reduce net pay. Reimbursements of expenses and non-gross payments paid to the employee use kind reimbursement, are never recurring, are excluded from gross_cents, and are added after deductions when reconciling net_cents. Base monthly salary may be recurring; bonuses and one-off salary allowances are earnings but are not recurring. gross_cents and net_cents must be the explicitly printed totals, never recomputed substitutes. confidence_bp is 0 to 10000 and must fall below 6000 when a label, sign or amount is ambiguous. If two values conflict, leave the field empty or zero and add a short warning naming the conflict. Do not merge employee and employer contributions bearing similar labels.
${text ? `OCR text extracted locally from the PDF:\n${text}` : 'No OCR text is available; use only the image.'}`;
}

async function analyze(requestId: string, imageUrls: string[] = [], extractedText = '') {
  try {
    let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
    let model: Awaited<ReturnType<typeof AutoModelForVision2Seq.from_pretrained>>;
    try {
      [processor, model] = await getEngine();
    } catch (error) {
      // Une coupure réseau ou un cache incomplet ne doit pas condamner toutes
      // les relances jusqu'au prochain redémarrage d'Elyko.
      resetEngine();
      throw error;
    }
    const content: Array<{ type: 'image'; image: string } | { type: 'text'; text: string }> = [];
    const images = [];
    for (const imageUrl of imageUrls.slice(0, 3)) {
      content.push({ type: 'image', image: imageUrl });
      images.push(await load_image(imageUrl));
    }
    content.push({ type: 'text', text: extractionPrompt(extractedText) });
    // Transformers.js supports multimodal content at runtime, while its public
    // Message type still describes text-only content in v3.7.1.
    const messages = [{ role: 'user', content }] as unknown as Parameters<typeof processor.apply_chat_template>[0];
    const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(prompt, images, { do_image_splitting: true });
    const output = await model.generate({
      ...inputs,
      do_sample: false,
      repetition_penalty: 1.05,
      max_new_tokens: 900,
      return_dict_in_generate: true,
    });
    const sequences = output && typeof output === 'object' && 'sequences' in output
      ? (output as { sequences: unknown }).sequences
      : output;
    if (!(sequences instanceof Tensor)) throw new Error("SmolVLM n'a pas renvoyé de séquence exploitable.");
    const decoded = processor.batch_decode(sequences, { skip_special_tokens: true });
    post({ type: 'analysis', requestId, output: decoded.at(-1) ?? '', modelId: MODEL_ID, modelVersion: MODEL_VERSION, mode: runtimeDevice });
  } catch (error) {
    post({ type: 'analysis_error', requestId, error: String(error) });
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'check') void checkWebGpu();
  if (request.type === 'load') {
    void getEngine()
      .then(() => post({ type: 'ready', modelId: MODEL_ID, modelVersion: MODEL_VERSION, mode: runtimeDevice }))
      .catch((error) => {
        resetEngine();
        post({ type: 'load_error', error: String(error) });
      });
  }
  if (request.type === 'analyze') void analyze(request.requestId, request.imageUrls, request.extractedText);
});

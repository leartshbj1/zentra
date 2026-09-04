import {
  AutoModelForVision2Seq,
  AutoProcessor,
  Tensor,
  env,
  load_image,
} from '@huggingface/transformers';
import {
  PAYROLL_AI_MODEL_ID,
  PAYROLL_AI_MODEL_REVISION,
} from '../../src/payrollAiModel.ts';
import { configurePayrollAiOnnxRuntime } from '../../src/payrollAiRuntimeAssets.ts';
import { payrollAiImageBlobFromDataUrl } from '../../src/payrollAiImageSource.ts';
import { parsePayrollAiJson } from '../../src/payrollImportAiDraft.ts';
import {
  payrollAiScanCorePrompt,
  payrollCoreFromGeneratedProtocol,
} from '../../src/payrollAiTextFallback.ts';

configurePayrollAiOnnxRuntime(env.backends.onnx);

const params = new URLSearchParams(location.search);
const imageUrl = params.get('image');
const expected = {
  employee_name: params.get('name') ?? 'Élodie Exemple',
  gross_cents: Number(params.get('gross') ?? 650000),
  net_cents: Number(params.get('net') ?? 628400),
};

const identity = document.querySelector('#identity');
const status = document.querySelector('#status');
const details = document.querySelector('#details');
const progress = document.querySelector('#progress');

function publish(state, payload = {}) {
  window.__ZENTRA_SMOLVLM_E2E__ = {
    state,
    modelId: PAYROLL_AI_MODEL_ID,
    modelRevision: PAYROLL_AI_MODEL_REVISION,
    transformersVersion: env.version,
    runtime: 'wasm',
    expected,
    ...payload,
  };
  document.documentElement.dataset.e2eState = state;
  if (state === 'passed') status.className = 'pass';
  if (state === 'failed') status.className = 'fail';
}

function normalizeName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function progressCallback(update) {
  const pct = Number.isFinite(update?.progress) ? Math.max(0, Math.min(100, update.progress)) : 0;
  progress.value = pct;
  status.textContent = update?.file ? `Chargement local : ${update.file}` : 'Chargement local du modèle...';
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

async function main() {
  if (!imageUrl) throw new Error('Ajoutez ?image=<URL PNG> pour lancer le contrôle.');
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly est indisponible dans ce navigateur.');

  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }

  identity.textContent = `${PAYROLL_AI_MODEL_ID} @ ${PAYROLL_AI_MODEL_REVISION} · Transformers.js ${env.version} · WASM`;
  publish('loading');

  const processorPromise = AutoProcessor.from_pretrained(PAYROLL_AI_MODEL_ID, {
    revision: PAYROLL_AI_MODEL_REVISION,
    progress_callback: progressCallback,
  });
  const modelPromise = AutoModelForVision2Seq.from_pretrained(PAYROLL_AI_MODEL_ID, {
    revision: PAYROLL_AI_MODEL_REVISION,
    dtype: {
      embed_tokens: 'fp32',
      vision_encoder: 'q4',
      decoder_model_merged: 'q4',
    },
    device: 'wasm',
    progress_callback: progressCallback,
  });
  const imagePromise = localImageDataUrl(imageUrl)
    .then(payrollAiImageBlobFromDataUrl)
    .then(load_image);
  const [processor, model, image] = await Promise.all([processorPromise, modelPromise, imagePromise]);

  progress.value = 100;
  status.textContent = 'Modèle chargé, génération locale en cours...';
  publish('generating', { image: { width: image.width, height: image.height } });

  const promptText = payrollAiScanCorePrompt('', 1);
  const messages = [{
    role: 'user',
    content: [
      { type: 'image' },
      { type: 'text', text: promptText },
    ],
  }];
  const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(prompt, [image], { do_image_splitting: true });
  const output = await model.generate({
    ...inputs,
    do_sample: false,
    repetition_penalty: 1.05,
    max_new_tokens: 96,
    return_dict_in_generate: true,
  });
  const sequences = output && typeof output === 'object' && 'sequences' in output ? output.sequences : output;
  if (!(sequences instanceof Tensor)) throw new Error('La génération ne contient pas de tenseur décodable.');
  const promptLength = inputs.input_ids instanceof Tensor ? inputs.input_ids.dims.at(-1) ?? 0 : 0;
  const sequenceLength = sequences.dims.at(-1) ?? 0;
  const generatedOnly = promptLength > 0 && sequenceLength > promptLength
    ? sequences.slice(null, [promptLength, sequenceLength])
    : sequences;
  const raw = processor.batch_decode(generatedOnly, { skip_special_tokens: true }).at(-1) ?? '';
  let parsed;
  try {
    const protocol = payrollCoreFromGeneratedProtocol(raw, 1, { allowMissingEnd: true });
    if (!protocol) throw new Error('Le protocole NAME/GROSS_CHF/NET_CHF/END est absent ou incomplet.');
    parsed = parsePayrollAiJson(protocol.rawOutput);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} Génération brute: ${JSON.stringify(raw)}`);
  }
  const matches = {
    employee_name: normalizeName(parsed.draft.employee.name) === normalizeName(expected.employee_name),
    gross_cents: parsed.draft.grossCents === expected.gross_cents,
    net_cents: parsed.draft.netCents === expected.net_cents,
  };
  const passed = Object.values(matches).every(Boolean);
  const result = {
    raw,
    parsed: parsed.draft,
    matches,
    tokenCounts: { prompt: promptLength, generated: Math.max(0, sequenceLength - promptLength) },
    image: { width: image.width, height: image.height },
  };
  status.textContent = passed ? 'PASS - génération locale conforme' : 'FAIL - génération obtenue, valeurs différentes';
  details.textContent = JSON.stringify(result, null, 2);
  publish(passed ? 'passed' : 'failed', result);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  status.textContent = 'FAIL - inférence locale interrompue';
  details.textContent = message;
  publish('failed', { error: message });
});

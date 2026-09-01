import {
  AutoModelForVision2Seq,
  AutoProcessor,
  RawImage,
  Tensor,
  env,
} from '@huggingface/transformers';
import {
  PAYROLL_AI_MODEL_ID,
  PAYROLL_AI_MODEL_REVISION,
} from '../../src/payrollAiModel.ts';

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

function strictJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Aucun objet JSON trouvé dans la génération.');
  return JSON.parse(trimmed.slice(start, end + 1));
}

function normalizeName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function progressCallback(update) {
  const pct = Number.isFinite(update?.progress) ? Math.max(0, Math.min(100, update.progress)) : 0;
  progress.value = pct;
  status.textContent = update?.file ? `Chargement local : ${update.file}` : 'Chargement local du modèle...';
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
  const imagePromise = RawImage.read(imageUrl);
  const [processor, model, image] = await Promise.all([processorPromise, modelPromise, imagePromise]);

  progress.value = 100;
  status.textContent = 'Modèle chargé, génération locale en cours...';
  publish('generating', { image: { width: image.width, height: image.height } });

  const localText = "EMPLOYEE: Élodie Exemple. PRINTED GROSS PAY: CHF 6'500.00. PRINTED NET PAY: CHF 6'284.00.";
  const promptText = `Convert the supporting local PDF text into one JSON line after checking the payslip image. Follow this exact example.\nPDF: EMPLOYEE: Alice Smith. PRINTED GROSS PAY: CHF 1'000.00. PRINTED NET PAY: CHF 900.00.\nJSON: {"employee_name":"Alice Smith","gross_cents":100000,"net_cents":90000}\nNow convert the real document. Do not repeat the PDF text and do not add Markdown.\nPDF: ${localText}\nJSON:`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', image: imageUrl },
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
    parsed = strictJson(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} Génération brute: ${JSON.stringify(raw)}`);
  }
  const matches = {
    employee_name: normalizeName(parsed.employee_name) === normalizeName(expected.employee_name),
    gross_cents: Number(parsed.gross_cents) === expected.gross_cents,
    net_cents: Number(parsed.net_cents) === expected.net_cents,
  };
  const passed = Object.values(matches).every(Boolean);
  const result = {
    raw,
    parsed,
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

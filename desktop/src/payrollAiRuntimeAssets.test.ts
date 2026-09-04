import { describe, expect, it } from 'vitest';
import {
  PAYROLL_AI_ONNX_RUNTIME_PATHS,
  configurePayrollAiOnnxRuntime,
} from './payrollAiRuntimeAssets';

describe('ressources locales du moteur ONNX de paie', () => {
  it('remplace le repli CDN par les deux ressources livrées avec Zentra', () => {
    const onnxEnvironment = {
      wasm: {
        wasmPaths: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers/runtime/',
      },
    };

    const configured = configurePayrollAiOnnxRuntime(onnxEnvironment, {
      mjs: 'https://tauri.localhost/assets/ort-runtime.mjs',
      wasm: 'https://tauri.localhost/assets/ort-runtime.wasm',
    });

    expect(configured).toEqual({
      mjs: 'https://tauri.localhost/assets/ort-runtime.mjs',
      wasm: 'https://tauri.localhost/assets/ort-runtime.wasm',
    });
    expect(onnxEnvironment.wasm.wasmPaths).toBe(configured);
  });

  it('référence exactement les variantes JSEP compatibles WebGPU et WASM', () => {
    expect(String(PAYROLL_AI_ONNX_RUNTIME_PATHS.mjs)).toMatch(
      /ort-wasm-simd-threaded\.jsep\.mjs$/,
    );
    expect(String(PAYROLL_AI_ONNX_RUNTIME_PATHS.wasm)).toMatch(
      /ort-wasm-simd-threaded\.jsep\.wasm$/,
    );
    expect(String(PAYROLL_AI_ONNX_RUNTIME_PATHS.mjs)).not.toContain(
      'cdn.jsdelivr.net',
    );
  });

  it('échoue explicitement si le backend WebAssembly est absent', () => {
    expect(() => configurePayrollAiOnnxRuntime({})).toThrow(
      "Le moteur ONNX local n'expose pas sa configuration WebAssembly.",
    );
  });
});

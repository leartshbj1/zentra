type OnnxRuntimeAssetPath = string | URL;

export type PayrollAiOnnxEnvironment = {
  readonly wasm?: {
    wasmPaths?:
      | string
      | {
          mjs?: OnnxRuntimeAssetPath;
          wasm?: OnnxRuntimeAssetPath;
        };
  };
};

export type PayrollAiOnnxRuntimePaths = {
  mjs: OnnxRuntimeAssetPath;
  wasm: OnnxRuntimeAssetPath;
};

// ONNX Runtime otherwise follows the CDN prefix installed by Transformers.js.
// Tauri deliberately blocks remote scripts, so both runtime assets must travel
// with the application and be loaded from its own origin.
export const PAYROLL_AI_ONNX_RUNTIME_PATHS: PayrollAiOnnxRuntimePaths = {
  mjs: new URL(
    '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
    import.meta.url,
  ).href,
  wasm: new URL(
    '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    import.meta.url,
  ).href,
};

export function configurePayrollAiOnnxRuntime(
  onnxEnvironment: PayrollAiOnnxEnvironment,
  paths: PayrollAiOnnxRuntimePaths = PAYROLL_AI_ONNX_RUNTIME_PATHS,
) {
  if (!onnxEnvironment.wasm) {
    throw new Error(
      "Le moteur ONNX local n'expose pas sa configuration WebAssembly.",
    );
  }

  onnxEnvironment.wasm.wasmPaths = {
    mjs: paths.mjs,
    wasm: paths.wasm,
  };

  return onnxEnvironment.wasm.wasmPaths;
}

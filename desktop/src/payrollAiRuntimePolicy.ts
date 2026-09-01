export type PayrollAiRuntimeDevice = 'webgpu' | 'wasm';

export function selectInitialPayrollAiRuntime(input: {
  webGpuAvailable: boolean;
  wasmAvailable: boolean;
}): PayrollAiRuntimeDevice | null {
  if (input.webGpuAvailable) return 'webgpu';
  if (input.wasmAvailable) return 'wasm';
  return null;
}

export function nextPayrollAiRuntimeAfterFailure(input: {
  failedDevice: PayrollAiRuntimeDevice;
  attemptedDevices: readonly PayrollAiRuntimeDevice[];
  wasmAvailable: boolean;
}): PayrollAiRuntimeDevice | null {
  // The only automatic fallback is WebGPU -> WASM. Never return to WebGPU
  // during the same operation and never retry WASM after it has failed.
  if (
    input.failedDevice === 'webgpu' &&
    input.wasmAvailable &&
    !input.attemptedDevices.includes('wasm')
  ) {
    return 'wasm';
  }
  return null;
}

import { describe, expect, it } from 'vitest';
import {
  nextPayrollAiRuntimeAfterFailure,
  selectInitialPayrollAiRuntime,
} from './payrollAiRuntimePolicy';

describe('politique du moteur IA local de paie', () => {
  it('préfère WebGPU puis utilise WASM quand le GPU est absent', () => {
    expect(
      selectInitialPayrollAiRuntime({ webGpuAvailable: true, wasmAvailable: true }),
    ).toBe('webgpu');
    expect(
      selectInitialPayrollAiRuntime({ webGpuAvailable: false, wasmAvailable: true }),
    ).toBe('wasm');
    expect(
      selectInitialPayrollAiRuntime({ webGpuAvailable: false, wasmAvailable: false }),
    ).toBeNull();
  });

  it('bascule une seule fois de WebGPU vers WASM', () => {
    expect(
      nextPayrollAiRuntimeAfterFailure({
        failedDevice: 'webgpu',
        attemptedDevices: ['webgpu'],
        wasmAvailable: true,
      }),
    ).toBe('wasm');
    expect(
      nextPayrollAiRuntimeAfterFailure({
        failedDevice: 'webgpu',
        attemptedDevices: ['webgpu', 'wasm'],
        wasmAvailable: true,
      }),
    ).toBeNull();
  });

  it('ne reboucle jamais de WASM vers WebGPU ou vers WASM', () => {
    expect(
      nextPayrollAiRuntimeAfterFailure({
        failedDevice: 'wasm',
        attemptedDevices: ['webgpu', 'wasm'],
        wasmAvailable: true,
      }),
    ).toBeNull();
    expect(
      nextPayrollAiRuntimeAfterFailure({
        failedDevice: 'webgpu',
        attemptedDevices: ['webgpu'],
        wasmAvailable: false,
      }),
    ).toBeNull();
  });
});

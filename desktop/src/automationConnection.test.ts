import { beforeEach, expect, it, vi } from 'vitest';
import { automationProblem } from './automationConnection';
import { createAutomationCompanySession } from './automationCompanySession';
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
import { automationState, loadAutomationState } from './automation';
beforeEach(() => mock.invoke.mockReset());
it('preserves native failures for settings while suggestions retain their safe fallback', async () => {
  mock.invoke.mockRejectedValue('[automation:company_mismatch] mismatch');
  const required = loadAutomationState(); const optional = automationState();
  await expect(required).rejects.toContain('[automation:company_mismatch]');
  await expect(optional).resolves.toBeNull();
  expect(mock.invoke).toHaveBeenCalledTimes(1);
  mock.invoke.mockResolvedValue(null); await loadAutomationState(); expect(mock.invoke).toHaveBeenCalledTimes(2);
});
it('uses offline guidance only with a reported network disconnection', () => {
  expect(automationProblem('500', true)).toBe('service');
  expect(automationProblem(Error('request timeout'), true)).toBe('service');
  expect(automationProblem(Error('request timeout'), false)).toBe('offline');
  expect(automationProblem('La session de cet appareil a expiré ou a été révoquée.')).toBe('session');
  expect(automationProblem('Champ invalide : [automation:company_mismatch] x', false)).toBe('company_mismatch');
  expect(automationProblem('[automation:company_unlinked] x')).toBe('company_unlinked');
});
it('clears the real issue after recovery and ignores late errors from an old company', async () => {
  const load = vi.fn().mockRejectedValueOnce('[automation:company_mismatch] x').mockResolvedValueOnce({ organizationId:'a', active:true });
  const session = createAutomationCompanySession('a', load); session.start(); await session.refresh();
  expect(session.getSnapshot().problem).toBe('company_mismatch');
  await session.refresh(); expect(session.getSnapshot().problem).toBeUndefined();
  let reject!: (reason: unknown) => void;
  const old = createAutomationCompanySession('a', () => new Promise((_, fail) => { reject = fail; })); old.start();
  const pending = old.refresh(); old.stop(); reject('expired'); await pending;
  expect(old.getSnapshot().problem).toBeUndefined();
});

import { expect, it, vi } from 'vitest';
import { createAutomationCompanySession } from './automationCompanySession';
import type { AutomationState } from './automation';
import { automationReadiness, recommendedAutomationSettings, workflowReady } from './automationExperience';

const active: AutomationState = { organizationId: 'a', active: true, canManage: true, available: ['document_routing'], settings: { enabled: true, consent: true, mode: 'suggest', flags: ['document_routing'], thresholds: { medium: .75, high: .95 } } };
it('discovers a company activation and removes access immediately when revoked', async () => {
  const load = vi.fn().mockResolvedValueOnce({ ...active, active: false }).mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, active: false });
  const session = createAutomationCompanySession('a', load); session.start();
  expect(session.getSnapshot().status).toBe('loading');
  await session.refresh(); expect(session.getSnapshot().knownActive).toBe(false);
  await session.refresh(); expect(session.getSnapshot().knownActive).toBe(true);
  await session.refresh(); expect(session.getSnapshot().knownActive).toBe(false);
});
it('retains only menu discovery during outages, with no stale actionable state', async () => {
  const session = createAutomationCompanySession('a', vi.fn().mockResolvedValueOnce(active).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(active)); session.start();
  await session.refresh(); await session.refresh();
  expect(session.getSnapshot()).toEqual({ state: null, knownActive: true, status: 'unavailable', problem: 'service' });
  expect(workflowReady(session.getSnapshot().state, ['document_routing'])).toBe(false);
  await session.refresh(); expect(session.getSnapshot().status).toBe('ready');
});
it('isolates organizations, ignores late responses and never loads a disconnected company', async () => {
  let finish!: (v: AutomationState) => void;
  const old = createAutomationCompanySession('a', () => new Promise(resolve => { finish = resolve; })); old.start();
  const pending = old.refresh(); old.stop(); finish(active); await pending;
  expect(old.getSnapshot().state).toBeNull();
  const current = createAutomationCompanySession('b', async () => active); current.start(); await current.refresh();
  expect(current.getSnapshot()).toEqual({ state: null, knownActive: false, status: 'unavailable', problem: 'company_mismatch' });
  const load = vi.fn(); const offline = createAutomationCompanySession(null, load); offline.start(); await offline.refresh(); expect(load).not.toHaveBeenCalled();
});
it('rechecks changes that arrive during a pending refresh without overlapping requests', async () => {
  let finish!: (v: AutomationState) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...active, settings: { ...active.settings, enabled: false } });
  const session = createAutomationCompanySession('a', load); session.start();
  const pending = session.refresh(); const second = session.refresh();
  expect(load).toHaveBeenCalledTimes(1); finish(active); await Promise.all([pending, second]);
  expect(load).toHaveBeenCalledTimes(2); expect(session.getSnapshot().state?.settings.enabled).toBe(false);
});
it('coalesces focus, visibility and polling without queuing identical network reads', async () => {
  let finish!: (v: AutomationState) => void;
  const load = vi.fn(() => new Promise<AutomationState>(resolve => { finish = resolve; }));
  const session = createAutomationCompanySession('a', load); session.start();
  const pending = session.refresh(false);
  for (let i = 0; i < 10; i++) expect(session.refresh(false)).toBe(pending);
  finish(active); await pending;
  expect(load).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().status).toBe('ready');
});
it('handles strict-mode restart without an older response replacing newer settings', async () => {
  let finish!: (v: AutomationState) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...active, active: false });
  const session = createAutomationCompanySession('a', load); session.start(); const pending = session.refresh(); session.stop(); session.start(); await session.refresh();
  finish(active); await pending; expect(session.getSnapshot().knownActive).toBe(false);
});
it('requires consent, enabled functions and provider availability independently of purchased access', () => {
  expect(automationReadiness(active)).toBe('ready');
  expect(automationReadiness({ ...active, settings: { ...active.settings, consent: false } })).toBe('consent');
  expect(automationReadiness({ ...active, settings: { ...active.settings, enabled: false } })).toBe('paused');
  expect(automationReadiness({ ...active, settings: { ...active.settings, flags: [] } })).toBe('empty');
  expect(automationReadiness({ ...active, available: [] })).toBe('unavailable');
  expect(automationReadiness({ ...active, settings: { ...active.settings, mode: 'shadow' } })).toBe('observation');
});
it('prepares only available features without granting consent or mutating saved settings', () => {
  const original = { ...active, settings: { ...active.settings, consent: false, enabled: false } };
  const draft = recommendedAutomationSettings(original);
  expect(draft).toMatchObject({ enabled: true, consent: false, flags: ['document_routing'], mode: 'suggest' });
  expect(original.settings.enabled).toBe(false);
});

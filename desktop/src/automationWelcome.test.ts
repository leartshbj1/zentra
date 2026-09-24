import { expect, it, vi } from 'vitest';
import { automationWelcomeKey, hasConfirmedAutomationAccess, hasSeenAutomationWelcome, rememberAutomationWelcome } from './automationWelcomeState';
import type { AutomationCompanySnapshot } from './automationCompanySession';
const active: AutomationCompanySnapshot = { status: 'ready', knownActive: true, state: { organizationId: 'a', active: true, canManage: true, available: [], settings: { enabled: false, consent: false, mode: 'suggest', flags: [], thresholds: { medium: .75, high: .95 } } } };
it('requires confirmed access for the selected company; the welcome never grants consent', () => {
  expect(hasConfirmedAutomationAccess(active, 'a')).toBe(true);
  expect(active.state?.settings.consent).toBe(false);
  expect(hasConfirmedAutomationAccess(active, 'b')).toBe(false);
  expect(hasConfirmedAutomationAccess(active, null)).toBe(false);
  for (const status of ['loading', 'unavailable', 'disconnected'] as const) expect(hasConfirmedAutomationAccess({ ...active, status }, 'a')).toBe(false);
  expect(hasConfirmedAutomationAccess({ ...active, state: { ...active.state!, active: false } }, 'a')).toBe(false);
});
it('keeps the once-only preference per company, including when storage is unavailable', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('Unavailable'); }, setItem: () => { throw Error('Unavailable'); } });
  try {
    expect(hasSeenAutomationWelcome('test-a')).toBe(false);
    rememberAutomationWelcome('test-a');
    expect(hasSeenAutomationWelcome('test-a')).toBe(true);
    expect(hasSeenAutomationWelcome('test-b')).toBe(false);
    expect(automationWelcomeKey('a/b')).not.toBe(automationWelcomeKey('a%2Fb'));
  } finally { vi.unstubAllGlobals(); }
});

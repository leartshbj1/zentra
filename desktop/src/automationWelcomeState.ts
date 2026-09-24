import type { AutomationCompanySnapshot } from './automationCompanySession';

export const automationWelcomeKey = (organizationId: string) => `zentra.automation.welcome.v1:${encodeURIComponent(organizationId)}`;
const remembered = new Set<string>();
export function hasSeenAutomationWelcome(organizationId: string) {
  if (remembered.has(organizationId)) return true;
  try { return localStorage.getItem(automationWelcomeKey(organizationId)) === 'seen'; } catch { return false; }
}
export function rememberAutomationWelcome(organizationId: string) {
  remembered.add(organizationId);
  try { localStorage.setItem(automationWelcomeKey(organizationId), 'seen'); } catch { /* Session fallback avoids repeated interruptions. */ }
}
export function hasConfirmedAutomationAccess(snapshot: AutomationCompanySnapshot, organizationId: string | null) {
  return !!organizationId && snapshot.status === 'ready' && snapshot.state?.organizationId === organizationId && snapshot.state.active;
}

/** Presentation preference only. Does not enable, purchase or grant consent to Automation. */
export function replayAutomationWelcome(organizationId: string) {
  window.dispatchEvent(new CustomEvent('zentra-automation-welcome', { detail: organizationId }));
}

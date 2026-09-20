import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { loadAutomationState } from './automation';
import { createAutomationCompanySession, type AutomationCompanySnapshot } from './automationCompanySession';

type CompanyContext = AutomationCompanySnapshot & { organizationId: string | null; readOnly: boolean; refresh: () => Promise<void> };
const Context = createContext<CompanyContext>({ state: null, knownActive: false, status: 'disconnected', organizationId: null, readOnly: false, refresh: async () => {} });
export const useCompanyAutomation = () => useContext(Context);

/** One background refresh for the opened company; no persisted business activity. */
export function AutomationCompanyProvider({ organizationId, readOnly = false, children }: { organizationId: string | null; readOnly?: boolean; children: ReactNode }) {
  const session = useMemo(() => createAutomationCompanySession(organizationId, loadAutomationState, () => navigator.onLine), [organizationId]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    session.start();
    const resume = () => { if (document.visibilityState !== 'hidden') void session.refresh(); };
    resume();
    const timer = window.setInterval(resume, 15000);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('zentra-automation-updated', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      session.stop();
      window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('zentra-automation-updated', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [session]);
  return <Context.Provider value={{ ...snapshot, organizationId, readOnly, refresh: session.refresh }}>{children}</Context.Provider>;
}

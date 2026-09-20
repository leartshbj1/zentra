import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { automationState, type AutomationState } from './automation';

type CompanyContext = { state: AutomationState | null; organizationId: string | null; readOnly: boolean; refresh: () => Promise<void> };
const Context = createContext<CompanyContext>({ state: null, organizationId: null, readOnly: false, refresh: async () => {} });
export const useCompanyAutomation = () => useContext(Context);

/** One background refresh for the opened company; no persisted business activity. */
export function AutomationCompanyProvider({ organizationId, readOnly = false, children }: { organizationId: string | null; readOnly?: boolean; children: ReactNode }) {
  const [state, setState] = useState<AutomationState | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true, pending = false;
    setState(null);
    const refresh = async () => {
      if (!live || pending || !organizationId || document.visibilityState === 'hidden') return;
      pending = true;
      const next = await automationState();
      pending = false;
      if (live) setState(next?.organizationId === organizationId ? next : null);
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    const resume = () => void refresh();
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('zentra-automation-updated', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('zentra-automation-updated', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [organizationId]);
  return <Context.Provider value={{ state: state?.organizationId === organizationId ? state : null, organizationId, readOnly, refresh: () => refreshRef.current() }}>{children}</Context.Provider>;
}

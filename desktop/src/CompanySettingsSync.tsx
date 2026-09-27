import { useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

/**
 * Reading settings must not stop reception. A remote swap recreates the pristine
 * form state from the received workspace, keeping the selected category. Edits
 * in any category (including hidden drafts) defer reception until leaving settings.
 * We deliberately do not clear this guard on a partial save: another form may
 * still contain an unsaved value.
 */
export function CompanySettingsSync({ busy, children }: {
  busy: boolean;
  children: (revision: number, category: string | null) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const navigationFocus = useRef<{ start: number | null; end: number | null } | null>(null);
  const [received, setReceived] = useState({ revision: 0, category: null as string | null });
  const markDraft = (event: SyntheticEvent) => {
    // Finding a setting is navigation, not an edit to company data.
    if (event.target instanceof Element && event.target.closest('[data-settings-navigation]')) return;
    if (root.current) root.current.dataset.companyDraft = 'true';
  };
  useLayoutEffect(() => {
    const refresh = () => {
      const category = root.current?.querySelector<HTMLElement>('.settings-category[open]')?.dataset.settingsId || null;
      const focused = document.activeElement;
      navigationFocus.current = focused instanceof HTMLInputElement && root.current?.contains(focused) && focused.closest('[data-settings-navigation]')
        ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
      setReceived(current => ({ revision: current.revision + 1, category }));
    };
    window.addEventListener('zentra-company-workspace-received', refresh);
    return () => window.removeEventListener('zentra-company-workspace-received', refresh);
  }, []);
  useLayoutEffect(() => {
    if (!navigationFocus.current) return;
    const input = root.current?.querySelector<HTMLInputElement>('[data-settings-navigation] input[type="search"]');
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(navigationFocus.current.start, navigationFocus.current.end);
    navigationFocus.current = null;
  }, [received.revision]);
  return <div className="company-settings-sync" ref={root} data-company-receive-busy={busy || undefined}
    onInputCapture={markDraft} onChangeCapture={markDraft}>
    {children(received.revision, received.category)}
  </div>;
}

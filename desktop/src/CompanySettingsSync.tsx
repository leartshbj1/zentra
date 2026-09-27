import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
  const [received, setReceived] = useState({ revision: 0, category: null as string | null });
  const markDraft = () => { if (root.current) root.current.dataset.companyDraft = 'true'; };
  useLayoutEffect(() => {
    const refresh = () => {
      const category = root.current?.querySelector<HTMLElement>('.settings-category[open]')?.dataset.settingsId || null;
      setReceived(current => ({ revision: current.revision + 1, category }));
    };
    window.addEventListener('zentra-company-workspace-received', refresh);
    return () => window.removeEventListener('zentra-company-workspace-received', refresh);
  }, []);
  return <div className="company-settings-sync" ref={root} data-company-receive-busy={busy || undefined}
    onInputCapture={markDraft} onChangeCapture={markDraft}>
    {children(received.revision, received.category)}
  </div>;
}

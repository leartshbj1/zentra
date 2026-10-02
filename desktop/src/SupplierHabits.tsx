import { withDiagnosticIntent } from './diagnosticIntent';
import { t, useAppLanguage } from './language';
import { useEffect, useRef, useState } from 'react';
import {
  inboxRequest,
  type SupplierInboxState,
  type SupplierHabit,
} from './supplierInbox';
import type { Workspace } from './types';
import { Button } from './ui';
export function SupplierHabits({
  org,
  workspace,
  manage,
}: {
  org: string;
  workspace?: Workspace;
  manage: boolean;
}) {
  useAppLanguage();
  const scope = workspace?.workNotesScope;
  const [rows, setRows] = useState<SupplierHabit[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const context = useRef({ org, scope, manage });
  context.current = { org, scope, manage };
  const reader = useRef<{ isCurrent: () => boolean; load: () => void; forgetting: boolean } | null>(null);
  useEffect(() => {
    let alive = true, running = false, queued = false, version = 0;
    const isCurrent = () => alive && context.current.org === org && context.current.scope === scope;
    setRows([]);
    setError('');
    setBusy(false);
    const load = () => {
      if (!isCurrent()) return;
      const requested = ++version;
      // Events during a slow read invalidate its snapshot and queue only one
      // fresh read. No retry is scheduled unless another event requested it.
      if (running) { queued = true; return; }
      running = true;
      void inboxRequest<SupplierInboxState>()
        .then((s) => {
          if (isCurrent() && requested === version && s.organizationId === org) {
            setRows(s.habits || []);
            setError('');
          }
        })
        .catch(() => {
          if (isCurrent() && requested === version)
            setError('Les habitudes sont temporairement indisponibles.');
        })
        .finally(() => {
          running = false;
          if (queued && isCurrent()) { queued = false; load(); }
        });
    };
    const admission = { isCurrent, load, forgetting: false };
    reader.current = admission;
    load();
    window.addEventListener('zentra-automation-updated', load);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      queued = false;
      if (reader.current === admission) reader.current = null;
      window.removeEventListener('zentra-automation-updated', load);
      window.removeEventListener('focus', load);
    };
  }, [org, scope]);
  return (
    <details className="automation-habits">
      <summary>
        {t('Ce qu’Automation a retenu')}
        <span>{rows.length}</span>
      </summary>
      <p>
        {t(
          'Vos classements confirmés servent aux prochaines factures du même fournisseur. Les montants et la TVA restent ceux du justificatif.',
        )}
      </p>
      {error && <p role="status">{error}</p>}
      {rows.length ? (
        rows.map((r) => (
          <article key={r.id}>
            <div>
              <strong>
                {workspace?.suppliers.find((s) => s.id === r.supplierId)
                  ?.name || r.sender}
              </strong>
              <span>{r.category}</span>
            </div>
            {manage && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  const admission = reader.current;
                  if (!admission?.isCurrent() || admission.forgetting || !context.current.manage
                    || context.current.org !== org || context.current.scope !== scope) return;
                  admission.forgetting = true;
                  setBusy(true);
                  setError('');
                  try {
                    await inboxRequest(withDiagnosticIntent({ action: 'forgetHabit', id: r.id }, 'supplier_inbox_request', 'forgetHabit'));
                    if (admission.isCurrent()) {
                      setRows((current) => current.filter((h) => h.id !== r.id));
                      // A list captured before this confirmed deletion cannot
                      // restore the habit. Refresh reads only; never repeat POST.
                      admission.load();
                    }
                  } catch (e) {
                    if (admission.isCurrent()) setError(String(e));
                  } finally {
                    if (admission.isCurrent()) { admission.forgetting = false; setBusy(false); }
                  }
                }}
              >
                {t('Oublier')}
              </Button>
            )}
          </article>
        ))
      ) : (
        <p>
          {t(
            'Les habitudes apparaîtront après la confirmation de vos factures.',
          )}
        </p>
      )}
    </details>
  );
}

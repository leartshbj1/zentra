import { t, useAppLanguage } from './language';
import { useEffect, useState } from 'react';
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
  const [rows, setRows] = useState<SupplierHabit[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setRows([]);
    setError('');
    const load = () => {
      void inboxRequest<SupplierInboxState>()
        .then((s) => {
          if (alive && s.organizationId === org) {
            setRows(s.habits || []);
            setError('');
          }
        })
        .catch(() => {
          if (alive)
            setError('Les habitudes sont temporairement indisponibles.');
        });
    };
    load();
    window.addEventListener('zentra-automation-updated', load);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('zentra-automation-updated', load);
      window.removeEventListener('focus', load);
    };
  }, [org]);
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
                  setBusy(true);
                  setError('');
                  try {
                    await inboxRequest({ action: 'forgetHabit', id: r.id });
                    setRows((current) => current.filter((h) => h.id !== r.id));
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
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

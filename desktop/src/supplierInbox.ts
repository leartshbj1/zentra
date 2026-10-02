import { copyDiagnosticIntent, withDiagnosticIntent } from './diagnosticIntent';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { diagnosticInvoke as invoke } from './diagnostics';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { prepareMailboxBatch, type MailboxBatch } from './supplierInboxBatch';
import {
  canPrepareMailboxSupplier,
} from './supplierInboxReview';
export type SupplierHabit = {
  id: string;
  sender: string;
  supplierName: string;
  supplierId: string;
  category: string;
  accountId: string | null;
  updatedAt: number;
};
export type MailInvoice = {
  id: string;
  organizationId: string;
  fileName: string;
  mediaType: string;
  sha256: string;
  sender: string;
  subject: string;
  state: string;
  invoiceId: string | null;
  automatic: boolean;
  otherDevice: boolean;
  createdAt: number;
  extraction: {
    kind?: string;
    kindConfidence?: number;
    fieldConfidence?: Record<string, number>;
    supplierName: string | null;
    reference: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    currency: string | null;
    netCents: number | null;
    vatCents: number | null;
    totalCents: number | null;
    vatBp: number | null;
    category: string | null;
    confidence: number;
    issues: string[];
    evidence: Record<string, string>;
  };
};
export type SupplierInboxState = {
  organizationId: string;
  linked: boolean;
  autoPost: boolean;
  automationActive: boolean;
  prepareEnabled?: boolean;
  items: MailInvoice[];
  habits?: SupplierHabit[];
};
export type InboxDraft = {
  supplier_id: string;
  date: string;
  due_date: string;
  reference: string;
  items: {
    description: string;
    quantity_milli: number;
    unit_price_cents: number;
    vat_bp: number;
    category: string;
    expense_account_id: string | null;
  }[];
};
export const inboxRequest = <T>(data: unknown = null) =>
  invoke<T>('supplier_inbox_request', data === null
    ? withDiagnosticIntent({ data }, 'supplier_inbox_request', 'state')
    : copyDiagnosticIntent(data, { data }, 'supplier_inbox_request'));
export function pendingMailInvoices(state: SupplierInboxState | null) {
  return (
    state?.items.filter((i) => !['imported', 'ignored'].includes(i.state)) || []
  );
}
export function useSupplierInbox(
  org: string | null,
  readOnly: boolean,
  blocked: () => boolean,
  onWorkspace: (w: Workspace) => void,
  refreshWorkspace?: () => Promise<void>,
  workspaceScope?: string,
) {
  const [state, setState] = useState<SupplierInboxState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const current = useRef({ org, readOnly, blocked, onWorkspace, refreshWorkspace, workspaceScope });
  current.current = { org, readOnly, blocked, onWorkspace, refreshWorkspace, workspaceScope };
  const lifetime = useRef({ active: true, generation: 0 });
  useLayoutEffect(() => {
    lifetime.current.active = true;
    lifetime.current.generation++;
    return () => { lifetime.current.active = false; lifetime.current.generation++; };
  }, [org, workspaceScope]);
  const running = useRef(false);
  const preparedSuppliers = useRef(new Set<string>());
  useEffect(() => { preparedSuppliers.current.clear(); }, [org]);
  const refresh = useCallback(async () => {
    if (
      !org ||
      running.current ||
      document.visibilityState === 'hidden' ||
      !navigator.onLine
    )
      return;
    running.current = true;
    try {
      const value = await inboxRequest<SupplierInboxState>();
      if (current.current.org !== org || value.organizationId !== org) return;
      setState(value);
      setError('');
      if (!current.current.readOnly && !current.current.blocked()) {
        let changed = false;
        if (value.prepareEnabled && value.linked) {
          const preparationKey = (i: MailInvoice) => JSON.stringify([org, i.id, i.extraction.supplierName, i.extraction.fieldConfidence, i.extraction.confidence, value.habits]);
          const candidates = pendingMailInvoices(value).filter(i => !i.otherDevice && canPrepareMailboxSupplier(i) && !preparedSuppliers.current.has(preparationKey(i))).slice(0, 10);
          if (candidates.length) {
            const result = await inboxRequest<{results: {id: string; supplierId?: string; created?: boolean; error?: string}[]}>(withDiagnosticIntent({action:'prepareSuppliers', ids:candidates.map(i=>i.id)}, 'supplier_inbox_request', 'prepareSuppliers'));
            if (current.current.org !== org) return;
            for (const row of result.results) {
              const item = candidates.find(i=>i.id === row.id);
              if (item) preparedSuppliers.current.add(preparationKey(item));
              changed = changed || !!row.created;
            }
          }
        }
        const queue = value.items
          .filter(
            (i) =>
              !i.otherDevice &&
              (i.state === 'processing' ||
                (value.autoPost && i.state === 'ready')),
          )
          .slice(0, 10);
        for (const next of queue) {
          if (current.current.org !== org || current.current.readOnly || current.current.blocked()) break;
          try {
            const saved = await inboxRequest<{
              saved?: boolean;
              id: string;
              alreadyImported?: boolean;
            }>(withDiagnosticIntent({
              action: 'import',
              id: next.id,
              automatic: next.state === 'ready',
            }, 'supplier_inbox_request', 'import'));
            if (current.current.org !== org) return;
            changed = changed || !!saved.saved;
          } catch (reason) {
            if (current.current.org === org) setError(String(reason));
          }
        }
        if (queue.length || changed) {
          if (changed) {
            if (current.current.refreshWorkspace) await current.current.refreshWorkspace();
            else {
              const workspace = await desktopApi.loadWorkspace();
              if (current.current.org === org) current.current.onWorkspace(workspace);
            }
            window.dispatchEvent(new Event('zentra-automation-updated'));
          }
          const updated = await inboxRequest<SupplierInboxState>();
          if (current.current.org === org && updated.organizationId === org)
            setState(updated);
        }
      }
    } catch (reason) {
      if (current.current.org === org)
        setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      running.current = false;
    }
  }, [org, readOnly]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  useEffect(() => {
    setState(null);
    setError('');
    void refresh();
    const resume = () => void refresh();
    const timer = window.setInterval(resume, 20000);
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refresh]);
  const importInvoice = async (
    item: MailInvoice,
    invoice: InboxDraft,
    confirm = false,
  ) => {
    const generation = lifetime.current.generation;
    const isCurrent = () => lifetime.current.active && lifetime.current.generation === generation
      && current.current.org === org && current.current.workspaceScope === workspaceScope;
    if (!org || !isCurrent() || item.organizationId !== org || current.current.readOnly || running.current)
      throw Error('Attendez la fin de la réception en cours.');
    running.current = true;
    setBusy(true);
    try {
      const result = await inboxRequest<{
        saved?: boolean;
        id: string;
        alreadyImported?: boolean;
        posted?: boolean;
      }>(withDiagnosticIntent({ action: 'import', id: item.id, invoice, automatic: false, confirm }, 'supplier_inbox_request', 'import'));
      if (isCurrent()) {
        // The native receipt is definitive. A failed/read-delayed UI refresh
        // must not reopen this mutation or make its confirmation repeatable.
        const reconcile = async () => {
          if (current.current.refreshWorkspace) await current.current.refreshWorkspace();
          else {
            const workspace = await desktopApi.loadWorkspace();
            if (isCurrent() && (!workspaceScope || workspace.workNotesScope === workspaceScope)) current.current.onWorkspace(workspace);
          }
        };
        void reconcile().catch(reason => { if (isCurrent()) setError(String(reason)); });
        window.dispatchEvent(new Event('zentra-automation-updated'));
      }
      return { id: result.id, posted: result.posted, current: isCurrent() };
    } finally {
      running.current = false;
      if (lifetime.current.active) { setBusy(false); void latestRefresh.current(); }
    }
  };
  const [batch, setBatch] = useState<MailboxBatch | null>(null);
  useEffect(() => { setBatch(null); }, [org]);
  const prepareAll = async (_workspace?: Workspace) => {
    if (!org || current.current.readOnly || !state?.prepareEnabled) return;
    if (running.current) {
      setError('La réception s’actualise. Réessayez dans un instant.');
      return;
    }
    setError('');
    running.current = true;
    setBusy(true);
    const isCurrent = () => current.current.org === org && !current.current.readOnly && !current.current.blocked();
    try {
      const latest = await inboxRequest<SupplierInboxState>();
      if (!isCurrent() || latest.organizationId !== org) return;
      setState(latest);
      await prepareMailboxBatch(latest, {
        request: inboxRequest,
        loadWorkspace: desktopApi.loadWorkspace,
        isCurrent,
        progress: next => { if (isCurrent()) setBatch(next); },
      });
    } catch (reason) {
      if (current.current.org === org) setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      // Supplier preparation may succeed even if an invoice needs an amount corrected.
      if (current.current.org === org) {
        try {
          if (current.current.refreshWorkspace) await current.current.refreshWorkspace();
          else {
            const workspace = await desktopApi.loadWorkspace();
            if (current.current.org === org) current.current.onWorkspace(workspace);
          }
          window.dispatchEvent(new Event('zentra-automation-updated'));
        } catch (reason) {
          if (current.current.org === org) setError(String(reason instanceof Error ? reason.message : reason));
        }
      }
      running.current = false;
      setBusy(false);
      void refresh();
    }
  };
  return { state, error, busy, refresh, importInvoice, prepareAll, batch };
}

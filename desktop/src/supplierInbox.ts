import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import {
  mailboxInvoiceDefaults,
  canPrepareMailboxSupplier,
  normalizedSupplier,
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
  invoke<T>('supplier_inbox_request', { data });
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
) {
  const [state, setState] = useState<SupplierInboxState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const current = useRef({ org, blocked, onWorkspace });
  current.current = { org, blocked, onWorkspace };
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
      if (!readOnly && !current.current.blocked()) {
        let changed = false;
        if (value.prepareEnabled && value.linked) {
          const preparationKey = (i: MailInvoice) => JSON.stringify([org, i.id, i.extraction.supplierName, i.extraction.fieldConfidence, i.extraction.confidence, value.habits]);
          const candidates = pendingMailInvoices(value).filter(i => !i.otherDevice && canPrepareMailboxSupplier(i) && !preparedSuppliers.current.has(preparationKey(i))).slice(0, 10);
          if (candidates.length) {
            const result = await inboxRequest<{results: {id: string; supplierId?: string; created?: boolean; error?: string}[]}>({action:'prepareSuppliers', ids:candidates.map(i=>i.id)});
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
          if (current.current.org !== org || current.current.blocked()) break;
          try {
            const saved = await inboxRequest<{
              saved?: boolean;
              id: string;
              alreadyImported?: boolean;
            }>({
              action: 'import',
              id: next.id,
              automatic: next.state === 'ready',
            });
            if (current.current.org !== org) return;
            changed = changed || !!saved.saved;
          } catch (reason) {
            if (current.current.org === org) setError(String(reason));
          }
        }
        if (queue.length || changed) {
          if (changed) {
            const workspace = await desktopApi.loadWorkspace();
            if (current.current.org === org)
              current.current.onWorkspace(workspace);
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
    if (readOnly || running.current)
      throw Error('Attendez la fin de la réception en cours.');
    running.current = true;
    setBusy(true);
    try {
      const result = await inboxRequest<{
        saved?: boolean;
        id: string;
        alreadyImported?: boolean;
      }>({ action: 'import', id: item.id, invoice, automatic: false, confirm });
      if (current.current.org !== org) throw Error('L’entreprise a changé.');
      const workspace = await desktopApi.loadWorkspace();
      if (current.current.org !== org) throw Error('L’entreprise a changé.');
      current.current.onWorkspace(workspace);
      window.dispatchEvent(new Event('zentra-automation-updated'));
      const posted =
        workspace.supplierInvoices.find((row) => row.id === result.id)
          ?.documentStatus === 'validated';
      return { id: result.id, workspace, posted };
    } finally {
      running.current = false;
      setBusy(false);
      void refresh();
    }
  };
  const [batch, setBatch] = useState<{
    done: number;
    total: number;
    results: { id: string; label: string; outcome: string }[];
  } | null>(null);
  useEffect(() => {
    setBatch(null);
  }, [org]);
  const prepareAll = async (workspace: Workspace) => {
    if (!org || readOnly || !state?.prepareEnabled) return;
    if (running.current) {
      setError('La réception s’actualise. Réessayez dans un instant.');
      return;
    }
    setError('');
    running.current = true;
    setBusy(true);
    const queue = pendingMailInvoices(state).filter((i) => !i.otherDevice),
      results: { id: string; label: string; outcome: string }[] = [];
    setBatch({ done: 0, total: queue.length, results: [] });
    let local = workspace;
    try {
      for (const item of queue) {
        if (current.current.org !== org) break;
        let outcome = '';
        try {
          if (state.autoPost && item.state === 'ready')
            try {
              const r = await inboxRequest<{
                saved?: boolean;
                posted?: boolean;
              }>({ action: 'import', id: item.id, automatic: true });
              if (r.saved)
                outcome = r.posted
                  ? 'Comptabilisée'
                  : 'Brouillon préparé · à confirmer';
            } catch {
              /* Prepare a reviewed draft below, preserving the posting guard. */
            }
          if (!outcome) {
            const e = item.extraction;
            if (
              e.currency !== 'CHF' ||
              !e.reference ||
              !e.invoiceDate ||
              !e.dueDate ||
              e.netCents === null ||
              e.netCents <= 0 ||
              e.vatBp === null ||
              e.vatCents === null ||
              e.totalCents !== e.netCents + e.vatCents ||
              Math.round((e.netCents * e.vatBp) / 10000) !== e.vatCents
            )
              throw Error('Vérifiez les dates, la référence ou les montants.');
            const defaults = mailboxInvoiceDefaults(item, local, state.habits);
            const habit = state.habits?.find(
              (h) =>
                h.sender === item.sender.trim().toLowerCase() &&
                h.supplierName === normalizedSupplier(e.supplierName || '') &&
                local.suppliers.some(
                  (s) => s.id === h.supplierId && !s.archivedAt,
                ),
            );
            let supplier = habit?.supplierId || defaults.supplierId;
            if (!supplier) {
              if (
                !canPrepareMailboxSupplier(item) ||
                local.suppliers.some(
                  (s) =>
                    !s.archivedAt &&
                    normalizedSupplier(s.name) ===
                      normalizedSupplier(e.supplierName || ''),
                )
              )
                throw Error(
                  'Choisissez le fournisseur parmi les correspondances.',
                );
              const prepared = await inboxRequest<{ supplierId: string }>({
                action: 'prepareSupplier',
                id: item.id,
              });
              supplier = prepared.supplierId;
              local = await desktopApi.loadWorkspace();
            }
            if (current.current.org !== org) break;
            const category = defaults.category;
            if (!category)
              throw Error('Choisissez le classement de cet achat.');
            const account =
              habit &&
              normalizedSupplier(habit.category) ===
                normalizedSupplier(category) &&
              local.accounts.some(
                (a) =>
                  a.id === habit.accountId &&
                  a.active &&
                  a.accountType === 'expense',
              )
                ? habit.accountId
                : defaults.accountId;
            const saved = await inboxRequest<{ id: string }>({
              action: 'import',
              id: item.id,
              automatic: false,
              confirm: false,
              invoice: {
                supplier_id: supplier,
                date: e.invoiceDate,
                due_date: e.dueDate,
                reference: e.reference,
                items: [
                  {
                    description: `Facture ${e.reference}`,
                    quantity_milli: 1000,
                    unit_price_cents: e.netCents,
                    vat_bp: e.vatBp,
                    category,
                    expense_account_id: account || null,
                  },
                ],
              },
            });
            local = await desktopApi.loadWorkspace();
            outcome =
              local.supplierInvoices.find((i) => i.id === saved.id)
                ?.documentStatus === 'validated'
                ? 'Comptabilisée'
                : 'Brouillon préparé · à confirmer';
          }
        } catch (e) {
          outcome = String(e instanceof Error ? e.message : e);
        }
        results.push({
          id: item.id,
          label: item.extraction.reference || item.fileName,
          outcome,
        });
        if (current.current.org === org)
          setBatch({
            done: results.length,
            total: queue.length,
            results: [...results],
          });
      }
      if (current.current.org === org) {
        const w = await desktopApi.loadWorkspace();
        if (current.current.org === org) current.current.onWorkspace(w);
        window.dispatchEvent(new Event('zentra-automation-updated'));
      }
    } finally {
      running.current = false;
      setBusy(false);
      void refresh();
    }
  };
  return { state, error, busy, refresh, importInvoice, prepareAll, batch };
}

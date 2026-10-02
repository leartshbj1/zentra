/** Same-instance prop contract only. Real App normally remounts on physical scope change. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StockMovementForm } from '../src/StockMovementForm';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import type { Workspace } from '../src/types';
import '../src/styles.css';

export function mountStockFormScopeFixture(root: HTMLElement) {
  const proof = { actions: 0, reads: 0, closed: false, native: [] as string[] };
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    proof.native.push(command);
    if (command === 'append_diagnostic_events') return;
    throw new Error('Standalone scope fixture forbids native commands');
  } } });
  const item = { id: 'same-synthetic-item', kind: 'product' as const, name: 'Produit fictif', sku: 'SYNTHETIC', unit: 'litre', description: '', salesPriceCents: 100, purchaseCostCents: 100, vatBp: 0, trackStock: true, stockQuantityMilli: 10000, reorderLevelMilli: 0, archivedAt: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
  const initial: Workspace = {
    schemaVersion: 43, onboardingCompleted: true, activityProfileRequired: false, settings: structuredClone(initialOnboardingSettings), workNotesScope: 'synthetic-company-a',
    catalogItems: [item], stockMovements: [], stockAvailability: [{ catalogItemId: item.id, onHandMilli: 10000, reservedMilli: 0, availableMilli: 10000 }], stockReservationEvents: [],
    clients: [], suppliers: [], projects: [], projectMilestones: [], projectTasks: [], agendaEvents: [], quotes: [], salesOrders: [], recurrenceSchedules: [], recurrenceOccurrences: [], deliveryNotes: [], salesOrderInvoiceBatches: [], salesOrderInvoiceAllocations: [], invoices: [], invoiceCorrectionWorkflows: [], payments: [], employees: [], timeEntries: [], timeBillingBatches: [], timeBillingEntries: [], activeTimer: null, expenses: [], supplierOrders: [], supplierOrderCancellationLines: [], supplierReceipts: [], supplierInvoices: [], supplierInvoicePayments: [], supplierInvoiceMatches: [], supplierCreditNotes: [], supplierExpenseReclassifications: [], payslips: [], payrollImports: [], employeePayrollTemplates: [], accounts: [], accountingSettings: null, backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null },
  };
  function Host() {
    const [workspace, setWorkspace] = useState(initial);
    const [readOnly, setReadOnly] = useState(false);
    const [closed, setClosed] = useState(false);
    Object.assign(window, { __qaStockFormScope: {
      proof,
      switchScope: () => setWorkspace(previous => ({ ...previous, workNotesScope: 'synthetic-company-b' })),
      setReadOnly,
      state: () => ({ scope: workspace.workNotesScope, sameItem: workspace.catalogItems[0].id, readOnly }),
    } });
    return closed ? <p>FORM CLOSED EXPLICITLY</p> : <StockMovementForm workspace={workspace} itemId={item.id} movementType="entry" requestId="same-synthetic-request" busy={false} readOnly={readOnly}
      close={() => { proof.closed = true; setClosed(true); }}
      onReadWorkspace={async () => { proof.reads++; return workspace; }}
      act={async () => { proof.actions++; throw new Error('No action should be admitted by this fixture'); }} />;
  }
  createRoot(root).render(<Host />);
}

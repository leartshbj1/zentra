import { describe, expect, it, vi } from 'vitest';
import {
  bankAccountAssociationPayload,
  bankConfirmationPayload,
  bankSupplierReconciliationResultFromRaw,
  bankWorkspaceFromRaw,
  canConfirmBankReconciliation,
  canConfirmSupplierBankReconciliation,
  filterBankCandidates,
  filterBankMovements,
  filterBankSupplierCandidates,
  importCamtFromLocalDialog,
  initialInvoiceChoice,
  initialSupplierInvoiceChoice,
  supplierBankConfirmationPayload,
} from './bank';
import type { BankMovement, CamtImportResult, Client, Invoice, Supplier, SupplierInvoice } from './types';

const rawWorkspace = {
  summary: {
    import_count: 1,
    movement_count: 5,
    unreconciled_count: 1,
    unreconciled_supplier_count: 1,
    pending_count: 1,
    booked_credit_count: 2,
    booked_debit_count: 2,
  },
  accounts: [{ account_id: 'CH9300', currency: 'CHF', linked: 1, link_source: 'settings_iban', movement_count: 5 }],
  imports: [{
    id: 'import-1', source_name: 'releve.xml', file_sha256: 'abc', file_size: 12_340,
    message_type: 'camt.053', namespace_version: '001.08', account_id: 'CH9300',
    account_currency: 'CHF', entry_count: 5, imported_count: 4, ignored_count: 1, created_at: '2026-09-01T08:00:00Z',
  }],
  movements: [
    {
      id: 'movement-booked', import_id: 'import-1', account_id: 'CH9300', account_currency: 'CHF',
      amount_cents: 10_000, currency: 'CHF', credit_debit: 'CRDT', status: 'BOOK', reversal: 0,
      booking_date: '2026-09-01', value_date: '2026-09-01', account_servicer_ref: 'ASR-1',
      end_to_end_id: 'E2E-1', transaction_id: 'TX-1', reference_type: 'QRR', reference_level: 'D',
      reference: '210000000003139471430009017', unstructured: 'Facture 2026-15', counterparty_name: 'Client SA',
      strong_key: 'strong-1', created_at: '2026-09-01T08:00:00Z', reconciliation: null,
      suggestion: {
        kind: 'automatic_exact', invoice_id: 'invoice-1', invoice_number: 'FAC-2026-15',
        reason: 'Référence QR et montant exacts.', confirmable: 1,
        candidates: [{ invoice_id: 'invoice-1', invoice_number: 'FAC-2026-15', remaining_cents: 10_000, amount_relation: 'exact', reason: 'Même référence QR.', confirmable: true }],
      },
    },
    {
      id: 'movement-pending', import_id: 'import-1', amount_cents: 2_000, currency: 'CHF', credit_debit: 'CRDT',
      status: 'PDNG', reversal: false, booking_date: '2026-09-02', created_at: '2026-09-02T08:00:00Z',
      suggestion: { kind: 'none', confirmable: false, candidates: [] },
    },
    {
      id: 'movement-reconciled', import_id: 'import-1', amount_cents: 5_000, currency: 'CHF', credit_debit: 'CRDT',
      status: 'BOOK', reversal: false, booking_date: '2026-08-31', created_at: '2026-08-31T08:00:00Z',
      reconciliation: { id: 'rec-1', movement_id: 'movement-reconciled', invoice_id: 'invoice-2', payment_id: 'payment-1', amount_cents: 5_000, confirmed_at: '2026-09-01T09:00:00Z', created_at: '2026-09-01T09:00:00Z' },
      suggestion: { kind: 'none', confirmable: false, candidates: [] },
    },
    {
      id: 'movement-supplier', import_id: 'import-1', account_id: 'CH9300', account_currency: 'CHF',
      amount_cents: 10_810, currency: 'CHF', credit_debit: 'DBIT', status: 'BOOK', reversal: false,
      booking_date: '2026-08-30', value_date: '2026-08-30', reference_type: 'SCOR', reference: 'RF18539007547034',
      counterparty_name: 'Fournitures SA', counterparty_iban: 'CH5604835012345678009', strong_key: 'strong-supplier', created_at: '2026-08-30T08:00:00Z',
      reconciliation: null, supplier_reconciliation: null,
      suggestion: {
        entity_type: 'supplier_invoice', kind: 'supplier_match', reason: 'Vérifiez la facture proposée puis confirmez explicitement le décaissement.',
        confirmable: true, requires_confirmation: true, supplier_invoice_id: 'supplier-invoice-1',
        candidates: [{
          supplier_invoice_id: 'supplier-invoice-1', supplier_id: 'supplier-1', supplier_name: 'Fournitures SA',
          supplier_iban: 'CH5604835012345678009', reference: 'RF18539007547034', document_date: '2026-08-12',
          remaining_cents: 10_810, amount_relation: 'exact', match_kind: 'structured_reference',
          reason: 'Référence structurée identique à la facture fournisseur.', confirmable: true,
        }],
      },
    },
    {
      id: 'movement-supplier-reconciled', import_id: 'import-1', account_id: 'CH9300', account_currency: 'CHF',
      amount_cents: 4_500, currency: 'CHF', credit_debit: 'DBIT', status: 'BOOK', reversal: false,
      booking_date: '2026-08-29', created_at: '2026-08-29T08:00:00Z',
      reconciliation: null,
      supplier_reconciliation: { id: 'supplier-rec-1', movement_id: 'movement-supplier-reconciled', supplier_invoice_id: 'supplier-invoice-2', supplier_payment_id: 'supplier-payment-1', amount_cents: 4_500, confirmed_at: '2026-08-29T09:00:00Z', created_at: '2026-08-29T09:00:00Z' },
      suggestion: { entity_type: 'supplier_invoice', kind: 'none', confirmable: false, requires_confirmation: true, candidates: [] },
    },
  ],
  reconciliations: [{ id: 'rec-1', movement_id: 'movement-reconciled', invoice_id: 'invoice-2', payment_id: 'payment-1', amount_cents: 5_000, confirmed_at: '2026-09-01T09:00:00Z', created_at: '2026-09-01T09:00:00Z' }],
  supplier_reconciliations: [{ id: 'supplier-rec-1', movement_id: 'movement-supplier-reconciled', supplier_invoice_id: 'supplier-invoice-2', supplier_payment_id: 'supplier-payment-1', amount_cents: 4_500, confirmed_at: '2026-08-29T09:00:00Z', created_at: '2026-08-29T09:00:00Z' }],
};

it('preserves expense payment proof and removes that movement from invoice choices and open counts', () => {
  const workspace = bankWorkspaceFromRaw({ movements: [{
    id: 'expense-bank', status: 'BOOK', credit_debit: 'DBIT', amount_cents: 10810,
    expense_reconciliation: { id: 'link', expense_id: 'expense', journal_entry_id: 'journal', confirmed_at: '2026-08-31T10:00:00Z' },
    expense_suggestion: { reason: 'Déjà rapproché', candidates: [] },
    suggestion: { entity_type: 'supplier_invoice', kind: 'supplier_match', confirmable: true, requires_confirmation: true, supplier_invoice_id: 'invoice', candidates: [{ supplier_invoice_id: 'invoice', confirmable: true, remaining_cents: 10810 }] },
  }] });
  const movement = workspace.movements[0];
  expect(movement.expenseReconciliation).toEqual({ id: 'link', expenseId: 'expense', journalEntryId: 'journal', confirmedAt: '2026-08-31T10:00:00Z' });
  expect(filterBankMovements([movement], 'unreconciled')).toEqual([]);
  expect(filterBankMovements([movement], 'reconciled')).toEqual([movement]);
  expect(canConfirmSupplierBankReconciliation(movement, 'invoice')).toBe(false);
  expect(canConfirmBankReconciliation(movement, 'invoice')).toBe(false);
});

describe('mapping CAMT local', () => {
  it('retrouve les mouvements par nom accentué, référence espacée et montant décimal sans changer le filtre', () => {
    const workspace = bankWorkspaceFromRaw(rawWorkspace);
    workspace.movements[0].counterpartyName = 'Électricité du Léman';
    expect(filterBankMovements(workspace.movements, 'unreconciled', 'electricite du leman').map((row) => row.id)).toEqual(['movement-booked']);
    expect(filterBankMovements(workspace.movements, 'unreconciled', 'RF18 5390 0754 7034').map((row) => row.id)).toEqual(['movement-supplier']);
    expect(filterBankMovements(workspace.movements, 'unreconciled', '108,10').map((row) => row.id)).toEqual(['movement-supplier']);
    expect(filterBankMovements(workspace.movements, 'reconciled', 'electricite')).toEqual([]);
  });
  it('déduit l’avoir déjà imputé dans le solde renvoyé après règlement fournisseur', () => {
    const result = bankSupplierReconciliationResultFromRaw({ supplier_invoice: { id: 'credited', total_cents: 10810, credited_cents: 2810, paid_cents: 8000 } });
    expect(result.supplierInvoice).toMatchObject({ totalCents: 10810, paidCents: 8000, creditedCents: 2810, balanceCents: 0 });
  });
  it('convertit systématiquement le snake_case du backend en types UI', () => {
    const workspace = bankWorkspaceFromRaw(rawWorkspace);
    expect(workspace.summary).toEqual({ importCount: 1, movementCount: 5, unreconciledCount: 1, unreconciledSupplierCount: 1, pendingCount: 1, bookedCreditCount: 2, bookedDebitCount: 2 });
    expect(workspace.imports[0]).toMatchObject({ sourceName: 'releve.xml', messageType: 'camt.053', namespaceVersion: '001.08', entryCount: 5, importedCount: 4, ignoredCount: 1 });
    expect(workspace.accounts[0]).toEqual({ accountId: 'CH9300', currency: 'CHF', linked: true, linkSource: 'settings_iban', movementCount: 5 });
    expect(workspace.movements[0]).toMatchObject({
      id: 'movement-booked', creditDebit: 'CRDT', status: 'BOOK', reversal: false,
      referenceType: 'QRR', referenceLevel: 'D', counterpartyName: 'Client SA',
    });
    expect(workspace.movements[0].suggestion.candidates[0]).toEqual({
      invoiceId: 'invoice-1', invoiceNumber: 'FAC-2026-15', remainingCents: 10_000,
      amountRelation: 'exact', reason: 'Même référence QR.', confirmable: true,
    });
  });

  it('isole la proposition fournisseur DBIT sans la faire passer pour une facture client', () => {
    const workspace = bankWorkspaceFromRaw(rawWorkspace);
    const movement = workspace.movements.find((item) => item.id === 'movement-supplier')!;
    expect(movement).toMatchObject({ creditDebit: 'DBIT', counterpartyIban: 'CH5604835012345678009' });
    expect(movement.suggestion).toMatchObject({ kind: 'none', invoiceId: null, candidates: [] });
    expect(movement.supplierSuggestion).toMatchObject({
      kind: 'supplier_match', supplierInvoiceId: 'supplier-invoice-1', confirmable: true, requiresConfirmation: true,
    });
    expect(movement.supplierSuggestion.candidates[0]).toEqual({
      supplierInvoiceId: 'supplier-invoice-1', supplierId: 'supplier-1', supplierName: 'Fournitures SA',
      supplierIban: 'CH5604835012345678009', reference: 'RF18539007547034', documentDate: '2026-08-12',
      remainingCents: 10_810, amountRelation: 'exact', matchKind: 'structured_reference',
      reason: 'Référence structurée identique à la facture fournisseur.', confirmable: true,
    });
    expect(workspace.supplierReconciliations[0]).toMatchObject({ supplierInvoiceId: 'supplier-invoice-2', supplierPaymentId: 'supplier-payment-1' });
  });

  it('reste compatible avec un ancien espace sans champs fournisseur', () => {
    const workspace = bankWorkspaceFromRaw({ summary: {}, movements: [{ id: 'legacy', credit_debit: 'CRDT', suggestion: { kind: 'none', candidates: [] } }] });
    expect(workspace.summary.unreconciledSupplierCount).toBe(0);
    expect(workspace.summary.bookedDebitCount).toBe(0);
    expect(workspace.supplierReconciliations).toEqual([]);
    expect(workspace.movements[0].supplierReconciliation).toBeNull();
    expect(workspace.movements[0].supplierSuggestion).toMatchObject({ kind: 'none', candidates: [], requiresConfirmation: true });
  });
});

describe('triage et choix de facture', () => {
  const workspace = bankWorkspaceFromRaw(rawWorkspace);

  it('sépare à rapprocher, en attente et rapprochés sans assimiler PDNG à BOOK', () => {
    expect(filterBankMovements(workspace.movements, 'unreconciled').map((item) => item.id)).toEqual(['movement-booked', 'movement-supplier']);
    expect(filterBankMovements(workspace.movements, 'pending').map((item) => item.id)).toEqual(['movement-pending']);
    expect(filterBankMovements(workspace.movements, 'reconciled').map((item) => item.id)).toEqual(['movement-reconciled', 'movement-supplier-reconciled']);
    expect(filterBankMovements(workspace.movements, 'all').map((item) => item.id)).toEqual(['movement-pending', 'movement-booked', 'movement-reconciled', 'movement-supplier', 'movement-supplier-reconciled']);
  });

  it('inclut les crédits et débits BOOK dans « À rapprocher » mais exclut les extournes', () => {
    const booked = workspace.movements[0];
    const debit = workspace.movements.find((item) => item.id === 'movement-supplier')!;
    const reversal: BankMovement = { ...booked, id: 'movement-reversal', reversal: true };
    expect(filterBankMovements([booked, debit, reversal], 'unreconciled').map((item) => item.id)).toEqual(['movement-booked', 'movement-supplier']);
    expect(filterBankMovements([booked, debit, reversal], 'all')).toHaveLength(3);
  });

  it('préselectionne uniquement une proposition automatique confirmable', () => {
    expect(initialInvoiceChoice(workspace.movements[0])).toBe('invoice-1');
    expect(initialInvoiceChoice(workspace.movements[1])).toBe('');
    expect(initialInvoiceChoice({ ...workspace.movements[0], suggestion: { ...workspace.movements[0].suggestion, kind: 'manual' } })).toBe('');
  });

  it('préselectionne uniquement une correspondance fournisseur unique et confirmable', () => {
    const debit = workspace.movements.find((item) => item.id === 'movement-supplier')!;
    expect(initialSupplierInvoiceChoice(debit)).toBe('supplier-invoice-1');
    expect(initialInvoiceChoice(debit)).toBe('');
    expect(initialSupplierInvoiceChoice({ ...debit, supplierSuggestion: { ...debit.supplierSuggestion, kind: 'supplier_manual', supplierInvoiceId: null } })).toBe('');
    expect(initialSupplierInvoiceChoice({ ...debit, supplierSuggestion: { ...debit.supplierSuggestion, requiresConfirmation: false } })).toBe('');
  });

  it('retrouve les candidats manuels par numéro, client et montant sans masquer les bloqués', () => {
    const movement: BankMovement = {
      ...workspace.movements[0],
      suggestion: {
        ...workspace.movements[0].suggestion,
        kind: 'manual',
        invoiceId: null,
        invoiceNumber: null,
        candidates: [
          workspace.movements[0].suggestion.candidates[0],
          { invoiceId: 'invoice-2', invoiceNumber: 'FAC-2026-99', remainingCents: 25_050, amountRelation: 'overpayment', reason: 'Montant trop élevé.', confirmable: false },
        ],
      },
    };
    const invoices = [
      { id: 'invoice-1', number: 'FAC-2026-15', clientId: 'client-1', title: 'Mandat Genève', issueDate: '2026-08-01', dueDate: '2026-08-31' },
      { id: 'invoice-2', number: 'FAC-2026-99', clientId: 'client-2', title: 'Maintenance', issueDate: '2026-08-02', dueDate: '2026-09-01' },
    ] as Invoice[];
    const clients = [
      { id: 'client-1', name: 'Alice', company: 'Client SA' },
      { id: 'client-2', name: 'Bob', company: 'Atelier Étoile' },
    ] as Client[];

    expect(filterBankCandidates(movement, invoices, clients, 'FAC-2026-15').map((item) => item.candidate.invoiceId)).toEqual(['invoice-1']);
    expect(filterBankCandidates(movement, invoices, clients, 'etoile').map((item) => item.candidate.invoiceId)).toEqual(['invoice-2']);
    expect(filterBankCandidates(movement, invoices, clients, '250,50')[0].candidate.confirmable).toBe(false);
    expect(filterBankCandidates(movement, invoices, clients, '')).toHaveLength(2);
  });

  it('bloque PDNG, les extournes et un montant supérieur au solde', () => {
    const booked = workspace.movements[0];
    expect(canConfirmBankReconciliation(booked, 'invoice-1')).toBe(true);
    expect(canConfirmBankReconciliation({ ...booked, status: 'PDNG' }, 'invoice-1')).toBe(false);
    expect(canConfirmBankReconciliation({ ...booked, reversal: true }, 'invoice-1')).toBe(false);
    const overpayment: BankMovement = { ...booked, amountCents: 10_001 };
    expect(canConfirmBankReconciliation(overpayment, 'invoice-1')).toBe(false);
  });

  it('retrouve les factures fournisseur par référence, nom, IBAN et montant', () => {
    const movement = workspace.movements.find((item) => item.id === 'movement-supplier')!;
    const invoices = [{
      id: 'supplier-invoice-1', supplierId: 'supplier-1', supplierName: 'Fournitures SA', reference: 'RF18539007547034',
      documentDate: '2026-08-12', dueDate: '2026-09-11',
    }] as SupplierInvoice[];
    const suppliers = [{ id: 'supplier-1', name: 'Fournitures SA', iban: 'CH5604835012345678009' }] as Supplier[];

    expect(filterBankSupplierCandidates(movement, invoices, suppliers, 'fournitures')[0].candidate.supplierInvoiceId).toBe('supplier-invoice-1');
    expect(filterBankSupplierCandidates(movement, invoices, suppliers, 'CH5604835')).toHaveLength(1);
    expect(filterBankSupplierCandidates(movement, invoices, suppliers, '108,10')).toHaveLength(1);
    expect(filterBankSupplierCandidates(movement, invoices, suppliers, 'introuvable')).toEqual([]);
  });

  it('garde le règlement fournisseur bloqué tant que tous les contrôles ne passent pas', () => {
    const debit = workspace.movements.find((item) => item.id === 'movement-supplier')!;
    expect(canConfirmSupplierBankReconciliation(debit, 'supplier-invoice-1')).toBe(true);
    expect(canConfirmSupplierBankReconciliation({ ...debit, status: 'PDNG' }, 'supplier-invoice-1')).toBe(false);
    expect(canConfirmSupplierBankReconciliation({ ...debit, reversal: true }, 'supplier-invoice-1')).toBe(false);
    expect(canConfirmSupplierBankReconciliation({ ...debit, creditDebit: 'CRDT' }, 'supplier-invoice-1')).toBe(false);
    expect(canConfirmSupplierBankReconciliation({ ...debit, amountCents: 10_811 }, 'supplier-invoice-1')).toBe(false);
    expect(canConfirmSupplierBankReconciliation({ ...debit, supplierReconciliation: workspace.supplierReconciliations[0] }, 'supplier-invoice-1')).toBe(false);
    expect(canConfirmSupplierBankReconciliation({ ...debit, supplierSuggestion: { ...debit.supplierSuggestion, confirmable: false } }, 'supplier-invoice-1')).toBe(false);
  });
});

describe('actions explicites', () => {
  it('n’importe rien lorsque le dialogue local est annulé', async () => {
    const importer = vi.fn<() => Promise<CamtImportResult>>();
    await expect(importCamtFromLocalDialog(async () => null, importer)).resolves.toBeNull();
    expect(importer).not.toHaveBeenCalled();
  });

  it('construit le payload snake_case exact de confirmation', () => {
    expect(bankConfirmationPayload('movement-1', 'invoice-1')).toEqual({ input: { movement_id: 'movement-1', invoice_id: 'invoice-1' } });
    expect(supplierBankConfirmationPayload('movement-2', 'supplier-invoice-1')).toEqual({ input: { movement_id: 'movement-2', supplier_invoice_id: 'supplier-invoice-1' } });
    expect(bankAccountAssociationPayload('CH9300', 'CHF')).toEqual({ input: { account_id: 'CH9300', currency: 'CHF' } });
  });

  it('mappe la réponse atomique du rapprochement fournisseur', () => {
    const result = bankSupplierReconciliationResultFromRaw({
      movement: { id: 'movement-2', credit_debit: 'DBIT', amount_cents: 10_810 },
      supplier_reconciliation: { id: 'supplier-rec-2', movement_id: 'movement-2', supplier_invoice_id: 'supplier-invoice-1', supplier_payment_id: 'supplier-payment-2', amount_cents: 10_810, confirmed_at: '2026-09-01T10:00:00Z', created_at: '2026-09-01T10:00:00Z' },
      payment: { id: 'supplier-payment-2', supplier_invoice_id: 'supplier-invoice-1', request_id: 'movement-2', date: '2026-09-01', amount_cents: 10_810, method: 'Virement bancaire CAMT', reference: 'RF18539007547034', journal_entry_id: 'journal-2', created_at: '2026-09-01T10:00:00Z' },
      supplier_invoice: { id: 'supplier-invoice-1', supplier_id: 'supplier-1', reference: 'RF18539007547034', status: 'validated', total_cents: 10_810, paid_cents: 10_810 },
      idempotent: true,
    });
    expect(result.supplierReconciliation).toMatchObject({ id: 'supplier-rec-2', supplierPaymentId: 'supplier-payment-2' });
    expect(result.movement.supplierReconciliation?.id).toBe('supplier-rec-2');
    expect(result.payment).toMatchObject({ supplierInvoiceId: 'supplier-invoice-1', amountCents: 10_810 });
    expect(result.supplierInvoice).toMatchObject({ documentStatus: 'validated', paidCents: 10_810, balanceCents: 0 });
    expect(result.idempotent).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  bankAccountAssociationPayload,
  bankConfirmationPayload,
  bankWorkspaceFromRaw,
  canConfirmBankReconciliation,
  filterBankCandidates,
  filterBankMovements,
  importCamtFromLocalDialog,
  initialInvoiceChoice,
} from './bank';
import type { BankMovement, CamtImportResult, Client, Invoice } from './types';

const rawWorkspace = {
  summary: {
    import_count: 1,
    movement_count: 3,
    unreconciled_count: 2,
    pending_count: 1,
    booked_credit_count: 1,
  },
  accounts: [{ account_id: 'CH9300', currency: 'CHF', linked: 1, link_source: 'settings_iban', movement_count: 3 }],
  imports: [{
    id: 'import-1', source_name: 'releve.xml', file_sha256: 'abc', file_size: 12_340,
    message_type: 'camt.053', namespace_version: '001.08', account_id: 'CH9300',
    account_currency: 'CHF', entry_count: 3, imported_count: 2, ignored_count: 1, created_at: '2026-09-01T08:00:00Z',
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
  ],
  reconciliations: [{ id: 'rec-1', movement_id: 'movement-reconciled', invoice_id: 'invoice-2', payment_id: 'payment-1', amount_cents: 5_000, confirmed_at: '2026-09-01T09:00:00Z', created_at: '2026-09-01T09:00:00Z' }],
};

describe('mapping CAMT local', () => {
  it('convertit systématiquement le snake_case du backend en types UI', () => {
    const workspace = bankWorkspaceFromRaw(rawWorkspace);
    expect(workspace.summary).toEqual({ importCount: 1, movementCount: 3, unreconciledCount: 2, pendingCount: 1, bookedCreditCount: 1 });
    expect(workspace.imports[0]).toMatchObject({ sourceName: 'releve.xml', messageType: 'camt.053', namespaceVersion: '001.08', entryCount: 3, importedCount: 2, ignoredCount: 1 });
    expect(workspace.accounts[0]).toEqual({ accountId: 'CH9300', currency: 'CHF', linked: true, linkSource: 'settings_iban', movementCount: 3 });
    expect(workspace.movements[0]).toMatchObject({
      id: 'movement-booked', creditDebit: 'CRDT', status: 'BOOK', reversal: false,
      referenceType: 'QRR', referenceLevel: 'D', counterpartyName: 'Client SA',
    });
    expect(workspace.movements[0].suggestion.candidates[0]).toEqual({
      invoiceId: 'invoice-1', invoiceNumber: 'FAC-2026-15', remainingCents: 10_000,
      amountRelation: 'exact', reason: 'Même référence QR.', confirmable: true,
    });
  });
});

describe('triage et choix de facture', () => {
  const workspace = bankWorkspaceFromRaw(rawWorkspace);

  it('sépare à rapprocher, en attente et rapprochés sans assimiler PDNG à BOOK', () => {
    expect(filterBankMovements(workspace.movements, 'unreconciled').map((item) => item.id)).toEqual(['movement-booked']);
    expect(filterBankMovements(workspace.movements, 'pending').map((item) => item.id)).toEqual(['movement-pending']);
    expect(filterBankMovements(workspace.movements, 'reconciled').map((item) => item.id)).toEqual(['movement-reconciled']);
    expect(filterBankMovements(workspace.movements, 'all').map((item) => item.id)).toEqual(['movement-pending', 'movement-booked', 'movement-reconciled']);
  });

  it('réserve « À rapprocher » aux crédits BOOK et garde débits et extournes dans « Tous »', () => {
    const booked = workspace.movements[0];
    const debit: BankMovement = { ...booked, id: 'movement-debit', creditDebit: 'DBIT' };
    const reversal: BankMovement = { ...booked, id: 'movement-reversal', reversal: true };
    expect(filterBankMovements([booked, debit, reversal], 'unreconciled').map((item) => item.id)).toEqual(['movement-booked']);
    expect(filterBankMovements([booked, debit, reversal], 'all')).toHaveLength(3);
  });

  it('préselectionne uniquement une proposition automatique confirmable', () => {
    expect(initialInvoiceChoice(workspace.movements[0])).toBe('invoice-1');
    expect(initialInvoiceChoice(workspace.movements[1])).toBe('');
    expect(initialInvoiceChoice({ ...workspace.movements[0], suggestion: { ...workspace.movements[0].suggestion, kind: 'manual' } })).toBe('');
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
});

describe('actions explicites', () => {
  it('n’importe rien lorsque le dialogue local est annulé', async () => {
    const importer = vi.fn<() => Promise<CamtImportResult>>();
    await expect(importCamtFromLocalDialog(async () => null, importer)).resolves.toBeNull();
    expect(importer).not.toHaveBeenCalled();
  });

  it('construit le payload snake_case exact de confirmation', () => {
    expect(bankConfirmationPayload('movement-1', 'invoice-1')).toEqual({ input: { movement_id: 'movement-1', invoice_id: 'invoice-1' } });
    expect(bankAccountAssociationPayload('CH9300', 'CHF')).toEqual({ input: { account_id: 'CH9300', currency: 'CHF' } });
  });
});

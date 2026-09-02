import { describe, expect, it } from 'vitest';
import { buildGettingStartedJourney } from './gettingStarted';
import type { Invoice, Project, Quote, Workspace } from './types';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    clients: [],
    projects: [],
    quotes: [],
    invoices: [],
    payments: [],
    accountingSettings: null,
    backupStatus: {
      lastSuccessAt: null,
      lastPath: null,
      nextScheduledAt: null,
    },
    ...overrides,
  } as Workspace;
}

const project = {
  id: 'project-1',
  clientId: 'client-1',
  name: 'Mandat réel',
  archivedAt: null,
} as Project;

function quote(status: Quote['status'], id = `quote-${status}`): Quote {
  return {
    id,
    number: status === 'draft' ? '' : 'DEV-1',
    clientId: 'client-1',
    status,
  } as Quote;
}

function invoice(status: Invoice['status'], id = `invoice-${status}`): Invoice {
  return {
    id,
    number: status === 'draft' ? '' : 'FAC-1',
    clientId: 'client-1',
    quoteId: 'quote-accepted',
    type: 'standard',
    status,
  } as Invoice;
}

describe('parcours de premiers pas dérivé des données réelles', () => {
  it('commence par une seule action client et ne valide aucune étape vide', () => {
    const result = buildGettingStartedJourney(workspace());

    expect(result.completedCount).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.nextStep?.id).toBe('client');
    expect(result.nextAction).toMatchObject({
      kind: 'create_client',
      view: 'clients',
    });
  });

  it('ne masque pas la suite après la création du premier client', () => {
    const result = buildGettingStartedJourney(workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
    }));

    expect(result.completedCount).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.nextStep?.id).toBe('project');
    expect(result.nextAction?.kind).toBe('create_project');
  });

  it('dirige vers le devis existant tant que la décision client manque', () => {
    const result = buildGettingStartedJourney(workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('issued')],
    }));

    expect(result.nextStep?.id).toBe('quote');
    expect(result.nextAction).toMatchObject({
      kind: 'review_quotes',
      entityId: 'quote-issued',
    });
  });

  it('ne contourne pas une configuration de facturation encore différée', () => {
    const result = buildGettingStartedJourney(workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      settings: {
        setupDeferred: { billing: true, work: false, backup: false },
      } as Workspace['settings'],
    }));

    expect(result.nextStep?.id).toBe('quote');
    expect(result.nextAction).toMatchObject({
      kind: 'configure_billing',
      view: 'settings',
    });
  });

  it('propose le brouillon de facture avant une nouvelle conversion', () => {
    const result = buildGettingStartedJourney(workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('accepted')],
      invoices: [invoice('draft')],
    }));

    expect(result.nextStep?.id).toBe('invoice');
    expect(result.nextAction).toMatchObject({
      kind: 'review_invoice',
      entityId: 'invoice-draft',
    });
  });

  it('demande la liaison comptable avant de proposer un encaissement', () => {
    const result = buildGettingStartedJourney(workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('accepted')],
      invoices: [invoice('issued')],
    }));

    expect(result.nextStep?.id).toBe('payment');
    expect(result.nextAction?.kind).toBe('configure_accounting');
  });

  it('cible une facture ouverte lorsque les comptes client et banque sont prêts', () => {
    const result = buildGettingStartedJourney(workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('accepted')],
      invoices: [invoice('issued')],
      accountingSettings: {
        enabled: true,
        arAccountId: '1100',
        bankAccountId: '1020',
      } as Workspace['accountingSettings'],
    }));

    expect(result.nextAction).toMatchObject({
      kind: 'record_payment',
      entityId: 'invoice-issued',
    });
  });

  it('ne valide que la preuve comptable active et sémantiquement vérifiée', () => {
    const base = {
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('accepted')],
      invoices: [invoice('paid')],
    };
    const incomplete = buildGettingStartedJourney(workspace({
      ...base,
      payments: [{
        id: 'payment-1',
        invoiceId: 'invoice-paid',
        amountCents: 10_000,
        journalEntryId: 'journal-1',
        journalEntryIsActive: true,
        journalEntrySemanticallyValid: false,
      } as Workspace['payments'][number]],
    }));
    const verified = buildGettingStartedJourney(workspace({
      ...base,
      payments: [{
        id: 'payment-1',
        invoiceId: 'invoice-paid',
        amountCents: 10_000,
        journalEntryId: 'journal-1',
        journalEntryIsActive: true,
        journalEntrySemanticallyValid: true,
      } as Workspace['payments'][number]],
    }));

    expect(incomplete.nextStep?.id).toBe('payment');
    expect(verified.nextStep?.id).toBe('backup');
    expect(verified.nextAction?.kind).toBe('create_backup');
  });

  it('refuse de composer une fausse chaîne avec une facture ou un paiement non liés', () => {
    const base = {
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('accepted')],
    };
    const unrelatedInvoice = invoice('paid');
    unrelatedInvoice.quoteId = 'quote-unrelated';
    const invoiceMismatch = buildGettingStartedJourney(workspace({
      ...base,
      invoices: [unrelatedInvoice],
      payments: [{
        id: 'payment-unrelated',
        invoiceId: unrelatedInvoice.id,
        amountCents: 10_000,
        journalEntryId: 'journal-unrelated',
        journalEntryIsActive: true,
        journalEntrySemanticallyValid: true,
      } as Workspace['payments'][number]],
    }));

    expect(invoiceMismatch.nextStep?.id).toBe('invoice');

    const linkedInvoice = invoice('paid');
    const paymentMismatch = buildGettingStartedJourney(workspace({
      ...base,
      invoices: [linkedInvoice],
      payments: [{
        id: 'payment-other-invoice',
        invoiceId: 'invoice-unrelated',
        amountCents: 10_000,
        journalEntryId: 'journal-other',
        journalEntryIsActive: true,
        journalEntrySemanticallyValid: true,
      } as Workspace['payments'][number]],
    }));

    expect(paymentMismatch.nextStep?.id).toBe('payment');
  });

  it('termine uniquement après une sauvegarde réussie avec un chemin réel', () => {
    const common = {
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [project],
      quotes: [quote('accepted')],
      invoices: [invoice('paid')],
      payments: [{
        id: 'payment-1',
        invoiceId: 'invoice-paid',
        amountCents: 10_000,
        journalEntryId: 'journal-1',
        journalEntryIsActive: true,
        journalEntrySemanticallyValid: true,
      } as Workspace['payments'][number]],
    };
    const withoutPath = buildGettingStartedJourney(workspace({
      ...common,
      backupStatus: {
        lastSuccessAt: '2026-09-02T08:00:00+02:00',
        lastPath: null,
        nextScheduledAt: null,
      },
    }));
    const complete = buildGettingStartedJourney(workspace({
      ...common,
      backupStatus: {
        lastSuccessAt: '2026-09-02T08:00:00+02:00',
        lastPath: 'D:\\Sauvegardes Zentra\\zentra-20260902.zentra',
        nextScheduledAt: null,
      },
    }));

    expect(withoutPath.complete).toBe(false);
    expect(complete).toMatchObject({
      completedCount: 6,
      totalCount: 6,
      percent: 100,
      complete: true,
      nextStep: null,
      nextAction: null,
    });
  });
});

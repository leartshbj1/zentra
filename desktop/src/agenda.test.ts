import { describe, expect, it } from 'vitest';
import {
  buildAgendaItems,
  calendarDays,
  itemOccursOn,
  shiftDate,
  shiftMonth,
  weekDates,
} from './agenda';
import type { Workspace } from './types';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    schemaVersion: 36,
    onboardingCompleted: true,
    activityProfileRequired: false,
    settings: null,
    clients: [],
    catalogItems: [],
    stockMovements: [],
    suppliers: [],
    projects: [],
    projectMilestones: [],
    projectTasks: [],
    agendaEvents: [],
    quotes: [],
    salesOrders: [],
    recurrenceSchedules: [],
    recurrenceOccurrences: [],
    deliveryNotes: [],
    stockReservationEvents: [],
    stockAvailability: [],
    salesOrderInvoiceBatches: [],
    salesOrderInvoiceAllocations: [],
    invoices: [],
    payments: [],
    employees: [],
    timeEntries: [],
    timeBillingBatches: [],
    timeBillingEntries: [],
    activeTimer: null,
    expenses: [],
    supplierOrders: [],
    supplierOrderCancellationLines: [],
    supplierReceipts: [],
    supplierInvoices: [],
    supplierInvoicePayments: [],
    supplierInvoiceMatches: [],
    supplierCreditNotes: [],
    supplierExpenseReclassifications: [],
    payslips: [],
    payrollImports: [],
    employeePayrollTemplates: [],
    accounts: [],
    accountingSettings: null,
    backupStatus: {
      automatic: false,
      folder: '',
      frequency: 'manual',
      retentionDaily: 0,
      retentionWeekly: 0,
      retentionMonthly: 0,
      recoveryConfirmed: false,
      lastBackupAt: '',
      lastBackupPath: '',
      lastBackupError: '',
      lastRestoreAt: '',
      nextBackupAt: '',
    },
    ...overrides,
  } as Workspace;
}

describe('agenda', () => {
  it('compose les objets réels et ignore les brouillons sans échéance utile', () => {
    const result = buildAgendaItems(
      workspace({
        clients: [
          {
            id: 'client-1',
            name: 'Aline',
            company: 'Alpina SA',
            email: '',
            phone: '',
            address: '',
            uidNumber: '',
            notes: '',
          },
        ],
        invoices: [
          {
            id: 'invoice-1',
            number: 'F-42',
            clientId: 'client-1',
            projectId: null,
            quoteId: null,
            originalInvoiceId: null,
            title: '',
            type: 'standard',
            issueDate: '2026-09-01',
            dueDate: '2026-09-30',
            serviceDateFrom: '',
            serviceDateTo: '',
            currency: 'CHF',
            status: 'issued',
            lines: [],
            notes: '',
            createdAt: '',
          },
          {
            id: 'invoice-draft',
            number: '',
            clientId: 'client-1',
            projectId: null,
            quoteId: null,
            originalInvoiceId: null,
            title: 'Brouillon',
            type: 'standard',
            issueDate: '',
            dueDate: '2026-09-12',
            serviceDateFrom: '',
            serviceDateTo: '',
            currency: 'CHF',
            status: 'draft',
            lines: [],
            notes: '',
            createdAt: '',
          },
        ],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'invoice',
      date: '2026-09-30',
      subtitle: 'Alpina SA',
    });
  });

  it('produit une grille complète commençant un lundi', () => {
    const days = calendarDays('2026-09');
    expect(days).toHaveLength(42);
    expect(days[0].date).toBe('2026-08-31');
    expect(days[41].date).toBe('2026-10-11');
  });

  it('gère les événements sur plusieurs jours et les changements de mois', () => {
    expect(
      itemOccursOn(
        {
          id: 'event:1',
          source: 'event',
          sourceId: '1',
          category: 'agenda',
          date: '2026-09-02',
          endDate: '2026-09-04',
          time: null,
          endTime: null,
          title: 'Visite',
          subtitle: '',
          status: 'active',
        },
        '2026-09-03',
      ),
    ).toBe(true);
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekDates('2026-09-02')).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });
});

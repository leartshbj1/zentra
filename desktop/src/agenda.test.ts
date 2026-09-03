import { describe, expect, it } from 'vitest';
import {
  agendaNavigationQuery,
  agendaNavigationTarget,
  buildAgendaItems,
  calendarDays,
  countUpcomingAgendaItems,
  formatAgendaItemRange,
  itemOccursOn,
  millisecondsUntilNextLocalDay,
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
    const source = workspace({
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
      });
    const result = buildAgendaItems(source);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'invoice',
      date: '2026-09-30',
      subtitle: 'Alpina SA',
    });
    expect(agendaNavigationQuery(result[0], source)).toBe('F-42');
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

  it('cible le vrai titre d’un jalon sans conserver le préfixe de l’agenda', () => {
    const source = workspace({
      projectMilestones: [
        {
          id: 'milestone-1',
          projectId: 'project-1',
          title: 'Réception finale',
          description: '',
          dueDate: '2026-09-12',
          status: 'done',
          priority: 'normal',
          sortOrder: 0,
          employeeId: null,
          completedAt: '2026-09-12T10:00:00Z',
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    const item = buildAgendaItems(source)[0];
    expect(item.title).toBe('Jalon · Réception finale');
    expect(agendaNavigationQuery(item, source)).toBe('Réception finale');
  });

  it('conserve l’identifiant exact même lorsque deux documents ont le même numéro', () => {
    const duplicate = (sourceId: string) => ({
      id: `invoice:${sourceId}:due`,
      source: 'invoice' as const,
      sourceId,
      category: 'deadlines' as const,
      date: '2026-09-30',
      endDate: '2026-09-30',
      time: null,
      endTime: null,
      title: 'Facture F-42',
      subtitle: 'Client',
      status: 'active' as const,
      route: 'invoices' as const,
    });

    expect(agendaNavigationTarget(duplicate('invoice-a'))).toEqual({
      route: 'invoices',
      source: 'invoice',
      sourceId: 'invoice-a',
    });
    expect(agendaNavigationTarget(duplicate('invoice-b'))?.sourceId).toBe(
      'invoice-b',
    );
  });

  it('affiche les factures fournisseurs validées à payer mais jamais les brouillons ou factures soldées', () => {
    const common = {
      supplierId: 'supplier-1',
      projectId: null,
      documentDate: '2026-09-01',
      dueDate: '2026-09-15',
      supplierName: 'Papeterie SA',
      reference: 'INV-42',
      currency: 'CHF' as const,
      netCents: 10_000,
      vatCents: 810,
      totalCents: 10_810,
      paidCents: 0,
      creditedCents: 0,
      balanceCents: 10_810,
      matchStatus: 'unmatched' as const,
      validatedAt: '2026-09-01T10:00:00Z',
      validationJournalEntryId: 'entry-1',
      note: '',
      lines: [],
      payments: [],
      attachments: [],
      createdAt: '',
      updatedAt: '',
    };
    const result = buildAgendaItems(
      workspace({
        supplierInvoices: [
          { ...common, id: 'pending', documentStatus: 'validated', paymentStatus: 'pending' },
          { ...common, id: 'partial', documentStatus: 'validated', paymentStatus: 'partial', paidCents: 1_000, balanceCents: 9_810 },
          { ...common, id: 'paid', documentStatus: 'validated', paymentStatus: 'paid', paidCents: 10_810, balanceCents: 0 },
          { ...common, id: 'draft', documentStatus: 'draft', paymentStatus: null, validatedAt: null, validationJournalEntryId: null },
        ],
      }),
    );
    expect(result.map((item) => item.sourceId).sort()).toEqual(['partial', 'pending']);
    expect(result.every((item) => item.route === 'expenses')).toBe(true);
  });

  it('reste stable aux années bissextiles et aux événements qui traversent une année', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2028-02-29', 1)).toBe('2028-03-01');
    expect(
      itemOccursOn(
        {
          id: 'event:new-year',
          source: 'event',
          sourceId: 'new-year',
          category: 'agenda',
          date: '2026-12-31',
          endDate: '2027-01-02',
          time: null,
          endTime: null,
          title: 'Fermeture annuelle',
          subtitle: '',
          status: 'active',
        },
        '2027-01-01',
      ),
    ).toBe(true);
  });

  it('compte exactement demain à J+7, sans recompter aujourd’hui', () => {
    const item = (id: string, date: string) => ({
      id,
      source: 'event' as const,
      sourceId: id,
      category: 'agenda' as const,
      date,
      endDate: date,
      time: null,
      endTime: null,
      title: id,
      subtitle: '',
      status: 'active' as const,
    });
    expect(
      countUpcomingAgendaItems(
        [
          item('today', '2026-09-03'),
          item('tomorrow', '2026-09-04'),
          item('day-seven', '2026-09-10'),
          item('day-eight', '2026-09-11'),
        ],
        '2026-09-03',
        7,
      ),
    ).toBe(2);
  });

  it('décrit correctement un rendez-vous horaire qui traverse minuit', () => {
    const overnight = {
      id: 'event:overnight',
      source: 'event' as const,
      sourceId: 'overnight',
      category: 'agenda' as const,
      date: '2026-09-03',
      endDate: '2026-09-04',
      time: '23:00',
      endTime: '01:00',
      title: 'Intervention de nuit',
      subtitle: '',
      status: 'active' as const,
    };
    expect(formatAgendaItemRange(overnight, false, '2026-09-03')).toBe(
      'Dès 23:00',
    );
    expect(formatAgendaItemRange(overnight, false, '2026-09-04')).toBe(
      'Jusqu’à 01:00',
    );
    expect(formatAgendaItemRange(overnight, true)).toContain('→');
    expect(formatAgendaItemRange(overnight, true)).toContain('01:00');
  });

  it('programme le changement de date au prochain minuit local', () => {
    const delay = millisecondsUntilNextLocalDay(
      new Date(2026, 8, 3, 23, 59, 30, 0),
    );
    expect(delay).toBe(31_000);
  });
});

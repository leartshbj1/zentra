import { describe, expect, it } from 'vitest';
import type { TimeEntry, Workspace } from './types';
import {
  eligibleTimeEntries,
  isTimeEntryInvoiceEligible,
  summarizeTimeBilling,
  timeEntryNetCents,
} from './timeBilling';

const entry = (patch: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 'time-1',
  projectId: 'project-1',
  employeeId: 'employee-1',
  date: '2026-09-01',
  minutes: 61,
  breakMinutes: 0,
  billable: true,
  billingRateCents: 10_001,
  hourlyCostCents: 5_000,
  note: '',
  status: 'approved',
  billingStatus: 'unbilled',
  billingBatchId: null,
  billingInvoiceId: null,
  billingInvoiceNumber: null,
  createdAt: '2026-09-01T08:00:00Z',
  ...patch,
});

describe('facturation des temps', () => {
  it('ne propose que les temps approuvés, facturables, tarifés et libres', () => {
    expect(isTimeEntryInvoiceEligible(entry())).toBe(true);
    expect(isTimeEntryInvoiceEligible(entry({ status: 'entered' }))).toBe(
      false,
    );
    expect(isTimeEntryInvoiceEligible(entry({ billable: false }))).toBe(false);
    expect(isTimeEntryInvoiceEligible(entry({ billingRateCents: 0 }))).toBe(
      false,
    );
    expect(
      isTimeEntryInvoiceEligible(entry({ billingStatus: 'reserved' })),
    ).toBe(false);
    expect(isTimeEntryInvoiceEligible(entry({ billingStatus: 'billed' }))).toBe(
      false,
    );
  });

  it('filtre sans mélanger les projets', () => {
    const workspace = {
      timeEntries: [entry(), entry({ id: 'time-2', projectId: 'project-2' })],
    } as Workspace;
    expect(
      eligibleTimeEntries(workspace, 'project-1').map((item) => item.id),
    ).toEqual(['time-1']);
  });

  it('arrondit chaque ligne et chaque TVA comme le moteur local', () => {
    const first = entry({ minutes: 1, billingRateCents: 31 });
    const second = entry({
      id: 'time-2',
      date: '2026-08-31',
      minutes: 61,
      billingRateCents: 10_001,
    });
    expect(timeEntryNetCents(first)).toBe(1);
    const summary = summarizeTimeBilling([first, second], 810);
    expect(summary.netCents).toBe(10_169);
    expect(summary.vatCents).toBe(824);
    expect(summary.totalCents).toBe(10_993);
    expect(summary.dateFrom).toBe('2026-08-31');
    expect(summary.dateTo).toBe('2026-09-01');
  });
});

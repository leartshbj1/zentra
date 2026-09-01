import type { TimeEntry, Workspace } from './types';

export type TimeBillingSummary = {
  minutes: number;
  netCents: number;
  vatCents: number;
  totalCents: number;
  dateFrom: string;
  dateTo: string;
};

function roundedRatio(numerator: number, denominator: number) {
  return Math.floor((numerator + denominator / 2) / denominator);
}

export function isTimeEntryInvoiceEligible(entry: TimeEntry) {
  return (
    entry.status === 'approved' &&
    entry.billable === true &&
    (entry.billingRateCents ?? 0) > 0 &&
    entry.minutes > 0 &&
    entry.billingStatus === 'unbilled'
  );
}

export function eligibleTimeEntries(workspace: Workspace, projectId?: string) {
  return workspace.timeEntries.filter(
    (entry) =>
      isTimeEntryInvoiceEligible(entry) &&
      (!projectId || entry.projectId === projectId),
  );
}

export function timeEntryNetCents(entry: TimeEntry) {
  return roundedRatio(entry.minutes * (entry.billingRateCents ?? 0), 60);
}

/** Reproduit l'arrondi transactionnel du moteur Rust, ligne par ligne. */
export function summarizeTimeBilling(
  entries: TimeEntry[],
  vatBp: number,
): TimeBillingSummary {
  const sortedDates = entries
    .map((entry) => entry.date)
    .filter(Boolean)
    .sort();
  let netCents = 0;
  let vatCents = 0;
  let minutes = 0;
  for (const entry of entries) {
    const lineNet = timeEntryNetCents(entry);
    minutes += entry.minutes;
    netCents += lineNet;
    vatCents += roundedRatio(lineNet * vatBp, 10_000);
  }
  return {
    minutes,
    netCents,
    vatCents,
    totalCents: netCents + vatCents,
    dateFrom: sortedDates[0] ?? '',
    dateTo: sortedDates.at(-1) ?? '',
  };
}

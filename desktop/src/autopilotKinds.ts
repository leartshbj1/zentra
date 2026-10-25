/**
 * The domain a prepared card comes from, shown as a small label above its title
 * so a list of mixed cards reads at a glance. Presentation only.
 */
const KINDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Ventes', ['reminder', 'poursuite', 'quote', 'acceptance', 'portal', 'opportunity', 'deliver', 'reminders-offer']],
  ['Banque', ['bank', 'bank-batch', 'statement', 'statement-file', 'pay', 'pay-order', 'online', 'treasury-low', 'cash-diff', 'cash-count', 'fx-rate', 'claims-pay', 'approve', 'receipt', 'receipt-more']],
  ['Achats', ['qrmail', 'order']],
  ['Stock', ['stock', 'produce', 'inventory', 'trace', 'lot-expiry', 'warehouse-negative']],
  ['Clients', ['contact']],
  ['Agenda', ['appointment', 'appt', 'tomorrow']],
  ['Projets', ['hours', 'timer', 'task', 'end', 'report']],
  ['Équipe', ['payroll', 'certificates', 'vacation', 'ijm', 'claims']],
  ['Comptabilité', ['vat', 'budget', 'closing', 'depreciation', 'archive', 'archive-problem', 'contract']],
  ['Autopilote', ['rule']],
];

/** French label (translated with t) for a card key such as `bank:123`, or null when unknown. */
export function autopilotKind(key: string): string | null {
  const prefix = key.split(':')[0];
  return KINDS.find(([, prefixes]) => prefixes.includes(prefix))?.[0] ?? null;
}

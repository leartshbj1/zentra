/**
 * The domain a prepared card comes from, shown as a small label above its title
 * so a list of mixed cards reads at a glance. Presentation only.
 */
const KINDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Ventes', ['ask', 'recurring', 'reminder', 'poursuite', 'quote', 'acceptance', 'portal', 'opportunity', 'deliver', 'reminders-offer', 'inbox']],
  ['Banque', ['bank', 'bank-batch', 'statement', 'statement-file', 'pay', 'pay-order', 'online', 'treasury-low', 'cash-diff', 'cash-count', 'fx-rate', 'claims-pay', 'approve', 'receipt', 'receipt-more', 'deposit']],
  ['Achats', ['qrmail', 'order', 'site']],
  ['Caisse', ['pos-close']],
  ['Stock', ['stock', 'produce', 'inventory', 'trace', 'lot-expiry', 'warehouse-negative']],
  ['Clients', ['contact']],
  ['Agenda', ['appointment', 'appt', 'tomorrow']],
  ['Projets', ['hours', 'timer', 'task', 'end', 'report', 'chantier']],
  ['Équipe', ['payroll', 'certificates', 'vacation', 'ijm', 'claims']],
  ['Comptabilité', ['summary', 'vat', 'budget', 'closing', 'depreciation', 'archive', 'archive-problem', 'contract']],
  ['Parc installé', ['service']],
  ['Rendez-vous en ligne', ['booking']],
  ['Autopilote', ['rule']],
];

/** The domain labels, in display order (for settings). */
export const AUTOPILOT_KIND_LABELS: readonly string[] = KINDS.map(([label]) => label).filter(label => label !== 'Autopilote');

/** French label (translated with t) for a card key such as `bank:123`, or null when unknown. */
export function autopilotKind(key: string): string | null {
  const prefix = key.split(':')[0];
  return KINDS.find(([, prefixes]) => prefixes.includes(prefix))?.[0] ?? null;
}

// Frais de rappel, intérêts moratoires et escompte : mêmes règles que le
// calcul natif (reminder_charges.rs), pour l'aperçu et les cartes.

export type ReminderChargeSettings = {
  interestEnabled: boolean;
  /** Taux annuel en points de base : 500 = 5 % (art. 104 CO). */
  interestRateBp: number;
  /** Frais par niveau de relance, en centimes. */
  fees: Record<number, number>;
};

export const defaultChargeSettings: ReminderChargeSettings = { interestEnabled: false, interestRateBp: 500, fees: {} };

const dayMs = 86_400_000;
const parse = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parse(toIso) - parse(fromIso)) / dayMs);
}

/** Intérêt simple, jours exacts sur 365, arrondi au centime (demi supérieur). */
export function lateInterestCents(balanceCents: number, rateBp: number, days: number): number {
  if (balanceCents <= 0 || rateBp <= 0 || days <= 0) return 0;
  const numerator = BigInt(balanceCents) * BigInt(rateBp) * BigInt(days);
  const denominator = 3_650_000n;
  return Number((numerator + denominator / 2n) / denominator);
}

export type ReminderCharges = {
  feeCents: number;
  interestCents: number;
  interestRateBp: number;
  interestDays: number;
  /** Lendemain de l'échéance, AAAA-MM-JJ. */
  interestFrom: string | null;
  totalDueCents: number;
};

export function reminderCharges(settings: ReminderChargeSettings, level: number, balanceCents: number, dueDate: string, asOf: string): ReminderCharges {
  const feeCents = Math.max(0, settings.fees[level] ?? 0);
  const days = settings.interestEnabled ? Math.max(0, daysBetween(dueDate, asOf)) : 0;
  const interestCents = lateInterestCents(balanceCents, settings.interestRateBp, days);
  const next = new Date(parse(dueDate) + dayMs).toISOString().slice(0, 10);
  return {
    feeCents,
    interestCents,
    interestRateBp: settings.interestEnabled ? settings.interestRateBp : 0,
    interestDays: days,
    interestFrom: days > 0 ? next : null,
    totalDueCents: Math.max(0, balanceCents) + feeCents + interestCents,
  };
}

export type CashDiscount = { discountBp: number; days: number; netDays: number };

/** Montant à payer avec escompte, arrondi aux 5 centimes inférieurs comme pour un paiement suisse. */
export function discountedAmountCents(totalCents: number, discountBp: number): number {
  const discount = Math.round((totalCents * discountBp) / 10_000);
  const raw = totalCents - discount;
  return raw - (raw % 5);
}

/** Conditions Swico « //S1/…/40/2:10;0:30 » à ajouter aux informations de facture QR. */
export function discountConditions(terms: CashDiscount): string {
  const percent = (terms.discountBp / 100).toString();
  return `${percent}:${terms.days};0:${terms.netDays}`;
}

export function withDiscountConditions(billInformation: string, terms: CashDiscount | null): string {
  const base = billInformation.trim();
  if (!terms) return base;
  const conditions = `/40/${discountConditions(terms)}`;
  if (!base) return `//S1${conditions}`;
  if (!base.startsWith('//S1/')) return base;
  // Remplace une balise 40 existante, sinon l'ajoute à la fin.
  return /\/40\/[^/]*/.test(base) ? base.replace(/\/40\/[^/]*/, conditions) : `${base}${conditions}`;
}

/** Paiement reçu avec escompte, dans le délai : montant attendu et écart à couvrir par un avoir. */
export function discountMatch(totalCents: number, issueDate: string, terms: CashDiscount, paidCents: number, paidOn: string) {
  const expected = discountedAmountCents(totalCents, terms.discountBp);
  const inTime = daysBetween(issueDate, paidOn) <= terms.days;
  return paidCents === expected && inTime ? { discountCents: totalCents - expected } : null;
}

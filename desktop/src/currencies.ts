/** Cours de change saisis (CHF pour une unité) et écritures en devise qui attendent leur cours. */
export type ExchangeRate = { currency: string; rateDate: string; chfPerUnitMicro: number; source: string; used: boolean };
export type PendingConversion = { currency: string; entries: number; firstDate: string; lastDate: string };
export type RealisedDifference = { year: string; gainCents: number; lossCents: number };
export type ExchangeRatesState = { rates: ExchangeRate[]; pending: PendingConversion[]; realised: RealisedDifference[]; validityDays: number };

/** « 0.9412 » ou « 0,9412 » → 941200 (millionièmes), sans passer par un nombre à virgule. */
export function parseRate(text: string): number | null {
  const match = /^\s*(\d{1,4})(?:[.,](\d{1,6}))?\s*$/.exec(text);
  if (!match) return null;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
  return micro >= 1 && micro <= 1_000_000_000 ? micro : null;
}

/** 941200 → « 0.9412 » (au moins quatre décimales, comme les cours de l'ESTV). */
export function formatRate(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const decimals = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(4, '0');
  return `${whole}.${decimals}`;
}



/** Date proposée pour le prochain cours : le premier jour du mois de la plus ancienne écriture en attente. */
export function suggestedRateDate(pending: readonly PendingConversion[], today: string): string {
  const first = pending.map(row => row.firstDate).filter(Boolean).sort()[0];
  return (first ?? today).slice(0, 8) + '01';
}

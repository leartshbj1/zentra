/**
 * Situations SIA 118 : aperçu du calcul fait par `src-tauri/src/progress_billing.rs`
 * (avancement cumulé, situations précédentes déduites, retenue de garantie par
 * taux de TVA, arrondi au 5 centimes reporté). L'app native refait le calcul
 * et crée la facture ; l'écran n'enregistre jamais un montant qu'il a calculé.
 */
import type { DocumentLine, Invoice, Quote } from './types';

export type ProgressMode = 'percent' | 'quantity';
export type ProgressKind = 'situation' | 'final' | 'retention_release';
export type ProgressEntry = { mode: ProgressMode; percentBp?: number; quantity?: number };

export type ProgressBill = {
  id: string; quoteId: string; invoiceId: string; sequence: number; kind: ProgressKind;
  progressDate: string; retentionBp: number; cumulativeNetCents: number; cumulativeRetentionCents: number;
  retentionByRate: Record<number, number>; previousNetCents: number; netCents: number; roundingCents: number;
  lines: { quoteItemId: string; mode: ProgressMode; cumulativePercentBp: number | null; cumulativeQuantity: number; cumulativeNetCents: number }[];
};
export type ProgressPlan = { quoteId: string; retentionBp: number; roundToFive: boolean };

/** Même règle que les lignes de document : demi vers l'extérieur. */
export function roundBp(value: number, basisPoints: number): number {
  const sign = value < 0 ? -1n : 1n;
  const absolute = BigInt(Math.abs(value));
  return Number(sign * ((absolute * BigInt(basisPoints) + 5_000n) / 10_000n));
}

/** Arrondi suisse au 5 centimes (2 vers le bas, 3 vers le haut). */
export function roundFive(cents: number): number {
  const remainder = ((cents % 5) + 5) % 5;
  return remainder < 3 ? cents - remainder : cents + (5 - remainder);
}

const baseCents = (line: DocumentLine, quantity: number) => Math.round(quantity * line.unitPriceCents);
const netOfBase = (line: DocumentLine, base: number) => base - roundBp(base, line.discountBp ?? 0);

/** Travaux exécutés cumulés d'une position (net HT après rabais). */
export function lineCumulative(line: DocumentLine, entry: ProgressEntry): { netCents: number; quantity: number } | { error: string } {
  if (entry.mode === 'percent') {
    const percent = entry.percentBp ?? NaN;
    if (!Number.isInteger(percent) || percent < 0 || percent > 10_000) return { error: 'L’avancement est compris entre 0 et 100 %. Au-delà, saisissez la quantité exécutée.' };
    const base = roundBp(baseCents(line, line.quantity), percent);
    return { netCents: netOfBase(line, base), quantity: Math.round(line.quantity * percent / 10_000 * 1_000) / 1_000 };
  }
  const quantity = entry.quantity ?? NaN;
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000) return { error: 'La quantité exécutée doit être positive.' };
  const rounded = Math.round(quantity * 1_000) / 1_000;
  return { netCents: netOfBase(line, baseCents(line, rounded)), quantity: rounded };
}

export type PreviousProgress = {
  sequence: number; lineNet: Record<string, number>; retentionByRate: Record<number, number>;
  roundingCents: number; billedNetCents: number; finalBilled: boolean; retentionReleased: boolean; draftSequence: number | null;
};

/** État laissé par les situations valables (factures non annulées), comme l'app native. */
export function previousProgress(quoteId: string, bills: readonly ProgressBill[], invoices: readonly Invoice[]): PreviousProgress {
  const state: PreviousProgress = { sequence: 0, lineNet: {}, retentionByRate: {}, roundingCents: 0, billedNetCents: 0, finalBilled: false, retentionReleased: false, draftSequence: null };
  const ordered = bills.filter(bill => bill.quoteId === quoteId).sort((a, b) => a.sequence - b.sequence);
  for (const bill of ordered) {
    state.sequence = Math.max(state.sequence, bill.sequence);
    const invoice = invoices.find(candidate => candidate.id === bill.invoiceId);
    if (!invoice || invoice.status === 'cancelled') continue;
    if (invoice.status === 'draft') { state.draftSequence = bill.sequence; continue; }
    state.roundingCents += bill.roundingCents;
    state.billedNetCents += bill.netCents + bill.roundingCents;
    state.retentionByRate = { ...bill.retentionByRate };
    if (bill.kind === 'final') state.finalBilled = true;
    if (bill.kind === 'retention_release') state.retentionReleased = true;
    else for (const line of bill.lines) state.lineNet[line.quoteItemId] = line.cumulativeNetCents;
  }
  return state;
}

export type ProgressPreview = {
  cumulativeNetCents: number; cumulativeRetentionCents: number; previousNetCents: number;
  netCents: number; vatCents: number; roundingCents: number; totalCents: number;
  increments: { lineId: string; cumulativeNetCents: number; incrementCents: number }[];
};

/** Aperçu d'une situation, du décompte final ou de la libération de la retenue. */
export function previewProgress(kind: ProgressKind, quote: Quote, entries: Readonly<Record<string, ProgressEntry>>, retentionBp: number, releaseRetention: boolean, roundToFive: boolean, previous: PreviousProgress): ProgressPreview | { error: string } {
  if (!Number.isInteger(retentionBp) || retentionBp < 0 || retentionBp > 3_000) return { error: 'La retenue de garantie est comprise entre 0 et 30 %.' };
  if (previous.draftSequence !== null) return { error: `La situation n° ${previous.draftSequence} est encore un brouillon : émettez-la ou supprimez-la d’abord.` };
  if (previous.retentionReleased) return { error: 'La facturation de ce devis est terminée.' };
  if (previous.finalBilled && kind !== 'retention_release') return { error: 'Le décompte final de ce devis est déjà établi.' };
  const works = new Map<number, number>();
  const invoiceLines: { price: number; vat: number }[] = [];
  const increments: ProgressPreview['increments'] = [];
  let retention: Map<number, number>;
  if (kind === 'retention_release') {
    if (!previous.finalBilled) return { error: 'La retenue se libère après le décompte final.' };
    const amounts = Object.entries(previous.retentionByRate).filter(([, amount]) => amount !== 0);
    if (!amounts.length) return { error: 'Aucune retenue de garantie n’est à libérer.' };
    for (const [rate, amount] of amounts) invoiceLines.push({ price: amount, vat: Number(rate) });
    retention = new Map(Object.keys(previous.retentionByRate).map(rate => [Number(rate), 0]));
    for (const line of quote.lines) works.set(line.vatRateBp, (works.get(line.vatRateBp) ?? 0) + (previous.lineNet[line.id] ?? 0));
  } else {
    for (const line of quote.lines) {
      const entry = entries[line.id] ?? (kind === 'final' ? { mode: 'quantity' as const, quantity: line.quantity } : undefined);
      if (!entry) { works.set(line.vatRateBp, (works.get(line.vatRateBp) ?? 0) + (previous.lineNet[line.id] ?? 0)); continue; }
      const computed = lineCumulative(line, entry);
      if ('error' in computed) return computed;
      const increment = computed.netCents - (previous.lineNet[line.id] ?? 0);
      works.set(line.vatRateBp, (works.get(line.vatRateBp) ?? 0) + computed.netCents);
      increments.push({ lineId: line.id, cumulativeNetCents: computed.netCents, incrementCents: increment });
      if (increment !== 0) invoiceLines.push({ price: increment, vat: line.vatRateBp });
    }
    const keep = !(kind === 'final' && releaseRetention);
    retention = new Map([...works].map(([rate, amount]) => [rate, keep ? roundBp(amount, retentionBp) : 0]));
    const rates = new Set([...retention.keys(), ...Object.keys(previous.retentionByRate).map(Number)]);
    for (const rate of rates) {
      const delta = (retention.get(rate) ?? 0) - (previous.retentionByRate[rate] ?? 0);
      if (delta !== 0) invoiceLines.push({ price: -delta, vat: rate });
    }
  }
  const netCents = invoiceLines.reduce((sum, line) => sum + line.price, 0);
  const vatCents = invoiceLines.reduce((sum, line) => sum + roundBp(line.price, line.vat), 0);
  const exact = netCents + vatCents;
  if (!invoiceLines.length || exact === 0) return { error: 'Rien de nouveau à facturer depuis la situation précédente.' };
  if (exact < 0) return { error: 'L’avancement saisi est inférieur à la situation précédente. Corrigez par un avoir.' };
  const roundingCents = roundToFive ? roundFive(exact - previous.roundingCents) - exact : 0;
  return {
    cumulativeNetCents: [...works.values()].reduce((sum, value) => sum + value, 0),
    cumulativeRetentionCents: [...retention.values()].reduce((sum, value) => sum + value, 0),
    previousNetCents: previous.billedNetCents,
    netCents, vatCents, roundingCents, totalCents: exact + roundingCents, increments,
  };
}

/** Quelle action proposer pour un devis facturé par situations. */
export function nextProgressStep(previous: PreviousProgress): ProgressKind | 'draft' | 'done' {
  if (previous.draftSequence !== null) return 'draft';
  if (previous.retentionReleased) return 'done';
  if (previous.finalBilled) return Object.values(previous.retentionByRate).some(amount => amount !== 0) ? 'retention_release' : 'done';
  return 'situation';
}

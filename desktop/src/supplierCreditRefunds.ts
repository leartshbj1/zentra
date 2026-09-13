import type { SupplierCreditNote } from './types';
import { creditAmount } from './creditAllocationWorkflow';

export function supplierCreditAvailable(credit: Pick<SupplierCreditNote, 'totalCents' | 'allocatedCents' | 'refundedCents'>) {
  return Math.max(0, credit.totalCents - credit.allocatedCents - credit.refundedCents);
}

export function supplierRefundAmount(value: string): number | null {
  const amount = creditAmount(value);
  return amount !== null && amount <= 9_000_000_000_000_000 ? amount : null;
}

export function supplierRefundDateError(value: string, minimum: string, maximum: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return 'Renseignez une date de règlement valide.';
  if (value < minimum) return 'La date ne peut pas précéder l’avoir ou le remboursement à corriger.';
  if (value > maximum) return 'Indiquez une date effective, au plus tard aujourd’hui.';
  return '';
}

import { isSalesDate } from './salesFormValidation';
import { creditAmount } from './creditAllocationWorkflow';

export function supplierPaymentInput(amount: string, date: string, invoiceDate: string, balanceCents: number) {
  const amountCents = creditAmount(amount);
  if (amountCents === null)
    return { amountCents: 0, field: 'amount' as const, error: 'Indiquez le montant réellement payé, supérieur à zéro, avec deux décimales au maximum.' };
  if (amountCents > balanceCents) return { amountCents, field: 'amount' as const, error: 'Ce montant dépasse le solde de la facture. Vérifiez le montant payé ou enregistrez seulement le solde restant.' };
  if (!isSalesDate(date)) return { amountCents, field: 'date' as const, error: 'Choisissez la date à laquelle vous avez payé le fournisseur.' };
  if (date < invoiceDate) return { amountCents, field: 'date' as const, error: 'Le paiement ne peut pas précéder cette facture. Vérifiez la date de facture et la date du paiement.' };
  return { amountCents, error: '' };
}


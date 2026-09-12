import { isSalesDate } from './salesFormValidation';

export function supplierPaymentInput(amount: string, date: string, invoiceDate: string, balanceCents: number) {
  const value = amount.trim().replace(',', '.');
  const amountCents = Math.round(Number(value) * 100);
  if (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(amountCents) || amountCents <= 0)
    return { amountCents: 0, error: 'Indiquez le montant réellement payé, supérieur à zéro, avec deux décimales au maximum.' };
  if (amountCents > balanceCents) return { amountCents, error: 'Ce montant dépasse le solde de la facture. Vérifiez le montant payé ou enregistrez seulement le solde restant.' };
  if (!isSalesDate(date)) return { amountCents, error: 'Choisissez la date à laquelle vous avez payé le fournisseur.' };
  if (date < invoiceDate) return { amountCents, error: 'Le paiement ne peut pas précéder cette facture. Vérifiez la date de facture et la date du paiement.' };
  return { amountCents, error: '' };
}

export function supplierDraftError(supplierId: string, date: string, dueDate: string, lines: Array<{ description: string; quantityMilli: number; unit: string; unitPriceCents: number; discountBp: number; vatBp: number; category: string }>, vatRates: number[], totalCents: number): string {
  if (!supplierId) return 'Choisissez le fournisseur qui a émis cette facture.';
  if (!isSalesDate(date)) return 'Indiquez la date inscrite sur la facture du fournisseur.';
  if (!isSalesDate(dueDate)) return 'Indiquez la date limite de paiement dans le champ « Échéance ».';
  if (dueDate < date) return 'L’échéance doit être le jour de la facture ou après. Vérifiez ces deux dates.';
  if (!lines.length) return 'Ajoutez au moins une ligne avec ce que vous avez acheté et son prix.';
  if (lines.length > 250) return 'Cette facture contient trop de lignes. La limite est de 250 lignes par facture.';
  for (const [index, line] of lines.entries()) {
    const prefix = `Ligne ${index + 1} : `;
    if (!line.description.trim()) return `${prefix}décrivez ce que vous avez acheté.`;
    if (!Number.isSafeInteger(line.quantityMilli) || line.quantityMilli <= 0 || line.quantityMilli > 1_000_000_000) return `${prefix}indiquez une quantité supérieure à zéro, avec trois décimales au maximum.`;
    if (!line.unit.trim()) return `${prefix}indiquez l’unité, par exemple pièce, heure ou mètre.`;
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) return `${prefix}le prix ne peut pas être négatif.`;
    if (!Number.isSafeInteger(line.discountBp) || line.discountBp < 0 || line.discountBp > 10_000) return `${prefix}la remise doit être comprise entre 0 et 100 %.`;
    if (!vatRates.includes(line.vatBp)) return `${prefix}vérifiez le taux de TVA affiché. Choisissez un taux disponible ou ajoutez ce taux dans les paramètres.`;
    if (!line.category) return `${prefix}choisissez une catégorie pour retrouver cet achat dans vos coûts.`;
  }
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return 'Indiquez le prix des achats. Le total de la facture doit être supérieur à zéro.';
  return '';
}

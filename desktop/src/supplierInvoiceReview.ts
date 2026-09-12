import type { SupplierInvoice, Workspace } from './types';
import { isSalesDate } from './salesFormValidation';
import { supplierInvoiceAccountingReady } from './purchases';
import { supplierInvoiceOrderMatchAmountMismatch } from './purchaseOrderFlow';

export type SupplierReviewTarget = 'document' | 'reference' | 'attachments' | 'matching' | 'accounts' | 'periods' | 'invoices';
export type SupplierReviewProblem = { title: string; text: string; action: string; target: SupplierReviewTarget };
export type SupplierReviewWorkspace = Pick<Workspace, 'supplierInvoices' | 'supplierInvoiceMatches' | 'supplierOrders' | 'supplierReceipts' | 'accountingSettings'>;

export function supplierReviewContext(invoice: SupplierInvoice, workspace: SupplierReviewWorkspace) {
  const matches = workspace.supplierInvoiceMatches.filter(row => row.supplierInvoiceId === invoice.id);
  const order = workspace.supplierOrders.find(row => matches.some(match => match.supplierOrderId === row.id))
    || workspace.supplierOrders.find(row => row.supplierId === invoice.supplierId && row.currency === invoice.currency && row.status === 'confirmed');
  return { matches, order, standaloneChoice: matches.length === 0 && Boolean(order) };
}

export function supplierReviewPreflight(invoice: SupplierInvoice, workspace: SupplierReviewWorkspace): SupplierReviewProblem | null {
  if (invoice.documentStatus !== 'draft') return { title: 'Ce document a déjà changé', text: 'Consultez son état actuel dans les achats avant de poursuivre.', target: 'invoices', action: 'Voir les achats' };
  if (!invoice.reference.trim()) {
    if (workspace.supplierInvoiceMatches.some(row => row.supplierInvoiceId === invoice.id)) return { title: 'La référence manque sur un brouillon rapproché', text: 'Retirez les liens dans le rapprochement pour déverrouiller la saisie, recopiez le numéro du fournisseur dans le brouillon, puis refaites le rapprochement.', target: 'matching', action: 'Ouvrir le rapprochement' };
    return { title: 'Ajoutez le numéro de la facture', text: 'Recopiez le numéro indiqué par le fournisseur sur son PDF ou sa facture papier, dans le champ « Numéro / référence fournisseur ».', target: 'reference', action: 'Compléter la référence' };
  }
  if (!isSalesDate(invoice.documentDate) || !isSalesDate(invoice.dueDate) || invoice.dueDate < invoice.documentDate) return { title: 'Vérifiez les dates', text: 'Recopiez la date de facture et la date limite de paiement. L’échéance doit être le jour de la facture ou après.', target: 'document', action: 'Corriger les dates du brouillon' };
  if (!invoice.lines.length || !Number.isSafeInteger(invoice.totalCents) || invoice.totalCents <= 0 || invoice.netCents + invoice.vatCents !== invoice.totalCents) return { title: 'Vérifiez le montant de l’achat', text: 'Le brouillon doit contenir les achats facturés et un total supérieur à zéro. Comparez ses lignes au document du fournisseur.', target: 'document', action: 'Revoir les lignes du brouillon' };
  const { matches, order } = supplierReviewContext(invoice, workspace);
  if (invoice.matchStatus === 'mismatch' || matches.length > 0 && (!order || supplierInvoiceOrderMatchAmountMismatch(invoice.id, order, workspace))) return { title: 'Le rapprochement présente un écart', text: 'Les quantités, prix ou montants de TVA ne correspondent pas aux commandes liées. Ouvrez le rapprochement pour corriger les liens avant de valider.', target: 'matching', action: 'Corriger le rapprochement' };
  if (!supplierInvoiceAccountingReady(workspace.accountingSettings)) return { title: 'Préparez les comptes pour cet achat', text: 'La comptabilité doit être active, avec les comptes de charges, de TVA préalable et de dettes fournisseurs. Le brouillon reste disponible pendant ce réglage.', target: 'accounts', action: 'Configurer les comptes' };
  return null;
}

export function supplierReviewProblem(message: string): SupplierReviewProblem {
  if (/clôtur|clotur|période.*ferm|periode.*ferm/i.test(message)) return { title: 'La date est dans une période fermée', text: 'Vérifiez l’exercice concerné. Corrigez la date du brouillon uniquement si elle ne correspond pas à la facture reçue.', target: 'periods', action: 'Vérifier les exercices' };
  if (/même référence|référence.*obligatoire|numéro.*obligatoire/i.test(message)) return { title: 'Vérifiez le numéro fournisseur', text: 'Recopiez la référence exacte. Si une facture validée porte déjà ce numéro chez ce fournisseur, vérifiez les achats existants avant de créer un doublon.', target: 'reference', action: 'Vérifier la référence' };
  if (/justificatif|pièce|provenance|attachment/i.test(message)) return { title: 'Vérifiez le document original', text: 'Ouvrez les justificatifs du brouillon et contrôlez le PDF ou la photo. Pour une facture importée par e-mail, l’original doit correspondre à celui de l’import ; le détail ci-dessous précise la pièce à rétablir.', target: 'attachments', action: 'Voir les justificatifs' };
  if (/rapproch|réception|quantit.*command|écart.*prix|écart.*TVA/i.test(message)) return { title: 'Les liens avec la commande sont à revoir', text: 'Contrôlez les quantités reçues, les lignes de commande et les montants associés à cette facture.', target: 'matching', action: 'Revoir le rapprochement' };
  if (/compte|comptabilit|liaison/i.test(message)) return { title: 'Un compte comptable est à vérifier', text: 'Vérifiez que les comptes de charges, TVA préalable et dettes fournisseurs sont actifs et correctement reliés, puis reprenez cette facture.', target: 'accounts', action: 'Vérifier les comptes' };
  return { title: 'La validation n’a pas abouti', text: 'Les informations restent disponibles. Relisez le détail, corrigez le brouillon si nécessaire ou réessayez si l’interruption était temporaire.', target: 'document', action: 'Revoir le brouillon' };
}

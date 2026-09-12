import type { Invoice, Workspace } from './types';
import { invoiceDatesError } from './salesFormValidation';

export type InvoiceIssueTarget = 'document' | 'dates' | 'billing' | 'periods' | 'accounts' | 'folder' | 'invoices';
export type InvoiceIssueProblem = { title: string; text: string; target: InvoiceIssueTarget; action: string };

export function invoiceIssuePreflight(invoice: Invoice, workspace: Pick<Workspace, 'invoices' | 'settings'>): InvoiceIssueProblem | null {
  if (invoice.status !== 'draft' || invoice.number) return { title: 'Ce document a déjà changé', text: 'Consultez son état actuel dans les factures avant de poursuivre.', target: 'invoices', action: 'Voir les factures' };
  const dateError = invoiceDatesError({ ...invoice, dueDate: invoice.type === 'credit_note' && !invoice.dueDate ? invoice.issueDate : invoice.dueDate });
  if (dateError) return { title: 'Complétons les dates', text: dateError, target: 'dates', action: 'Corriger les dates' };
  if (!invoice.lines.length) return { title: 'Ajoutez la prestation', text: 'Ce brouillon ne contient aucune ligne. Ajoutez ce que vous facturez avant de l’émettre.', target: 'document', action: 'Compléter le brouillon' };
  if (invoice.billingPair?.balanceInvoiceId === invoice.id) {
    const deposit = workspace.invoices.find(row => row.id === invoice.billingPair?.depositInvoiceId);
    if (!deposit?.number || deposit.status === 'draft' || deposit.status === 'cancelled') return { title: 'L’acompte vient en premier', text: 'Émettez la facture d’acompte du dossier. Vous pourrez ensuite émettre le solde, avec la déduction déjà prévue.', target: 'folder', action: 'Voir l’acompte du dossier' };
  }
  if (invoice.type !== 'credit_note' && !workspace.settings?.billing.iban.trim()) return { title: 'Ajoutez le compte de paiement', text: 'Renseignez l’IBAN de votre entreprise dans les réglages de facturation, puis revenez à cette facture.', target: 'billing', action: 'Compléter les coordonnées bancaires' };
  return null;
}

export function invoiceIssueProblem(message: string): InvoiceIssueProblem {
  if (/clôtur|clotur|période.*ferm|periode.*ferm|exercice.*ferm/i.test(message)) return { title: 'La période est fermée', text: 'Cette date appartient à une période comptable fermée. Vérifiez l’exercice concerné ou corrigez la date du brouillon si elle est erronée.', target: 'periods', action: 'Vérifier les exercices' };
  if (/service_date|date.*prestation|dates de prestation|issue_date|due_date|échéance|émission.*date/i.test(message)) return { title: 'Une date est à vérifier', text: 'Ouvrez le brouillon et contrôlez la date d’émission, l’échéance et le début de la prestation. Pour une prestation d’un jour, le début suffit.', target: 'dates', action: 'Corriger les dates' };
  if (/iban|coordonnées bancaires|compte de paiement|onboarding|configuration initiale/i.test(message)) return { title: 'Vérifiez les coordonnées de facturation', text: 'Ouvrez les réglages de facturation et contrôlez le compte bancaire de votre entreprise avant de reprendre.', target: 'billing', action: 'Ouvrir les réglages de facturation' };
  if (/acompte.*lié|acompte.*d’abord|d’abord.*acompte/i.test(message)) return { title: 'Vérifiez l’acompte du dossier', text: 'L’acompte lié doit être émis avant le solde. Ouvrez le dossier pour retrouver les deux documents.', target: 'folder', action: 'Voir le dossier' };
  if (/avoir correctif|facture originale|facture de remplacement/i.test(message)) return { title: 'Vérifiez les documents liés', text: 'Consultez la facture d’origine et ses corrections. Si un avoir correctif a été préparé, émettez-le avant la facture de remplacement.', target: 'invoices', action: 'Voir les factures et avoirs' };
  if (/liaison|compte.*comptab|comptabilit|écriture.*comptab/i.test(message)) return { title: 'La comptabilité demande un réglage', text: 'Vérifiez les comptes et leurs liaisons. Revenez ensuite à cette facture pour reprendre l’émission.', target: 'accounts', action: 'Vérifier les comptes' };
  return { title: 'L’émission n’a pas abouti', text: 'Le document reste disponible. Consultez le détail ci-dessous pour corriger le point signalé, ou réessayez si l’interruption était temporaire.', target: 'document', action: 'Revoir le brouillon' };
}

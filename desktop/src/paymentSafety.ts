// Paiements sûrs : les contrôles, l'historique du fournisseur et la double
// validation viennent de l'app native (payment_safety.rs). Ici, on les met en
// phrases claires, et on repère les dépenses bancaires restées sans justificatif.

import { t } from './language';
import type { Attachment, BankMovement, BankWorkspace, Employee, SupplierInvoice } from './types';
import { formatDate, formatMoney } from './utils';

export type PaymentFinding =
  | { kind: 'iban_changed'; previousIban: string; currentIban: string; changedOn: string | null; lastPaidOn: string | null }
  | { kind: 'new_supplier' }
  | { kind: 'possible_duplicate'; otherInvoiceId: string; otherReference: string | null; otherTotalCents: number; otherDocumentDate: string; reason: 'same_number' | 'same_payment_reference' | 'same_amount_and_date' }
  | { kind: 'unusual_amount'; usualCents: number; historyCount: number; factor: number };
export type PaymentFindingKind = PaymentFinding['kind'];

export type SupplierPaymentHistory = {
  paymentCount: number;
  total12MonthsCents: number;
  lastPaymentDate: string | null;
  lastPaymentCents: number | null;
  usualCents: number | null;
  invoiceCount: number;
  paidIbans: string[];
};

export type PaymentApproval = {
  required: boolean;
  covered: boolean;
  status: 'prepared' | 'approved' | null;
  stale: boolean;
  amountCents: number | null;
  preparedBy: string | null;
  preparedByMe: boolean;
  preparedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  refusal: string | null;
};

export type PaymentReview = {
  supplierInvoiceId: string;
  supplierId: string;
  amountCents: number;
  creditorIban: string | null;
  findings: PaymentFinding[];
  history: SupplierPaymentHistory;
  approval: PaymentApproval;
};

export type PaymentSafetySettings = { approvalEnabled: boolean; approvalThresholdCents: number; receiptReminderDays: number };
export type PaymentSafetyActor = { userId: string; displayName: string; role: string; solo: boolean; mayApprove: boolean };
export type PaymentSafetyOverview = { settings: PaymentSafetySettings; actor: PaymentSafetyActor; invoices: PaymentReview[] };

export type EntryFinding =
  | { kind: 'unusual_account'; line: number; description: string; account: string | null }
  | { kind: 'unusual_vat_rate'; line: number; description: string; vatBp: number }
  | { kind: 'unusual_amount'; usualCents: number; factor: number };
export type EntryReview = { supplierInvoiceId: string; supplierName: string; historyCount: number; usualAccount: string | null; usualVatBp: number | null; findings: EntryFinding[] };

export const defaultPaymentSafetySettings: PaymentSafetySettings = { approvalEnabled: true, approvalThresholdCents: 500_000, receiptReminderDays: 10 };

/** Le natif renvoie déjà les noms de l'interface ; on garde des valeurs sûres si un champ manque. */
export function paymentSafetyFromRaw(raw: Partial<PaymentSafetyOverview> | null | undefined): PaymentSafetyOverview {
  return {
    settings: { ...defaultPaymentSafetySettings, ...raw?.settings },
    actor: { userId: '', displayName: '', role: 'owner', solo: true, mayApprove: true, ...raw?.actor },
    invoices: (raw?.invoices ?? []).map((review) => ({ ...review, findings: review.findings ?? [] })),
  };
}

export function reviewFor(overview: PaymentSafetyOverview | null, invoiceId: string): PaymentReview | undefined {
  return overview?.invoices.find((review) => review.supplierInvoiceId === invoiceId);
}

export const percent = (bp: number) => `${(bp / 100).toLocaleString('fr-CH', { maximumFractionDigits: 2 })} %`;

export function findingTitle(finding: PaymentFinding): string {
  switch (finding.kind) {
    case 'iban_changed': return t('IBAN changé depuis le dernier paiement');
    case 'new_supplier': return t('Premier paiement à ce fournisseur');
    case 'possible_duplicate': return t('Facture peut-être en double');
    case 'unusual_amount': return t('Montant inhabituel pour ce fournisseur');
  }
}

/** La règle en clair, avec les chiffres de l'app. */
export function findingDetail(finding: PaymentFinding, amountCents: number): string {
  switch (finding.kind) {
    case 'iban_changed': {
      const before = finding.lastPaidOn
        ? t('Dernier paiement le {date} sur {iban}.', { date: formatDate(finding.lastPaidOn), iban: finding.previousIban })
        : t('IBAN connu jusqu’ici : {iban}.', { iban: finding.previousIban });
      const now = finding.changedOn
        ? t('Cette facture demande {iban}, vu pour la première fois le {date}.', { iban: finding.currentIban, date: formatDate(finding.changedOn) })
        : t('Cette facture demande {iban}.', { iban: finding.currentIban });
      return `${before} ${now} ${t('Appelez le fournisseur à un numéro que vous connaissez déjà avant de payer.')}`;
    }
    case 'new_supplier': return t('Zentra n’a encore jamais payé ce fournisseur. Vérifiez son IBAN avec lui avant le premier paiement.');
    case 'possible_duplicate': {
      const other = { reference: finding.otherReference || t('sans numéro'), date: formatDate(finding.otherDocumentDate), amount: formatMoney(finding.otherTotalCents) };
      if (finding.reason === 'same_number') return t('La facture {reference} du {date} porte déjà ce numéro.', other);
      if (finding.reason === 'same_payment_reference') return t('La facture {reference} du {date} porte la même référence de paiement.', other);
      return t('La facture {reference} du {date} a le même montant ({amount}), à moins de 10 jours d’écart.', other);
    }
    case 'unusual_amount': return t('D’habitude, ce fournisseur facture environ {usual} (médiane de {count} factures). Celle-ci, {amount}, dépasse {factor} fois ce montant.', {
      usual: formatMoney(finding.usualCents), count: finding.historyCount, amount: formatMoney(amountCents), factor: finding.factor,
    });
  }
}

/** « 12 paiements · CHF 4 210.00 sur 12 mois · dernier le 3 oct. 2026 (CHF 380.00) ». */
export function historyLines(history: SupplierPaymentHistory): { label: string; value: string }[] {
  if (!history.paymentCount && !history.paidIbans.length) return [{ label: t('Historique'), value: t('Aucun paiement enregistré') }];
  const lines = [
    { label: t('Paiements'), value: history.paymentCount === 1 ? t('1 paiement') : t('{count} paiements', { count: history.paymentCount }) },
    { label: t('12 derniers mois'), value: formatMoney(history.total12MonthsCents) },
  ];
  if (history.lastPaymentDate) lines.push({ label: t('Dernier paiement'), value: `${formatDate(history.lastPaymentDate)} · ${formatMoney(history.lastPaymentCents ?? 0)}` });
  if (history.usualCents !== null) lines.push({ label: t('Montant habituel'), value: formatMoney(history.usualCents) });
  if (history.paidIbans.length) lines.push({ label: history.paidIbans.length === 1 ? t('IBAN utilisé') : t('IBAN utilisés'), value: history.paidIbans.join(', ') });
  return lines;
}

/** Ce que la ligne « À payer » dit du circuit préparé → approuvé → payé. */
export function approvalText(approval: PaymentApproval, settings: PaymentSafetySettings): string {
  if (approval.status === 'approved' && approval.covered) return t('Approuvé par {name}', { name: approval.approvedBy ?? '' });
  if (approval.stale) return t('Le montant ou l’IBAN a changé depuis l’approbation : à approuver à nouveau.');
  if (approval.status === 'prepared') return approval.preparedByMe
    ? t('En attente d’approbation par une autre personne')
    : t('Préparé par {name} · à approuver', { name: approval.preparedBy ?? '' });
  if (approval.required) return t('À partir de {amount}, une deuxième personne approuve le paiement.', { amount: formatMoney(settings.approvalThresholdCents) });
  return '';
}

export function entryFindingText(finding: EntryFinding): string {
  switch (finding.kind) {
    case 'unusual_account': return t('Ligne « {line} » : compte {account} jamais utilisé pour ce fournisseur.', { line: finding.description, account: finding.account ?? t('sans compte') });
    case 'unusual_vat_rate': return t('Ligne « {line} » : TVA {rate}, jamais utilisée pour ce fournisseur.', { line: finding.description, rate: percent(finding.vatBp) });
    case 'unusual_amount': return t('Montant plus de {factor} fois supérieur à l’habitude ({usual}).', { factor: finding.factor, usual: formatMoney(finding.usualCents) });
  }
}

/** « D'habitude, Fournisseur X va en 4000 Achats de matériel avec TVA 8,1 %. » */
export function entryHabit(review: EntryReview): string {
  if (review.usualAccount && review.usualVatBp !== null) return t('D’habitude, {supplier} va en {account} avec TVA {rate}.', { supplier: review.supplierName, account: review.usualAccount, rate: percent(review.usualVatBp) });
  if (review.usualAccount) return t('D’habitude, {supplier} va en {account}.', { supplier: review.supplierName, account: review.usualAccount });
  return '';
}

// ---------------------------------------------------------------------------
// Justificatifs manquants
// ---------------------------------------------------------------------------

export type MissingReceipt = {
  movement: BankMovement;
  /** unlinked : débit sans facture ni dépense ; expense / supplier_invoice : rapproché, mais sans pièce. */
  reason: 'unlinked' | 'expense' | 'supplier_invoice';
  ageDays: number;
  expenseId?: string;
  supplierInvoiceId?: string;
};

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) / 86_400_000);

/**
 * Dépenses bancaires (débits comptabilisés) sans pièce depuis au moins `days` jours :
 * pas rapprochées et sans facture ni dépense à rapprocher, ou rapprochées d'une
 * dépense ou d'une facture fournisseur qui n'a aucun justificatif joint.
 * Les remboursements (clients ou fournisseurs) ne demandent pas de pièce.
 */
export function missingReceipts(bank: BankWorkspace | null, attachments: readonly Attachment[], supplierInvoices: readonly SupplierInvoice[], days: number, today: string): MissingReceipt[] {
  if (!bank) return [];
  const expensesWithReceipt = new Set(attachments.filter((file) => file.entityType === 'expense' && file.entityId).map((file) => file.entityId!));
  const invoices = new Map(supplierInvoices.map((invoice) => [invoice.id, invoice]));
  const rows: MissingReceipt[] = [];
  for (const movement of bank.movements) {
    if (movement.creditDebit !== 'DBIT' || movement.status !== 'BOOK' || movement.reversal) continue;
    const date = movement.bookingDate || movement.valueDate;
    if (!date) continue;
    const ageDays = dayNumber(today) - dayNumber(date);
    if (ageDays < days || movement.refundMatch || movement.reconciliation) continue;
    if (movement.expenseReconciliation) {
      if (!expensesWithReceipt.has(movement.expenseReconciliation.expenseId)) rows.push({ movement, reason: 'expense', ageDays, expenseId: movement.expenseReconciliation.expenseId });
      continue;
    }
    if (movement.supplierReconciliation) {
      const invoice = invoices.get(movement.supplierReconciliation.supplierInvoiceId);
      if (invoice && !invoice.attachments.length) rows.push({ movement, reason: 'supplier_invoice', ageDays, supplierInvoiceId: invoice.id });
      continue;
    }
    const matchable = movement.supplierSuggestion?.confirmable || movement.expenseSuggestion?.candidates.some((candidate) => candidate.confirmable) || movement.refundSuggestion?.candidates.some((candidate) => candidate.confirmable);
    if (!matchable) rows.push({ movement, reason: 'unlinked', ageDays });
  }
  return rows.sort((left, right) => right.ageDays - left.ageDays || left.movement.id.localeCompare(right.movement.id));
}

export function receiptWho(movement: BankMovement): string {
  return movement.counterpartyName || movement.unstructured || movement.reference || '';
}

/** Collaborateurs à qui demander la pièce : ceux qui ont une adresse e-mail, le plus probable d'abord. */
export function receiptRecipients(employees: readonly Employee[], rememberedId?: string): Employee[] {
  const reachable = employees.filter((employee) => employee.email.includes('@') && !employee.employmentEnd);
  return reachable.sort((left, right) => Number(right.id === rememberedId) - Number(left.id === rememberedId) || left.name.localeCompare(right.name));
}

/** Messagerie qui envoie la demande : celle de l'entreprise (serveur Zentra) ou celle de cet appareil. */
export type ReceiptRequestChannel =
  | { kind: 'company'; scope: string; connectionId: string; fromEmail: string }
  | { kind: 'device'; scope: string; fromEmail: string };

/** Brouillon écrit par l'app : montant, date et bénéficiaire viennent du relevé. */
export function receiptRequestDraft(receipt: MissingReceipt, employee: Pick<Employee, 'name' | 'email'>, companyName: string): { subject: string; body: string; href: string } {
  const amount = formatMoney(Math.abs(receipt.movement.amountCents), receipt.movement.currency || 'CHF');
  const date = formatDate((receipt.movement.bookingDate || receipt.movement.valueDate).slice(0, 10));
  const who = receiptWho(receipt.movement);
  const first = employee.name.trim().split(/\s+/)[0] || employee.name;
  const subject = t('Justificatif à transmettre : {amount} du {date}', { amount, date });
  const body = [
    t('Bonjour {name},', { name: first }),
    '',
    t('Il nous manque le justificatif de cette dépense :'),
    `${amount} · ${date}${who ? ` · ${who}` : ''}`,
    '',
    t('Pouvez-vous nous l’envoyer en réponse à ce message (photo ou PDF) ?'),
    '',
    t('Merci et belle journée,'),
    companyName,
  ].join('\n');
  const href = `mailto:${encodeURIComponent(employee.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { subject, body, href };
}

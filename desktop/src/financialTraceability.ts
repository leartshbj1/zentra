import type { DocumentLine, Invoice, JournalEntry, VatReturnPreview, VatSourceClassification, VatSourceType, Workspace } from './types';
import { t } from './language';

export type FinancialSourceTarget = {
  kind: 'invoice' | 'expense' | 'supplierInvoice' | 'supplierCredit' | 'payslip';
  id: string;
  label: string;
};

/** Read facts only. Missing stored cents never become a recomputed fiscal amount. */
export function recordedDocumentAmounts(row: Record<string, unknown>): DocumentLine['recordedAmounts'] {
  const values = [row.line_net_cents, row.line_vat_cents, row.line_total_cents];
  if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value))) return undefined;
  return { netCents: values[0] as number, vatCents: values[1] as number, totalCents: values[2] as number };
}

export function financialSourceTarget(kind: FinancialSourceTarget['kind'], id: string, workspace: Workspace): FinancialSourceTarget | null {
  if (kind === 'invoice') {
    const row = workspace.invoices.find(item => item.id === id);
    return row ? { kind, id, label: `${t(row.type === 'credit_note' ? 'Avoir client' : 'Facture client')} · ${row.number || row.title}` } : null;
  }
  if (kind === 'expense') {
    const row = workspace.expenses.find(item => item.id === id);
    return row ? { kind, id, label: `${t('Dépense')} · ${row.reference || row.supplier}` } : null;
  }
  if (kind === 'supplierInvoice') {
    const row = workspace.supplierInvoices.find(item => item.id === id);
    return row ? { kind, id, label: `${t('Facture fournisseur')} · ${row.reference || row.supplierName}` } : null;
  }
  if (kind === 'supplierCredit') {
    const row = workspace.supplierCreditNotes.find(item => item.id === id);
    return row ? { kind, id, label: `${t('Avoir fournisseur')} · ${row.reference || row.number}` } : null;
  }
  const row = workspace.payslips.find(item => item.id === id);
  return row ? { kind, id, label: `${t('Fiche de salaire')} · ${row.period}` } : null;
}

export function journalSourceTarget(entry: JournalEntry, workspace: Workspace, entries: JournalEntry[] = []): FinancialSourceTarget | null {
  const visited = new Set<string>();
  let source: JournalEntry | undefined = entry;
  while (source?.reversalOf) {
    if (visited.has(source.id)) return null;
    visited.add(source.id);
    source = entries.find(item => item.id === source!.reversalOf);
  }
  if (!source) return null;
  let kind: FinancialSourceTarget['kind'];
  let id = source.sourceId;
  switch (source.sourceType) {
    case 'invoice': kind = 'invoice'; break;
    case 'payment':
    case 'vat_cash_reclassification':
      kind = 'invoice';
      id = workspace.payments.find(item => item.id === source!.sourceId)?.invoiceId || '';
      break;
    case 'customer_credit_settlement':
      kind = 'invoice';
      id = workspace.invoices.flatMap(item => item.creditSettlements ?? []).find(item => item.id === source!.sourceId)?.creditNoteId || '';
      break;
    case 'expense': kind = 'expense'; break;
    case 'expense_refund':
      kind = 'expense';
      id = workspace.expenses.find(item => item.refunds?.some(refund => refund.id === source!.sourceId))?.id || '';
      break;
    case 'supplier_invoice': kind = 'supplierInvoice'; break;
    case 'supplier_expense_reclassification':
      kind = 'supplierInvoice';
      id = workspace.supplierExpenseReclassifications?.find(item => item.id === source!.sourceId)?.supplierInvoiceId || '';
      break;
    case 'supplier_payment':
      kind = 'supplierInvoice';
      id = workspace.supplierInvoicePayments.find(item => item.id === source!.sourceId)?.supplierInvoiceId || '';
      break;
    case 'supplier_credit_note': kind = 'supplierCredit'; break;
    case 'supplier_credit_refund':
      kind = 'supplierCredit';
      id = workspace.supplierCreditNotes.find(item => item.refunds.some(refund => refund.id === source!.sourceId))?.id || '';
      break;
    case 'payslip': kind = 'payslip'; break;
    default: return null;
  }
  return financialSourceTarget(kind, id, workspace);
}

export function vatSourceTarget(source: { sourceType: VatSourceType; parentId: string }, workspace: Workspace) {
  const kind = source.sourceType === 'invoice_item' ? 'invoice'
    : source.sourceType === 'supplier_invoice_item' ? 'supplierInvoice'
      : source.sourceType === 'supplier_credit_note_item' ? 'supplierCredit' : 'expense';
  return financialSourceTarget(kind, source.parentId, workspace);
}

export type VatSalesSource = {
  invoice: Invoice;
  line: DocumentLine;
  treatment: VatSourceClassification['treatment'] | null;
  inclusion: 'included' | 'unclassified' | 'foreign' | 'annual_adjustments_only' | 'amounts_unavailable' | 'classification_unavailable';
};

/** Same document/date/nonzero selection as the agreed native report, without calculating its tax. */
export function agreedVatSalesSources(invoices: Invoice[], preview: VatReturnPreview, classifications: VatSourceClassification[] | null): VatSalesSource[] {
  if (preview.profile.formOfReporting !== 'agreed') return [];
  const validTreatments = new Set(['taxable', 'supplies_to_foreign', 'supplies_abroad', 'transfer_notification', 'exempt', 'out_of_scope', 'opted']);
  const treatments = new Map(classifications?.filter(row => row.sourceType === 'invoice_item' && validTreatments.has(row.treatment)).map(row => [row.sourceId, row.treatment]));
  return invoices.filter(invoice => invoice.nativeDocumentState?.number != null && ['emise', 'partiellement_payee', 'payee'].includes(invoice.nativeDocumentState.status)
    && invoice.issueDate >= preview.dateFrom && invoice.issueDate <= preview.dateTo)
    .flatMap(invoice => invoice.lines.filter(line => !line.recordedAmounts
      || Object.values(line.recordedAmounts).some(value => value !== 0)).map(line => {
      const treatment = treatments.get(line.id) ?? null;
      const inclusion: VatSalesSource['inclusion'] = !line.recordedAmounts ? 'amounts_unavailable'
        : preview.submissionType === 'annual_reconciliation' ? 'annual_adjustments_only'
          : invoice.currency.trim().toUpperCase() !== 'CHF' ? 'foreign'
            : classifications === null ? 'classification_unavailable' : !treatment ? 'unclassified' : 'included';
      return { invoice, line, treatment, inclusion };
    })).sort((a, b) => a.invoice.issueDate.localeCompare(b.invoice.issueDate) || a.invoice.id.localeCompare(b.invoice.id) || a.line.id.localeCompare(b.line.id));
}

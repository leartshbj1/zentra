import { boundedPositiveSum, boundedSignedSum } from './business-sync-money';
import {
  transitionField as f,
  transitionDifferent as different,
  transitionParentLocked as locked,
  transitionRowVisible as visible,
} from './business-sync-transition-state';

export const postedPayslipFields = [
  'id',
  'employee_id',
  'period',
  'gross_cents',
  'deductions_cents',
  'net_cents',
  'employer_costs_cents',
  'notes',
  'snapshot_json',
  'created_at',
] as const;
export const validatedSupplierFields = [
  'id',
  'supplier_id',
  'project_id',
  'document_date',
  'due_date',
  'supplier_name',
  'reference',
  'reference_normalized',
  'currency',
  'status',
  'net_cents',
  'vat_cents',
  'total_cents',
  'validated_at',
  'validation_journal_entry_id',
  'snapshot_json',
  'note',
  'created_at',
] as const;
export const validatedSupplierCreditFields = [
  'supplier_id',
  'number',
  'document_date',
  'supplier_name',
  'reference',
  'reference_normalized',
  'currency',
  'net_cents',
  'vat_cents',
  'total_cents',
  'note',
  'snapshot_json',
  'validation_journal_entry_id',
  'validated_at',
] as const;
const json = (alias: string, name: string) =>
  `json_extract(${alias}.row_json,'$.${name}')`;
const parentKey = (column: string, image = 22) =>
  `json_array(${f(image, column)})`;
const defaultParent = (column: string) =>
  `json_array(json_extract(COALESCE(?22,?23),'$.${column}'))`;
const supplierPaymentTotal = (
  id: string,
) => `(SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ${boundedPositiveSum('amount')} END FROM
 (SELECT ${json('payment', 'amount_cents')} amount FROM business_sync_versions payment WHERE ${visible('supplier_payments', 'payment')} AND ${json('payment', 'supplier_invoice_id')}=${id}))`;
const supplierCreditTotal = (
  id: string,
) => `(SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ${boundedSignedSum('amount')} END FROM
 (SELECT CASE ${locked('supplier_credit_notes', `json_array(${json('allocation', 'supplier_credit_note_id')})`, -2)} WHEN 0 THEN 0 WHEN 1 THEN CASE ${json('allocation', 'event_type')} WHEN 'apply' THEN ${json('allocation', 'amount_cents')} ELSE -${json('allocation', 'amount_cents')} END END amount
 FROM business_sync_versions allocation WHERE ${visible('supplier_credit_allocations', 'allocation')} AND ${json('allocation', 'supplier_invoice_id')}=${id}))`;
const journalProof = (
  id: string,
  kind: string,
  source: string,
  event: string,
  date: string,
) => `EXISTS(SELECT 1 FROM business_sync_versions entry WHERE ${visible('journal_entries', 'entry')} AND entry.row_key_json=json_array(${id})
 AND ${json('entry', 'source_type')}='${kind}' AND ${json('entry', 'source_id')}=${source} AND ${json('entry', 'source_event')}=${event} AND ${json('entry', 'entry_date')}=${date})`;
const payslipPayment = `(((${f(22, 'status')}='comptabilise' AND ${f(23, 'status')}='paye' AND ${f(23, 'payment_date')} IS NOT NULL AND ${f(23, 'payment_journal_entry_id')} IS NOT NULL)
 OR (${f(22, 'status')}='paye' AND ${f(23, 'status')}='paye' AND (${f(22, 'payment_date')} IS NULL OR ${f(22, 'payment_journal_entry_id')} IS NULL)
 AND ${f(23, 'payment_date')} IS NOT NULL AND ${f(23, 'payment_journal_entry_id')} IS NOT NULL
 AND (${f(22, 'payment_date')} IS NULL OR ${f(23, 'payment_date')} IS ${f(22, 'payment_date')})
 AND (${f(22, 'payment_journal_entry_id')} IS NULL OR ${f(23, 'payment_journal_entry_id')} IS ${f(22, 'payment_journal_entry_id')})
 AND (${f(22, 'payment_reference')} IS ${f(23, 'payment_reference')} OR ${f(22, 'payment_reference')} IS NULL))) AND NOT (${different(postedPayslipFields)}))`;
const draftParents = (table: string, column: string) =>
  `(?22 IS NOT NULL AND ${locked(table, parentKey(column), -2)}<>0) OR (?23 IS NOT NULL AND ${locked(table, parentKey(column, 23), -2)}<>0)`;

export const accountingTransitionConditions = [
  {
    table: 'expenses',
    id: 'transition:posted-expense',
    invalid: `?22 IS NOT NULL AND EXISTS(SELECT 1 FROM business_sync_versions entry WHERE ${visible('journal_entries', 'entry')} AND ${json('entry', 'source_type')}='expense' AND ${json('entry', 'source_id')}=${f(22, 'id')})`,
  },
  {
    table: 'payslips',
    id: 'transition:posted-payslip',
    invalid: `(?22 IS NOT NULL AND ${f(22, 'status')} IN ('comptabilise','paye') AND (?23 IS NULL OR NOT ${payslipPayment}))
 OR (?23 IS NOT NULL AND ${f(23, 'status')}='paye' AND ${f(23, 'payment_journal_entry_id')} IS NOT NULL AND NOT ${journalProof(f(23, 'payment_journal_entry_id'), 'payslip', f(23, 'id'), "'payment'", f(23, 'payment_date'))})`,
  },
  {
    table: 'payslip_items',
    id: 'transition:posted-payslip-items',
    invalid: `${locked('payslips', defaultParent('payslip_id'))}<>0`,
  },
  {
    table: 'supplier_invoices',
    id: 'transition:validated-supplier-invoice',
    invalid: `?22 IS NOT NULL AND ${f(22, 'status')}<>'draft' AND (?23 IS NULL OR ${different(validatedSupplierFields)}
 OR ${f(23, 'paid_cents')}<${f(22, 'paid_cents')} OR ${f(23, 'credited_cents')}<0
 OR ${f(23, 'paid_cents')} IS NOT ${supplierPaymentTotal(f(22, 'id'))} OR ${f(23, 'credited_cents')} IS NOT ${supplierCreditTotal(f(22, 'id'))}
 OR ${f(23, 'paid_cents')}>${f(23, 'total_cents')}-${f(23, 'credited_cents')})`,
  },
  {
    table: 'supplier_invoice_items',
    id: 'transition:validated-supplier-items',
    invalid: draftParents('supplier_invoices', 'supplier_invoice_id'),
  },
  {
    table: 'supplier_invoice_matches',
    id: 'transition:validated-supplier-matches',
    invalid: `?22 IS NOT NULL AND ${locked('supplier_invoices', parentKey('supplier_invoice_id'))}<>0`,
  },
  {
    table: 'supplier_credit_notes',
    id: 'transition:validated-supplier-credit',
    invalid: `?22 IS NOT NULL AND ${f(22, 'status')}='validated' AND (?23 IS NULL OR ${f(23, 'status')} IS NOT 'validated' OR ${different(validatedSupplierCreditFields)})`,
  },
  {
    table: 'supplier_credit_note_items',
    id: 'transition:validated-supplier-credit-items',
    invalid: draftParents('supplier_credit_notes', 'supplier_credit_note_id'),
  },
  {
    table: 'supplier_credit_allocations',
    id: 'transition:validated-credit-allocation',
    invalid: `?22 IS NOT NULL AND ${locked('supplier_credit_notes', parentKey('supplier_credit_note_id'))}<>0`,
  },
  {
    table: 'supplier_payments',
    id: 'transition:supplier-payment-proof',
    invalid: `?23 IS NOT NULL AND (${locked('supplier_invoices', parentKey('supplier_invoice_id', 23), -2)}<>1 OR NOT ${journalProof(f(23, 'journal_entry_id'), 'supplier_payment', f(23, 'id'), `'invoice:'||${f(23, 'supplier_invoice_id')}`, f(23, 'date'))}
 OR NOT EXISTS(SELECT 1 FROM business_sync_versions invoice WHERE invoice.transfer_id=?1 AND invoice.organization_id=?2 AND invoice.table_name='supplier_invoices' AND invoice.row_key_json=${parentKey('supplier_invoice_id', 23)}
 AND ${f(23, 'date')}>=${json('invoice', 'document_date')} AND ${f(23, 'amount_cents')}<=${json('invoice', 'total_cents')}-${supplierPaymentTotal(f(23, 'supplier_invoice_id'))}-${supplierCreditTotal(f(23, 'supplier_invoice_id'))}))`,
  },
];

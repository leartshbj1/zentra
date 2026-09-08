import type { AccountingRule } from './business-sync-accounting';
import { structuralRows as rows } from './business-sync-structure';

const entries = `entries AS MATERIALIZED (${rows('journal_entries', ['id', 'number', 'entry_date', 'source_type', 'source_id', 'source_event', 'reversal_of'])})`;
const lines = `lines AS MATERIALIZED (${rows('journal_lines', ['journal_entry_id', 'account_id', 'debit_cents', 'credit_cents', 'currency', 'memo', 'project_id', 'client_id', 'employee_id'])})`;
// Each node has exactly one parent. A component with a cycle cannot be reached
// from a root. Count all reached nodes after checking forks and foreign keys;
// no UUID ordering or arbitrary recursion-depth cutoff changes the result.
const chain = `chain(root_id,id,depth) AS (
 SELECT id,id,0 FROM entries WHERE reversal_of IS NULL UNION ALL
 SELECT c.root_id,e.id,c.depth+1 FROM chain c JOIN entries e ON e.reversal_of=c.id)`;
const effective = `depths AS MATERIALIZED (SELECT root_id,MAX(depth) depth FROM chain GROUP BY root_id),
 effective AS MATERIALIZED (SELECT e.* FROM entries e JOIN depths d ON d.root_id=e.id WHERE d.depth%2=0)`;
const typedLines = `${lines}, accounts AS MATERIALIZED (${rows('accounts', ['id', 'account_type'])}),
 typed_lines AS MATERIALIZED (SELECT l.*,a.account_type FROM lines l JOIN accounts a ON a.id=l.account_id),
 totals AS MATERIALIZED (SELECT journal_entry_id,SUM(debit_cents) debit,SUM(credit_cents) credit,MIN(currency) min_currency,MAX(currency) max_currency FROM lines GROUP BY journal_entry_id)`;
// SUM is safe here: the preceding journal rules have already established
// positive sides and the combined signed-int64 cap for every journal entry.
const context = `WITH RECURSIVE ${entries},${chain},${effective},${typedLines}`;
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const lineWhere = (
  memo: string,
  debit: string,
  credit: string,
  entry = 'e.id',
  prefix = false,
) =>
  `l.journal_entry_id=${entry} AND ${prefix ? `substr(l.memo,1,${memo.length})` : 'l.memo'}=${quote(memo)} AND l.debit_cents=${debit} AND l.credit_cents=${credit}`;
const exact = (
  memo: string,
  debit: string,
  credit: string,
  type: string,
  entry = 'e.id',
  prefix = false,
) =>
  `(SELECT COUNT(*) FROM typed_lines l WHERE ${lineWhere(memo, debit, credit, entry, prefix)} AND l.account_type=${quote(type)})=1`;
const account = (
  memo: string,
  debit: string,
  credit: string,
  entry = 'e.id',
  prefix = false,
) =>
  `(SELECT account_id FROM typed_lines l WHERE ${lineWhere(memo, debit, credit, entry, prefix)} LIMIT 1)`;
const matches = (amount: string, currency: string) =>
  `(${amount}>0 AND t.debit=${amount} AND t.credit=${amount} AND t.min_currency=${currency} AND t.max_currency=${currency})`;
const invoiceRows = rows('invoices', [
  'id',
  'type',
  'status',
  'number',
  'issue_date',
  'currency',
  'total_cents',
  'vat_cents',
  'original_invoice_id',
  'subtotal_cents',
  'discount_cents',
]);
const invoiceCte = `invoices AS MATERIALIZED (${invoiceRows})`;
const due = 'TVA due';
const deferred = 'TVA à régulariser · contre-prestations reçues';
const creditVatMemos = [
  'Extourne TVA',
  'TVA de l’avoir en attente de règlement',
  'Extourne TVA à régulariser',
  'Extourne TVA due encaissée',
]
  .map(quote)
  .join(',');

const invoiceShape = `i.number IS NOT NULL AND i.issue_date IS NOT NULL AND e.entry_date=i.issue_date
 AND e.source_event='issue' AND ${matches('ABS(i.total_cents)', 'i.currency')}`;
const normalInvoice = `i.total_cents>0 AND i.vat_cents>=0 AND i.total_cents-i.vat_cents>=0
 AND ${exact('Créance client', 'i.total_cents', '0', 'asset')}
 AND (i.total_cents=i.vat_cents OR ${exact('Produit facturé', '0', 'i.total_cents-i.vat_cents', 'revenue')})
 AND (i.vat_cents=0 OR (SELECT COUNT(*) FROM typed_lines l WHERE l.journal_entry_id=e.id
   AND l.memo=CASE WHEN COALESCE((SELECT form_of_reporting FROM profiles WHERE effective_from<=i.issue_date AND COALESCE(effective_to,'9999-12-31')>=i.issue_date ORDER BY effective_from DESC LIMIT 1),'agreed')='received' THEN ${quote(deferred)} ELSE ${quote(due)} END
   AND l.debit_cents=0 AND l.credit_cents=i.vat_cents AND l.account_type='liability')=1)`;
const creditInvoice = `i.total_cents<0 AND i.vat_cents<=0 AND i.total_cents-i.vat_cents<=0
 AND ${exact('Réduction créance client', '0', '-i.total_cents', 'asset')}
 AND (i.total_cents=i.vat_cents OR ${exact('Extourne produit', 'i.vat_cents-i.total_cents', '0', 'revenue')})
 AND COALESCE((SELECT SUM(l.debit_cents) FROM typed_lines l WHERE l.journal_entry_id=e.id AND l.memo IN (${creditVatMemos}) AND l.credit_cents=0 AND l.account_type='liability'),0)=-i.vat_cents`;

// D1's workerd SQLite accepts fewer compound SELECT terms than node:sqlite.
// Materialized groups also prevent the planner from flattening the union again.
const sources = `customer_sources AS MATERIALIZED (
 SELECT 'invoice' kind,id,issue_date date,'issue' event FROM invoices WHERE number IS NOT NULL AND status<>'annulee'
   AND NOT(type='finale' AND total_cents=0 AND vat_cents=0 AND subtotal_cents=discount_cents AND EXISTS(SELECT 1 FROM pairs WHERE balance_invoice_id=invoices.id))
 UNION ALL SELECT 'payment',id,date,'invoice:'||invoice_id FROM payments
 UNION ALL SELECT 'expense',id,COALESCE(paid_at,date),'create' FROM expenses WHERE payment_status='paid'),
 other_sources AS MATERIALIZED (
 SELECT 'supplier_invoice' kind,id,document_date date,'validate' event FROM supplier_invoices WHERE status='validated'
 UNION ALL SELECT 'supplier_payment',id,date,'invoice:'||supplier_invoice_id FROM supplier_payments
 UNION ALL SELECT 'payslip',id,period||'-01','post' FROM payslips WHERE status IN ('comptabilise','paye')
 UNION ALL SELECT 'payslip',id,payment_date,'payment' FROM payslips WHERE status='paye'),
 sources AS MATERIALIZED (SELECT * FROM customer_sources UNION ALL SELECT * FROM other_sources)`;
const sourceTables = `${invoiceCte},
 payments AS MATERIALIZED (${rows('payments', ['id', 'invoice_id', 'date'])}),
 expenses AS MATERIALIZED (${rows('expenses', ['id', 'date', 'paid_at', 'payment_status'])}),
 supplier_invoices AS MATERIALIZED (${rows('supplier_invoices', ['id', 'status', 'document_date'])}),
 supplier_payments AS MATERIALIZED (${rows('supplier_payments', ['id', 'supplier_invoice_id', 'date'])}),
 payslips AS MATERIALIZED (${rows('payslips', ['id', 'period', 'status', 'payment_date'])}),
 pairs AS MATERIALIZED (${rows('quote_invoice_pairs', ['balance_invoice_id'])}),
 settings AS MATERIALIZED (${rows('accounting_settings', ['enabled'])}), periods AS MATERIALIZED (${rows('accounting_periods', ['status', 'date_to'])})`;
const payrollContext = `${context}, payslips AS MATERIALIZED (${rows('payslips', ['id', 'period', 'status', 'gross_cents', 'net_cents', 'employer_costs_cents', 'payment_date', 'payment_journal_entry_id'])}),
 settings AS MATERIALIZED (${rows('settings', ['currency'])})`;

export const postingRules: AccountingRule[] = [
  {
    id: 'posting:automatic_sides',
    sql: `WITH ${entries},${lines} SELECT e.id AS __key FROM entries e JOIN lines l ON l.journal_entry_id=e.id
   WHERE e.reversal_of IS NULL AND e.source_type NOT IN ('manual','customer_credit_settlement','customer_credit_recovery')
   GROUP BY e.id,l.account_id HAVING MAX(l.debit_cents)>0 AND MAX(l.credit_cents)>0 LIMIT 1`,
  },
  {
    id: 'reversal:fork',
    sql: `WITH ${entries} SELECT reversal_of AS __key FROM entries WHERE reversal_of IS NOT NULL GROUP BY reversal_of HAVING COUNT(*)>1 LIMIT 1`,
  },
  {
    id: 'reversal:chain',
    sql: `WITH RECURSIVE ${entries},${chain} SELECT 1 AS __key WHERE (SELECT COUNT(*) FROM chain)<>(SELECT COUNT(*) FROM entries)`,
  },
  {
    id: 'reversal:date',
    sql: `WITH ${entries} SELECT e.id AS __key FROM entries e JOIN entries p ON p.id=e.reversal_of WHERE e.entry_date<p.entry_date LIMIT 1`,
  },
  {
    id: 'reversal:lines',
    sql: `WITH ${entries},${lines}, compared AS (
    SELECT e.id, l.account_id,l.credit_cents debit,l.debit_cents credit,l.currency,l.project_id,l.client_id,l.employee_id,1 sign
     FROM entries e JOIN lines l ON l.journal_entry_id=e.reversal_of
    UNION ALL SELECT e.id,l.account_id,l.debit_cents,l.credit_cents,l.currency,l.project_id,l.client_id,l.employee_id,-1
     FROM entries e JOIN lines l ON l.journal_entry_id=e.id WHERE e.reversal_of IS NOT NULL)
    SELECT id AS __key FROM compared GROUP BY id,account_id,debit,credit,currency,project_id,client_id,employee_id HAVING SUM(sign)<>0 LIMIT 1`,
  },
  {
    id: 'posting:source',
    sql: `WITH ${entries},
    customer_documents AS MATERIALIZED (${['invoices', 'payments', 'expenses'].map((table, index) => `SELECT ${quote(['invoice', 'payment', 'expense'][index])} kind,id FROM (${rows(table, ['id'])})`).join(' UNION ALL ')}),
    other_documents AS MATERIALIZED (${['supplier_invoices', 'supplier_payments', 'payslips'].map((table, index) => `SELECT ${quote(['supplier_invoice', 'supplier_payment', 'payslip'][index])} kind,id FROM (${rows(table, ['id'])})`).join(' UNION ALL ')}),
    documents AS MATERIALIZED (SELECT * FROM customer_documents UNION ALL SELECT * FROM other_documents)
    SELECT e.id AS __key FROM entries e LEFT JOIN documents d ON d.kind=e.source_type AND d.id=e.source_id
    WHERE e.reversal_of IS NULL AND e.source_type IN ('invoice','payment','expense','supplier_invoice','supplier_payment','payslip') AND d.id IS NULL LIMIT 1`,
  },
  {
    id: 'posting:required',
    sql: `${context},${sourceTables},${sources} SELECT s.id AS __key FROM sources s
    WHERE (EXISTS(SELECT 1 FROM entries e WHERE e.source_type=s.kind AND e.source_id=s.id AND e.source_event=s.event)
      OR (EXISTS(SELECT 1 FROM settings WHERE enabled=1) AND NOT EXISTS(SELECT 1 FROM periods p WHERE p.status='closed' AND s.date<=p.date_to)))
      AND NOT EXISTS(SELECT 1 FROM effective e WHERE e.source_type=s.kind AND e.source_id=s.id AND e.source_event=s.event) LIMIT 1`,
  },
  {
    id: 'posting:cancelled_invoice',
    sql: `${context},${invoiceCte} SELECT i.id AS __key FROM invoices i JOIN effective e ON e.source_type='invoice' AND e.source_id=i.id WHERE i.status='annulee' LIMIT 1`,
  },
  {
    id: 'posting:invoice',
    sql: `${context},${invoiceCte}, profiles AS MATERIALIZED (${rows('vat_profiles', ['effective_from', 'effective_to', 'form_of_reporting'])})
    SELECT e.id AS __key FROM effective e LEFT JOIN invoices i ON i.id=e.source_id JOIN totals t ON t.journal_entry_id=e.id
    WHERE e.source_type='invoice' AND (i.id IS NULL OR NOT(${invoiceShape} AND CASE WHEN i.type='avoir' THEN (${creditInvoice}) ELSE (${normalInvoice}) END)) LIMIT 1`,
  },
  {
    id: 'posting:credit_accounts',
    sql: `${context},${invoiceCte} SELECT e.id AS __key FROM effective e JOIN invoices i ON i.id=e.source_id
    LEFT JOIN invoices original ON original.id=i.original_invoice_id
    LEFT JOIN effective o ON o.source_type='invoice' AND o.source_id=original.id AND o.source_event='issue'
    WHERE e.source_type='invoice' AND i.type='avoir' AND i.original_invoice_id IS NOT NULL AND (o.id IS NULL
      OR ${account('Réduction créance client', '0', '-i.total_cents')} IS NOT ${account('Créance client', 'original.total_cents', '0', 'o.id')}
      OR (i.total_cents<>i.vat_cents AND ${account('Extourne produit', 'i.vat_cents-i.total_cents', '0')} IS NOT ${account('Produit facturé', '0', 'original.total_cents-original.vat_cents', 'o.id')})) LIMIT 1`,
  },
  {
    id: 'posting:payment',
    sql: `${context},${invoiceCte}, payments AS MATERIALIZED (${rows('payments', ['id', 'invoice_id', 'date', 'amount_cents'])})
    SELECT e.id AS __key FROM effective e LEFT JOIN payments p ON p.id=e.source_id LEFT JOIN invoices i ON i.id=p.invoice_id
    LEFT JOIN effective o ON o.source_type='invoice' AND o.source_id=i.id AND o.source_event='issue'
    JOIN totals t ON t.journal_entry_id=e.id WHERE e.source_type='payment' AND (p.id IS NULL OR i.id IS NULL OR o.id IS NULL
      OR e.source_event<>'invoice:'||i.id OR e.entry_date<>p.date OR NOT ${matches('p.amount_cents', 'i.currency')}
      OR NOT ${exact('Encaissement', 'p.amount_cents', '0', 'asset')} OR NOT ${exact('Règlement créance', '0', 'p.amount_cents', 'asset')}
      OR ${account('Règlement créance', '0', 'p.amount_cents')} IS NOT ${account('Créance client', 'i.total_cents', '0', 'o.id')}) LIMIT 1`,
  },
  {
    id: 'posting:expense',
    sql: `${context}, expenses AS MATERIALIZED (${rows('expenses', ['id', 'date', 'paid_at', 'net_cents', 'vat_cents', 'total_cents', 'currency', 'payment_status'])})
    SELECT e.id AS __key FROM effective e LEFT JOIN expenses d ON d.id=e.source_id JOIN totals t ON t.journal_entry_id=e.id
    WHERE e.source_type='expense' AND (d.id IS NULL OR d.payment_status<>'paid' OR e.source_event<>'create' OR e.entry_date<>COALESCE(d.paid_at,d.date)
      OR NOT ${matches('d.total_cents', 'd.currency')} OR (d.net_cents<>0 AND NOT ${exact('Charge', 'd.net_cents', '0', 'expense')})
      OR (d.vat_cents<>0 AND NOT ${exact('TVA préalable', 'd.vat_cents', '0', 'asset')}) OR NOT ${exact('Paiement dépense', '0', 'd.total_cents', 'asset')}) LIMIT 1`,
  },
  {
    id: 'posting:supplier_invoice',
    sql: `${context}, invoices AS MATERIALIZED (${rows('supplier_invoices', ['id', 'document_date', 'currency', 'status', 'net_cents', 'vat_cents', 'total_cents', 'validation_journal_entry_id'])})
    SELECT e.id AS __key FROM effective e LEFT JOIN invoices d ON d.id=e.source_id JOIN totals t ON t.journal_entry_id=e.id
    WHERE e.source_type='supplier_invoice' AND (d.id IS NULL OR d.status<>'validated' OR e.id IS NOT d.validation_journal_entry_id OR e.source_event<>'validate' OR e.entry_date<>d.document_date
      OR NOT ${matches('d.total_cents', 'd.currency')}
      OR COALESCE((SELECT SUM(l.debit_cents) FROM typed_lines l WHERE l.journal_entry_id=e.id AND l.memo IS NOT 'TVA préalable fournisseur' AND l.account_type='expense'),0)<>d.net_cents
      OR (d.vat_cents<>0 AND NOT ${exact('TVA préalable fournisseur', 'd.vat_cents', '0', 'asset')})
      OR NOT ${exact('Dette fournisseur', '0', 'd.total_cents', 'liability')}) LIMIT 1`,
  },
  {
    id: 'posting:supplier_payment',
    sql: `${context}, invoices AS MATERIALIZED (${rows('supplier_invoices', ['id', 'currency', 'total_cents'])}), payments AS MATERIALIZED (${rows('supplier_payments', ['id', 'supplier_invoice_id', 'journal_entry_id', 'date', 'amount_cents'])})
    SELECT e.id AS __key FROM effective e LEFT JOIN payments p ON p.id=e.source_id LEFT JOIN invoices d ON d.id=p.supplier_invoice_id
    LEFT JOIN effective o ON o.source_type='supplier_invoice' AND o.source_id=d.id AND o.source_event='validate' JOIN totals t ON t.journal_entry_id=e.id
    WHERE e.source_type='supplier_payment' AND (p.id IS NULL OR d.id IS NULL OR o.id IS NULL OR e.id IS NOT p.journal_entry_id OR e.entry_date<>p.date
      OR e.source_event<>'invoice:'||d.id OR NOT ${matches('p.amount_cents', 'd.currency')}
      OR NOT ${exact('Règlement dette fournisseur', 'p.amount_cents', '0', 'liability')} OR NOT ${exact('Paiement fournisseur', '0', 'p.amount_cents', 'asset')}
      OR ${account('Règlement dette fournisseur', 'p.amount_cents', '0')} IS NOT ${account('Dette fournisseur', '0', 'd.total_cents', 'o.id')}) LIMIT 1`,
  },
  {
    id: 'posting:payslip',
    sql: `${payrollContext} SELECT e.id AS __key FROM effective e LEFT JOIN payslips d ON d.id=e.source_id JOIN totals t ON t.journal_entry_id=e.id
    WHERE e.source_type='payslip' AND (d.id IS NULL OR d.status NOT IN ('comptabilise','paye') OR e.source_event NOT IN ('post','payment')
      OR (e.source_event='post' AND (substr(e.entry_date,1,7)<>d.period OR t.min_currency<>(SELECT currency FROM settings) OR t.max_currency<>(SELECT currency FROM settings)
        OR d.gross_cents<0 OR d.net_cents<0 OR d.employer_costs_cents<0
        OR (d.gross_cents<>0 AND NOT ${exact('Salaire brut', 'd.gross_cents', '0', 'expense')})
        OR (d.net_cents<>0 AND NOT ${exact('Salaire net dû', '0', 'd.net_cents', 'liability')})))) LIMIT 1`,
  },
  {
    id: 'posting:payslip_total',
    sql: `${payrollContext}, reimbursements AS MATERIALIZED (${rows('payslip_items', ['payslip_id', 'kind', 'amount_cents'])}), movements AS (
    SELECT e.id,t.debit-d.gross_cents-d.employer_costs_cents amount FROM effective e JOIN payslips d ON d.id=e.source_id JOIN totals t ON t.journal_entry_id=e.id WHERE e.source_type='payslip' AND e.source_event='post'
    UNION ALL SELECT e.id,-r.amount_cents FROM effective e JOIN reimbursements r ON r.payslip_id=e.source_id WHERE e.source_type='payslip' AND e.source_event='post' AND r.kind='reimbursement')
    SELECT id AS __key FROM movements GROUP BY id HAVING SUM(amount/1000000000)+SUM(amount%1000000000)/1000000000<>0 OR SUM(amount%1000000000)%1000000000<>0 LIMIT 1`,
  },
  {
    id: 'posting:payslip_payment',
    sql: `${payrollContext} SELECT e.id AS __key FROM effective e LEFT JOIN payslips d ON d.id=e.source_id
    LEFT JOIN effective o ON o.source_type='payslip' AND o.source_id=d.id AND o.source_event='post' JOIN totals t ON t.journal_entry_id=e.id
    WHERE e.source_type='payslip' AND e.source_event='payment' AND (d.id IS NULL OR o.id IS NULL OR d.status<>'paye' OR e.entry_date IS NOT d.payment_date OR e.id IS NOT d.payment_journal_entry_id
      OR NOT ${matches('d.net_cents', '(SELECT currency FROM settings)')}
      OR NOT ${exact('Extinction salaire net dû', 'd.net_cents', '0', 'liability', 'e.id', true)} OR NOT ${exact('Paiement bancaire du salaire', '0', 'd.net_cents', 'asset', 'e.id', true)}
      OR ${account('Extinction salaire net dû', 'd.net_cents', '0', 'e.id', true)} IS NOT ${account('Salaire net dû', '0', 'd.net_cents', 'o.id')}) LIMIT 1`,
  },
];

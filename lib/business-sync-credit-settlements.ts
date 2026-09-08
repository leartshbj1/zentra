import type { AccountingRule } from './business-sync-accounting';
import { structuralRows as rows } from './business-sync-structure';
import { postingContextSql } from './business-sync-postings';
import { boundedSignedSum } from './business-sync-money';

const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
const creditMemo = 'Règlement de l’avoir client';
const applyMemo = 'Imputation sur facture client';
const refundMemo = 'Remboursement au client';
const pending = 'TVA de l’avoir en attente de règlement';
const deferred = 'TVA à régulariser · contre-prestations reçues';
const creditRelease = 'Reprise TVA de l’avoir réglé';
const creditDue = 'Réduction TVA due sur règlement de l’avoir';
const invoiceRelease = 'Reclassement TVA à régulariser';
const invoiceDue = 'TVA due sur encaissement';

const settlements = `settlements AS MATERIALIZED (${rows('customer_credit_settlements', ['id', 'sequence', 'request_id', 'request_json', 'credit_note_id', 'invoice_id', 'event_type', 'reverses_id', 'date', 'created_at', 'amount_cents', 'bank_account_id', 'reference', 'reason'])})`;
const invoices = `invoices AS MATERIALIZED (${rows('invoices', ['id', 'type', 'number', 'status', 'issue_date', 'client_id', 'project_id', 'currency', 'original_invoice_id', 'total_cents', 'vat_cents'])})`;
const documents = `documents AS MATERIALIZED (${rows('customer_credit_documents', ['credit_note_id'])})`;
const items = `items AS MATERIALIZED (${rows('invoice_items', ['id', 'invoice_id', 'position', 'line_total_cents', 'line_vat_cents'])})`;
const parts = `parts AS MATERIALIZED (${rows('customer_credit_settlement_lines', ['settlement_id', 'side', 'invoice_item_id', 'gross_cents', 'vat_cents'])})`;
const proofs = `proofs AS MATERIALIZED (${rows('customer_credit_settlement_postings', ['settlement_id', 'journal_entry_id', 'snapshot_json'])})`;
const basis = `WITH ${settlements},${invoices},${documents},${items},${parts}`;
const journal = `${postingContextSql},${settlements},${invoices},${proofs},${parts},
 recovery AS MATERIALIZED (${rows('customer_credit_recovery_postings', ['source_type', 'source_id', 'journal_entry_id'])})`;
const signed =
  "CASE WHEN s.event_type IN ('apply','refund') THEN s.amount_cents ELSE -s.amount_cents END";

// Split signed sums remain exact even if positive and negative movements each
// exceed int64 before cancellation. Normalize to Euclidean quotient/remainder.
// The staged contract caps the total row count at 200,000.
const outside = (high: string, low: string, cap: string) => {
  const h = `(${high}+${low}/1000000000-CASE WHEN ${low}%1000000000<0 THEN 1 ELSE 0 END)`;
  const r = `((${low}%1000000000+1000000000)%1000000000)`;
  return `(${h}<0 OR ${h}>${cap}/1000000000 OR (${h}=${cap}/1000000000 AND ${r}>${cap}%1000000000))`;
};
const nonzeroSum = (field: string) =>
  `(SUM(${field}/1000000000)+SUM(${field}%1000000000)/1000000000<>0 OR SUM(${field}%1000000000)%1000000000<>0)`;

const history = `${basis}, payments AS MATERIALIZED (${rows('payments', ['id', 'invoice_id', 'date', 'created_at', 'amount_cents'])}),
 movements AS MATERIALIZED (
   SELECT 'credit' side,s.credit_note_id document_id,s.id,s.date,s.created_at,s.sequence,${signed} amount FROM settlements s
   UNION ALL SELECT 'invoice',s.invoice_id,s.id,s.date,s.created_at,s.sequence,${signed} FROM settlements s WHERE s.invoice_id IS NOT NULL
   UNION ALL SELECT 'invoice',p.invoice_id,p.id,p.date,p.created_at,0,p.amount_cents FROM payments p
     WHERE EXISTS(SELECT 1 FROM settlements s WHERE s.invoice_id=p.invoice_id)),
 prefixes AS MATERIALIZED (SELECT *,
   SUM(amount/1000000000) OVER timeline hi,SUM(amount%1000000000) OVER timeline lo
   FROM movements WINDOW timeline AS (PARTITION BY side,document_id ORDER BY date,created_at,sequence,id ROWS UNBOUNDED PRECEDING))`;

// Actual journal row objects are compared to the saved proof by field and line
// identity. SQL compares integer atoms directly; JavaScript never parses money.
// Local SQLite rowid is not portable, so an array's line order is not an identity.
const raw = (table: string, extra = '') =>
  `SELECT row_json,json_extract(row_json,'$.id') id${extra} FROM business_sync_versions WHERE transfer_id=?1 AND organization_id=?2 AND table_name='${table}'`;
const snapshots = `WITH ${proofs},
 raw_entries AS MATERIALIZED (${raw('journal_entries')}),
 raw_lines AS MATERIALIZED (${raw('journal_lines', ",json_extract(row_json,'$.journal_entry_id') journal_entry_id")}),
 pieces AS MATERIALIZED (
   SELECT p.settlement_id proof_id,'entry' kind,'' piece,1 sign,json_extract(p.snapshot_json,'$.entry') payload FROM proofs p
   UNION ALL SELECT p.settlement_id,'entry','',-1,e.row_json FROM proofs p JOIN raw_entries e ON e.id=p.journal_entry_id
   UNION ALL SELECT p.settlement_id,'line',json_extract(l.value,'$.id'),1,l.value FROM proofs p,json_each(p.snapshot_json,'$.lines') l
   UNION ALL SELECT p.settlement_id,'line',l.id,-1,l.row_json FROM proofs p JOIN raw_lines l ON l.journal_entry_id=p.journal_entry_id),
 nodes AS (SELECT proof_id,kind,piece,n.fullkey,n.type,n.atom,sign FROM pieces,json_tree(pieces.payload) n)`;

const historicalAccounts = `invoice_accounts AS MATERIALIZED (SELECT i.id,
  MAX(CASE WHEN l.memo=CASE i.type WHEN 'avoir' THEN 'Réduction créance client' ELSE 'Créance client' END AND a.account_type='asset' THEN l.account_id END) ar,
  MAX(CASE WHEN l.memo=CASE i.type WHEN 'avoir' THEN ${q(pending)} ELSE ${q(deferred)} END AND a.account_type='liability' THEN l.account_id END) deferred
  FROM invoices i LEFT JOIN effective e ON e.source_type='invoice' AND e.source_id=i.id AND e.source_event='issue'
  LEFT JOIN lines l ON l.journal_entry_id=e.id LEFT JOIN accounts a ON a.id=l.account_id GROUP BY i.id),
 recovered_accounts AS MATERIALIZED (SELECT r.source_id id,MAX(l.account_id) deferred FROM recovery r JOIN lines l ON l.journal_entry_id=r.journal_entry_id
  JOIN accounts a ON a.id=l.account_id AND a.account_type='liability' WHERE r.source_type='credit' AND l.memo=${q(pending)} GROUP BY r.source_id),
 taxes AS MATERIALIZED (SELECT settlement_id,side,${boundedSignedSum('vat_cents')} amount FROM parts GROUP BY settlement_id,side),
 posting_basis AS MATERIALIZED (SELECT s.*,p.journal_entry_id,c.currency,c.client_id,c.project_id credit_project,
  CASE WHEN s.invoice_id IS NULL THEN c.project_id ELSE i.project_id END counterpart_project,
  ca.ar credit_ar,CASE WHEN s.invoice_id IS NULL THEN s.bank_account_id ELSE ia.ar END counterpart_ar,
  COALESCE(ca.deferred,ra.deferred) credit_deferred,ia.deferred invoice_deferred,
  CASE WHEN COALESCE(ca.deferred,ra.deferred) IS NULL THEN 0 ELSE COALESCE(ct.amount,0) END credit_tax,
  CASE WHEN ia.deferred IS NULL THEN 0 ELSE COALESCE(it.amount,0) END invoice_tax,${signed} signed_amount
  FROM settlements s JOIN proofs p ON p.settlement_id=s.id JOIN invoices c ON c.id=s.credit_note_id
  LEFT JOIN invoices i ON i.id=s.invoice_id LEFT JOIN invoice_accounts ca ON ca.id=c.id LEFT JOIN invoice_accounts ia ON ia.id=i.id
  LEFT JOIN recovered_accounts ra ON ra.id=c.id LEFT JOIN taxes ct ON ct.settlement_id=s.id AND ct.side='credit'
  LEFT JOIN taxes it ON it.settlement_id=s.id AND it.side='invoice')`;

export const creditSettlementRules: AccountingRule[] = [
  {
    id: 'credit_documents:source',
    sql: `${basis} SELECT d.credit_note_id __key FROM documents d LEFT JOIN invoices c ON c.id=d.credit_note_id
      WHERE c.id IS NULL OR c.type<>'avoir' OR c.number IS NULL OR c.status IN ('annulee','brouillon') OR c.total_cents>=0 LIMIT 1`,
  },
  {
    id: 'credit_settlements:source',
    // Closed periods and inactive bank accounts are allowed for historical rows;
    // creation-time checks must not invalidate a legitimate frozen history.
    sql: `${basis}, accounts AS MATERIALIZED (${rows('accounts', ['id', 'account_type'])})
      SELECT s.id __key FROM settlements s LEFT JOIN invoices c ON c.id=s.credit_note_id LEFT JOIN documents d ON d.credit_note_id=c.id
      LEFT JOIN invoices i ON i.id=s.invoice_id LEFT JOIN accounts a ON a.id=s.bank_account_id
      WHERE d.credit_note_id IS NULL OR c.client_id IS NULL OR s.sequence<=0
        OR date(s.date,'+0 days') IS NULL OR date(s.date,'+0 days')<>s.date OR s.date<c.issue_date
        OR (s.invoice_id IS NOT NULL AND (i.id IS NULL OR i.type='avoir' OR i.number IS NULL OR i.status IN ('annulee','brouillon')
          OR i.total_cents<=0 OR s.date<i.issue_date OR i.client_id IS NOT c.client_id OR i.currency<>c.currency
          OR EXISTS(SELECT 1 FROM invoices l WHERE l.original_invoice_id=i.id AND l.type='avoir' AND l.number IS NOT NULL AND l.status<>'annulee'
             AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.credit_note_id=l.id))))
        OR (s.bank_account_id IS NOT NULL AND (a.id IS NULL OR a.account_type<>'asset')) LIMIT 1`,
  },
  {
    id: 'credit_settlements:request',
    sql: `${basis} SELECT s.id __key FROM settlements s WHERE json_type(s.request_json,'$.input') IS NOT 'object'
      OR ${['request_id', 'date', 'reason'].map((f) => `json_type(s.request_json,'$.input.${f}') IS NOT 'text'`).join(' OR ')}
      OR json_extract(s.request_json,'$.input.request_id') IS NOT s.request_id OR json_extract(s.request_json,'$.input.date') IS NOT s.date
      OR json_extract(s.request_json,'$.input.reason') IS NOT s.reason
      OR CASE WHEN s.reverses_id IS NULL THEN
        json_extract(s.request_json,'$.operation') IS NOT 'record'
        OR json_type(s.request_json,'$.input.amount_cents') IS NOT 'integer'
        OR ${['credit_note_id', 'event_type', 'reference'].map((f) => `json_type(s.request_json,'$.input.${f}') IS NOT 'text'`).join(' OR ')}
        OR ${['invoice_id', 'bank_account_id'].map((f) => `json_type(s.request_json,'$.input.${f}') IS NOT CASE WHEN s.${f} IS NULL THEN 'null' ELSE 'text' END`).join(' OR ')}
        OR ${['credit_note_id', 'event_type', 'invoice_id', 'amount_cents', 'bank_account_id', 'reference'].map((f) => `json_extract(s.request_json,'$.input.${f}') IS NOT s.${f}`).join(' OR ')}
        ELSE json_extract(s.request_json,'$.operation') IS NOT 'reverse' OR json_type(s.request_json,'$.input.settlement_id') IS NOT 'text' OR json_extract(s.request_json,'$.input.settlement_id') IS NOT s.reverses_id END LIMIT 1`,
  },
  {
    id: 'credit_settlements:reversal',
    sql: `${basis} SELECT s.id __key FROM settlements s LEFT JOIN settlements o ON o.id=s.reverses_id
      WHERE s.reverses_id IS NOT NULL AND (o.id IS NULL OR o.reverses_id IS NOT NULL OR o.credit_note_id<>s.credit_note_id
        OR o.event_type<>CASE s.event_type WHEN 'reverse_apply' THEN 'apply' ELSE 'refund' END
        OR o.invoice_id IS NOT s.invoice_id OR o.bank_account_id IS NOT s.bank_account_id OR o.amount_cents<>s.amount_cents
        OR o.reference<>s.reference OR o.sequence>=s.sequence
        OR (s.date,s.created_at,s.sequence,s.id)<=(o.date,o.created_at,o.sequence,o.id)) LIMIT 1`,
  },
  {
    id: 'credit_settlements:line_source',
    sql: `${basis}, sides AS MATERIALIZED (SELECT id,'credit' side,credit_note_id document_id FROM settlements
      UNION ALL SELECT id,'invoice',invoice_id FROM settlements WHERE invoice_id IS NOT NULL)
      SELECT p.settlement_id __key FROM parts p LEFT JOIN sides s ON s.id=p.settlement_id AND s.side=p.side LEFT JOIN items i ON i.id=p.invoice_item_id
      WHERE s.id IS NULL OR i.id IS NULL OR i.invoice_id<>s.document_id
      UNION ALL SELECT s.id FROM sides s LEFT JOIN items i ON i.invoice_id=s.document_id LEFT JOIN parts p ON p.settlement_id=s.id AND p.side=s.side AND p.invoice_item_id=i.id
      GROUP BY s.id,s.side HAVING COUNT(i.id)=0 OR COUNT(p.invoice_item_id)<>COUNT(i.id) LIMIT 1`,
  },
  {
    id: 'credit_settlements:line_bounds',
    sql: `${basis}, normalized AS (SELECT p.*,s.event_type,i.line_total_cents,i.line_vat_cents,
      CASE WHEN (CASE p.side WHEN 'credit' THEN -i.line_total_cents ELSE i.line_total_cents END)<0 THEN -1 ELSE 1 END
        * CASE WHEN s.reverses_id IS NULL THEN 1 ELSE -1 END sign
      FROM parts p JOIN settlements s ON s.id=p.settlement_id JOIN items i ON i.id=p.invoice_item_id)
      SELECT settlement_id __key FROM normalized WHERE gross_cents=-9223372036854775808 OR vat_cents=-9223372036854775808
        OR line_total_cents=-9223372036854775808 OR line_vat_cents=-9223372036854775808
        OR gross_cents*sign<0 OR vat_cents*sign<0 OR vat_cents*sign>gross_cents*sign
        OR gross_cents*sign>ABS(line_total_cents) OR vat_cents*sign>ABS(line_vat_cents) LIMIT 1`,
  },
  {
    id: 'credit_settlements:line_totals',
    sql: `${basis}, amounts AS (SELECT settlement_id id,side,gross_cents amount FROM parts
      UNION ALL SELECT s.id,'credit',-(${signed}) FROM settlements s
      UNION ALL SELECT s.id,'invoice',-(${signed}) FROM settlements s WHERE s.invoice_id IS NOT NULL)
      SELECT id __key FROM amounts GROUP BY id,side HAVING ${nonzeroSum('amount')} LIMIT 1`,
  },
  {
    id: 'credit_settlements:reversal_parts',
    sql: `${basis} SELECT p.settlement_id __key FROM parts p JOIN settlements s ON s.id=p.settlement_id AND s.reverses_id IS NOT NULL
      LEFT JOIN parts o ON o.settlement_id=s.reverses_id AND o.side=p.side AND o.invoice_item_id=p.invoice_item_id
      WHERE o.invoice_item_id IS NULL OR p.gross_cents<>-o.gross_cents OR p.vat_cents<>-o.vat_cents LIMIT 1`,
  },
  {
    id: 'credit_settlements:tax_sum',
    sql: `${basis} SELECT settlement_id __key FROM parts GROUP BY settlement_id,side HAVING ${boundedSignedSum('vat_cents')} IS NULL LIMIT 1`,
  },
  {
    id: 'credit_settlements:chronology',
    sql: `${history} SELECT p.id __key FROM prefixes p JOIN invoices i ON i.id=p.document_id
      WHERE ${outside('p.hi', 'p.lo', "(CASE p.side WHEN 'credit' THEN -i.total_cents ELSE i.total_cents END)")} LIMIT 1`,
  },
  {
    id: 'credit_settlements:posting_source',
    sql: `${journal} SELECT p.settlement_id __key FROM proofs p LEFT JOIN settlements s ON s.id=p.settlement_id LEFT JOIN entries e ON e.id=p.journal_entry_id
      WHERE s.id IS NULL OR e.id IS NULL OR e.source_type<>'customer_credit_settlement' OR e.source_id<>s.id OR e.source_event<>s.event_type
        OR e.entry_date<>s.date OR e.reversal_of IS NOT NULL OR EXISTS(SELECT 1 FROM entries r WHERE r.reversal_of=e.id)
      UNION ALL SELECT e.id FROM entries e LEFT JOIN proofs p ON p.journal_entry_id=e.id
        WHERE e.source_type='customer_credit_settlement' AND p.journal_entry_id IS NULL LIMIT 1`,
  },
  {
    id: 'credit_settlements:posting_required',
    sql: `${journal}, settings AS MATERIALIZED (${rows('accounting_settings', ['enabled'])}), periods AS MATERIALIZED (${rows('accounting_periods', ['status', 'date_to'])})
      SELECT s.id __key FROM settlements s LEFT JOIN proofs p ON p.settlement_id=s.id LEFT JOIN proofs o ON o.settlement_id=s.reverses_id
      WHERE (p.settlement_id IS NULL AND (o.settlement_id IS NOT NULL OR (EXISTS(SELECT 1 FROM settings WHERE enabled=1)
        AND NOT EXISTS(SELECT 1 FROM periods WHERE status='closed' AND s.date<=date_to))))
        OR (p.settlement_id IS NOT NULL AND s.reverses_id IS NOT NULL AND o.settlement_id IS NULL) LIMIT 1`,
  },
  {
    id: 'credit_settlements:proof_shape',
    sql: `WITH ${proofs} SELECT settlement_id __key FROM proofs p WHERE json_type(snapshot_json) IS NOT 'object'
      OR json_type(snapshot_json,'$.entry') IS NOT 'object' OR json_type(snapshot_json,'$.lines') IS NOT 'array'
      OR (SELECT COUNT(*) FROM json_each(p.snapshot_json))<>2
      OR EXISTS(SELECT 1 FROM json_each(p.snapshot_json,'$.lines') l WHERE l.type<>'object' OR json_type(l.value,'$.id') IS NOT 'text') LIMIT 1`,
  },
  {
    id: 'credit_settlements:proof_snapshot',
    sql: `${snapshots} SELECT proof_id __key FROM nodes GROUP BY proof_id,kind,piece,fullkey,type,atom HAVING SUM(sign)<>0 LIMIT 1`,
  },
  {
    id: 'credit_settlements:posting_lines',
    sql: `${journal},${historicalAccounts}, expected AS MATERIALIZED (
      SELECT id,journal_entry_id,${q(creditMemo)} memo,credit_ar account_id,'asset' account_type,signed_amount amount,credit_project project_id,client_id,currency FROM posting_basis
      UNION ALL SELECT id,journal_entry_id,CASE WHEN invoice_id IS NULL THEN ${q(refundMemo)} ELSE ${q(applyMemo)} END,counterpart_ar,'asset',-signed_amount,counterpart_project,client_id,currency FROM posting_basis),
      tax_expectations AS MATERIALIZED (
        SELECT id,journal_entry_id,${q(creditRelease)} memo,credit_deferred account_id,-credit_tax amount,credit_project project_id,client_id,currency FROM posting_basis WHERE credit_tax<>0
        UNION ALL SELECT id,journal_entry_id,${q(invoiceRelease)},invoice_deferred,invoice_tax,counterpart_project,client_id,currency FROM posting_basis WHERE invoice_tax<>0),
      expected_lines AS MATERIALIZED (SELECT * FROM expected
        UNION ALL SELECT id,journal_entry_id,memo,account_id,'liability',amount,project_id,client_id,currency FROM tax_expectations
        UNION ALL SELECT id,journal_entry_id,CASE memo WHEN ${q(creditRelease)} THEN ${q(creditDue)} ELSE ${q(invoiceDue)} END,NULL,'liability',-amount,project_id,client_id,currency FROM tax_expectations)
      SELECT x.id __key FROM expected_lines x WHERE (x.account_id IS NULL AND x.account_type='asset') OR
        (SELECT COUNT(*) FROM typed_lines l WHERE l.journal_entry_id=x.journal_entry_id AND l.memo=x.memo AND l.account_type=x.account_type
          AND (x.account_id IS NULL OR l.account_id=x.account_id) AND l.debit_cents=MAX(x.amount,0) AND l.credit_cents=MAX(-x.amount,0)
          AND l.currency=x.currency AND l.client_id IS x.client_id AND l.project_id IS x.project_id AND l.employee_id IS NULL)<>1
      UNION ALL SELECT b.id FROM posting_basis b WHERE (SELECT COUNT(*) FROM lines l WHERE l.journal_entry_id=b.journal_entry_id)<>2+2*(b.credit_tax<>0)+2*(b.invoice_tax<>0)
        OR (b.invoice_id IS NULL AND b.credit_ar=b.counterpart_ar)
        OR EXISTS(SELECT 1 FROM tax_expectations x JOIN lines l ON l.journal_entry_id=x.journal_entry_id
          AND l.memo=CASE x.memo WHEN ${q(creditRelease)} THEN ${q(creditDue)} ELSE ${q(invoiceDue)} END WHERE x.id=b.id AND l.account_id=x.account_id) LIMIT 1`,
  },
  {
    id: 'credit_settlements:reversal_posting',
    sql: `${journal}, compared AS (SELECT s.id,l.account_id,l.credit_cents debit,l.debit_cents credit,l.currency,l.memo,l.project_id,l.client_id,l.employee_id,1 sign
      FROM settlements s JOIN proofs p ON p.settlement_id=s.reverses_id JOIN lines l ON l.journal_entry_id=p.journal_entry_id
      UNION ALL SELECT s.id,l.account_id,l.debit_cents,l.credit_cents,l.currency,l.memo,l.project_id,l.client_id,l.employee_id,-1
      FROM settlements s JOIN proofs p ON p.settlement_id=s.id JOIN lines l ON l.journal_entry_id=p.journal_entry_id WHERE s.reverses_id IS NOT NULL)
      SELECT id __key FROM compared GROUP BY id,account_id,debit,credit,currency,memo,project_id,client_id,employee_id HAVING SUM(sign)<>0 LIMIT 1`,
  },
];

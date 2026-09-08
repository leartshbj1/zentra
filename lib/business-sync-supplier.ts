import type { AccountingRule } from './business-sync-accounting';
import { structuralRows as rows } from './business-sync-structure';
import { boundedPositiveSum, boundedSignedSum } from './business-sync-money';

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const safe = (value: string) =>
  `CASE WHEN json_valid(${value}) THEN ${value} ELSE 'null' END`;
const object = (alias: string) =>
  `CASE ${alias}.type WHEN 'object' THEN ${alias}.value ELSE '{}' END`;
const raw = (table: string) =>
  `SELECT row_json,json_extract(row_json,'$.id') id FROM business_sync_versions WHERE transfer_id=?1 AND organization_id=?2 AND table_name=${q(table)}`;
// These nullable columns were added without rewriting immutable snapshots.
// Normalize only missing/null values; an existing frozen value must still match.
const nullableField = (payload: string, field: string) =>
  `json_set(${payload},'$.${field}',json_extract(${payload},'$.${field}'))`;
const rate = (amount: string, bp: string) =>
  `(${amount}/10000*${bp}+(${amount}%10000*${bp}+5000)/10000)`;
// Decompose both operands before multiplying thousandths. Each term remains an
// integer; guard both the whole-unit product and final addition before SQLite
// could promote either to REAL. Invoice arithmetic accepts the full i64 range.
const tail = `(unit_price_cents/1000*(quantity_milli%1000)+(unit_price_cents%1000*(quantity_milli%1000)+500)/1000)`;
const base = `CASE WHEN unit_price_cents=0 THEN 0 WHEN quantity_milli/1000<=9223372036854775807/unit_price_cents
  THEN CASE WHEN quantity_milli/1000*unit_price_cents<=9223372036854775807-${tail}
    THEN quantity_milli/1000*unit_price_cents+${tail} END END`;
const accountRows = `accounts AS MATERIALIZED (${rows('accounts', ['id', 'account_type'])})`;
const entryRows = `entries AS MATERIALIZED (${rows('journal_entries', ['id', 'source_type', 'source_id', 'source_event', 'entry_date', 'status', 'reversal_of'])})`;
const lineRows = `lines AS MATERIALIZED (${rows('journal_lines', ['id', 'journal_entry_id', 'account_id', 'debit_cents', 'credit_cents', 'currency', 'memo', 'project_id', 'client_id', 'employee_id'])})`;

function documents(credit: boolean): AccountingRule[] {
  const table = credit ? 'supplier_credit_notes' : 'supplier_invoices';
  const itemTable = credit
    ? 'supplier_credit_note_items'
    : 'supplier_invoice_items';
  const parent = credit ? 'supplier_credit_note_id' : 'supplier_invoice_id';
  const kind = credit ? 'supplier_credit_note' : 'supplier_invoice';
  const headerFields = credit
    ? [
        'id',
        'supplier_id',
        'document_date',
        'supplier_name',
        'reference',
        'reference_normalized',
        'currency',
        'net_cents',
        'vat_cents',
        'total_cents',
        'note',
        'created_at',
      ]
    : [
        'id',
        'supplier_id',
        'supplier_name',
        'document_date',
        'due_date',
        'reference',
        'currency',
        'net_cents',
        'vat_cents',
        'total_cents',
        'project_id',
        'note',
      ];
  const header = (payload: string) =>
    `json_object(${headerFields.flatMap((f) => [q(f), `json_extract(${payload},'$.${f}')`]).join(',')})`;
  const context = `WITH raw_documents AS MATERIALIZED (${raw(table)}),raw_items AS MATERIALIZED (${raw(itemTable)}),
    documents AS MATERIALIZED (${rows(table, ['id', 'status', 'document_date', 'currency', 'net_cents', 'vat_cents', 'total_cents', 'snapshot_json', 'validation_journal_entry_id', ...(credit ? [] : ['project_id'])])}),
    stored_items AS MATERIALIZED (${rows(itemTable, ['id', parent, 'quantity_milli', 'unit_price_cents', 'discount_bp', 'vat_bp', 'line_net_cents', 'line_vat_cents', 'line_total_cents', 'description', 'posted_expense_account_id', 'project_id'])}),
    ${accountRows},${entryRows},${lineRows},
    items AS MATERIALIZED (SELECT i.*,COALESCE(i.posted_expense_account_id,
      (SELECT CASE WHEN COUNT(DISTINCT l.account_id)=1 THEN MIN(l.account_id) END
       FROM lines l JOIN accounts a ON a.id=l.account_id AND a.account_type='expense'
       JOIN documents d ON d.id=i.${parent} AND d.validation_journal_entry_id=l.journal_entry_id
       WHERE l.memo=i.description AND l.debit_cents=${credit ? '0' : 'i.line_net_cents'}
         AND l.credit_cents=${credit ? 'i.line_net_cents' : '0'})) effective_expense_account_id
      FROM stored_items i)`;
  const snapshots = `snapshots AS MATERIALIZED (SELECT d.id,${safe('d.snapshot_json')} payload FROM documents d WHERE d.status='validated'),
    saved_items AS MATERIALIZED (SELECT s.id document_id,json_extract(${object('i')},'$.id') id,${object('i')} payload,i.type FROM snapshots s,json_each(s.payload,'$.items') i)`;
  const itemProject = credit
    ? 'i.project_id'
    : 'COALESCE(i.project_id,d.project_id)';
  const docProject = credit ? 'NULL' : 'd.project_id';
  const payableMemo = credit
    ? 'Avoir sur dette fournisseur'
    : 'Dette fournisseur';
  const vatMemo = credit
    ? 'Correction TVA préalable fournisseur'
    : 'TVA préalable fournisseur';
  const frozenHeaderPath = credit ? 'credit_note' : 'document';
  const comparisons = `${snapshots},pieces AS MATERIALIZED (
    SELECT s.id document_id,'document' kind,s.id id,${header(`CASE WHEN json_type(s.payload,'$.${frozenHeaderPath}')='object' THEN json_extract(s.payload,'$.${frozenHeaderPath}') ELSE '{}' END`)} payload,1 sign FROM snapshots s
    UNION ALL SELECT s.id,'document',s.id,${header('d.row_json')},-1 FROM snapshots s JOIN raw_documents d ON d.id=s.id
    UNION ALL SELECT document_id,'item',id,${nullableField('payload', 'posted_expense_account_id')},1 FROM saved_items
    UNION ALL SELECT d.id,'item',i.id,${nullableField('i.row_json', 'posted_expense_account_id')},-1 FROM documents d JOIN raw_items i ON json_extract(i.row_json,'$.${parent}')=d.id WHERE d.status='validated'),
    nodes AS (SELECT document_id,kind,pieces.id,n.fullkey,n.type,n.atom,sign FROM pieces,json_tree(pieces.payload) n)`;
  const expected = `expected AS MATERIALIZED (
    SELECT d.id document_id,i.effective_expense_account_id account_id,${credit ? '0' : 'i.line_net_cents'} debit,${credit ? 'i.line_net_cents' : '0'} credit,d.currency,i.description memo,${itemProject} project_id,NULL client_id,NULL employee_id
    FROM documents d JOIN items i ON i.${parent}=d.id WHERE d.status='validated' AND i.line_net_cents>0
    UNION ALL SELECT d.id,l.account_id,${credit ? 'd.total_cents' : '0'},${credit ? '0' : 'd.total_cents'},d.currency,${q(payableMemo)},${docProject},NULL,NULL
    FROM documents d JOIN lines l ON l.journal_entry_id=d.validation_journal_entry_id AND l.memo=${q(payableMemo)} JOIN accounts a ON a.id=l.account_id AND a.account_type='liability' WHERE d.status='validated'
    UNION ALL SELECT d.id,l.account_id,${credit ? '0' : 'd.vat_cents'},${credit ? 'd.vat_cents' : '0'},d.currency,${q(vatMemo)},${docProject},NULL,NULL
    FROM documents d JOIN lines l ON l.journal_entry_id=d.validation_journal_entry_id AND l.memo=${q(vatMemo)} JOIN accounts a ON a.id=l.account_id AND a.account_type='asset' WHERE d.status='validated' AND d.vat_cents>0),
    compared AS MATERIALIZED (SELECT *,1 sign FROM expected UNION ALL SELECT d.id,l.account_id,l.debit_cents,l.credit_cents,l.currency,l.memo,l.project_id,l.client_id,l.employee_id,-1
    FROM documents d JOIN lines l ON l.journal_entry_id=d.validation_journal_entry_id WHERE d.status='validated')`;
  return [
    {
      id: `${itemTable}:exact_amounts`,
      sql: `${context},bases AS MATERIALIZED (SELECT *,${base} base FROM items)
      SELECT id __key FROM bases WHERE base IS NULL ${credit ? 'OR base>9000000000000000 OR line_total_cents>9000000000000000' : ''} OR line_net_cents IS NOT base-${rate('base', 'discount_bp')}
      OR line_vat_cents IS NOT ${rate('line_net_cents', 'vat_bp')} OR line_net_cents>9223372036854775807-line_vat_cents OR line_total_cents IS NOT line_net_cents+line_vat_cents LIMIT 1`,
    },
    {
      id: `${table}:item_totals`,
      sql: `${context},sums AS (SELECT ${parent} id,${boundedPositiveSum('line_net_cents')} net,${boundedPositiveSum('line_vat_cents')} vat,${boundedPositiveSum('line_total_cents')} total FROM items GROUP BY ${parent})
      SELECT d.id __key FROM documents d LEFT JOIN sums s ON s.id=d.id WHERE d.net_cents IS NOT COALESCE(s.net,CASE WHEN s.id IS NULL THEN 0 END)
      OR d.vat_cents IS NOT COALESCE(s.vat,CASE WHEN s.id IS NULL THEN 0 END) OR d.total_cents IS NOT COALESCE(s.total,CASE WHEN s.id IS NULL THEN 0 END)
      OR (d.status='validated' AND (s.id IS NULL OR d.total_cents<=0)) LIMIT 1`,
    },
    {
      id: `${table}:snapshot_shape`,
      sql: `${context},${snapshots} SELECT s.id __key FROM snapshots s WHERE json_type(s.payload) IS NOT 'object'
      OR json_extract(s.payload,'$.schema') IS NOT ${q(`elyko.${kind}_snapshot.v1`)} OR json_type(s.payload,'$.${frozenHeaderPath}') IS NOT 'object'
      OR json_type(s.payload,'$.items') IS NOT 'array' OR json_type(s.payload,'$.captured_at') IS NOT 'text'
      OR EXISTS(SELECT 1 FROM saved_items i WHERE i.document_id=s.id AND (i.type<>'object' OR typeof(i.id)<>'text'))
      OR (SELECT COUNT(*) FROM saved_items i WHERE i.document_id=s.id)<>(SELECT COUNT(DISTINCT i.id) FROM saved_items i WHERE i.document_id=s.id) LIMIT 1`,
    },
    {
      id: `${table}:snapshot_rows`,
      sql: `${context},${comparisons} SELECT document_id __key FROM nodes GROUP BY document_id,kind,id,fullkey,type,atom HAVING SUM(sign)<>0 LIMIT 1`,
    },
    {
      id: `${table}:source_journal`,
      sql: `${context} SELECT d.id __key FROM documents d LEFT JOIN entries e ON e.id=d.validation_journal_entry_id WHERE
      CASE WHEN d.status='validated' THEN e.id IS NULL OR e.source_type<>${q(kind)} OR e.source_id<>d.id OR e.source_event<>'validate' OR e.entry_date<>d.document_date
        OR e.status<>'posted' OR e.reversal_of IS NOT NULL OR EXISTS(SELECT 1 FROM entries r WHERE r.reversal_of=e.id)
        OR (SELECT COUNT(*) FROM entries j WHERE j.source_type=${q(kind)} AND j.source_id=d.id)<>1
      ELSE d.validation_journal_entry_id IS NOT NULL OR d.snapshot_json IS NOT NULL END
      UNION ALL SELECT e.id FROM entries e LEFT JOIN documents d ON d.id=e.source_id WHERE e.source_type=${q(kind)} AND (d.id IS NULL OR d.status<>'validated' OR d.validation_journal_entry_id IS NOT e.id) LIMIT 1`,
    },
    {
      id: `${table}:posted_accounts`,
      sql: `${context} SELECT d.id __key FROM documents d WHERE d.status='validated' AND (
      EXISTS(SELECT 1 FROM items i LEFT JOIN accounts a ON a.id=i.effective_expense_account_id WHERE i.${parent}=d.id AND i.line_net_cents>0 AND (a.id IS NULL OR a.account_type<>'expense'))
      OR (SELECT COUNT(*) FROM lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=d.validation_journal_entry_id AND l.memo=${q(payableMemo)} AND a.account_type='liability')<>1
      OR (d.vat_cents>0 AND (SELECT COUNT(*) FROM lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=d.validation_journal_entry_id AND l.memo=${q(vatMemo)} AND a.account_type='asset')<>1)) LIMIT 1`,
    },
    {
      id: `${table}:exact_posting`,
      sql: `${context},${expected} SELECT document_id __key FROM compared GROUP BY document_id,account_id,debit,credit,currency,memo,project_id,client_id,employee_id HAVING SUM(sign)<>0 LIMIT 1`,
    },
  ];
}

const settlementContext = `WITH invoices AS MATERIALIZED (${rows('supplier_invoices', ['id', 'supplier_id', 'currency', 'status', 'document_date', 'paid_cents', 'credited_cents', 'total_cents'])}),
 credits AS MATERIALIZED (${rows('supplier_credit_notes', ['id', 'supplier_id', 'currency', 'status', 'document_date', 'total_cents', 'validation_journal_entry_id'])}),
 allocations AS MATERIALIZED (${rows('supplier_credit_allocations', ['id', 'request_id', 'supplier_credit_note_id', 'supplier_invoice_id', 'event_type', 'amount_cents', 'effective_date', 'reverses_allocation_id', 'created_at', 'sequence'])}),
 refunds AS MATERIALIZED (${rows('supplier_credit_refunds', ['id', 'supplier_credit_note_id', 'event_type', 'reverses_id', 'date', 'amount_cents', 'bank_account_id', 'payable_account_id', 'journal_entry_id', 'reason', 'created_at', 'sequence'])}),
 payments AS MATERIALIZED (${rows('supplier_payments', ['id', 'supplier_invoice_id', 'date', 'amount_cents', 'created_at'])}),${accountRows},${entryRows},${lineRows}`;
const movements = `movements AS MATERIALIZED (
 SELECT 'credit' kind,a.supplier_credit_note_id document_id,a.id,a.effective_date date,a.created_at,a.sequence,CASE a.event_type WHEN 'apply' THEN a.amount_cents ELSE -a.amount_cents END amount FROM allocations a
 UNION ALL SELECT 'credit',r.supplier_credit_note_id,r.id,r.date,r.created_at,r.sequence,CASE r.event_type WHEN 'refund' THEN r.amount_cents ELSE -r.amount_cents END FROM refunds r
 UNION ALL SELECT 'invoice',a.supplier_invoice_id,a.id,a.effective_date,a.created_at,a.sequence,CASE a.event_type WHEN 'apply' THEN a.amount_cents ELSE -a.amount_cents END FROM allocations a JOIN credits c ON c.id=a.supplier_credit_note_id WHERE c.status='validated'
 UNION ALL SELECT 'invoice',p.supplier_invoice_id,p.id,p.date,p.created_at,0,p.amount_cents FROM payments p),
 documents AS MATERIALIZED (SELECT 'credit' kind,id,total_cents total FROM credits UNION ALL SELECT 'invoice',id,total_cents FROM invoices)`;
const frozenAllocations = `WITH raw_credits AS MATERIALIZED (${raw('supplier_credit_notes')}),
  raw_allocations AS MATERIALIZED (${raw('supplier_credit_allocations')}),
  snapshots AS MATERIALIZED (SELECT id,${safe("json_extract(row_json,'$.snapshot_json')")} payload FROM raw_credits WHERE json_extract(row_json,'$.status')='validated'),
  saved AS MATERIALIZED (SELECT s.id document_id,a.type,${object('a')} payload,json_extract(${object('a')},'$.id') id
    FROM snapshots s,json_each(s.payload,'$.allocations') a)`;
export const supplierRules: AccountingRule[] = [
  ...documents(false),
  ...documents(true),
  {
    id: 'supplier_credit_notes:allocation_snapshot_shape',
    sql: `${frozenAllocations} SELECT s.id __key FROM snapshots s WHERE json_type(s.payload,'$.allocations') IS NOT 'array'
      OR EXISTS(SELECT 1 FROM saved a WHERE a.document_id=s.id AND (a.type<>'object' OR typeof(a.id)<>'text'
        OR json_extract(a.payload,'$.request_id') IS NOT NULL OR json_extract(a.payload,'$.event_type') IS NOT 'apply'
        OR json_extract(a.payload,'$.supplier_credit_note_id') IS NOT s.id))
      OR (SELECT COUNT(*) FROM saved a WHERE a.document_id=s.id)<>(SELECT COUNT(DISTINCT a.id) FROM saved a WHERE a.document_id=s.id) LIMIT 1`,
  },
  {
    id: 'supplier_credit_notes:allocation_snapshot_rows',
    sql: `${frozenAllocations},pieces AS MATERIALIZED (
      SELECT document_id,id,${nullableField('payload', 'effective_date')} payload,1 sign FROM saved
      UNION ALL SELECT s.id,a.id,${nullableField('a.row_json', 'effective_date')},-1 FROM snapshots s JOIN raw_allocations a
        ON json_extract(a.row_json,'$.supplier_credit_note_id')=s.id WHERE json_extract(a.row_json,'$.request_id') IS NULL),
      nodes AS (SELECT document_id,pieces.id,n.fullkey,n.type,n.atom,sign FROM pieces,json_tree(pieces.payload) n)
      SELECT document_id __key FROM nodes GROUP BY document_id,id,fullkey,type,atom HAVING SUM(sign)<>0 LIMIT 1`,
  },
  {
    id: 'supplier_allocations:source',
    sql: `${settlementContext} SELECT a.id __key FROM allocations a LEFT JOIN credits c ON c.id=a.supplier_credit_note_id LEFT JOIN invoices i ON i.id=a.supplier_invoice_id
    WHERE c.id IS NULL OR i.id IS NULL OR i.status<>'validated' OR c.supplier_id<>i.supplier_id OR c.currency<>i.currency
    OR (c.status='draft' AND (a.event_type<>'apply' OR a.request_id IS NOT NULL OR a.reverses_allocation_id IS NOT NULL))
    OR (a.effective_date IS NOT NULL AND (a.effective_date<c.document_date OR a.effective_date<i.document_date))
    LIMIT 1`,
  },
  {
    id: 'supplier_allocations:reversal',
    sql: `${settlementContext} SELECT a.id __key FROM allocations a LEFT JOIN allocations o ON o.id=a.reverses_allocation_id WHERE a.event_type='reverse' AND
    (a.request_id IS NULL OR o.id IS NULL OR o.event_type<>'apply' OR o.supplier_credit_note_id<>a.supplier_credit_note_id OR o.supplier_invoice_id<>a.supplier_invoice_id OR o.amount_cents<>a.amount_cents
      OR a.sequence<=o.sequence OR (a.effective_date,a.created_at,a.sequence,a.id)<=(o.effective_date,o.created_at,o.sequence,o.id)) LIMIT 1`,
  },
  {
    id: 'supplier_invoices:credited',
    sql: `${settlementContext},sums AS (SELECT a.supplier_invoice_id id,${boundedSignedSum('a.amount')} amount FROM
    (SELECT a.supplier_invoice_id,CASE a.event_type WHEN 'apply' THEN a.amount_cents ELSE -a.amount_cents END amount FROM allocations a JOIN credits c ON c.id=a.supplier_credit_note_id WHERE c.status='validated') a GROUP BY a.supplier_invoice_id)
    SELECT i.id __key FROM invoices i LEFT JOIN sums s ON s.id=i.id WHERE i.credited_cents IS NOT COALESCE(s.amount,CASE WHEN s.id IS NULL THEN 0 END) LIMIT 1`,
  },
  {
    id: 'supplier_settlements:balance',
    sql: `${settlementContext},${movements},sums AS (SELECT kind,document_id,${boundedSignedSum('amount')} amount FROM movements GROUP BY kind,document_id)
    SELECT s.document_id __key FROM sums s JOIN documents d ON d.kind=s.kind AND d.id=s.document_id WHERE s.amount IS NULL OR s.amount<0 OR s.amount>d.total LIMIT 1`,
  },
  {
    id: 'supplier_settlements:chronology',
    sql: `${settlementContext},${movements},prefixes AS MATERIALIZED (SELECT *,
    SUM(amount/1000000000) OVER w hi,SUM(amount%1000000000) OVER w lo FROM movements m WHERE date IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM movements unknown WHERE unknown.kind=m.kind AND unknown.document_id=m.document_id AND unknown.date IS NULL)
    WINDOW w AS (PARTITION BY kind,document_id ORDER BY date,created_at,sequence,id ROWS UNBOUNDED PRECEDING)),normalized AS (
    SELECT *,hi+lo/1000000000-CASE WHEN lo%1000000000<0 THEN 1 ELSE 0 END h,(lo%1000000000+1000000000)%1000000000 r FROM prefixes)
    SELECT n.document_id __key FROM normalized n JOIN documents d ON d.kind=n.kind AND d.id=n.document_id
    WHERE h<0 OR h>d.total/1000000000 OR (h=d.total/1000000000 AND r>d.total%1000000000) LIMIT 1`,
  },
  {
    id: 'supplier_refunds:source',
    sql: `${settlementContext} SELECT r.id __key FROM refunds r LEFT JOIN credits c ON c.id=r.supplier_credit_note_id
    WHERE c.id IS NULL OR c.status<>'validated' OR c.currency<>'CHF' OR r.date<c.document_date
    OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=r.bank_account_id AND a.account_type='asset')
    OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=r.payable_account_id AND a.account_type='liability')
    OR NOT EXISTS(SELECT 1 FROM lines l WHERE l.journal_entry_id=c.validation_journal_entry_id AND l.account_id=r.payable_account_id AND l.debit_cents=c.total_cents AND l.credit_cents=0 AND l.memo='Avoir sur dette fournisseur') LIMIT 1`,
  },
  {
    id: 'supplier_refunds:reversal',
    sql: `${settlementContext} SELECT r.id __key FROM refunds r LEFT JOIN refunds o ON o.id=r.reverses_id WHERE r.event_type='reverse' AND
    (o.id IS NULL OR o.event_type<>'refund' OR o.supplier_credit_note_id<>r.supplier_credit_note_id OR o.amount_cents<>r.amount_cents OR o.bank_account_id<>r.bank_account_id
      OR o.payable_account_id<>r.payable_account_id OR r.sequence<=o.sequence OR (r.date,r.created_at,r.sequence,r.id)<=(o.date,o.created_at,o.sequence,o.id)) LIMIT 1`,
  },
  {
    id: 'supplier_refunds:journal',
    sql: `${settlementContext} SELECT r.id __key FROM refunds r LEFT JOIN entries e ON e.id=r.journal_entry_id
    WHERE e.id IS NULL OR e.status<>'posted' OR e.source_type<>'supplier_credit_refund' OR e.source_id<>r.id OR e.source_event<>r.event_type OR e.entry_date<>r.date
    OR e.reversal_of IS NOT NULL OR EXISTS(SELECT 1 FROM entries x WHERE x.reversal_of=e.id)
    OR (SELECT COUNT(*) FROM lines l WHERE l.journal_entry_id=e.id)<>2
    OR (SELECT COUNT(*) FROM lines l WHERE l.journal_entry_id=e.id AND l.currency='CHF' AND l.memo=r.reason AND l.project_id IS NULL AND l.client_id IS NULL AND l.employee_id IS NULL AND
      ((l.account_id=r.bank_account_id AND l.debit_cents=CASE r.event_type WHEN 'refund' THEN r.amount_cents ELSE 0 END AND l.credit_cents=CASE r.event_type WHEN 'reverse' THEN r.amount_cents ELSE 0 END)
      OR (l.account_id=r.payable_account_id AND l.debit_cents=CASE r.event_type WHEN 'reverse' THEN r.amount_cents ELSE 0 END AND l.credit_cents=CASE r.event_type WHEN 'refund' THEN r.amount_cents ELSE 0 END)))<>2
    UNION ALL SELECT e.id FROM entries e LEFT JOIN refunds r ON r.journal_entry_id=e.id AND r.id=e.source_id WHERE e.source_type='supplier_credit_refund' AND r.id IS NULL LIMIT 1`,
  },
];

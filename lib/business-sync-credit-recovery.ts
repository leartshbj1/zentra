import type { AccountingRule } from './business-sync-accounting';
import { structuralRows as rows } from './business-sync-structure';
import { boundedSignedSum } from './business-sync-money';

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const deferred = 'TVA à régulariser · contre-prestations reçues';
const release = 'Reclassement TVA à régulariser';
const due = 'TVA due sur encaissement';
const restore = 'Rétablissement TVA historique de l’avoir';
const pending = 'TVA de l’avoir en attente de règlement';
const safe = (field: string) =>
  `CASE WHEN json_valid(${field}) THEN ${field} ELSE 'null' END`;
const object = (alias: string) =>
  `CASE ${alias}.type WHEN 'object' THEN ${alias}.value ELSE '{}' END`;
const recoveries = `recovery_rows AS MATERIALIZED (${rows('customer_credit_recoveries', ['id', 'request_id', 'original_invoice_id', 'request_json', 'source_json', 'result_json', 'created_at'])}),
 recoveries AS MATERIALIZED (SELECT *,${safe('request_json')} request,${safe('source_json')} history FROM recovery_rows)`;
const proofs = `proof_rows AS MATERIALIZED (${rows('customer_credit_recovery_postings', ['id', 'recovery_id', 'original_invoice_id', 'source_type', 'source_id', 'date', 'source_json', 'parts_json', 'expected_vat_cents', 'due_change_cents', 'journal_entry_id', 'snapshot_json'])}),
 proofs AS MATERIALIZED (SELECT *,${safe('source_json')} source,${safe('parts_json')} parts,${safe('snapshot_json')} snapshot FROM proof_rows)`;
const models = `models AS MATERIALIZED (${rows('customer_credit_recovery_tax_models', ['original_invoice_id', 'recovery_id', 'model'])})`;
const invoices = `invoices AS MATERIALIZED (${rows('invoices', ['id', 'type', 'number', 'status', 'issue_date', 'currency', 'total_cents', 'vat_cents', 'original_invoice_id', 'client_id', 'project_id'])})`;
const payments = `payments AS MATERIALIZED (${rows('payments', ['id', 'invoice_id', 'date', 'amount_cents', 'created_at'])})`;
const entries = `entries AS MATERIALIZED (${rows('journal_entries', ['id', 'entry_date', 'source_type', 'source_id', 'source_event', 'status', 'reversal_of'])})`;
const lines = `lines AS MATERIALIZED (${rows('journal_lines', ['id', 'journal_entry_id', 'account_id', 'debit_cents', 'credit_cents', 'currency', 'memo', 'project_id', 'client_id', 'employee_id'])})`;
const accounts = `accounts AS MATERIALIZED (${rows('accounts', ['id', 'account_type'])})`;
const requested = `requested AS MATERIALIZED (SELECT r.id recovery_id,json_extract(${object('c')},'$.credit_note_id') id,
 json_extract(${object('c')},'$.applied_cents') applied,json_extract(${object('c')},'$.application_date') date,c.type kind
 FROM recoveries r,json_each(r.request,'$.credits') c)`;
const historicalPayments = `historical_payments AS MATERIALIZED (SELECT r.id recovery_id,json_extract(${object('p')},'$.id') id,${object('p')} payload,p.type kind
 FROM recoveries r,json_each(r.history,'$.payments') p)`;
const historicalRows = `historical_documents AS MATERIALIZED (SELECT r.id recovery_id,json_extract(${object('d')},'$.id') id,${object('d')} payload,d.type kind FROM recoveries r,json_each(r.history,'$.documents') d),
 historical_items AS MATERIALIZED (SELECT r.id recovery_id,json_extract(${object('d')},'$.id') id,${object('d')} payload,d.type kind FROM recoveries r,json_each(r.history,'$.items') d),
 invoice_items AS MATERIALIZED (${rows('invoice_items', ['id', 'invoice_id'])})`;
const base = `${recoveries},${proofs},${models},${invoices},${payments},${entries},${lines},${accounts},${requested},${historicalPayments}`;
const context = `WITH ${base}`;
const origins = `origin_accounts AS MATERIALIZED (SELECT i.id,
 MAX(CASE l.memo WHEN ${q(deferred)} THEN l.account_id END) deferred,
 MAX(CASE l.memo WHEN 'Créance client' THEN l.account_id END) receivable,
 SUM(l.memo=${q(deferred)}) deferred_count,SUM(l.memo='Créance client') receivable_count
 FROM invoices i JOIN entries e ON e.source_type='invoice' AND e.source_id=i.id AND e.source_event='issue'
 JOIN lines l ON l.journal_entry_id=e.id GROUP BY i.id)`;
const sourceJournals = `source_journals AS MATERIALIZED (SELECT p.id proof_id,e.* FROM proofs p JOIN entries e ON e.source_id=p.source_id
 WHERE (p.source_type='credit' AND e.source_type='invoice') OR (p.source_type='payment' AND e.source_type IN ('payment','vat_cash_reclassification')))`;

// Compare immutable JSON fragments by field and stable journal/line identity.
// Native rowid and array order are not portable. Integer atoms stay inside SQL.
const snapshots = `source_snapshots AS MATERIALIZED (SELECT 'source' kind,p.id proof_id,${object('s')} payload,s.type FROM proofs p,json_each(p.source,'$.journals') s),
 history_snapshots AS MATERIALIZED (SELECT 'history' kind,r.id proof_id,${object('s')} payload,s.type FROM recoveries r JOIN models m ON m.recovery_id=r.id,json_each(r.history,'$.journals') s),
 snapshots AS MATERIALIZED (
 SELECT * FROM source_snapshots UNION ALL SELECT * FROM history_snapshots
 UNION ALL SELECT 'correction',p.id,p.snapshot,json_type(p.snapshot) FROM proofs p WHERE p.journal_entry_id IS NOT NULL)`;
const raw = (table: string) =>
  `SELECT row_json,json_extract(row_json,'$.id') id FROM business_sync_versions WHERE transfer_id=?1 AND organization_id=?2 AND table_name='${table}'`;
const snapshotComparison = `${snapshots},raw_entries AS MATERIALIZED (${raw('journal_entries')}),raw_lines AS MATERIALIZED (${raw('journal_lines')}),
 pieces AS MATERIALIZED (
 SELECT s.kind,s.proof_id,json_extract(s.payload,'$.entry.id') jid,'entry' part,'' item,1 sign,CASE WHEN json_type(s.payload,'$.entry')='object' THEN json_extract(s.payload,'$.entry') ELSE '{}' END payload FROM snapshots s
 UNION ALL SELECT s.kind,s.proof_id,e.id,'entry','',-1,e.row_json FROM snapshots s JOIN raw_entries e ON e.id=json_extract(s.payload,'$.entry.id')
 UNION ALL SELECT s.kind,s.proof_id,json_extract(s.payload,'$.entry.id'),'line',json_extract(${object('l')},'$.id'),1,${object('l')} FROM snapshots s,json_each(s.payload,'$.lines') l
 UNION ALL SELECT s.kind,s.proof_id,json_extract(s.payload,'$.entry.id'),'line',l.id,-1,l.row_json FROM snapshots s JOIN raw_lines l ON json_extract(l.row_json,'$.journal_entry_id')=json_extract(s.payload,'$.entry.id')),
 nodes AS (SELECT kind,proof_id,jid,part,item,n.fullkey,n.type,n.atom,sign FROM pieces,json_tree(pieces.payload) n)`;
const creditFields = [
  'id',
  'number',
  'issue_date',
  'total_cents',
  'vat_cents',
  'currency',
  'client_id',
  'project_id',
  'original_invoice_id',
];
const sourceRows = `raw_invoices AS MATERIALIZED (${raw('invoices')}),raw_payments AS MATERIALIZED (${raw('payments')}),
 row_pairs AS MATERIALIZED (
 SELECT p.id proof_id,CASE WHEN json_type(p.source,'$.row')='object' THEN json_extract(p.source,'$.row') ELSE '{}' END payload,1 sign FROM proofs p
 UNION ALL SELECT p.id,json_object(${creditFields.flatMap((f) => [q(f), `json_extract(i.row_json,'$.${f}')`]).join(',')}),-1 FROM proofs p JOIN raw_invoices i ON i.id=p.source_id WHERE p.source_type='credit'
 UNION ALL SELECT p.id,i.row_json,-1 FROM proofs p JOIN raw_payments i ON i.id=p.source_id WHERE p.source_type='payment'),
 row_nodes AS (SELECT proof_id,n.fullkey,n.type,n.atom,sign FROM row_pairs,json_tree(row_pairs.payload) n)`;
const header = (payload: string) =>
  `json_object(${creditFields.flatMap((f) => [q(f), `json_extract(${payload},'$.${f}')`]).join(',')})`;
const historyComparison = `${historicalRows}, raw_invoices AS MATERIALIZED (${raw('invoices')}),raw_payments AS MATERIALIZED (${raw('payments')}),raw_items AS MATERIALIZED (${raw('invoice_items')}),
 saved_rows AS MATERIALIZED (SELECT d.recovery_id,'document' kind,d.id,${header('d.payload')} payload,1 sign FROM historical_documents d
 UNION ALL SELECT p.recovery_id,'payment',p.id,p.payload,1 FROM historical_payments p
 UNION ALL SELECT i.recovery_id,'item',i.id,i.payload,1 FROM historical_items i),
 current_rows AS MATERIALIZED (SELECT d.recovery_id,'document' kind,d.id,${header('i.row_json')} payload,-1 sign FROM historical_documents d JOIN raw_invoices i ON i.id=d.id
 UNION ALL SELECT h.recovery_id,'payment',h.id,p.row_json,-1 FROM historical_payments h JOIN raw_payments p ON p.id=h.id
 UNION ALL SELECT h.recovery_id,'item',h.id,i.row_json,-1 FROM historical_items h JOIN raw_items i ON i.id=h.id),
 row_pieces AS MATERIALIZED (SELECT * FROM saved_rows UNION ALL SELECT * FROM current_rows),
 history_nodes AS (SELECT recovery_id,kind,row_pieces.id,n.fullkey,n.type,n.atom,sign FROM row_pieces,json_tree(row_pieces.payload) n)`;

// Original entries were balanced and capped by the preceding journal rules.
// A payment has at most one old VAT release; subtraction cannot exceed i64.
const paymentFacts = `${origins},${sourceJournals},payment_facts AS MATERIALIZED (SELECT p.id,p.original_invoice_id,p.source_id,p.expected_vat_cents,
 o.deferred,o.receivable,o.deferred_count,o.receivable_count,
 (SELECT COUNT(*) FROM source_journals j WHERE j.proof_id=p.id AND j.source_type='payment') bank_count,
 (SELECT COUNT(*) FROM source_journals j WHERE j.proof_id=p.id AND j.source_type='vat_cash_reclassification') vat_count,
 COALESCE((SELECT l.debit_cents FROM source_journals j JOIN lines l ON l.journal_entry_id=j.id WHERE j.proof_id=p.id AND j.source_type='vat_cash_reclassification' AND l.memo=${q(release)}),0) old_vat,
 COALESCE((SELECT l.account_id FROM source_journals j JOIN lines l ON l.journal_entry_id=j.id WHERE j.proof_id=p.id AND j.source_type='vat_cash_reclassification' AND l.memo=${q(due)}),json_extract(p.source,'$.fallback_due_account')) due_account
 FROM proofs p LEFT JOIN origin_accounts o ON o.id=p.original_invoice_id WHERE p.source_type='payment')`;
const creditFacts = `${origins},${sourceJournals},credit_facts AS MATERIALIZED (SELECT p.id,p.source_id,p.original_invoice_id,p.expected_vat_cents,
 o.deferred,o.deferred_count,-i.vat_cents vat,
 (SELECT COUNT(*) FROM source_journals j WHERE j.proof_id=p.id) journal_count,
 (SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ${boundedSignedSum('l.debit_cents')} END FROM source_journals j JOIN lines l ON l.journal_entry_id=j.id WHERE j.proof_id=p.id AND l.memo IN ('Extourne TVA à régulariser','Extourne TVA due encaissée')) old_vat,
 (SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ${boundedSignedSum('l.debit_cents')} END FROM source_journals j JOIN lines l ON l.journal_entry_id=j.id WHERE j.proof_id=p.id AND l.memo='Extourne TVA due encaissée') old_due
 FROM proofs p JOIN invoices i ON i.id=p.source_id LEFT JOIN origin_accounts o ON o.id=p.original_invoice_id WHERE p.source_type='credit')`;
const corrections = `${paymentFacts},
 payment_corrections AS MATERIALIZED (SELECT f.id proof_id,f.deferred account_id,f.expected_vat_cents-f.old_vat amount,i.currency,${q(release)} memo,i.project_id,i.client_id,NULL employee_id
 FROM payment_facts f JOIN invoices i ON i.id=f.original_invoice_id WHERE f.expected_vat_cents<>f.old_vat
 UNION ALL SELECT f.id,f.due_account,f.old_vat-f.expected_vat_cents,i.currency,${q(due)},i.project_id,i.client_id,NULL
 FROM payment_facts f JOIN invoices i ON i.id=f.original_invoice_id WHERE f.expected_vat_cents<>f.old_vat),
 credit_corrections AS MATERIALIZED (SELECT p.id proof_id,l.account_id,-l.debit_cents amount,i.currency,${q(restore)} memo,i.project_id,i.client_id,NULL employee_id
 FROM proofs p JOIN invoices i ON i.id=p.source_id JOIN source_journals j ON j.proof_id=p.id JOIN lines l ON l.journal_entry_id=j.id
 WHERE p.source_type='credit' AND l.memo IN ('Extourne TVA à régulariser','Extourne TVA due encaissée')
 UNION ALL SELECT p.id,o.deferred,-i.vat_cents,i.currency,${q(pending)},i.project_id,i.client_id,NULL
 FROM proofs p JOIN invoices i ON i.id=p.source_id JOIN origin_accounts o ON o.id=p.original_invoice_id WHERE p.source_type='credit' AND i.vat_cents<>0),
 corrections AS MATERIALIZED (SELECT * FROM payment_corrections UNION ALL SELECT * FROM credit_corrections)`;

export const creditRecoveryRules: AccountingRule[] = [
  {
    id: 'credit_recovery:model',
    sql: `${context},${origins} SELECT m.original_invoice_id __key FROM models m LEFT JOIN recoveries r ON r.id=m.recovery_id LEFT JOIN invoices i ON i.id=m.original_invoice_id LEFT JOIN origin_accounts o ON o.id=i.id
      WHERE r.id IS NULL OR r.original_invoice_id IS NOT m.original_invoice_id OR m.model<>'received_v1' OR i.id IS NULL OR i.type='avoir' OR i.number IS NULL OR i.vat_cents<=0 OR o.deferred_count IS NOT 1
      UNION ALL SELECT p.id FROM proofs p LEFT JOIN models m ON m.original_invoice_id=p.original_invoice_id AND m.recovery_id=p.recovery_id WHERE m.recovery_id IS NULL LIMIT 1`,
  },
  {
    id: 'credit_recovery:request',
    sql: `${context} SELECT r.id __key FROM recoveries r JOIN models m ON m.recovery_id=r.id WHERE json_type(r.request) IS NOT 'object'
      OR json_extract(r.request,'$.request_id') IS NOT r.request_id OR json_extract(r.request,'$.original_invoice_id') IS NOT r.original_invoice_id
      OR json_type(r.request,'$.confirm_vat_reconciliation') IS NOT 'true' OR json_type(r.request,'$.no_prior_refund') IS NOT 'true'
      OR json_type(r.request,'$.source_token') IS NOT 'text' OR length(json_extract(r.request,'$.source_token'))<>64
      OR json_type(r.request,'$.credits') IS NOT 'array' OR json_array_length(r.request,'$.credits') NOT BETWEEN 1 AND 500
      OR (SELECT COUNT(*) FROM requested c WHERE c.recovery_id=r.id)<>(SELECT COUNT(DISTINCT c.id) FROM requested c WHERE c.recovery_id=r.id)
      OR EXISTS(SELECT 1 FROM requested c LEFT JOIN invoices i ON i.id=c.id WHERE c.recovery_id=r.id AND
        (c.kind<>'object' OR i.id IS NULL OR i.type<>'avoir' OR i.original_invoice_id IS NOT r.original_invoice_id OR typeof(c.applied)<>'integer' OR c.applied<0 OR c.applied>-i.total_cents
          OR (c.applied=0 AND c.date IS NOT NULL) OR (c.applied>0 AND (typeof(c.date)<>'text' OR c.date<i.issue_date)))) LIMIT 1`,
  },
  {
    id: 'credit_recovery:history',
    sql: `${context} SELECT r.id __key FROM recoveries r JOIN models m ON m.recovery_id=r.id WHERE json_type(r.history) IS NOT 'object'
      OR json_type(r.history,'$.journals') IS NOT 'array' OR json_type(r.history,'$.payments') IS NOT 'array'
      OR json_type(r.history,'$.documents') IS NOT 'array' OR json_type(r.history,'$.items') IS NOT 'array'
      OR json_type(r.history,'$.settlements') IS NOT 'array' OR json_array_length(r.history,'$.settlements')<>0
      OR (SELECT COUNT(*) FROM historical_payments h WHERE h.recovery_id=r.id)<>(SELECT COUNT(DISTINCT h.id) FROM historical_payments h WHERE h.recovery_id=r.id)
      OR EXISTS(SELECT 1 FROM historical_payments h LEFT JOIN payments p ON p.id=h.id WHERE h.recovery_id=r.id AND (h.kind<>'object' OR p.id IS NULL OR p.invoice_id IS NOT r.original_invoice_id))
      OR (SELECT COUNT(*) FROM proofs p WHERE p.recovery_id=r.id)<>json_array_length(r.request,'$.credits')+json_array_length(r.history,'$.payments') LIMIT 1`,
  },
  {
    id: 'credit_recovery:history_links',
    sql: `${context},${historicalRows} SELECT r.id __key FROM recoveries r JOIN models m ON m.recovery_id=r.id WHERE
      (SELECT COUNT(*) FROM historical_documents d WHERE d.recovery_id=r.id AND d.id=r.original_invoice_id)<>1
      OR (SELECT COUNT(*) FROM historical_documents d WHERE d.recovery_id=r.id)<>(SELECT COUNT(DISTINCT d.id) FROM historical_documents d WHERE d.recovery_id=r.id)
      OR EXISTS(SELECT 1 FROM historical_documents d LEFT JOIN invoices i ON i.id=d.id WHERE d.recovery_id=r.id AND (d.kind<>'object' OR i.id IS NULL OR (i.id<>r.original_invoice_id AND (i.type<>'avoir' OR i.original_invoice_id IS NOT r.original_invoice_id))))
      OR EXISTS(SELECT 1 FROM requested c WHERE c.recovery_id=r.id AND NOT EXISTS(SELECT 1 FROM historical_documents d WHERE d.recovery_id=r.id AND d.id=c.id))
      OR EXISTS(SELECT 1 FROM historical_items h LEFT JOIN invoice_items i ON i.id=h.id WHERE h.recovery_id=r.id AND (h.kind<>'object' OR i.id IS NULL OR NOT EXISTS(SELECT 1 FROM historical_documents d WHERE d.recovery_id=r.id AND d.id=i.invoice_id)))
      OR (SELECT COUNT(*) FROM historical_items h WHERE h.recovery_id=r.id)<>(SELECT COUNT(DISTINCT h.id) FROM historical_items h WHERE h.recovery_id=r.id)
      OR (SELECT COUNT(*) FROM historical_items h WHERE h.recovery_id=r.id)<>(SELECT COUNT(*) FROM invoice_items i JOIN historical_documents d ON d.id=i.invoice_id WHERE d.recovery_id=r.id)
      OR json_array_length(r.history,'$.journals')<>(SELECT COUNT(*) FROM entries e WHERE
        (e.source_type='invoice' AND EXISTS(SELECT 1 FROM historical_documents d WHERE d.recovery_id=r.id AND d.id=e.source_id))
        OR (e.source_type IN ('payment','vat_cash_reclassification') AND EXISTS(SELECT 1 FROM historical_payments p WHERE p.recovery_id=r.id AND p.id=e.source_id))) LIMIT 1`,
  },
  {
    id: 'credit_recovery:history_rows',
    sql: `${context},${historyComparison} SELECT recovery_id __key FROM history_nodes GROUP BY recovery_id,kind,id,fullkey,type,atom HAVING SUM(sign)<>0 LIMIT 1`,
  },
  {
    id: 'credit_recovery:source',
    sql: `${context},${sourceJournals} SELECT p.id __key FROM proofs p LEFT JOIN invoices c ON c.id=p.source_id LEFT JOIN payments pay ON pay.id=p.source_id
      WHERE json_type(p.source) IS NOT 'object' OR json_type(p.source,'$.row') IS NOT 'object' OR json_type(p.source,'$.journals') IS NOT 'array'
      OR (SELECT COUNT(*) FROM json_each(p.source))<>CASE p.source_type WHEN 'payment' THEN 3 ELSE 2 END
      OR (p.source_type='payment' AND json_type(p.source,'$.fallback_due_account') IS NULL)
      OR json_type(p.parts) IS NOT 'array' OR p.expected_vat_cents<0
      OR CASE p.source_type WHEN 'credit' THEN c.id IS NULL OR c.original_invoice_id IS NOT p.original_invoice_id OR p.date IS NOT c.issue_date OR json_array_length(p.parts)<>0
          OR NOT EXISTS(SELECT 1 FROM requested r WHERE r.recovery_id=p.recovery_id AND r.id=p.source_id)
        WHEN 'payment' THEN pay.id IS NULL OR pay.invoice_id IS NOT p.original_invoice_id OR p.date IS NOT pay.date
          OR NOT EXISTS(SELECT 1 FROM historical_payments h WHERE h.recovery_id=p.recovery_id AND h.id=p.source_id)
        ELSE 1 END
      OR json_array_length(p.source,'$.journals')<>(SELECT COUNT(*) FROM source_journals j WHERE j.proof_id=p.id)
      OR EXISTS(SELECT 1 FROM source_journals j WHERE j.proof_id=p.id AND (j.status<>'posted' OR j.reversal_of IS NOT NULL OR EXISTS(SELECT 1 FROM entries reverse WHERE reverse.reversal_of=j.id))) LIMIT 1`,
  },
  {
    id: 'credit_recovery:source_row',
    sql: `${context},${sourceRows} SELECT proof_id __key FROM row_nodes GROUP BY proof_id,fullkey,type,atom HAVING SUM(sign)<>0 LIMIT 1`,
  },
  {
    id: 'credit_recovery:snapshot_shape',
    sql: `${context},${snapshots} SELECT proof_id __key FROM snapshots s WHERE s.type IS NOT 'object' OR json_type(s.payload,'$.entry') IS NOT 'object' OR json_type(s.payload,'$.entry.id') IS NOT 'text'
      OR (SELECT COUNT(*) FROM json_each(s.payload))<>2
      OR json_type(s.payload,'$.lines') IS NOT 'array'
      OR EXISTS(SELECT 1 FROM json_each(s.payload,'$.lines') l WHERE l.type<>'object' OR json_type(${object('l')},'$.id') IS NOT 'text')
      OR json_array_length(s.payload,'$.lines')<>(SELECT COUNT(DISTINCT json_extract(${object('l')},'$.id')) FROM json_each(s.payload,'$.lines') l)
      UNION ALL SELECT proof_id FROM snapshots GROUP BY kind,proof_id,json_extract(payload,'$.entry.id') HAVING COUNT(*)<>1 LIMIT 1`,
  },
  {
    id: 'credit_recovery:snapshot_links',
    sql: `${context},${sourceJournals},${historicalRows},${snapshots} SELECT s.proof_id __key FROM snapshots s LEFT JOIN entries e ON e.id=json_extract(s.payload,'$.entry.id')
      WHERE e.id IS NULL OR e.status<>'posted' OR e.reversal_of IS NOT NULL OR EXISTS(SELECT 1 FROM entries reverse WHERE reverse.reversal_of=e.id)
      OR (s.kind='source' AND NOT EXISTS(SELECT 1 FROM source_journals j WHERE j.proof_id=s.proof_id AND j.id=e.id))
      OR (s.kind='correction' AND NOT EXISTS(SELECT 1 FROM proofs p WHERE p.id=s.proof_id AND p.journal_entry_id=e.id))
      OR (s.kind='history' AND NOT EXISTS(SELECT 1 FROM recoveries r WHERE r.id=s.proof_id AND
        ((e.source_type='invoice' AND EXISTS(SELECT 1 FROM historical_documents d WHERE d.recovery_id=r.id AND d.id=e.source_id))
          OR (e.source_type IN ('payment','vat_cash_reclassification') AND EXISTS(SELECT 1 FROM historical_payments h WHERE h.recovery_id=r.id AND h.id=e.source_id))))) LIMIT 1`,
  },
  {
    id: 'credit_recovery:snapshot',
    sql: `${context},${snapshotComparison} SELECT proof_id __key FROM nodes GROUP BY kind,proof_id,jid,part,item,fullkey,type,atom HAVING SUM(sign)<>0 LIMIT 1`,
  },
  {
    id: 'credit_recovery:payment_basis',
    sql: `${context},${paymentFacts} SELECT f.id __key FROM payment_facts f JOIN proofs p ON p.id=f.id JOIN payments pay ON pay.id=f.source_id JOIN invoices i ON i.id=f.original_invoice_id
      WHERE f.bank_count<>1 OR f.vat_count>1 OR f.deferred_count IS NOT 1 OR f.receivable_count IS NOT 1
      OR EXISTS(SELECT 1 FROM source_journals j WHERE j.proof_id=f.id AND (j.entry_date<>pay.date OR j.source_event IS NOT 'invoice:'||i.id
        OR (SELECT COUNT(*) FROM lines l WHERE l.journal_entry_id=j.id)<>2
        OR CASE j.source_type WHEN 'payment' THEN
          (SELECT COUNT(*) FROM lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=j.id AND l.currency=i.currency AND
            ((l.memo='Encaissement' AND l.debit_cents=pay.amount_cents AND l.credit_cents=0 AND a.account_type='asset' AND l.account_id<>f.receivable)
             OR (l.memo='Règlement créance' AND l.debit_cents=0 AND l.credit_cents=pay.amount_cents AND l.account_id=f.receivable)))<>2
        ELSE f.old_vat<=0 OR (SELECT COUNT(*) FROM lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=j.id AND l.currency=i.currency AND
          ((l.memo=${q(release)} AND l.debit_cents=f.old_vat AND l.credit_cents=0 AND l.account_id=f.deferred)
           OR (l.memo=${q(due)} AND l.debit_cents=0 AND l.credit_cents=f.old_vat AND l.account_id<>f.deferred AND a.account_type='liability')))<>2 END))
      OR p.due_change_cents IS NOT f.expected_vat_cents-f.old_vat
      OR (f.expected_vat_cents<>f.old_vat AND (f.due_account IS NULL OR f.due_account=f.deferred OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=f.due_account AND a.account_type='liability'))) LIMIT 1`,
  },
  {
    id: 'credit_recovery:credit_basis',
    sql: `${context},${creditFacts} SELECT f.id __key FROM credit_facts f JOIN proofs p ON p.id=f.id WHERE f.journal_count<>1 OR f.deferred_count IS NOT 1
      OR f.expected_vat_cents<>f.vat OR f.old_vat IS NOT f.vat OR p.due_change_cents IS NOT f.old_due
      OR EXISTS(SELECT 1 FROM source_journals j JOIN lines l ON l.journal_entry_id=j.id WHERE j.proof_id=f.id AND l.memo IN ('Extourne TVA à régulariser','Extourne TVA due encaissée')
        AND (l.debit_cents<=0 OR l.credit_cents<>0 OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=l.account_id AND a.account_type='liability')
          OR (l.memo='Extourne TVA à régulariser' AND l.account_id<>f.deferred) OR (l.memo='Extourne TVA due encaissée' AND l.account_id=f.deferred))) LIMIT 1`,
  },
  {
    id: 'credit_recovery:correction',
    sql: `${context},${corrections} SELECT p.id __key FROM proofs p LEFT JOIN entries e ON e.id=p.journal_entry_id WHERE
      CASE WHEN p.journal_entry_id IS NULL THEN p.snapshot_json<>'null' OR EXISTS(SELECT 1 FROM corrections c WHERE c.proof_id=p.id)
      ELSE e.id IS NULL OR e.source_type<>'customer_credit_recovery' OR e.source_id<>p.id OR e.source_event<>p.source_type OR e.entry_date<>p.date
        OR e.status<>'posted' OR e.reversal_of IS NOT NULL OR NOT EXISTS(SELECT 1 FROM corrections c WHERE c.proof_id=p.id) END
      UNION ALL SELECT e.id FROM entries e WHERE e.source_type='customer_credit_recovery' AND NOT EXISTS(SELECT 1 FROM proofs p WHERE p.id=e.source_id AND p.journal_entry_id=e.id) LIMIT 1`,
  },
  {
    id: 'credit_recovery:correction_lines',
    sql: `${context},${corrections},compared AS MATERIALIZED (
      SELECT proof_id,account_id,MAX(amount,0) debit,MAX(-amount,0) credit,currency,memo,project_id,client_id,employee_id,1 sign FROM corrections
      UNION ALL SELECT p.id,l.account_id,l.debit_cents,l.credit_cents,l.currency,l.memo,l.project_id,l.client_id,l.employee_id,-1 FROM proofs p JOIN lines l ON l.journal_entry_id=p.journal_entry_id)
      SELECT proof_id __key FROM compared GROUP BY proof_id,account_id,debit,credit,currency,memo,project_id,client_id,employee_id HAVING SUM(sign)<>0 LIMIT 1`,
  },
];

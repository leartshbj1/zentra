import type { AccountingRule } from './business-sync-accounting';
import { postingContextSql } from './business-sync-postings';
import { structuralRows as rows } from './business-sync-structure';
import {
  boundedPositiveSum,
  roundedProportionCtes,
} from './business-sync-money';

const deferred = "'TVA à régulariser · contre-prestations reçues'";
const release = "'Reclassement TVA à régulariser'";
const due = "'TVA due sur encaissement'";
const creditDeferred = "'Extourne TVA à régulariser'";
const creditDue = "'Extourne TVA due encaissée'";
const context = `${postingContextSql},
 invoices AS MATERIALIZED (${rows('invoices', ['id', 'type', 'status', 'number', 'total_cents', 'vat_cents', 'currency', 'original_invoice_id'])}),
 payments AS MATERIALIZED (${rows('payments', ['id', 'invoice_id', 'date', 'created_at', 'amount_cents'])}),
 settlements AS MATERIALIZED (${rows('customer_credit_settlements', ['invoice_id'])}),
 models AS MATERIALIZED (${rows('customer_credit_recovery_tax_models', ['original_invoice_id'])}),
 documents AS MATERIALIZED (${rows('customer_credit_documents', ['credit_note_id'])}),
 originals AS MATERIALIZED (SELECT i.*,e.id entry_id,l.account_id deferred_account
   FROM invoices i JOIN effective e ON e.source_type='invoice' AND e.source_id=i.id AND e.source_event='issue'
   LEFT JOIN lines l ON l.journal_entry_id=e.id AND l.memo=${deferred}
   WHERE i.type<>'avoir'),
 legacy AS MATERIALIZED (SELECT * FROM originals i WHERE i.deferred_account IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM settlements s WHERE s.invoice_id=i.id)
   AND NOT EXISTS(SELECT 1 FROM models m WHERE m.original_invoice_id=i.id))`;

// These four UNION terms stay within workerd's compound SELECT limit. Keep
// missing categories distinguishable from an existing, overflowing aggregate.
const movements = `movements AS MATERIALIZED (
 SELECT p.invoice_id id,'paid' kind,p.amount_cents amount FROM payments p JOIN legacy i ON i.id=p.invoice_id
 UNION ALL SELECT c.original_invoice_id,'credited',-c.total_cents FROM invoices c JOIN legacy i ON i.id=c.original_invoice_id
   WHERE c.type='avoir' AND c.number IS NOT NULL AND c.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.credit_note_id=c.id)
 UNION ALL SELECT p.invoice_id,CASE l.memo WHEN ${release} THEN 'released' ELSE 'due' END,
   CASE l.memo WHEN ${release} THEN l.debit_cents ELSE l.credit_cents END
   FROM effective e JOIN payments p ON e.source_type='vat_cash_reclassification' AND e.source_id=p.id
   JOIN legacy i ON i.id=p.invoice_id JOIN lines l ON l.journal_entry_id=e.id WHERE l.memo IN (${release},${due})
 UNION ALL SELECT c.original_invoice_id,CASE l.memo WHEN ${creditDeferred} THEN 'credit_deferred' ELSE 'credit_due' END,l.debit_cents
   FROM invoices c JOIN legacy i ON i.id=c.original_invoice_id JOIN effective e ON e.source_type='invoice' AND e.source_id=c.id AND e.source_event='issue'
   JOIN lines l ON l.journal_entry_id=e.id WHERE c.type='avoir' AND c.number IS NOT NULL AND c.status<>'annulee' AND l.memo IN (${creditDeferred},${creditDue})),
 vat_sums AS MATERIALIZED (SELECT id,kind,${boundedPositiveSum('amount')} amount FROM movements GROUP BY id,kind),
 vat_state AS MATERIALIZED (SELECT i.*,
   COALESCE(MIN(CASE WHEN s.id IS NULL THEN 1 ELSE s.amount IS NOT NULL END),1) valid,
   ${['paid', 'credited', 'released', 'due', 'credit_deferred', 'credit_due'].map((k) => `COALESCE(MAX(CASE WHEN s.kind='${k}' THEN s.amount END),0) ${k}`).join(',')}
   FROM legacy i LEFT JOIN vat_sums s ON s.id=i.id GROUP BY i.id)`;

export const cashVatRules: AccountingRule[] = [
  {
    id: 'vat_cash:source',
    sql: `${context} SELECT e.id AS __key FROM entries e
      LEFT JOIN payments p ON p.id=e.source_id LEFT JOIN invoices i ON i.id=p.invoice_id
      WHERE e.reversal_of IS NULL AND e.source_type='vat_cash_reclassification'
        AND (p.id IS NULL OR i.id IS NULL OR i.type='avoir' OR e.source_event<>'invoice:'||i.id OR e.entry_date<>p.date) LIMIT 1`,
  },
  {
    id: 'vat_cash:lines',
    sql: `${context} SELECT e.id AS __key FROM effective e LEFT JOIN payments p ON p.id=e.source_id
      LEFT JOIN originals i ON i.id=p.invoice_id
      WHERE e.source_type='vat_cash_reclassification' AND (i.id IS NULL OR i.deferred_account IS NULL
        OR (SELECT COUNT(*) FROM lines l WHERE l.journal_entry_id=e.id)<>2
        OR NOT EXISTS(SELECT 1 FROM typed_lines r JOIN typed_lines d ON d.journal_entry_id=r.journal_entry_id
          WHERE r.journal_entry_id=e.id AND r.memo=${release} AND d.memo=${due}
          AND r.account_id=i.deferred_account AND r.account_type='liability' AND d.account_type='liability' AND d.account_id<>r.account_id
          AND r.debit_cents=d.credit_cents AND r.credit_cents=d.debit_cents
          AND r.currency=i.currency AND d.currency=i.currency)
        OR (EXISTS(SELECT 1 FROM legacy v WHERE v.id=i.id) AND EXISTS(SELECT 1 FROM lines r WHERE r.journal_entry_id=e.id AND r.memo=${release} AND r.credit_cents<>0))) LIMIT 1`,
  },
  {
    id: 'vat_cash:legacy_total',
    sql: `${context},${movements}, ratio_input AS MATERIALIZED (SELECT id,vat_cents amount,paid numerator,total_cents denominator FROM vat_state),
      ${roundedProportionCtes('ratio_input', 'ratios')}
      SELECT s.id AS __key FROM vat_state s LEFT JOIN ratios r ON r.id=s.id
      WHERE NOT s.valid OR r.amount IS NULL OR s.vat_cents<=0 OR s.credited>s.total_cents-s.paid
        OR s.due<>s.released OR s.credit_due>s.released OR s.credit_deferred>s.vat_cents-s.released
        OR s.released<>CASE WHEN s.paid=s.total_cents-s.credited THEN s.vat_cents-s.credit_deferred ELSE MIN(r.amount,s.vat_cents-s.credit_deferred) END LIMIT 1`,
  },
  {
    id: 'vat_cash:payment_schedule',
    // For dossiers without a credit/recovery history, every payment releases
    // the difference between consecutive rounded cumulative amounts. Checking
    // only the final sum would miss shifting VAT into a later reporting period.
    sql: `${context}, schedule AS MATERIALIZED (SELECT p.*,i.vat_cents,i.total_cents,
      SUM(p.amount_cents) OVER(PARTITION BY p.invoice_id ORDER BY p.date,p.created_at,p.id ROWS UNBOUNDED PRECEDING) paid
      FROM payments p JOIN legacy i ON i.id=p.invoice_id
      WHERE NOT EXISTS(SELECT 1 FROM invoices c WHERE c.original_invoice_id=i.id AND c.type='avoir' AND c.number IS NOT NULL AND c.status<>'annulee')),
      ratio_input AS MATERIALIZED (SELECT id,vat_cents amount,paid numerator,total_cents denominator FROM schedule),
      ${roundedProportionCtes('ratio_input', 'ratios')},
      targets AS MATERIALIZED (SELECT p.id,r.amount-LAG(r.amount,1,0) OVER(PARTITION BY p.invoice_id ORDER BY p.date,p.created_at,p.id) amount
        FROM schedule p JOIN ratios r ON r.id=p.id),
      actual AS MATERIALIZED (SELECT e.source_id id,SUM(l.debit_cents-l.credit_cents) amount FROM effective e JOIN lines l ON l.journal_entry_id=e.id
        WHERE e.source_type='vat_cash_reclassification' AND l.memo=${release} GROUP BY e.source_id)
      SELECT t.id AS __key FROM targets t LEFT JOIN actual a ON a.id=t.id WHERE t.amount IS NULL OR t.amount<>COALESCE(a.amount,0) LIMIT 1`,
  },
];

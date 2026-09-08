import { structuralRows as rows } from './business-sync-structure';
import { postingContextSql } from './business-sync-postings';
import {
  boundedSignedSum,
  proportionDivRemCtes,
  roundedProportionCtes,
} from './business-sync-money';

// Every statement has the same 22 context bindings. Monetary bindings are
// decimal strings, narrowed by SQL only after the state reader validates i64.
const args = `args AS MATERIALIZED (SELECT ?1 transfer,?2 organization,?3 validator,?4 document_id,?5 cursor,?6 page_size,
 ?7 movement_id,CAST(?8 AS INTEGER) amount,CAST(?9 AS INTEGER) remaining_total,?10 is_credit,?11 signed_weights,?12 extra_cents,
 ?13 previous_date,?14 previous_created_at,CAST(?15 AS INTEGER) previous_sequence,?16 previous_id,?17 reverses_id,
 ?18 revision,?19 state_json,?20 manifest_sha256,?21 generation,?22 installation_id)`;
const active = `SELECT 1 FROM business_sync_transfers t JOIN business_sync_spaces s ON s.organization_id=t.organization_id
 AND s.bootstrap_transfer_id=t.transfer_id AND s.generation=t.generation JOIN args a
 WHERE t.transfer_id=a.transfer AND t.organization_id=a.organization AND t.installation_id=a.installation_id
 AND t.generation=a.generation AND t.manifest_sha256=a.manifest_sha256 AND t.kind='bootstrap' AND t.state='uploaded'
 AND s.state='initializing' AND s.head_revision=0
 AND EXISTS(SELECT 1 FROM business_sync_integrity_checks i WHERE i.transfer_id=a.transfer AND i.validator_sha256=a.validator
   AND i.manifest_sha256=a.manifest_sha256 AND i.generation=a.generation AND i.state='projecting')`;
const guard = `guard AS (SELECT 1 FROM business_sync_credit_projection p JOIN args a WHERE p.transfer_id=a.transfer AND p.validator_sha256=a.validator
 AND p.manifest_sha256=a.manifest_sha256 AND p.generation=a.generation AND p.revision=a.revision AND p.state_json=a.state_json AND EXISTS(${active}))`;
const prefix = `WITH RECURSIVE ${args},${guard}`;
const query = (body: string, ctes = '') =>
  `${prefix}${ctes ? ',' + ctes : ''} ${body}`;
const lineScope =
  'l.transfer_id=a.transfer AND l.validator_sha256=a.validator AND l.document_id=a.document_id';
const eventScope =
  'e.transfer_id=a.transfer AND e.validator_sha256=a.validator AND e.document_id=a.document_id';
const currentLines = `current_lines AS MATERIALIZED (SELECT l.* FROM business_sync_credit_lines l JOIN args a WHERE ${lineScope})`;
const pageLines = `page_lines AS MATERIALIZED (SELECT l.* FROM business_sync_credit_lines l JOIN args a WHERE ${lineScope}
 AND l.item_id>COALESCE(a.cursor,'') ORDER BY l.item_id LIMIT (SELECT page_size FROM args))`;
const storedParts = `stored_parts AS MATERIALIZED (SELECT p.* FROM (${rows('customer_credit_settlement_lines', ['settlement_id', 'side', 'invoice_item_id', 'gross_cents', 'vat_cents'])}) p JOIN args a
 WHERE p.settlement_id=a.movement_id AND p.side=CASE a.is_credit WHEN 1 THEN 'credit' ELSE 'invoice' END)`;
const originalParts = `original_parts AS MATERIALIZED (SELECT p.* FROM (${rows('customer_credit_settlement_lines', ['settlement_id', 'side', 'invoice_item_id', 'gross_cents', 'vat_cents'])}) p JOIN args a
 WHERE p.settlement_id=a.reverses_id AND p.side=CASE a.is_credit WHEN 1 THEN 'credit' ELSE 'invoice' END)`;

function source(
  table: 'invoice_items' | 'payments' | 'customer_credit_settlements',
) {
  const parent =
    table === 'customer_credit_settlements'
      ? "CASE a.is_credit WHEN 1 THEN json_extract(v.row_json,'$.credit_note_id') ELSE json_extract(v.row_json,'$.invoice_id') END"
      : "json_extract(v.row_json,'$.invoice_id')";
  return `SELECT v.row_key_json,v.row_json FROM business_sync_versions v JOIN args a
    WHERE v.transfer_id=a.transfer AND v.organization_id=a.organization AND v.table_name='${table}'
    AND v.row_key_json>COALESCE(a.cursor,'') AND ${parent}=a.document_id
    ORDER BY v.row_key_json LIMIT (SELECT page_size FROM args)`;
}
const sourcePage = (
  table: 'invoice_items' | 'payments' | 'customer_credit_settlements',
) => `source_page AS MATERIALIZED (${source(table)})`;
const field = (name: string) => `json_extract(row_json,'$.${name}')`;
const lineInputs = `incoming AS MATERIALIZED (SELECT ${field('id')} item_id,${field('position')} position,
  CASE a.is_credit WHEN 1 THEN -${field('line_total_cents')} ELSE ${field('line_total_cents')} END gross,
  CASE a.is_credit WHEN 1 THEN -${field('line_vat_cents')} ELSE ${field('line_vat_cents')} END vat
  FROM source_page JOIN args a)`;
const movementInputs = (
  table: 'payments' | 'customer_credit_settlements',
) => `incoming AS MATERIALIZED (SELECT ${field('id')} movement_id,
 '${table === 'payments' ? 'payment' : 'settlement'}' kind,${field('date')} date,${field('created_at')} created_at,
 ${table === 'payments' ? '0' : field('sequence')} sequence,${field('amount_cents')} amount,${table === 'payments' ? 'NULL' : field('reverses_id')} reverses_id FROM source_page)`;

const eligible = `registered AS MATERIALIZED (${rows('customer_credit_documents', ['credit_note_id'])}),
 settlements AS MATERIALIZED (${rows('customer_credit_settlements', ['invoice_id'])}),
 models AS MATERIALIZED (${rows('customer_credit_recovery_tax_models', ['original_invoice_id'])}),
 eligible AS MATERIALIZED (SELECT credit_note_id id FROM registered UNION SELECT invoice_id FROM settlements WHERE invoice_id IS NOT NULL UNION SELECT original_invoice_id FROM models),
 documents AS MATERIALIZED (${rows('invoices', ['id', 'type', 'total_cents'])})`;
const grossInputs = `${pageLines},inputs AS MATERIALIZED (SELECT l.item_id id,ABS(l.remaining) amount,a.amount numerator,a.remaining_total denominator FROM page_lines l JOIN args a),
 ${proportionDivRemCtes('inputs', 'fractions')}, proposals AS MATERIALIZED (SELECT l.item_id,
 CASE WHEN l.remaining<0 THEN -f.quotient-CASE WHEN f.remainder>0 THEN 1 ELSE 0 END ELSE f.quotient END gross,
 CASE WHEN l.remaining<0 AND f.remainder>0 THEN f.denominator-f.remainder ELSE f.remainder END remainder
 FROM page_lines l JOIN fractions f ON f.id=l.item_id)`;
const taxInputs = `${pageLines},normalized AS MATERIALIZED (SELECT item_id,gross,
 ABS(gross) g,ABS(vat) v,ABS(remaining) r,ABS(released) t,ABS(proposed_gross) p FROM page_lines),
 inputs AS MATERIALIZED (SELECT item_id id,v amount,g-r+p numerator,g denominator FROM normalized WHERE p>0 AND g>0),
 ${roundedProportionCtes('inputs', 'targets')}, proposals AS MATERIALIZED (SELECT n.item_id,
 CASE WHEN p=0 THEN 0 ELSE MAX(MAX(0,(v-t)-(r-p)),MIN(target.amount-t,MIN(v-t,p))) END*CASE WHEN gross<0 THEN -1 ELSE 1 END vat
 FROM normalized n LEFT JOIN targets target ON target.id=n.item_id)`;
const proposedBounds = `SELECT l.item_id invalid FROM current_lines l WHERE
 typeof(l.proposed_gross)<>'integer' OR typeof(l.proposed_vat)<>'integer'
 OR typeof(l.remaining-l.proposed_gross)<>'integer' OR typeof(l.released+l.proposed_vat)<>'integer'
 OR CASE WHEN l.gross<0 THEN
   l.remaining-l.proposed_gross NOT BETWEEN l.gross AND 0 OR l.released+l.proposed_vat NOT BETWEEN l.vat AND 0
   OR -(l.vat-(l.released+l.proposed_vat))>-(l.remaining-l.proposed_gross)
 ELSE l.remaining-l.proposed_gross NOT BETWEEN 0 AND l.gross OR l.released+l.proposed_vat NOT BETWEEN 0 AND l.vat
   OR l.vat-(l.released+l.proposed_vat)>l.remaining-l.proposed_gross END LIMIT 1`;
const journal = postingContextSql.replace(/^WITH RECURSIVE /, '');
const recovery = `recoveries AS MATERIALIZED (${rows('customer_credit_recovery_postings', ['original_invoice_id', 'source_type', 'source_id', 'journal_entry_id', 'parts_json', 'expected_vat_cents'])})`;

export const creditProjectionSql = {
  recoveryToken:
    query(`SELECT r.source_json,CASE WHEN json_valid(r.request_json) THEN json_extract(r.request_json,'$.source_token') END token
    FROM (${rows('customer_credit_recoveries', ['original_invoice_id', 'source_json', 'request_json'])}) r JOIN args a WHERE r.original_invoice_id=a.document_id`),
  initialize:
    query(`INSERT OR IGNORE INTO business_sync_credit_projection(transfer_id,validator_sha256,manifest_sha256,generation,revision,state_json,updated_at)
    SELECT transfer,validator,manifest_sha256,generation,0,state_json,?23 FROM args WHERE EXISTS(${active})`),
  save: query(`UPDATE business_sync_credit_projection SET state_json=?23,revision=revision+1,updated_at=?24
    WHERE transfer_id=(SELECT transfer FROM args) AND validator_sha256=(SELECT validator FROM args) AND EXISTS(SELECT 1 FROM guard)`),
  active: query(`SELECT 1 active WHERE EXISTS(${active})`),
  nextDocument: query(
    `SELECT d.id,CASE d.type WHEN 'avoir' THEN 1 ELSE 0 END credit,
    CAST(CASE d.type WHEN 'avoir' THEN -d.total_cents ELSE d.total_cents END AS TEXT) total
    FROM documents d JOIN eligible e ON e.id=d.id JOIN args a WHERE d.id>COALESCE(a.cursor,'') ORDER BY d.id LIMIT 1`,
    eligible,
  ),
  seedLinesMeta: query(
    'SELECT row_key_json,length(CAST(row_json AS BLOB)) bytes FROM source_page ORDER BY row_key_json',
    sourcePage('invoice_items'),
  ),
  seedPaymentsMeta: query(
    'SELECT row_key_json,length(CAST(row_json AS BLOB)) bytes FROM source_page ORDER BY row_key_json',
    sourcePage('payments'),
  ),
  seedSettlementsMeta: query(
    'SELECT row_key_json,length(CAST(row_json AS BLOB)) bytes FROM source_page ORDER BY row_key_json',
    sourcePage('customer_credit_settlements'),
  ),
  seedLinesCheck: query(
    `SELECT item_id invalid FROM incoming WHERE typeof(gross)<>'integer' OR typeof(vat)<>'integer'
    OR gross=-9223372036854775808 OR vat=-9223372036854775808
    OR (gross>=0 AND (vat<0 OR vat>gross)) OR (gross<0 AND (vat>0 OR vat<gross)) LIMIT 1`,
    `${sourcePage('invoice_items')},${lineInputs}`,
  ),
  seedLines: query(
    `INSERT INTO business_sync_credit_lines(transfer_id,validator_sha256,document_id,item_id,position,gross,vat,remaining,released)
    SELECT a.transfer,a.validator,a.document_id,i.item_id,i.position,i.gross,i.vat,i.gross,0 FROM incoming i JOIN args a WHERE EXISTS(SELECT 1 FROM guard)`,
    `${sourcePage('invoice_items')},${lineInputs}`,
  ),
  seedPaymentsCheck: query(
    `SELECT i.movement_id invalid FROM incoming i JOIN args a WHERE length(i.created_at)>128 OR length(i.movement_id)>1024
    OR i.amount<=0 OR EXISTS(SELECT 1 FROM business_sync_credit_movements e WHERE ${eventScope} AND e.movement_id=i.movement_id) LIMIT 1`,
    `${sourcePage('payments')},${movementInputs('payments')}`,
  ),
  seedSettlementsCheck: query(
    `SELECT i.movement_id invalid FROM incoming i JOIN args a WHERE length(i.created_at)>128 OR length(i.movement_id)>1024
    OR i.amount<=0 OR EXISTS(SELECT 1 FROM business_sync_credit_movements e WHERE ${eventScope} AND e.movement_id=i.movement_id) LIMIT 1`,
    `${sourcePage('customer_credit_settlements')},${movementInputs('customer_credit_settlements')}`,
  ),
  seedPayments: query(
    `INSERT INTO business_sync_credit_movements(transfer_id,validator_sha256,document_id,movement_id,kind,date,created_at,sequence,amount,reverses_id)
    SELECT a.transfer,a.validator,a.document_id,i.movement_id,i.kind,i.date,i.created_at,i.sequence,i.amount,i.reverses_id FROM incoming i JOIN args a WHERE EXISTS(SELECT 1 FROM guard)`,
    `${sourcePage('payments')},${movementInputs('payments')}`,
  ),
  seedSettlements: query(
    `INSERT INTO business_sync_credit_movements(transfer_id,validator_sha256,document_id,movement_id,kind,date,created_at,sequence,amount,reverses_id)
    SELECT a.transfer,a.validator,a.document_id,i.movement_id,i.kind,i.date,i.created_at,i.sequence,i.amount,i.reverses_id FROM incoming i JOIN args a WHERE EXISTS(SELECT 1 FROM guard)`,
    `${sourcePage('customer_credit_settlements')},${movementInputs('customer_credit_settlements')}`,
  ),
  totals: query(
    `SELECT COUNT(*) count,CAST(${boundedSignedSum('gross')} AS TEXT) gross,
    CAST(${boundedSignedSum('remaining')} AS TEXT) remaining,CAST(${boundedSignedSum('released')} AS TEXT) released,
    COALESCE(MIN(remaining)<0,0) signed FROM current_lines`,
    currentLines,
  ),
  nextMovement:
    query(`SELECT e.movement_id id,e.kind,e.date,e.created_at,CAST(e.sequence AS TEXT) sequence,CAST(e.amount AS TEXT) amount,e.reverses_id reverses
    FROM business_sync_credit_movements e JOIN args a WHERE ${eventScope} AND (a.previous_id IS NULL OR
      (e.date,e.created_at,e.sequence,e.movement_id)>(a.previous_date,a.previous_created_at,a.previous_sequence,a.previous_id))
    ORDER BY e.date,e.created_at,e.sequence,e.movement_id LIMIT 1`),
  resetProposals:
    query(`UPDATE business_sync_credit_lines AS l SET proposed_gross=NULL,proposed_vat=NULL,remainder=NULL
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${lineScope}) AND EXISTS(SELECT 1 FROM guard)`),
  linePage: query('SELECT item_id FROM page_lines ORDER BY item_id', pageLines),
  gross: query(
    `UPDATE business_sync_credit_lines AS l SET proposed_gross=(SELECT p.gross FROM proposals p WHERE p.item_id=l.item_id),
    remainder=(SELECT p.remainder FROM proposals p WHERE p.item_id=l.item_id)
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${lineScope}) AND l.item_id IN(SELECT item_id FROM proposals) AND EXISTS(SELECT 1 FROM guard)`,
    grossInputs,
  ),
  grossTotals: query(
    `SELECT COUNT(*) count,CAST(${boundedSignedSum('proposed_gross')} AS TEXT) amount,
    SUM(CASE WHEN a.signed_weights=1 OR proposed_gross<remaining THEN 1 ELSE 0 END) eligible,
    SUM(CASE WHEN typeof(proposed_gross)<>'integer' OR typeof(remainder)<>'integer' OR remainder<0 OR remainder>=a.remaining_total THEN 1 ELSE 0 END) invalid
    FROM current_lines JOIN args a`,
    currentLines,
  ),
  rank: query(
    `UPDATE business_sync_credit_lines AS l SET proposed_gross=proposed_gross+1
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${lineScope}) AND item_id IN(SELECT item_id FROM ranked WHERE place<=(SELECT extra_cents FROM args)) AND EXISTS(SELECT 1 FROM guard)`,
    `${currentLines},ranked AS MATERIALIZED (SELECT item_id,ROW_NUMBER() OVER(ORDER BY remainder DESC,position,item_id) place FROM current_lines JOIN args a WHERE a.signed_weights=1 OR proposed_gross<remaining)`,
  ),
  grossBounds: query(
    `SELECT item_id invalid FROM current_lines WHERE typeof(proposed_gross)<>'integer'
    OR (gross<0 AND proposed_gross NOT BETWEEN remaining AND 0) OR (gross>=0 AND proposed_gross NOT BETWEEN 0 AND remaining) LIMIT 1`,
    currentLines,
  ),
  tax: query(
    `UPDATE business_sync_credit_lines AS l SET proposed_vat=(SELECT p.vat FROM proposals p WHERE p.item_id=l.item_id)
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${lineScope}) AND l.item_id IN(SELECT item_id FROM proposals) AND EXISTS(SELECT 1 FROM guard)`,
    taxInputs,
  ),
  reversalSource:
    query(`SELECT 1 invalid WHERE NOT EXISTS(SELECT 1 FROM business_sync_credit_movements e JOIN args a WHERE ${eventScope}
    AND e.movement_id=a.reverses_id AND e.kind='settlement' AND e.validated=1 AND e.reverses_id IS NULL AND e.amount=a.amount)`),
  reverse: query(
    `UPDATE business_sync_credit_lines AS l SET proposed_gross=-(SELECT p.gross_cents FROM original_parts p WHERE p.invoice_item_id=l.item_id),
    proposed_vat=-(SELECT p.vat_cents FROM original_parts p WHERE p.invoice_item_id=l.item_id)
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${lineScope}) AND EXISTS(SELECT 1 FROM guard)`,
    originalParts,
  ),
  proposalBounds: query(proposedBounds, currentLines),
  proposalTotals: query(
    `SELECT CAST(${boundedSignedSum('proposed_gross')} AS TEXT) gross,CAST(${boundedSignedSum('proposed_vat')} AS TEXT) vat FROM current_lines`,
    currentLines,
  ),
  settlementParts: query(
    `SELECT l.item_id invalid FROM current_lines l LEFT JOIN stored_parts p ON p.invoice_item_id=l.item_id
    WHERE p.invoice_item_id IS NULL OR p.gross_cents<>l.proposed_gross OR p.vat_cents<>l.proposed_vat
    UNION ALL SELECT p.invoice_item_id FROM stored_parts p LEFT JOIN current_lines l ON l.item_id=p.invoice_item_id WHERE l.item_id IS NULL LIMIT 1`,
    `${currentLines},${storedParts}`,
  ),
  paymentPosting: query(
    `SELECT
    EXISTS(SELECT 1 FROM effective e JOIN lines l ON l.journal_entry_id=e.id JOIN args a WHERE e.source_type='invoice' AND e.source_id=a.document_id
      AND e.source_event='issue' AND l.memo='TVA à régulariser · contre-prestations reçues') received,
    CAST(COALESCE(${boundedSignedSum('released')},0) AS TEXT) released,
    CAST(COALESCE(${boundedSignedSum('due')},0) AS TEXT) due,
    CASE WHEN COUNT(*)=0 THEN 1 ELSE ${boundedSignedSum('released')} IS NOT NULL AND ${boundedSignedSum('due')} IS NOT NULL END valid
    FROM movements`,
    `${journal},${recovery}, movements AS MATERIALIZED (
      SELECT CASE l.memo WHEN 'Reclassement TVA à régulariser' THEN l.debit_cents-l.credit_cents ELSE 0 END released,
        CASE l.memo WHEN 'TVA due sur encaissement' THEN l.credit_cents-l.debit_cents ELSE 0 END due
      FROM effective e JOIN lines l ON l.journal_entry_id=e.id JOIN args a WHERE e.source_type='vat_cash_reclassification' AND e.source_id=a.movement_id
      UNION ALL SELECT CASE l.memo WHEN 'Reclassement TVA à régulariser' THEN l.debit_cents-l.credit_cents ELSE 0 END,
        CASE l.memo WHEN 'TVA due sur encaissement' THEN l.credit_cents-l.debit_cents ELSE 0 END
      FROM recoveries r JOIN lines l ON l.journal_entry_id=r.journal_entry_id JOIN args a WHERE r.original_invoice_id=a.document_id AND r.source_type='payment' AND r.source_id=a.movement_id)`,
  ),
  recoveryParts: query(
    `SELECT r.source_id invalid FROM recoveries r JOIN args a WHERE r.source_type='payment' AND r.source_id=a.movement_id
    AND (r.original_invoice_id IS NOT a.document_id OR json_type(r.safe_parts) IS NOT 'array'
      OR json_array_length(r.safe_parts)<>(SELECT COUNT(*) FROM current_lines)
      OR EXISTS(SELECT 1 FROM json_each(r.safe_parts) p LEFT JOIN current_lines l ON l.item_id=json_extract(CASE p.type WHEN 'object' THEN p.value ELSE '{}' END,'$.invoice_item_id')
        WHERE p.type<>'object' OR l.item_id IS NULL OR json_type(CASE p.type WHEN 'object' THEN p.value ELSE '{}' END,'$.gross_cents') IS NOT 'integer' OR json_type(CASE p.type WHEN 'object' THEN p.value ELSE '{}' END,'$.vat_cents') IS NOT 'integer'
        OR json_extract(CASE p.type WHEN 'object' THEN p.value ELSE '{}' END,'$.gross_cents') IS NOT l.proposed_gross OR json_extract(CASE p.type WHEN 'object' THEN p.value ELSE '{}' END,'$.vat_cents') IS NOT l.proposed_vat)
      OR (SELECT COUNT(DISTINCT json_extract(CASE p.type WHEN 'object' THEN p.value ELSE '{}' END,'$.invoice_item_id')) FROM json_each(r.safe_parts) p)<>(SELECT COUNT(*) FROM current_lines)
      OR r.expected_vat_cents IS NOT (SELECT ${boundedSignedSum('proposed_vat')} FROM current_lines)) LIMIT 1`,
    `${currentLines},
        recovery_source AS MATERIALIZED (${rows('customer_credit_recovery_postings', ['original_invoice_id', 'source_type', 'source_id', 'parts_json', 'expected_vat_cents'])}),
        recoveries AS MATERIALIZED (SELECT *,CASE WHEN json_valid(parts_json) THEN parts_json ELSE 'null' END safe_parts FROM recovery_source)`,
  ),
  apply:
    query(`UPDATE business_sync_credit_lines AS l SET remaining=remaining-proposed_gross,released=released+proposed_vat
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${lineScope}) AND EXISTS(SELECT 1 FROM guard)`),
  confirmMovement: query(
    `UPDATE business_sync_credit_movements AS e SET validated=1,
    computed_vat=(SELECT ${boundedSignedSum('proposed_vat')} FROM current_lines)
    WHERE EXISTS(SELECT 1 FROM args a WHERE ${eventScope} AND e.movement_id=a.movement_id) AND EXISTS(SELECT 1 FROM guard)`,
    currentLines,
  ),
  unfinished: query(
    `SELECT e.movement_id invalid FROM business_sync_credit_movements e JOIN args a WHERE ${eventScope} AND e.validated<>1 LIMIT 1`,
  ),
};

import type { BankStatement } from './accounting/reconciliation';
import { ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { validateUsBankRequest } from './us-bank-reconciliation';

export interface UsBankStatementCsvInput {
  readonly text: string;
  readonly id: string;
  readonly organizationId: string;
  readonly externalConnectionId: string;
  readonly cashAccountId: string;
  readonly start: string;
  readonly end: string;
  /** Explicit decimal major USD units, like the CSV amount column. */
  readonly opening: string;
  readonly closing: string;
}
function fail(): never { throw new ErpError('invalid_bank_statement', 422); }
function cents(input: unknown): string {
  if (typeof input !== 'string' || !/^-?(?:0|[1-9][0-9]{0,35})(?:\.[0-9]{1,2})?$/.test(input)) return fail();
  const negative = input.startsWith('-'), [major, fraction = ''] = (negative ? input.slice(1) : input).split('.');
  const value = BigInt(major) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  if ((negative && value === BigInt(0)) || value.toString().length > 36) return fail();
  return (negative ? -value : value).toString();
}
/** A bounded RFC4180 subset: comma columns, quoted commas/doubled quotes,
 * LF/CRLF, no implicit locale/header/date/precision detection. References cannot
 * contain controls, so multiline cells are rejected by the statement validator. */
function rows(input: string): string[][] {
  const text = input.startsWith('\ufeff') ? input.slice(1) : input;
  const result: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false, started = false;
  const field = () => { row.push(cell); cell = ''; closed = false; started = false; if (row.length > 3) return fail(); };
  const line = () => { field(); result.push(row); row = []; if (result.length > 1001) return fail(); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') { if (c === '\r') { if (text[i + 1] !== '\n') return fail(); i++; } line(); }
    else if (c === '"' && !started && !closed && !cell) { quoted = true; started = true; }
    else { if (closed || c === '"') return fail(); cell += c; started = true; }
    if (cell.length > 1024) return fail();
  }
  if (quoted) return fail();
  if (started || closed || cell || row.length) line();
  return result;
}

/** No journal/credential/authority is created. Stable line IDs bind the exact
 * imported order and text; immutable statement review happens separately. */
export function parseUsBankStatementCsv(input: UsBankStatementCsvInput): BankStatement {
  try {
    const v = snapshotPrivateJson(input) as unknown as UsBankStatementCsvInput;
    const keys = ['text', 'id', 'organizationId', 'externalConnectionId', 'cashAccountId', 'start', 'end', 'opening', 'closing'];
    if (!v || typeof v !== 'object' || Array.isArray(v) || keys.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !keys.includes(k)) || typeof v.text !== 'string' || v.text.length > 524288) return fail();
    const data = rows(v.text);
    if (!data.length || data[0].length !== 3 || data[0].join(',') !== 'date,amount,reference') return fail();
    const statement: BankStatement = { id: v.id, organizationId: v.organizationId, externalConnectionId: v.externalConnectionId, currency: 'USD', cashAccountId: v.cashAccountId, start: v.start, end: v.end, opening: { currency: 'USD', minorUnits: cents(v.opening) }, closing: { currency: 'USD', minorUnits: cents(v.closing) }, lines: data.slice(1).map((row, i) => {
      if (row.length !== 3) return fail();
      return { id: `${v.id}:${i + 1}`, date: row[0], amount: { currency: 'USD', minorUnits: cents(row[1]) }, reference: row[2] };
    }) };
    const request = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: 'csv-validation', reconciliationId: v.id, expectedErpRevision: 1, expectedReconciliationRevision: null, command: { type: 'create_statement', statement } }, v.organizationId);
    if (request.command.type !== 'create_statement') return fail();
    return request.command.statement;
  } catch { return fail(); }
}

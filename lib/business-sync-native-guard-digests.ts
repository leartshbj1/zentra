import { AccountPublicError, sha256Hex } from './account-security';
import type { TransactionChange } from './business-sync-transaction-format';
import { database } from './runtime';

// SQL in D1 cannot call the native zentra_sha256 function. Load only the
// assessments referenced by this page, then follow its original change order.
// No digest supplied by the uploading installation is trusted here.
export async function nativeGuardDigests(
  transfer: string,
  organization: string,
  validator: string,
  source: string,
  changes: readonly TransactionChange[],
): Promise<(string | null)[]> {
  const images = changes.map((c) =>
    c.after_json === null
      ? null
      : (JSON.parse(c.after_json) as Record<string, unknown>),
  );
  const ids = [
    ...new Set(
      changes.flatMap((c, i) =>
        c.table === 'payslips' && images[i] ? [String(images[i]!.id)] : [],
      ),
    ),
  ];
  const hashes = new Map<string, string | null>();
  if (ids.length) {
    const rows = (
      await database()
        .prepare(`WITH requested AS (SELECT value id,json_array(value) row_key FROM json_each(?5))
      SELECT r.id,CASE WHEN EXISTS(SELECT 1 FROM business_sync_transaction_accounting_states s WHERE s.transfer_id=?1 AND s.validator_sha256=?3 AND s.table_name='payslip_small_salary_assessments' AND s.row_key_json=r.row_key)
      THEN (SELECT json_extract(s.row_json,'$.assessment_json') FROM business_sync_transaction_accounting_states s WHERE s.transfer_id=?1 AND s.validator_sha256=?3 AND s.table_name='payslip_small_salary_assessments' AND s.row_key_json=r.row_key)
      ELSE (SELECT json_extract(v.row_json,'$.assessment_json') FROM business_sync_versions v WHERE v.transfer_id=?4 AND v.organization_id=?2 AND v.table_name='payslip_small_salary_assessments' AND v.row_key_json=r.row_key) END payload
      FROM requested r`)
        .bind(transfer, organization, validator, source, JSON.stringify(ids))
        .all<{ id: string; payload: string | null }>()
    ).results;
    for (const row of rows) {
      if (row.payload !== null && typeof row.payload !== 'string')
        throw new AccountPublicError('La preuve de paie est illisible.', 503);
      hashes.set(
        row.id,
        row.payload === null ? null : await sha256Hex(row.payload),
      );
    }
  }
  const result: (string | null)[] = [];
  for (const [i, c] of changes.entries()) {
    const after = images[i];
    if (c.table === 'payslip_small_salary_assessments') {
      const digest =
        after && typeof after.assessment_json === 'string'
          ? await sha256Hex(after.assessment_json)
          : null;
      const key = JSON.parse(c.key_json) as string[];
      hashes.set(key[0], digest);
      result.push(digest);
    } else
      result.push(
        c.table === 'payslips' && after
          ? (hashes.get(String(after.id)) ?? null)
          : null,
      );
  }
  return result;
}

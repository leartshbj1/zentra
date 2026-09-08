import schema from '../desktop/src-tauri/src/business_sync_schema.json';
import { AccountPublicError } from './account-security';

const aliases = new Map(
  Object.entries(schema.tables).flatMap(([table, definition]) => {
    const primary = definition.columns.filter(
      (c) => c.primary_key_position > 0,
    );
    return primary.length === 1 && primary[0].type.toUpperCase() === 'INTEGER'
      ? [[table, primary[0].name] as const]
      : [];
  }),
);
export function sharedRowid(
  table: string,
  image: Record<string, unknown>,
): string | null {
  const alias = aliases.get(table);
  return alias && Object.hasOwn(image, alias)
    ? sourceRowid(String(image[alias]), table, image)
    : null;
}
// Store rowids as canonical decimal strings: SQLite signed 64-bit integers need
// not fit in a JavaScript Number. Their exact source values matter to exports
// and event replay, including negative legacy rowids and retained sequence gaps.
export function sourceRowid(
  value: unknown,
  table: string,
  image: Record<string, unknown>,
): string {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]{0,18})$/.test(value))
    throw new AccountPublicError(
      'La position d’origine de la ligne est invalide.',
    );
  const integer = BigInt(value);
  if (
    integer < BigInt('-9223372036854775808') ||
    integer > BigInt('9223372036854775807')
  )
    throw new AccountPublicError(
      'La position d’origine dépasse les limites SQLite.',
    );
  const alias = aliases.get(table);
  if (alias && Object.hasOwn(image, alias) && String(image[alias]) !== value)
    throw new AccountPublicError(
      'La séquence de la ligne ne correspond pas à son ordre d’origine.',
    );
  return value;
}

// Receipts validate the audit graph. This last check also guarantees that its
// portable storage order is the same linear order used by the native audit.
export const sourceAuditOrderSql = `SELECT 1 FROM business_sync_audit_nodes current
 JOIN business_sync_audit_nodes previous ON previous.transfer_id=current.transfer_id AND previous.validator_sha256=current.validator_sha256 AND previous.entry_hash=current.previous_hash
 JOIN business_sync_row_order co ON co.transfer_id=current.transfer_id AND co.table_name='audit_log' AND co.row_key_json=current.row_key
 JOIN business_sync_row_order po ON po.transfer_id=previous.transfer_id AND po.table_name='audit_log' AND po.row_key_json=previous.row_key
 WHERE current.transfer_id=?1 AND current.validator_sha256=?7
 AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=?1 AND organization_id=?2)
 AND CAST(po.source_rowid AS INTEGER)>=CAST(co.source_rowid AS INTEGER) LIMIT 1`;

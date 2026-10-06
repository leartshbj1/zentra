import { database } from '@/lib/runtime';
import { ownedPrepaidReceipt } from '@/lib/payments/prepaid-receipt';
import {
  prepaidReceiptPath,
  validPrepaidReceiptId,
} from '@/lib/payments/prepaid-receipt-types';

export type OwnedPendingPrepaidReceipt = Readonly<{
  intentId: string;
  name: string;
  targetName: string | null;
  status: 'pending' | 'verification_required' | 'activation_pending';
  receiptHref: string;
}>;
export type OwnedPendingPrepaidReceiptsPage = Readonly<{
  items: readonly OwnedPendingPrepaidReceipt[];
  nextCursor: string | null;
}>;
type Cursor = Readonly<{ createdAt: number; intentId: string }>;
type Candidate = { created_at: number; intent_id: string };
const CHUNK_SIZE = 4;
const MAX_CHUNKS = 1;
const MAX_ITEMS = 4;
const empty = (): OwnedPendingPrepaidReceiptsPage => ({
  items: [],
  nextCursor: null,
});

export class PendingPrepaidReceiptCursorError extends Error {
  constructor() {
    super('Invalid pending payment cursor.');
  }
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const encodeCursor = (cursor: Cursor) =>
  btoa(JSON.stringify([1, cursor.createdAt, cursor.intentId]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
function decodeCursor(value: unknown, now: number): Cursor | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new PendingPrepaidReceiptCursorError();
  try {
    const decoded: unknown = JSON.parse(
      atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      decoded[0] !== 1 ||
      !positive(decoded[1]) ||
      decoded[1] > now ||
      !validPrepaidReceiptId(decoded[2])
    )
      throw new PendingPrepaidReceiptCursorError();
    const cursor = { createdAt: decoded[1], intentId: decoded[2] };
    if (encodeCursor(cursor) !== value)
      throw new PendingPrepaidReceiptCursorError();
    return cursor;
  } catch {
    throw new PendingPrepaidReceiptCursorError();
  }
}

// Only pointers are selected here. Frozen content, ownership, current links,
// paid evidence and current access are rechecked by the canonical receipt reader.
// A reservation which never dispatched and has no provider reference cannot
// have sent a financial request; its expiry does not hide uncertain payments.
export const OWNED_PENDING_PREPAID_CANDIDATES_SQL = `SELECT i.intent_id,i.created_at
  FROM purchase_intents i
  WHERE i.owner_id=? AND i.provider='postfinance' AND i.environment IN('TEST','PRODUCTION')
  AND length(i.intent_id)=45 AND i.intent_id GLOB 'purchase_????????-????-????-????-????????????'
  AND substr(i.intent_id,10) NOT GLOB '*[^0-9a-f-]*'
  AND length(replace(substr(i.intent_id,10),'-',''))=32
  AND i.state IN('reserved','dispatched','uncertain','settled')
  AND (i.state<>'reserved' OR i.expires_at>? OR i.dispatched_at IS NOT NULL OR i.provider_reference IS NOT NULL)
  AND typeof(i.created_at)='integer' AND i.created_at>0 AND i.created_at<=?
  AND json_valid(i.parameters) AND length(CAST(i.parameters AS BLOB))<=16384
  AND NOT EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(i.parameters) THEN i.parameters ELSE '{}' END)
    GROUP BY parent,key HAVING COUNT(*)>1)
  AND (? IS NULL OR i.created_at<? OR (i.created_at=? AND i.intent_id<?))
  ORDER BY i.created_at DESC,i.intent_id DESC LIMIT 5`;

/** SELECT-only discovery, independent of browser storage and purchase flags.
 * The cursor only filters this authenticated owner's rows; it grants no access.
 * Scan at most four pointers, return at most four current pollable receipts, and
 * advance on scanned rows even when every candidate is invalid or already paid.
 */
export async function listOwnedPendingPrepaidReceipts(
  user: { userId: string; emailConfirmed: boolean },
  dependencies: {
    database?: () => Pick<D1Database, 'prepare'>;
    now?: () => number;
    cursor?: unknown;
  } = {},
): Promise<OwnedPendingPrepaidReceiptsPage> {
  if (!user.userId || user.emailConfirmed !== true) return empty();
  const now = (dependencies.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (!positive(now)) return empty();
  let cursor = decodeCursor(dependencies.cursor, now);
  const db = (dependencies.database ?? database)();
  const items: OwnedPendingPrepaidReceipt[] = [];
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const candidates = await db
      .prepare(OWNED_PENDING_PREPAID_CANDIDATES_SQL)
      .bind(
        user.userId,
        now,
        now,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.intentId ?? null,
      )
      .all<Candidate>();
    const rows = candidates.results.slice(0, CHUNK_SIZE);
    const more = candidates.results.length > CHUNK_SIZE;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      cursor = { createdAt: row.created_at, intentId: row.intent_id };
      if (validPrepaidReceiptId(row.intent_id)) {
        const receipt = await ownedPrepaidReceipt(user, row.intent_id, {
          database: () => db,
          now: () => now,
        });
        if (
          receipt?.poll &&
          (receipt.status === 'pending' ||
            receipt.status === 'verification_required' ||
            receipt.status === 'activation_pending')
        ) {
          items.push({
            intentId: receipt.intentId,
            name: receipt.name,
            targetName:
              receipt.organization?.name ?? receipt.workspace?.name ?? null,
            status: receipt.status,
            receiptHref: prepaidReceiptPath(receipt.intentId),
          });
        }
      }
      if (items.length === MAX_ITEMS)
        return {
          items,
          nextCursor:
            index < rows.length - 1 || more ? encodeCursor(cursor) : null,
        };
    }
    if (!more) return { items, nextCursor: null };
  }
  return { items, nextCursor: cursor ? encodeCursor(cursor) : null };
}

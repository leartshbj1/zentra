import { AccountPublicError, sha256Hex } from './account-security';
import { storedBlobPart } from './business-sync-blob-store';
import {
  transactionChanges,
  type TransactionManifest,
} from './business-sync-transaction-format';
import { database } from './runtime';

export async function readBusinessTransactionChunk(
  id: string,
  manifest: TransactionManifest,
  index: number,
) {
  const part = manifest.chunks[index];
  if (!part)
    throw new AccountPublicError(
      'Le contrôle a dépassé les fragments disponibles.',
      503,
    );
  const stored = await database()
    .prepare(
      'SELECT object_key,sha256,size_bytes,change_count FROM business_sync_transaction_parts WHERE transaction_id=? AND part_index=?',
    )
    .bind(id, index)
    .first<{
      object_key: string;
      sha256: string;
      size_bytes: number;
      change_count: number;
    }>();
  const expectedKey = `business-sync/${manifest.organization_id}/transactions/${manifest.capture_generation}/${id}/${index}-${part.sha256}.json`;
  if (
    !stored ||
    stored.object_key !== expectedKey ||
    stored.sha256 !== part.sha256 ||
    stored.size_bytes !== part.size_bytes ||
    stored.change_count !== part.change_count
  )
    throw new AccountPublicError(
      'Un fragment de la transaction est absent ou incohérent.',
      503,
    );
  const bytes = await storedBlobPart(expectedKey, part.size_bytes);
  if (
    bytes.length !== part.size_bytes ||
    (await sha256Hex(bytes)) !== part.sha256
  )
    throw new AccountPublicError(
      'Le fragment de transaction conservé est altéré.',
      503,
    );
  return transactionChanges(bytes, manifest, index);
}

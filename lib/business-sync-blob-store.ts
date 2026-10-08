import { createHash } from 'node:crypto';
import { AccountPublicError, sha256Hex } from './account-security';
import { readBytesBodyWithinLimit } from './request-body';
import { database, fileArchive } from './runtime';
import { requireLegacyCountryTransport } from './international/legacy-country-guard';

export const SYNC_BLOB_PART_BYTES = 4 * 1024 * 1024;
export type StoredBlobPart = {
  part_index: number;
  sha256: string;
  size_bytes: number;
  object_key: string;
};
function requireBlobOrganization(organizationId: string, key: string) {
  if (!organizationId || !key.startsWith(`business-sync/${organizationId}/`))
    throw new AccountPublicError('Ce fragment ne correspond pas à son entreprise.', 409);
}
// Private reader: only the guarded exports below may enter the storage loop.
async function readStoredBlobPart(key: string, expected: number) {
  const blob = await fileArchive().get(key);
  if (
    !blob ||
    blob.size !== expected ||
    expected < 0 ||
    expected > SYNC_BLOB_PART_BYTES
  )
    throw new AccountPublicError(
      'Un fragment de fichier conservé est absent ou incohérent.',
      409,
    );
  return readBytesBodyWithinLimit(
    new Request('https://storage.invalid/fragment', {
      method: 'POST',
      body: blob.body,
      duplex: 'half',
    } as RequestInit),
    expected,
  );
}
export async function storedBlobPart(organizationId: string, key: string, expected: number) {
  await requireLegacyCountryTransport(organizationId, database());
  requireBlobOrganization(organizationId, key);
  return readStoredBlobPart(key, expected);
}
export async function verifyStoredBlob(
  organizationId: string,
  parts: StoredBlobPart[],
  size: number,
  sha: string,
  key: (index: number) => string,
) {
  await requireLegacyCountryTransport(organizationId, database());
  if (parts.length !== Math.ceil(size / SYNC_BLOB_PART_BYTES))
    throw new AccountPublicError(
      'Des fragments du fichier manquent encore.',
      409,
    );
  const digest = createHash('sha256');
  let received = 0;
  for (const [index, part] of parts.entries()) {
    const expected = Math.min(SYNC_BLOB_PART_BYTES, size - received);
    if (
      part.part_index !== index ||
      part.size_bytes !== expected ||
      part.object_key !== key(index)
    )
      throw new AccountPublicError(
        'Les fragments conservés sont incohérents.',
        409,
      );
    requireBlobOrganization(organizationId, part.object_key);
    const bytes = await readStoredBlobPart(part.object_key, expected);
    if (bytes.length !== expected || (await sha256Hex(bytes)) !== part.sha256)
      throw new AccountPublicError('Un fragment conservé est altéré.', 409);
    received += bytes.length;
    digest.update(bytes);
  }
  if (received !== size || digest.digest('hex') !== sha)
    throw new AccountPublicError(
      'Le fichier complet ne correspond pas à la pièce d’origine.',
      409,
    );
}

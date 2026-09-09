import { AccountPublicError, sha256Hex } from './account-security';

// Version 1 was an unpublished, non-resumable native prototype. Version 2 is
// independent of page boundaries; only a 32-byte chain head must be retained.
export const STATE_FINGERPRINT_VERSION = 2;
export const STATE_FINGERPRINT_SEED = 'zentra-business-state-v2\0';
export const STATE_FINGERPRINT_ROW = 'zentra-business-state-row-v2\0';
const encoder = new TextEncoder();
export function initialStateHash() {
  return sha256Hex(STATE_FINGERPRINT_SEED);
}
export async function appendStateRow(
  previous: string,
  table: string,
  key: string,
  rowid: string,
  normalizedRow: string,
) {
  if (!/^[a-f0-9]{64}$/.test(previous))
    throw new AccountPublicError('L’empreinte conservée est invalide.', 503);
  const fields = [table, key, rowid, normalizedRow].map((v) =>
    encoder.encode(v),
  );
  const domain = encoder.encode(STATE_FINGERPRINT_ROW);
  const bytes = new Uint8Array(
    domain.length + 32 + fields.reduce((n, v) => n + 8 + v.length, 0),
  );
  bytes.set(domain);
  bytes.set(
    Uint8Array.from(previous.match(/../g)!, (v) => Number.parseInt(v, 16)),
    domain.length,
  );
  let offset = domain.length + 32;
  const view = new DataView(bytes.buffer);
  for (const field of fields) {
    view.setBigUint64(offset, BigInt(field.length), false);
    bytes.set(field, offset + 8);
    offset += 8 + field.length;
  }
  return sha256Hex(bytes);
}

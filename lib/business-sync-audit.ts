import { sha256Hex } from './account-security';
export const auditHashFields = [
  'id',
  'occurred_at',
  'actor',
  'action',
  'entity_type',
  'entity_id',
  'payload_json',
] as const;
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export async function verifiedAuditNode(data: Record<string, unknown>) {
  if (
    auditHashFields.some((field) => typeof data[field] !== 'string') ||
    !hash(data.entry_hash) ||
    !(data.previous_hash === null || hash(data.previous_hash))
  )
    return null;
  const computed = await sha256Hex(
    [
      data.previous_hash ?? '',
      ...auditHashFields.map((field) => data[field]),
    ].join('\n'),
  );
  return computed === data.entry_hash
    ? {
        entry_hash: data.entry_hash,
        previous_hash: data.previous_hash as string | null,
      }
    : null;
}

export const AUTOPILOT_REVIEW_REASONS = [
  'missing_customer_name', 'ambiguous_customer', 'archived_customer', 'missing_quantity',
  'ambiguous_quantity', 'unsupported_quantity', 'missing_article', 'too_many_candidates',
  'source_too_long', 'low_confidence', 'not_quote_request', 'invalid_decision', 'provider_unavailable',
] as const;
export type AutopilotReviewReason = typeof AUTOPILOT_REVIEW_REASONS[number];
export type AutopilotReviewItem = Readonly<{
  proposalId: string; sourceId: string; createdAt: number; disposition: 'needs_review';
  reasons: readonly AutopilotReviewReason[]; requiresHumanValidation: true;
  /** Optional server hint: the client asked for "the usual". Present only when true. */
  usualRequested?: true;
}>;
export type AutopilotReviewPage = Readonly<{
  organizationId: string; items: readonly AutopilotReviewItem[]; nextCursor: string | null;
}>;
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value);
function dataRecord(value: unknown, names: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  const present = optional.filter(name => keys.includes(name));
  if (keys.length !== names.length + present.length || keys.some(key => typeof key !== 'string' || !names.includes(key) && !optional.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of [...names, ...present]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) return null;
    result[key] = field.value;
  }
  return result;
}
function dataArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const count = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count > max || Reflect.ownKeys(value).length !== count + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < count; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) return null;
    result.push(field.value);
  }
  return result;
}
/** Read-only projection. A review is never a draft, approval or retry request. */
export function normalizeAutopilotReviewPage(raw: unknown, organizationId?: string): AutopilotReviewPage | null {
  try {
    if (!identifier(organizationId)) return null;
    const page = dataRecord(raw, ['organizationId', 'items', 'nextCursor']);
    if (!page || page.organizationId !== organizationId || page.nextCursor !== null &&
      (typeof page.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(page.nextCursor))) return null;
    const rows = dataArray(page.items, 50); if (!rows) return null;
    const items: AutopilotReviewItem[] = [], proposals = new Map<string, string>(), sources = new Map<string, string>();
    for (const rawItem of rows) {
      const item = dataRecord(rawItem, ['proposalId', 'sourceId', 'createdAt', 'disposition', 'reasons', 'requiresHumanValidation'], ['usualRequested']);
      if (item && 'usualRequested' in item && typeof item.usualRequested !== 'boolean') return null;
      if (!item || !identifier(item.proposalId) || !identifier(item.sourceId) || item.disposition !== 'needs_review'
        || item.requiresHumanValidation !== true || typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt)
        || item.createdAt < 1 || item.createdAt > 253402300799) return null;
      const reasons = dataArray(item.reasons, AUTOPILOT_REVIEW_REASONS.length);
      if (!reasons || reasons.length < 1 || new Set(reasons).size !== reasons.length
        || reasons.some(reason => typeof reason !== 'string' || !AUTOPILOT_REVIEW_REASONS.includes(reason as AutopilotReviewReason))) return null;
      const captured: AutopilotReviewItem = Object.freeze({ proposalId: item.proposalId, sourceId: item.sourceId,
        createdAt: item.createdAt, disposition: 'needs_review', reasons: Object.freeze(reasons as AutopilotReviewReason[]), requiresHumanValidation: true,
        ...(item.usualRequested === true ? { usualRequested: true as const } : {}) });
      const serialized = JSON.stringify(captured);
      if (proposals.has(captured.proposalId) && proposals.get(captured.proposalId) !== serialized
        || sources.has(captured.sourceId) && sources.get(captured.sourceId) !== captured.proposalId) return null;
      if (!proposals.has(captured.proposalId)) items.push(captured);
      proposals.set(captured.proposalId, serialized); sources.set(captured.sourceId, captured.proposalId);
    }
    return Object.freeze({ organizationId, items: Object.freeze(items), nextCursor: page.nextCursor as string | null });
  } catch { return null; }
}

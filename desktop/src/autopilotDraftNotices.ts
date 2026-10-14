import { normalizeConfirmedQuoteActivityPage, type ConfirmedQuoteActivity, type ConfirmedQuoteActivityPage } from './confirmedQuoteActivity';
import { resolveConfirmedQuoteDestination } from './confirmedQuoteDestination';

export const QUOTE_ACTIVITY_LIVE_SELECTOR = 'quote-activity-live-v2';
const MAX_PENDING = 100;
type Cursor = Readonly<{ raw: string; identity: string; sequence: number }>;
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(value);
function cursor(raw: string | null, organizationId: string): Cursor | null {
  try {
    if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    const bytes = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'confirmed-quote-changes-v2'
      || data[1] !== organizationId || !data.slice(1, 4).every(identifier)
      || typeof data[4] !== 'number' || !Number.isSafeInteger(data[4]) || data[4] < 0) return null;
    const canonical = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    return canonical === raw ? { raw, identity: JSON.stringify(data.slice(1, 4)), sequence: data[4] } : null;
  } catch { return null; }
}

export function selectAutopilotDraftNotices(pending: readonly ConfirmedQuoteActivity[], organizationId: string,
  origin: Parameters<typeof resolveConfirmedQuoteDestination>[0]['origin'],
  workspace: Parameters<typeof resolveConfirmedQuoteDestination>[1], identity: Parameters<typeof resolveConfirmedQuoteDestination>[2],
  current: Parameters<typeof resolveConfirmedQuoteDestination>[3]) {
  let draft: ConfirmedQuoteActivity | null = null;
  const handled: string[] = [];
  for (const item of pending) {
    const destination = resolveConfirmedQuoteDestination({ organizationId, quoteId: item.quoteId, origin }, workspace, identity, current);
    if (destination.kind !== 'available') continue;
    if (destination.quote.status === 'draft') draft ??= item;
    else if (['issued', 'accepted', 'refused', 'expired', 'cancelled'].includes(destination.quote.status)) handled.push(item.activityId);
  }
  return Object.freeze({ draft, handled: Object.freeze(handled) });
}
export function resolveAutopilotDraftNotice(...args: Parameters<typeof selectAutopilotDraftNotices>): ConfirmedQuoteActivity | null {
  return selectAutopilotDraftNotices(...args).draft;
}

/** Session-only v2 cursor. It is a read selector, never writing authority.
 * Cursor + captured pending items advance atomically, without a timestamp
 * watermark or an unbounded history set. A full queue pauses reads, not work. */
export function createAutopilotDraftNotices() {
  let scope: string | null = null, position: Cursor | null = null, more = false;
  let preview: ConfirmedQuoteActivityPage | null = null;
  let pending: readonly ConfirmedQuoteActivity[] = Object.freeze([]);
  const bind = (key: string) => {
    if (scope !== key) { scope = key; position = null; more = false; preview = null; pending = Object.freeze([]); }
  };
  const selection = () => {
    const limit = Math.min(50, MAX_PENDING - pending.length);
    return limit ? Object.freeze({ limit, cursor: position?.raw ?? QUOTE_ACTIVITY_LIVE_SELECTOR }) : null;
  };
  return {
    hasBaseline(key: string) { bind(key); return position !== null; },
    selection(key: string) { bind(key); return selection(); },
    needsDrain(key: string) { bind(key); return more && selection() !== null; },
    preview(key: string) { bind(key); return preview; },
    observe(key: string, organizationId: string, raw: unknown, requested: Readonly<{ limit: number; cursor: string }>): boolean {
      bind(key);
      const page = normalizeConfirmedQuoteActivityPage(raw, organizationId);
      const next = page && cursor(page.nextCursor, organizationId), wanted = selection();
      if (!page || !next || !wanted || requested.cursor !== wanted.cursor || !Number.isSafeInteger(requested.limit)
        || requested.limit < 1 || requested.limit > wanted.limit
        || page.items.length > requested.limit) return false;
      if (!position && next.sequence === 0 && page.items.length > 0) return false;
      if (position && (next.identity !== position.identity || next.sequence < position.sequence
        || next.sequence === position.sequence && page.items.length > 0)) return false;
      const known = new Map([...(preview?.items ?? []), ...pending].map(item => [item.activityId, JSON.stringify(item)]));
      if (page.items.some(item => known.has(item.activityId) && known.get(item.activityId) !== JSON.stringify(item))) return false;
      const fresh = position ? page.items.filter(item => !known.has(item.activityId)) : [];
      if (pending.length + fresh.length > MAX_PENDING) return false;
      const incoming = new Set(page.items.map(item => item.activityId));
      const items = position ? [...(preview?.items ?? []).filter(item => !incoming.has(item.activityId)), ...page.items].slice(-50) : [...page.items];
      const capturedPreview = normalizeConfirmedQuoteActivityPage({ organizationId, items, nextCursor: null }, organizationId);
      if (!capturedPreview) return false;
      // Baseline is silent even when it contains50 items. Subsequent full
      // batches are drained; one final empty read is harmless at exact limits.
      more = position !== null && page.items.length === requested.limit;
      pending = fresh.length ? Object.freeze([...pending, ...fresh]) : pending;
      preview = capturedPreview;
      position = next;
      return true;
    },
    pending(key: string): readonly ConfirmedQuoteActivity[] { bind(key); return pending; },
    consume(key: string, activityIds: readonly string[]) {
      if (scope !== key) return false;
      const ids = new Set(activityIds), found = pending.some(item => ids.has(item.activityId));
      pending = Object.freeze(pending.filter(item => !ids.has(item.activityId)));
      return found;
    },
  };
}

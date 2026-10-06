import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { database } from '@/lib/runtime';
import { prepaidProduct } from './prepaid-catalog';
import { ownedPrepaidReceipt } from './prepaid-receipt';
import { prepaidReceiptPath } from './prepaid-receipt-types';
import { validPostFinanceTargetId } from './postfinance-client-navigation';

/** Recover the receipt after a lost response. SELECT only, no provider retry. */
export async function runPostFinanceAttempt(
  request: Request,
  deps: {
    user?: () => Promise<ZentraUser | null>;
    database?: () => Pick<D1Database, 'prepare'>;
    receipt?: typeof ownedPrepaidReceipt;
  } = {},
) {
  const headers = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
    'Referrer-Policy': 'same-origin',
  };
  const answer = (code: string, status: number) =>
    Response.json({ code }, { status, headers });
  try {
    if (request.method !== 'GET') return answer('method_not_allowed', 405);
    if (
      request.headers.has('Authorization') ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site'
    )
      return answer('account_required', 401);
    const user = await (
      deps.user ??
      (() => getZentraUser({ refreshSession: true, offerAccess: false }))
    )();
    if (!user?.emailConfirmed) return answer('account_required', 401);
    const params = new URL(request.url).searchParams;
    const allowed = ['requestId', 'product', 'organizationId', 'workspaceId'];
    if (
      [...params.keys()].some((key) => !allowed.includes(key)) ||
      allowed.some((key) => params.getAll(key).length > 1) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        params.get('requestId') ?? '',
      ) ||
      !prepaidProduct(params.get('product')) ||
      ['organizationId', 'workspaceId'].some(
        (key) => params.has(key) && !validPostFinanceTargetId(params.get(key)),
      )
    )
      return answer('attempt_not_found', 404);
    const db = (deps.database ?? database)();
    const found = await db
      .prepare(`SELECT intent_id FROM purchase_intents WHERE owner_id=? AND provider='postfinance'
      AND organization_id IS ? AND workspace_id IS ? AND json_valid(parameters) AND length(CAST(parameters AS BLOB))<=16384
      AND NOT EXISTS(SELECT 1 FROM json_tree(parameters) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
      AND json_extract(parameters,'$.requestId')=? AND json_extract(parameters,'$.productKey')=? LIMIT 2`)
      .bind(
        user.userId,
        params.get('organizationId'),
        params.get('workspaceId'),
        params.get('requestId'),
        params.get('product'),
      )
      .all<{ intent_id: string }>();
    if (
      found.results.length !== 1 ||
      !(await (deps.receipt ?? ownedPrepaidReceipt)(
        user,
        found.results[0].intent_id,
        { database: () => db },
      ))
    )
      return answer('attempt_not_found', 404);
    return Response.json(
      { receiptHref: prepaidReceiptPath(found.results[0].intent_id) },
      { headers },
    );
  } catch {
    console.warn('zentra_payment_attempt', {
      provider: 'postfinance',
      code: 'attempt_unavailable',
    });
    return answer('attempt_unavailable', 503);
  }
}

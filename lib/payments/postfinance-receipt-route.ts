import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { noStoreHeaders } from '@/lib/stripe';
import { ownedPrepaidReceipt } from './prepaid-receipt';
import { validPrepaidReceiptId } from './prepaid-receipt-types';

/** Polling never calls a provider, dispatches a payment, or modifies a quota. */
export async function runPostFinanceReceipt(request: Request, dependencies: {
  user?: () => Promise<ZentraUser | null>;
  receipt?: typeof ownedPrepaidReceipt;
} = {}) {
  const headers = new Headers(noStoreHeaders());
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('Vary', 'Cookie');
  headers.set('Referrer-Policy', 'same-origin');
  const answer = (code: string, status: number) => Response.json({ code }, { status, headers });
  try {
    if (request.method !== 'GET') return answer('method_not_allowed', 405);
    if (request.headers.has('Authorization') || request.headers.get('Sec-Fetch-Site') === 'cross-site') return answer('account_required', 401);
    const user = await (dependencies.user ?? (() => getZentraUser({ refreshSession: true, offerAccess: false })))();
    if (!user || user.emailConfirmed !== true) return answer('account_required', 401);
    const params = new URL(request.url).searchParams;
    if (params.getAll('achat').length !== 1 || [...params.keys()].some(key => key !== 'achat') || !validPrepaidReceiptId(params.get('achat'))) return answer('receipt_not_found', 404);
    const receipt = await (dependencies.receipt ?? ownedPrepaidReceipt)(user, params.get('achat'));
    return receipt ? Response.json(receipt, { headers }) : answer('receipt_not_found', 404);
  } catch {
    console.warn('zentra_payment_receipt', { provider: 'postfinance', code: 'receipt_unavailable' });
    return answer('receipt_unavailable', 503);
  }
}

import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { runtimeValue } from '@/lib/runtime';
import { prepaidProduct } from './prepaid-catalog';
import { postFinancePurchaseOption } from './postfinance-option';
import type { PostFinancePurchaseBinding } from './postfinance-purchase-configuration';

export async function runPostFinanceOption(
  request: Request,
  deps: {
    user?: () => Promise<ZentraUser | null>;
    read?: (name: PostFinancePurchaseBinding) => string;
  } = {},
) {
  const headers = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
    'Referrer-Policy': 'same-origin',
  };
  if (request.method !== 'GET')
    return Response.json(
      { code: 'method_not_allowed' },
      { status: 405, headers },
    );
  if (
    request.headers.has('Authorization') ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    return Response.json(
      { available: false, testMode: false, methods: [] },
      { headers },
    );
  const url = new URL(request.url),
    params = url.searchParams;
  if (
    params.getAll('product').length !== 1 ||
    [...params.keys()].some((key) => key !== 'product') ||
    !prepaidProduct(params.get('product'))
  )
    return Response.json(
      { code: 'product_not_found' },
      { status: 404, headers },
    );
  const option = await postFinancePurchaseOption(
    params.get('product'),
    url.origin,
    deps.user ??
      (() => getZentraUser({ refreshSession: true, offerAccess: false })),
    deps.read ?? runtimeValue,
  );
  return Response.json(option, { headers });
}

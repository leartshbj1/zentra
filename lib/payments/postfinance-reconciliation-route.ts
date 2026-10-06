import { database, runtimeValue } from '@/lib/runtime';
import {
  postFinanceWebhookConfiguration,
  type PostFinanceWebhookBinding,
} from './postfinance-runtime';
import {
  reconcilePostFinanceJobs,
  type ReconciliationListener,
} from './postfinance-reconciliation';

type Binding =
  | PostFinanceWebhookBinding
  | 'POSTFINANCE_RECONCILIATION_ENABLED'
  | 'POSTFINANCE_RECONCILIATION_TOKEN'
  | 'POSTFINANCE_RECONCILIATION_KINDS_JSON'
  | 'POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED';
const headers = { 'Cache-Control': 'no-store, max-age=0' };
async function equalToken(expected: string, actual: string) {
  const encode = new TextEncoder();
  const [left, right] = await Promise.all(
    [expected, actual].map((value) =>
      crypto.subtle.digest('SHA-256', encode.encode(value)),
    ),
  );
  const a = new Uint8Array(left),
    b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Private scheduler entrypoint, independently disabled until staged merchant
 * verification. Request JSON/query parameters cannot supply flags or secrets. */
export async function runPostFinanceReconciliation(
  request: Request,
  dependencies: {
    read?: (name: Binding) => string;
    database?: () => Pick<D1Database, 'prepare' | 'batch'>;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const read = dependencies.read ?? runtimeValue;
  if (read('POSTFINANCE_RECONCILIATION_ENABLED') !== 'true')
    return Response.json(
      { error: 'Le rapprochement des paiements est désactivé.' },
      { status: 503, headers },
    );
  const token = read('POSTFINANCE_RECONCILIATION_TOKEN');
  const authorization = request.headers.get('Authorization') ?? '';
  if (
    !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
    authorization.length > 160 ||
    !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization) ||
    !(await equalToken(token, authorization.slice(7)))
  )
    return Response.json({ error: 'Accès refusé.' }, { status: 401, headers });
  try {
    const config = postFinanceWebhookConfiguration(read);
    if (!config) throw new Error('Disabled receipt.');
    const raw = read('POSTFINANCE_RECONCILIATION_KINDS_JSON');
    if (!raw || new TextEncoder().encode(raw).length > 8192)
      throw new Error('Invalid listener mapping.');
    const kinds: unknown = JSON.parse(raw);
    if (
      !Array.isArray(kinds) ||
      kinds.length !== config.listeners.length ||
      kinds.length > 16
    )
      throw new Error('Invalid listener mapping.');
    const mapping = new Map<number, ReconciliationListener['kind']>();
    for (const value of kinds) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) => !['listenerId', 'kind'].includes(key),
        ) ||
        !Number.isSafeInteger(value.listenerId) ||
        !config.listeners.some(
          (listener) => listener.id === value.listenerId,
        ) ||
        !['transaction', 'invoice', 'refund'].includes(value.kind) ||
        mapping.has(value.listenerId)
      )
        throw new Error('Invalid listener mapping.');
      mapping.set(value.listenerId, value.kind);
    }
    const listeners = config.listeners.map((listener) => ({
      ...listener,
      kind: mapping.get(listener.id)!,
    }));
    const result = await reconcilePostFinanceJobs(
      {
        ...config,
        listeners,
        enabled: true,
        settlementEvidenceVerified:
          read('POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED') === 'true',
      },
      {
        database: dependencies.database ?? database,
        fetch: dependencies.fetch,
        now: dependencies.now,
      },
      1,
    );
    return Response.json(result, { headers });
  } catch {
    // No provider exception, token, request body or customer ID in diagnostics.
    console.warn('zentra_payment_reconciliation', {
      provider: 'postfinance',
      code: 'worker_unavailable',
    });
    return Response.json(
      {
        error:
          'Le rapprochement des paiements est temporairement indisponible.',
      },
      { status: 503, headers: { ...headers, 'Retry-After': '60' } },
    );
  }
}

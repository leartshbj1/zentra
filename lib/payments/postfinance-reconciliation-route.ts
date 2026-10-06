import { database, runtimeValue } from '@/lib/runtime';
import { isPrivateWorkerRequest } from '@/lib/payments/private-worker-request';
import {
  postFinanceWebhookConfiguration,
  type PostFinanceWebhookBinding,
} from '@/lib/payments/postfinance-runtime';
import {
  reconcilePostFinanceJobs,
  type ReconciliationListener,
  type PostFinanceReconciliationConfiguration,
} from '@/lib/payments/postfinance-reconciliation';
import {
  postFinancePurchaseConfiguration,
  postFinanceTestPurchaseAllowed,
  type PostFinancePurchaseBinding,
} from '@/lib/payments/postfinance-purchase-configuration';

type Binding =
  | PostFinanceWebhookBinding
  | PostFinancePurchaseBinding
  | 'POSTFINANCE_OBSERVATIONS_ENABLED'
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
  if (!(await isPrivateWorkerRequest(request)))
    return Response.json(
      { error: 'Requête invalide.' },
      { status: 400, headers },
    );
  try {
    const observationsEnabled =
      read('POSTFINANCE_OBSERVATIONS_ENABLED') === 'true';
    // When observation activation is absent, preserve the existing webhook
    // loader and its complete listener mapping. No implicit observation scope.
    const config = postFinanceWebhookConfiguration(read);
    if (!config && !observationsEnabled) throw new Error('Disabled receipt.');
    let observationConfiguration: PostFinanceReconciliationConfiguration | null =
      null;
    if (observationsEnabled) {
      const purchase = postFinancePurchaseConfiguration(read);
      // This entrypoint remains private TEST staging. The pure worker can use
      // explicit PRODUCTION fixtures, while this route cannot enable them.
      if (
        purchase.enabled !== true ||
        purchase.connection.prepaidEnvironment !== 'TEST'
      )
        throw new Error('Invalid observation configuration.');
      const rawOwners = read('POSTFINANCE_TEST_ACCOUNT_USER_IDS');
      if (!rawOwners || rawOwners.length > 4096)
        throw new Error('Invalid observation owners.');
      const ownerIds: unknown = JSON.parse(rawOwners);
      if (
        !Array.isArray(ownerIds) ||
        typeof ownerIds[0] !== 'string' ||
        !postFinanceTestPurchaseAllowed(purchase, ownerIds[0], read)
      )
        throw new Error('Invalid observation owners.');
      if (
        config &&
        (config.apiOrigin !== purchase.connection.apiOrigin ||
          config.spaceId !== purchase.connection.spaceId)
      )
        throw new Error('Inconsistent observation configuration.');
      observationConfiguration = {
        enabled: true,
        apiOrigin: purchase.connection.apiOrigin!,
        spaceId: purchase.connection.spaceId!,
        connection: purchase.connection,
        listeners: [],
        settlementEvidenceVerified: purchase.settlementEvidenceVerified,
        observations: { enabled: true, environment: 'TEST', ownerIds },
      };
    }
    const listeners: ReconciliationListener[] = [];
    if (config) {
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
      listeners.push(
        ...config.listeners.map((listener) => ({
          ...listener,
          kind: mapping.get(listener.id)!,
        })),
      );
    }
    const workerConfiguration = observationConfiguration ?? {
      ...config!,
      enabled: true,
      settlementEvidenceVerified:
        read('POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED') === 'true',
    };
    const result = await reconcilePostFinanceJobs(
      {
        ...workerConfiguration,
        listeners,
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

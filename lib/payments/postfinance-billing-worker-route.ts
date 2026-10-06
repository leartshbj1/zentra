import { database, runtimeValue } from '@/lib/runtime';
import {
  postFinancePurchaseConfiguration,
  type PostFinancePurchaseBinding,
} from './postfinance-purchase-configuration';
import { runPrepaidRenewal } from './prepaid-renewal';
import { stopCancelledPrepaidFlows } from './prepaid-cancellation';
import { prepaidMonthlyPeriod } from './prepaid-calendar';

type Binding =
  | PostFinancePurchaseBinding
  | 'POSTFINANCE_BILLING_WORKER_ENABLED'
  | 'POSTFINANCE_BILLING_WORKER_TOKEN';
const headers = { 'Cache-Control': 'no-store, max-age=0' };
// SQLite's '+1 month' on a day-31 timestamp can overflow into March. Start at
// the original anchor's month, then clamp its original day within the target
// month and retain its UTC time. These expressions match prepaidMonthlyPeriod.
function anchoredBoundary(offset: number) {
  return `CAST(strftime('%s',date(c.anchor_start,'unixepoch','start of month',
    printf('+%d months',p.ordinal+${offset}),printf('+%d days',min(
      CAST(strftime('%d',c.anchor_start,'unixepoch') AS INTEGER),
      CAST(strftime('%d',date(c.anchor_start,'unixepoch','start of month',
        printf('+%d months',p.ordinal+${offset + 1}),'-1 day')) AS INTEGER))-1))
    ||' '||strftime('%H:%M:%S',c.anchor_start,'unixepoch')) AS INTEGER)`;
}
async function equal(expected: string, actual: string) {
  const hashes = await Promise.all(
    [expected, actual].map((s) =>
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    ),
  );
  const a = new Uint8Array(hashes[0]),
    b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Explicit private scheduler, independently off by default. HTTP input never
 * chooses a company, date, amount or token. Disabling new purchases need not
 * prevent stopping an already submitted renewal: lifecycle has its own switch. */
export async function runPostFinanceBillingWorker(
  request: Request,
  dependencies: {
    read?: (name: Binding) => string;
    database?: () => Pick<D1Database, 'prepare' | 'batch'>;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const read = dependencies.read ?? runtimeValue;
  if (read('POSTFINANCE_BILLING_WORKER_ENABLED') !== 'true')
    return Response.json(
      { error: 'Le traitement des abonnements est désactivé.' },
      { status: 503, headers },
    );
  const token = read('POSTFINANCE_BILLING_WORKER_TOKEN'),
    authorization = request.headers.get('Authorization') ?? '';
  if (
    !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
    !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization) ||
    !(await equal(token, authorization.slice(7)))
  )
    return Response.json({ error: 'Accès refusé.' }, { status: 401, headers });
  if (
    request.method !== 'POST' ||
    new URL(request.url).search ||
    request.body !== null
  )
    return Response.json(
      { error: 'Requête invalide.' },
      { status: 400, headers },
    );
  try {
    const configuration = postFinancePurchaseConfiguration((name) =>
      name === 'POSTFINANCE_PURCHASES_ENABLED' ? 'true' : read(name),
    );
    const db = (dependencies.database ?? database)(),
      now = dependencies.now ?? (() => Date.now());
    const deadline = now() + 110000;
    let calls = 0;
    const transport: typeof fetch = async (input, init) => {
      if (now() >= deadline || ++calls > 64)
        throw Error('Bounded payment worker stopped.');
      return (dependencies.fetch ?? fetch)(input, {
        ...init,
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(Math.max(1, deadline - now())),
        ]),
      });
    };
    const clock = () => Math.floor(now() / 1000);
    const stopped = await stopCancelledPrepaidFlows(
      configuration,
      { database: () => db, now: clock, fetch: transport },
      1,
    );
    const c = configuration.connection;
    const due = await db
      .prepare(`SELECT c.contract_id,c.anchor_start,p.ordinal+1 AS ordinal,
      p.ends_at AS starts_at,${anchoredBoundary(2)} AS ends_at
      FROM prepaid_contracts c JOIN prepaid_purchase_projections x ON x.contract_id=c.contract_id AND x.closed_at IS NOT NULL
      JOIN prepaid_periods p ON p.contract_id=c.contract_id JOIN prepaid_settlement_proofs proof ON proof.period_id=p.period_id
      JOIN prepaid_tokens token ON token.contract_id=c.contract_id AND token.owner_id=c.owner_id
        AND token.organization_id IS c.organization_id AND token.workspace_id IS c.workspace_id
        AND token.api_origin=c.api_origin AND token.space_id=c.space_id AND token.environment=c.environment
      WHERE c.cancelled_at IS NULL AND c.api_origin=? AND c.space_id=? AND c.environment=? AND p.ends_at<=?
      AND p.ends_at=${anchoredBoundary(1)} AND ${anchoredBoundary(2)}>?
      AND proof.reconciled_at<=?
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=token.initial_period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_periods newer JOIN prepaid_settlement_proofs s ON s.period_id=newer.period_id
        WHERE newer.contract_id=c.contract_id AND newer.ordinal>p.ordinal)
      AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=c.owner_id AND a.deleted_at IS NOT NULL)
      AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o
        JOIN organization_members member ON member.organization_id=o.organization_id
        WHERE o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id
        AND member.user_id=c.owner_id AND member.role='owner' AND member.revoked_at IS NULL
        AND (c.product_key NOT LIKE 'gestion:%' AND c.product_key NOT LIKE 'complet:%' OR o.subscription_id=c.contract_id)))
      AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces workspace
        WHERE workspace.id=c.workspace_id AND workspace.owner_id=c.owner_id))
      AND NOT EXISTS(SELECT 1 FROM prepaid_periods next
        JOIN prepaid_renewal_requests renewal ON renewal.period_id=next.period_id AND renewal.contract_id=c.contract_id
        LEFT JOIN postfinance_mutations created ON created.scope_hash=renewal.create_scope_hash
        LEFT JOIN postfinance_mutations applied ON applied.scope_hash=renewal.apply_scope_hash
        WHERE next.contract_id=c.contract_id AND next.ordinal=p.ordinal+1
        AND (created.state IN ('claimed','uncertain') OR applied.scope_hash IS NOT NULL))
      ORDER BY p.ends_at,c.contract_id LIMIT 1`)
      .bind(
        c.apiOrigin!,
        c.spaceId!,
        c.prepaidEnvironment!,
        clock(),
        clock(),
        clock(),
      )
      .first<{
        contract_id: string;
        anchor_start: number;
        ordinal: number;
        starts_at: number;
        ends_at: number;
      }>();
    if (due) {
      const dates = prepaidMonthlyPeriod(due.anchor_start, due.ordinal);
      if (
        dates.startSeconds !== due.starts_at ||
        dates.endSeconds !== due.ends_at ||
        dates.startSeconds > clock() ||
        dates.endSeconds <= clock()
      )
        throw Error('Invalid selected monthly period.');
    }
    const renewal =
      due && now() < deadline
        ? await runPrepaidRenewal(
            configuration,
            { contractId: due.contract_id, ordinal: due.ordinal },
            { database: () => db, now: clock, fetch: transport },
          )
        : null;
    // No account, company, merchant token or provider body in the response/log.
    return Response.json(
      {
        stopped: stopped.stopped,
        terminalObserved: stopped.terminalObserved,
        uncertain: stopped.uncertain,
        renewal: renewal?.state ?? 'idle',
      },
      { headers },
    );
  } catch {
    console.warn('zentra_payment_billing_worker', {
      provider: 'postfinance',
      code: 'lifecycle_unavailable',
    });
    return Response.json(
      { error: 'Le traitement des abonnements doit être vérifié.' },
      { status: 503, headers: { ...headers, 'Retry-After': '60' } },
    );
  }
}

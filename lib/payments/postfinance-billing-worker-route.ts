import { database, runtimeValue } from '@/lib/runtime';
import {
  postFinancePurchaseConfiguration,
  type PostFinancePurchaseBinding,
} from './postfinance-purchase-configuration';
import {
  runPrepaidRenewal,
  PrepaidMandateAdmissionError,
} from './prepaid-renewal';
import { D1PrepaidRenewalAdmission } from './prepaid-renewal-admission';
import { stopCancelledPrepaidFlows } from './prepaid-cancellation';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import { isPrivateWorkerRequest } from './private-worker-request';

type Binding =
  | PostFinancePurchaseBinding
  | 'POSTFINANCE_BILLING_WORKER_ENABLED'
  | 'POSTFINANCE_BILLING_WORKER_TOKEN';
const headers = { 'Cache-Control': 'no-store, max-age=0' };
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
  if (!(await isPrivateWorkerRequest(request)))
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
    const admissions = new D1PrepaidRenewalAdmission(db, clock);
    const due =
      now() < deadline
        ? await admissions.claimNext({
            apiOrigin: c.apiOrigin!,
            spaceId: c.spaceId!,
            environment: c.prepaidEnvironment!,
          })
        : null;
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
    let renewal: Awaited<ReturnType<typeof runPrepaidRenewal>> | null = null;
    if (due && now() < deadline) {
      try {
        renewal = await runPrepaidRenewal(
          configuration,
          { contractId: due.contract_id, ordinal: due.ordinal },
          { database: () => db, now: clock, fetch: transport },
        );
      } catch (error) {
        // Only the GET-only mandate check can be deferred. Never turn an
        // uncertain merchant operation into a fresh financial attempt.
        if (!(error instanceof PrepaidMandateAdmissionError)) throw error;
        if (!(await admissions.defer(due, error.code)))
          throw Error('Scheduling lease lost.');
      }
      if (renewal && !(await admissions.complete(due)))
        throw Error('Scheduling lease lost.');
    }
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

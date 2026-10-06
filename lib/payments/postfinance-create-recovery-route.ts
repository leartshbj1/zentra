import { getZentraUser, type ZentraUser } from "@/app/zentra-auth";
import { database, runtimeValue } from "@/lib/runtime";
import { readTextBodyWithinLimit, RequestBodyError } from "@/lib/request-body";
import {
  postFinancePurchaseConfiguration,
  postFinanceTestPurchaseAllowed,
  type PostFinancePurchaseBinding,
} from "./postfinance-purchase-configuration";
import { ownedPrepaidReceipt } from "./prepaid-receipt";
import { prepaidReceiptPath, validPrepaidReceiptId } from "./prepaid-receipt-types";
import { recoverPrepaidCreate, PrepaidCreateRecoveryError } from "./prepaid-create-recovery";
import { D1PrepaidObservations } from "./prepaid-observation-store";
import { ownedPostFinanceInitialRecoveryTarget } from "./postfinance-option";

type Database = Pick<D1Database, "prepare" | "batch">;
export type PostFinanceCreateRecoveryBinding =
  | PostFinancePurchaseBinding
  | "POSTFINANCE_CREATE_RECOVERY_ENABLED";

/** Only discovers an already attempted first CREATE. The browser cannot choose
 * a period, transaction, target, environment or price. No checkout preparation,
 * confirm, ChargeFlow, merchant page or paid access is dispatched here. */
export async function runPostFinanceCreateRecovery(
  request: Request,
  dependencies: {
    read?: (name: PostFinanceCreateRecoveryBinding) => string;
    database?: () => Database;
    user?: () => Promise<ZentraUser | null>;
    now?: () => number;
    fetch?: typeof fetch;
  } = {},
) {
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
  const answer = (code: string, status: number) => Response.json({ code }, { status, headers });
  if (request.method !== "POST") return answer("method_not_allowed", 405);

  const abort = new AbortController();
  const end = () => abort.abort(new Error("Recovery request aborted."));
  request.signal.addEventListener("abort", end, { once: true });
  if (request.signal.aborted) end();
  const timer = setTimeout(end, 30_000);
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(new Error("Recovery request aborted."));
    abort.signal.addEventListener("abort", rejectAborted, { once: true });
    if (abort.signal.aborted) rejectAborted();
  });
  const current = () => abort.signal.throwIfAborted();

  try {
    return await Promise.race([
      aborted,
      (async () => {
        current();
        const read = dependencies.read ?? runtimeValue;
        if (read("POSTFINANCE_CREATE_RECOVERY_ENABLED") !== "true")
          return answer("recovery_unavailable", 503);
        const configuration = postFinancePurchaseConfiguration(read);
        if (!configuration.enabled) return answer("recovery_unavailable", 503);
        const origin = configuration.connection.returnOrigin!;
        if (
          request.headers.has("Authorization") ||
          request.headers.get("Origin") !== origin ||
          new URL(request.url).origin !== origin ||
          ![null, "same-origin", "none"].includes(request.headers.get("Sec-Fetch-Site"))
        )
          return answer("account_required", 403);
        const readUser =
          dependencies.user ?? (() => getZentraUser({ refreshSession: true, offerAccess: false }));
        const user = await readUser();
        current();
        if (!user || user.emailConfirmed !== true) return answer("account_required", 401);
        if (!postFinanceTestPurchaseAllowed(configuration, user.userId, read))
          return answer("recovery_not_allowed", 403);
        if (
          request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
          "application/json"
        )
          return answer("invalid_request", 415);
        const body = await readTextBodyWithinLimit(request, 512);
        current();
        // The one-key wire format also rejects duplicate JSON keys and escapes.
        const match = /^\s*\{\s*"purchaseId"\s*:\s*"(purchase_[a-f0-9-]+)"\s*\}\s*$/.exec(body);
        if (!match || !validPrepaidReceiptId(match[1])) return answer("invalid_request", 400);
        const purchaseId = match[1];
        const db = (dependencies.database ?? database)();
        const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
        const seconds = now();
        if (!Number.isSafeInteger(seconds) || seconds <= 0)
          return answer("recovery_unavailable", 503);
        // Dedicated, owner-wide 5/30min budget; it neither consumes nor resets the
        // checkout budget. The counter claim is atomic, including concurrent tabs.
        const window = Math.floor(seconds / 1800) * 1800;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`postfinance:create-recovery:${user.userId}:${window}`),
        );
        const key = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        current();
        const count = await db
          .prepare(`INSERT INTO checkout_rate_limits(rate_key,count,window_started_at,expires_at)
        VALUES(?,1,?,?) ON CONFLICT(rate_key) DO UPDATE SET count=count+1 RETURNING count`)
          .bind(key, window, window + 1800)
          .first<{ count: number }>();
        current();
        if (!count || !Number.isSafeInteger(count.count) || count.count > 5)
          return answer("recovery_rate_limited", 429);
        const receipt = await ownedPrepaidReceipt(user, purchaseId, {
          database: () => db,
          now,
        });
        current();
        if (!receipt) return answer("receipt_not_found", 404);
        const found = await ownedPostFinanceInitialRecoveryTarget(
          db,
          user,
          purchaseId,
          receipt.environment,
          configuration,
        );
        current();
        if (!found) return answer("receipt_not_found", 404);
        const transport = dependencies.fetch ?? globalThis.fetch;
        const getOnly: typeof fetch = async (input, init) => {
          current();
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (
            init?.method !== "GET" ||
            url.origin !== configuration.connection.apiOrigin ||
            !/^\/api\/v2\.0\/payment\/transactions\/(search|[1-9][0-9]*)$/.test(url.pathname) ||
            url.username ||
            url.password ||
            (init.headers as Record<string, string> | undefined)?.Space !==
              String(configuration.connection.spaceId)
          )
            throw new Error("Recovery transport refused.");
          const response = await transport(input, {
            ...init,
            signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]),
          });
          current();
          return response;
        };
        const result = await recoverPrepaidCreate(
          { ...configuration, createRecoveryEnabled: true },
          { periodId: found.period_id },
          { database: () => db, now, fetch: getOnly, signal: abort.signal },
        );
        current();
        // Refresh authentication and SQL ownership after the provider reads. A
        // changed session or role cannot receive even an old private receipt link.
        const fresh = await readUser();
        current();
        if (!fresh || fresh.userId !== user.userId || fresh.emailConfirmed !== true)
          return answer("account_required", 401);
        if (!postFinanceTestPurchaseAllowed(configuration, fresh.userId, read))
          return answer("recovery_not_allowed", 403);
        if (
          !(await ownedPrepaidReceipt(fresh, purchaseId, {
            database: () => db,
            now,
          }))
        )
          return answer("receipt_not_found", 404);
        current();
        let tracking = false;
        if (result.state === "bound") {
          const evidence = await db
            .prepare(
              "SELECT evidence_fingerprint FROM prepaid_create_recoveries WHERE period_id=? AND transaction_id=?",
            )
            .bind(result.periodId, result.transactionId)
            .first<{ evidence_fingerprint: string }>();
          current();
          if (!evidence || !/^[a-f0-9]{64}$/.test(evidence.evidence_fingerprint))
            throw new Error("Missing recovery admission.");
          const admitted = await new D1PrepaidObservations(db, now).ensureCreateRecoveryAdmission({
            periodId: result.periodId,
            transactionId: result.transactionId,
            recoveryEvidenceFingerprint: evidence.evidence_fingerprint,
          });
          current();
          tracking = admitted.state !== "failed";
        }
        return Response.json(
          {
            state: tracking ? "tracking" : "verification_required",
            receiptHref: prepaidReceiptPath(purchaseId),
          },
          { headers },
        );
      })(),
    ]);
  } catch (error) {
    if (error instanceof RequestBodyError) return answer("invalid_request", error.status);
    if (
      error instanceof PrepaidCreateRecoveryError &&
      ["binding", "not-claimed"].includes(error.code)
    )
      return answer("recovery_verification_required", 409);
    console.warn("zentra_payment_create_recovery", {
      provider: "postfinance",
      code: "recovery_unavailable",
    });
    return answer("recovery_unavailable", 503);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", end);
    abort.signal.removeEventListener("abort", rejectAborted);
  }
}

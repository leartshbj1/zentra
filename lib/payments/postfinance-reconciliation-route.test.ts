import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/runtime", () => ({ database: vi.fn(), runtimeValue: () => "" }));
import { runPostFinanceReconciliation } from "@/lib/payments/postfinance-reconciliation-route";
import { prepaidProduct } from "@/lib/payments/prepaid-catalog";
import { POST } from "@/app/api/payments/postfinance/reconcile/route";
const token = "synthetic_scheduler_token_".padEnd(43, "x");
function dependencies(patch: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    POSTFINANCE_RECONCILIATION_ENABLED: "true",
    POSTFINANCE_RECONCILIATION_TOKEN: token,
    POSTFINANCE_WEBHOOKS_ENABLED: "true",
    POSTFINANCE_API_ORIGIN: "https://checkout.postfinance.ch",
    POSTFINANCE_APPLICATION_USER_ID: "512",
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    POSTFINANCE_SPACE_ID: "405",
    POSTFINANCE_WEBHOOK_LISTENERS_JSON: JSON.stringify([
      { id: 10, entityId: 20, technicalName: "Transaction" },
    ]),
    POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
      { listenerId: 10, kind: "transaction" },
    ]),
    ...patch,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error("No merchant request in route gate test.");
  });
  const database = vi.fn(
    () =>
      ({
        batch: async () => {
          throw Error("Guard-only fixture must never execute a provisioning batch.");
        },
        prepare: () => {
          const statement = {
            bind: () => statement,
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          };
          return statement;
        },
      }) as unknown as Pick<D1Database, "prepare" | "batch">,
  );
  return { read: (key: string) => env[key] ?? "", fetch, database };
}
function request(
  authorization = `Bearer ${token}`,
  options: { body?: string; suffix?: string; method?: string } = {},
) {
  return new Request(
    "https://zentra.example.test/api/payments/postfinance/reconcile" + (options.suffix ?? ""),
    {
      method: options.method ?? "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    },
  );
}
beforeEach(() => vi.restoreAllMocks());
describe("private, independently disabled PostFinance worker route", () => {
  it("keeps the real route disabled with absent server flags", async () => {
    expect((await POST(request())).status).toBe(503);
  });
  it.each(["", "false", "TRUE", "1"])(
    "does not accept request flags when server flag is %s",
    async (value) => {
      const deps = dependencies({ POSTFINANCE_RECONCILIATION_ENABLED: value });
      const response = await runPostFinanceReconciliation(request(), deps);
      expect(response.status).toBe(503);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["", `Bearer ${"z".repeat(43)}`, "Basic abc", `Bearer ${"z".repeat(200)}`])(
    "rejects a missing or wrong scheduler secret",
    async (auth) => {
      const deps = dependencies();
      const response = await runPostFinanceReconciliation(request(auth), deps);
      expect(response.status).toBe(401);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { POSTFINANCE_RECONCILIATION_TOKEN: "" },
    { POSTFINANCE_WEBHOOKS_ENABLED: "false" },
    { POSTFINANCE_RECONCILIATION_KINDS_JSON: "[]" },
    {
      POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
        { listenerId: 11, kind: "transaction" },
      ]),
    },
    {
      POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
        { listenerId: 10, kind: "transaction", enabled: true },
      ]),
    },
    {
      POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
        { listenerId: 10, kind: "unapproved" },
      ]),
    },
  ])("fails closed for invalid server configuration", async (patch) => {
    const deps = dependencies(patch);
    const response = await runPostFinanceReconciliation(request(), deps);
    expect([401, 503]).toContain(response.status);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(token);
  });
  it.each([undefined, "{}"])(
    "returns honest idle counters with scheduler envelope %s and no merchant calls",
    async (body) => {
      const deps = dependencies();
      const response = await runPostFinanceReconciliation(request(undefined, { body }), deps);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.json()).toEqual({
        state: "processed",
        claimed: 0,
        completed: 0,
        waiting: 0,
        settlementWaiting: 0,
        failures: 0,
        lost: 0,
      });
      expect(deps.database).toHaveBeenCalledOnce();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { body: '{"enabled":true,"maximumJobs":4}' },
    { suffix: "?enabled=true" },
    { body: "[]" },
    { body: " ".repeat(65) + "{}" },
    { method: "GET" },
  ])("rejects caller-controlled work before database and provider %j", async (options) => {
    const deps = dependencies();
    const response = await runPostFinanceReconciliation(request(undefined, options), deps);
    expect(response.status).toBe(400);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

const testOwner = "11111111-1111-4111-8111-111111111111";
function observationDependencies(patch: Record<string, string | undefined> = {}) {
  const product = prepaidProduct("gestion:start")!;
  return dependencies({
    POSTFINANCE_OBSERVATIONS_ENABLED: "true",
    POSTFINANCE_WEBHOOKS_ENABLED: "false",
    POSTFINANCE_PURCHASES_ENABLED: "true",
    POSTFINANCE_MERCHANT_APPROVED: "true",
    POSTFINANCE_CHARGE_FLOW_ENABLED: "true",
    POSTFINANCE_PAY_TOKEN_ENABLED: "true",
    POSTFINANCE_PREPAID_ENVIRONMENT: "TEST",
    POSTFINANCE_RETURN_ORIGIN: "https://zentra.example.test",
    POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify([testOwner]),
    POSTFINANCE_PREPAID_CONNECTORS_JSON: JSON.stringify({
      postfinance_pay: 92,
    }),
    POSTFINANCE_PREPAID_CATALOG_JSON: JSON.stringify({
      [product.productKey]: {
        currency: "CHF",
        billingPeriod: "P1M",
        priceChfMinor: product.priceChfMinor,
        reference: product.catalogVersion,
        name: product.name,
        methodConfigurations: { postfinance_pay: 91 },
      },
    }),
    ...patch,
  });
}
describe("independent private TEST observation route with real strict configuration loaders", () => {
  it("approved PRODUCTION observations use the real server scope and no TEST identity list", async () => {
    const deps = observationDependencies({
      POSTFINANCE_PREPAID_ENVIRONMENT: "PRODUCTION",
      POSTFINANCE_PRODUCTION_ENABLED: "true",
      POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: "true",
      POSTFINANCE_TEST_ACCOUNT_USER_IDS: "not-read",
    });
    const reads: string[] = [];
    const response = await runPostFinanceReconciliation(request(), {
      ...deps,
      read: (key) => {
        reads.push(key);
        if (key === "POSTFINANCE_TEST_ACCOUNT_USER_IDS")
          throw Error("Production cannot read TEST list");
        return deps.read(key);
      },
    });
    expect(response.status).toBe(200);
    expect(deps.database).toHaveBeenCalledOnce();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(reads).not.toContain("POSTFINANCE_TEST_ACCOUNT_USER_IDS");
  });
  it.each(["", "false", "TRUE", "1", " true"])(
    "PRODUCTION observations cannot bypass activation %j",
    async (flag) => {
      const deps = observationDependencies({
        POSTFINANCE_PREPAID_ENVIRONMENT: "PRODUCTION",
        POSTFINANCE_PRODUCTION_ENABLED: flag,
        POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: "true",
      });
      expect((await runPostFinanceReconciliation(request(), deps)).status).toBe(503);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED", "POSTFINANCE_MERCHANT_APPROVED"])(
    "PRODUCTION observations require %s",
    async (key) => {
      const deps = observationDependencies({
        POSTFINANCE_PREPAID_ENVIRONMENT: "PRODUCTION",
        POSTFINANCE_PRODUCTION_ENABLED: "true",
        POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: "true",
        [key]: "false",
      });
      expect((await runPostFinanceReconciliation(request(), deps)).status).toBe(503);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it("works with no fabricated listener and an explicitly approved TEST server connection", async () => {
    const deps = observationDependencies();
    const response = await runPostFinanceReconciliation(request(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "processed",
      claimed: 0,
      completed: 0,
    });
    expect(deps.database).toHaveBeenCalledOnce();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it.each([
    { POSTFINANCE_PURCHASES_ENABLED: "false" },
    { POSTFINANCE_MERCHANT_APPROVED: "false" },
    { POSTFINANCE_CHARGE_FLOW_ENABLED: "false" },
    {
      POSTFINANCE_PREPAID_ENVIRONMENT: "PRODUCTION",
      POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: "true",
    },
    { POSTFINANCE_PREPAID_ENVIRONMENT: "" },
    { POSTFINANCE_TEST_ACCOUNT_USER_IDS: "" },
    { POSTFINANCE_TEST_ACCOUNT_USER_IDS: "[]" },
    {
      POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify([testOwner, testOwner]),
    },
    {
      POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify(["owner@example.test"]),
    },
    {
      POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify(["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]),
    },
    {
      POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify(
        Array.from(
          { length: 21 },
          (_, i) => "11111111-1111-4111-8111-" + String(i).padStart(12, "0"),
        ),
      ),
    },
    { POSTFINANCE_AUTHENTICATION_KEY_BASE64: "invalid" },
    { POSTFINANCE_PREPAID_CATALOG_JSON: "{}" },
  ])("rejects invalid observation server settings before database or HTTP %j", async (patch) => {
    const deps = observationDependencies(patch);
    const response = await runPostFinanceReconciliation(request(), deps);
    expect(response.status).toBe(503);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(token);
  });
  it("observation activation cannot bypass the reconciliation activation or private bearer", async () => {
    const disabled = observationDependencies({
      POSTFINANCE_RECONCILIATION_ENABLED: "false",
    });
    expect((await runPostFinanceReconciliation(request(), disabled)).status).toBe(503);
    expect(disabled.database).not.toHaveBeenCalled();
    const wrong = observationDependencies();
    expect(
      (await runPostFinanceReconciliation(request("Bearer " + "z".repeat(43)), wrong)).status,
    ).toBe(401);
    expect(wrong.database).not.toHaveBeenCalled();
  });
  it("an enabled webhook source still requires its exact real listener mapping", async () => {
    const deps = observationDependencies({
      POSTFINANCE_WEBHOOKS_ENABLED: "true",
      POSTFINANCE_RECONCILIATION_KINDS_JSON: "[]",
    });
    expect((await runPostFinanceReconciliation(request(), deps)).status).toBe(503);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("does not parse observation credentials or allowlist on the preserved webhook-only path", async () => {
    const deps = dependencies();
    const reads: string[] = [];
    const read = deps.read;
    const response = await runPostFinanceReconciliation(request(), {
      ...deps,
      read: (key) => {
        reads.push(key);
        if (
          [
            "POSTFINANCE_PURCHASES_ENABLED",
            "POSTFINANCE_TEST_ACCOUNT_USER_IDS",
            "POSTFINANCE_PREPAID_ENVIRONMENT",
          ].includes(key)
        )
          throw Error("Legacy path must not read observation configuration.");
        return read(key);
      },
    });
    expect(response.status).toBe(200);
    expect(reads).not.toContain("POSTFINANCE_TEST_ACCOUNT_USER_IDS");
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

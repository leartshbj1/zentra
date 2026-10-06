import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepaidCatalog } from "./prepaid-catalog";
import { CheckoutUnavailable } from "./postfinance-client";
import {
  postFinancePurchaseConfiguration,
  postFinancePurchaseContext,
  postFinanceTestPurchaseAllowed,
  type PostFinancePurchaseBinding,
} from "./postfinance-purchase-configuration";

// Explicit fictional bindings only. Never read process.env, a Cloudflare
// runtime, a credential store or a provider API in this pure loader suite.
type Bindings = Record<PostFinancePurchaseBinding, string>;
const fakeKey = Buffer.alloc(32, 0x5a).toString("base64");
const accountId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
function bindings(): Bindings {
  return {
    POSTFINANCE_PURCHASES_ENABLED: "true",
    POSTFINANCE_PRODUCTION_ENABLED: "true",
    POSTFINANCE_MERCHANT_APPROVED: "true",
    POSTFINANCE_API_ORIGIN: "https://checkout.postfinance.ch",
    POSTFINANCE_APPLICATION_USER_ID: "512",
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: fakeKey,
    POSTFINANCE_SPACE_ID: "405",
    POSTFINANCE_RETURN_ORIGIN: "https://zentra.example.test",
    POSTFINANCE_PREPAID_ENVIRONMENT: "PRODUCTION",
    POSTFINANCE_PREPAID_CATALOG_JSON: JSON.stringify(
      Object.fromEntries(
        prepaidCatalog().map((product) => [
          product.productKey,
          {
            currency: "CHF",
            billingPeriod: "P1M",
            priceChfMinor: product.priceChfMinor,
            reference: product.catalogVersion,
            name: product.name,
            methodConfigurations: { postfinance_pay: 91, twint: 93 },
          },
        ]),
      ),
    ),
    POSTFINANCE_PREPAID_CONNECTORS_JSON: JSON.stringify({
      postfinance_pay: 92,
      twint: 94,
    }),
    POSTFINANCE_CHARGE_FLOW_ENABLED: "true",
    POSTFINANCE_PAY_TOKEN_ENABLED: "true",
    POSTFINANCE_TWINT_USER_ON_FILE_ENABLED: "true",
    POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: "true",
    POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify([accountId]),
  };
}
function reader(values: Bindings) {
  return vi.fn((name: PostFinancePurchaseBinding) => values[name]);
}
function updateCatalog(
  values: Bindings,
  change: (catalog: Record<string, Record<string, unknown>>) => void,
) {
  const catalog = JSON.parse(values.POSTFINANCE_PREPAID_CATALOG_JSON) as Record<
    string,
    Record<string, unknown>
  >;
  change(catalog);
  values.POSTFINANCE_PREPAID_CATALOG_JSON = JSON.stringify(catalog);
}
function refused(values: Bindings) {
  let caught: unknown;
  try {
    postFinancePurchaseConfiguration(reader(values));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CheckoutUnavailable);
  expect((caught as Error).message).toBe("PostFinance purchase configuration is unavailable.");
  expect(String(caught)).not.toContain(values.POSTFINANCE_AUTHENTICATION_KEY_BASE64);
}
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw Error("Pure configuration cannot use HTTP.");
  });
});

describe("opaque purchase display context contains no credentials", () => {
  const context = (v = bindings(), key: unknown = "gestion:solo", owner = accountId) =>
    postFinancePurchaseContext(
      postFinancePurchaseConfiguration(reader(v)),
      key,
      "https://zentra.example.test",
      owner,
    );
  it("is deterministic canonical base64url and independent of credential rotation", async () => {
    const v = bindings(),
      first = await context(v);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await context(v)).toBe(first);
    v.POSTFINANCE_AUTHENTICATION_KEY_BASE64 = Buffer.alloc(32, 0x31).toString("base64");
    expect(await context(v)).toBe(first);
    expect(first).not.toContain(fakeKey);
  });
  it.each([
    "owner",
    "product",
    "environment",
    "Space",
    "application",
    "method",
    "connector",
    "token-policy",
  ])("%s drift invalidates the displayed snapshot", async (field) => {
    const v = bindings(),
      first = await context(v);
    let key = "gestion:solo",
      owner = accountId;
    if (field === "owner") owner = otherId;
    if (field === "product") key = "support:starter";
    if (field === "environment") v.POSTFINANCE_PREPAID_ENVIRONMENT = "TEST";
    if (field === "Space") v.POSTFINANCE_SPACE_ID = "406";
    if (field === "application") v.POSTFINANCE_APPLICATION_USER_ID = "513";
    if (field === "method")
      updateCatalog(v, (c) => {
        (c["gestion:solo"].methodConfigurations as Record<string, unknown>).postfinance_pay = 191;
      });
    if (field === "connector")
      v.POSTFINANCE_PREPAID_CONNECTORS_JSON = JSON.stringify({ postfinance_pay: 192, twint: 94 });
    if (field === "token-policy") {
      v.POSTFINANCE_TWINT_USER_ON_FILE_ENABLED = "false";
      updateCatalog(v, (c) => {
        for (const p of Object.values(c)) p.methodConfigurations = { postfinance_pay: 91 };
      });
    }
    expect(await context(v, key, owner)).not.toBe(first);
  });
  it("returns no context for disabled, absent product or foreign origin", async () => {
    const v = bindings();
    v.POSTFINANCE_PURCHASES_ENABLED = "false";
    expect(await context(v)).toBeNull();
    const c = postFinancePurchaseConfiguration(reader(bindings()));
    expect(
      await postFinancePurchaseContext(c, "unknown", "https://zentra.example.test", accountId),
    ).toBeNull();
    expect(
      await postFinancePurchaseContext(
        c,
        "gestion:solo",
        "https://foreign.example.test",
        accountId,
      ),
    ).toBeNull();
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
});

describe("private PostFinance purchase configuration loader", () => {
  it.each(["", "false", "TRUE", "1", " true", "true ", "yes"])(
    "off switch %j reads exactly one flag and no credentials",
    (value) => {
      const read = vi.fn((name: PostFinancePurchaseBinding) => {
        if (name !== "POSTFINANCE_PURCHASES_ENABLED")
          throw Error("Credentials must remain unread while disabled.");
        return value;
      });
      expect(postFinancePurchaseConfiguration(read)).toEqual({
        enabled: false,
        settlementEvidenceVerified: false,
        connection: { enabled: false },
        connectorConfigurations: {},
      });
      expect(read.mock.calls).toEqual([["POSTFINANCE_PURCHASES_ENABLED"]]);
    },
  );
  it("loads the entire approved catalogue including Automation and every Complete plan", () => {
    const read = reader(bindings()),
      config = postFinancePurchaseConfiguration(read);
    expect(config).toMatchObject({
      enabled: true,
      settlementEvidenceVerified: true,
      connectorConfigurations: { postfinance_pay: 92, twint: 94 },
      connection: {
        enabled: true,
        apiOrigin: "https://checkout.postfinance.ch",
        spaceId: 405,
        applicationUserId: "512",
        authenticationKeyBase64: fakeKey,
        returnOrigin: "https://zentra.example.test",
        merchantApproved: true,
        prepaidFeatureEnabled: true,
        chargeFlowEnabled: true,
        prepaidEnvironment: "PRODUCTION",
        postfinancePayTokenEnabled: true,
        twintUserOnFileEnabled: true,
      },
    });
    expect(Object.keys(config.connection.prepaidProducts!).sort()).toEqual(
      prepaidCatalog()
        .map((product) => product.productKey)
        .sort(),
    );
    expect(read.mock.calls.some(([name]) => name === "POSTFINANCE_TEST_ACCOUNT_USER_IDS")).toBe(
      false,
    );
    for (const product of prepaidCatalog())
      expect(config.connection.prepaidProducts![product.productKey]).toEqual({
        currency: "CHF",
        billingPeriod: "P1M",
        priceChfMinor: product.priceChfMinor,
        reference: product.catalogVersion,
        name: product.name,
        methodConfigurations: { postfinance_pay: 91, twint: 93 },
      });
  });
  it.each(prepaidCatalog().map((product) => product.productKey))(
    "supports server staging of exact single catalogue product %s",
    (productKey) => {
      const values = bindings();
      updateCatalog(values, (catalog) => {
        for (const key of Object.keys(catalog)) if (key !== productKey) delete catalog[key];
      });
      expect(
        Object.keys(postFinancePurchaseConfiguration(reader(values)).connection.prepaidProducts!),
      ).toEqual([productKey]);
    },
  );
  it("accepts the second explicit API origin without defaulting to it", () => {
    const values = bindings();
    values.POSTFINANCE_API_ORIGIN = "https://app-wallee.com";
    expect(postFinancePurchaseConfiguration(reader(values)).connection.apiOrigin).toBe(
      "https://app-wallee.com",
    );
  });
  it.each([
    "",
    "http://checkout.postfinance.ch",
    "https://checkout.postfinance.ch/",
    "https://checkout.postfinance.ch/api",
    "https://checkout.postfinance.ch.example.test",
    "https://app-wallee.com:444",
    "https://user@checkout.postfinance.ch",
    "HTTPS://checkout.postfinance.ch",
  ])("rejects unapproved API origin %j", (value) => {
    const values = bindings();
    values.POSTFINANCE_API_ORIGIN = value;
    refused(values);
  });
  it.each(["", "0", "-1", "1.1", "NaN", "Infinity", "9007199254740992"])(
    "rejects nonpositive/unsafe Space %j",
    (value) => {
      const values = bindings();
      values.POSTFINANCE_SPACE_ID = value;
      refused(values);
    },
  );
  it.each([
    "",
    "0",
    "-1",
    "01",
    "512 ",
    "+512",
    "5.12e2",
    "0x200",
    "1.1",
    "9007199254740992",
    "10000000000000000",
  ])("rejects noncanonical or unsafe application user ID %j", (value) => {
    const values = bindings();
    values.POSTFINANCE_APPLICATION_USER_ID = value;
    refused(values);
  });
  it.each(["", "false", "1", "TRUE", " true"])(
    "merchant and Charge Flow each require exact true (%j)",
    (value) => {
      for (const name of [
        "POSTFINANCE_MERCHANT_APPROVED",
        "POSTFINANCE_CHARGE_FLOW_ENABLED",
      ] as const) {
        const values = bindings();
        values[name] = value;
        refused(values);
      }
    },
  );
  it.each(["", "LIVE", "test", "production", "TEST ", "PRODUCTION "])(
    "rejects unknown prepaid environment %j",
    (value) => {
      const values = bindings();
      values.POSTFINANCE_PREPAID_ENVIRONMENT = value;
      refused(values);
    },
  );
  it.each(["", "false", "TRUE", "1", " true"])(
    "PRODUCTION requires exact settlement evidence gate %j",
    (value) => {
      const values = bindings();
      values.POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED = value;
      refused(values);
    },
  );
  it("allows isolated TEST configuration without claiming verified production settlement", () => {
    const values = bindings();
    values.POSTFINANCE_PREPAID_ENVIRONMENT = "TEST";
    values.POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED = "false";
    expect(postFinancePurchaseConfiguration(reader(values))).toMatchObject({
      enabled: true,
      settlementEvidenceVerified: false,
      connection: { prepaidEnvironment: "TEST" },
    });
  });
  it.each([
    "",
    "http://zentra.example.test",
    "https://zentra.example.test/",
    "https://zentra.example.test/account",
    "https://zentra.example.test?query=1",
    "https://zentra.example.test#fragment",
    "https://user:password@zentra.example.test",
    "https://zentra.example.test:443",
    "HTTPS://zentra.example.test",
    "not a URL",
  ])("rejects noncanonical return origin %j", (value) => {
    const values = bindings();
    values.POSTFINANCE_RETURN_ORIGIN = value;
    refused(values);
  });
  it.each([
    "",
    "fictional-not-a-key",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    fakeKey.slice(0, -1),
    `${fakeKey}\n`,
    `${fakeKey.slice(0, -2)}p=`,
    Buffer.alloc(32, 255).toString("base64").replaceAll("/", "_"),
  ])("rejects malformed/wrong-sized/noncanonical synthetic authentication key %j", (value) => {
    const values = bindings();
    values.POSTFINANCE_AUTHENTICATION_KEY_BASE64 = value;
    // Avoid asserting the empty string cannot occur in an error message.
    expect(() => postFinancePurchaseConfiguration(reader(values))).toThrowError(
      new CheckoutUnavailable("PostFinance purchase configuration is unavailable."),
    );
  });
  it("masks a binding-reader error instead of propagating its synthetic secret", () => {
    const marker = "fictional-secret-cannot-escape";
    const read = vi.fn((name: PostFinancePurchaseBinding) => {
      if (name === "POSTFINANCE_AUTHENTICATION_KEY_BASE64") throw Error(marker);
      return bindings()[name];
    });
    expect(() => postFinancePurchaseConfiguration(read)).toThrowError(
      "PostFinance purchase configuration is unavailable.",
    );
    try {
      postFinancePurchaseConfiguration(read);
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });
  it.each(["", "{", "null", "[]", "42", "true", '"fictional-secret"'])(
    "rejects nonobject connector and catalogue JSON %j",
    (value) => {
      for (const name of [
        "POSTFINANCE_PREPAID_CONNECTORS_JSON",
        "POSTFINANCE_PREPAID_CATALOG_JSON",
      ] as const) {
        const values = bindings();
        values[name] = value;
        refused(values);
      }
    },
  );
  it("bounds JSON in UTF-8 bytes rather than allowing large multibyte text", () => {
    for (const name of [
      "POSTFINANCE_PREPAID_CONNECTORS_JSON",
      "POSTFINANCE_PREPAID_CATALOG_JSON",
    ] as const) {
      const values = bindings();
      values[name] += " ".repeat(16_384);
      refused(values);
      values[name] = JSON.stringify({ ["é".repeat(9000)]: 92 });
      expect(values[name].length).toBeLessThan(16_384);
      refused(values);
    }
  });
  it.each([
    {},
    { card: 92 },
    { postfinance_pay: "92", twint: 94 },
    { postfinance_pay: 0, twint: 94 },
    { postfinance_pay: 1.1, twint: 94 },
    { postfinance_pay: Number.MAX_SAFE_INTEGER + 1, twint: 94 },
    { postfinance_pay: null, twint: 94 },
  ])("rejects absent/unknown/invalid connector map %j", (value) => {
    const values = bindings();
    values.POSTFINANCE_PREPAID_CONNECTORS_JSON = JSON.stringify(value);
    refused(values);
  });
  it.each(["postfinance_pay", "twint"] as const)(
    "requires connector and token capability for configured %s",
    (method) => {
      const values = bindings();
      values.POSTFINANCE_PREPAID_CONNECTORS_JSON = JSON.stringify(
        method === "twint" ? { postfinance_pay: 92 } : { twint: 94 },
      );
      refused(values);
      const flag =
        method === "twint"
          ? "POSTFINANCE_TWINT_USER_ON_FILE_ENABLED"
          : "POSTFINANCE_PAY_TOKEN_ENABLED";
      for (const value of ["", "false", "TRUE", "1"]) {
        const invalid = bindings();
        invalid[flag] = value;
        refused(invalid);
      }
    },
  );
  it("allows a PFPay-only staged catalogue while TWINT capability is disabled", () => {
    const values = bindings();
    values.POSTFINANCE_PREPAID_CONNECTORS_JSON = JSON.stringify({
      postfinance_pay: 92,
    });
    values.POSTFINANCE_TWINT_USER_ON_FILE_ENABLED = "false";
    updateCatalog(values, (catalog) => {
      for (const product of Object.values(catalog))
        product.methodConfigurations = { postfinance_pay: 91 };
    });
    const config = postFinancePurchaseConfiguration(reader(values));
    expect(config.connection.twintUserOnFileEnabled).toBe(false);
    for (const product of Object.values(config.connection.prepaidProducts!))
      expect(product.methodConfigurations).toEqual({ postfinance_pay: 91 });
  });
  it.each(["currency", "billingPeriod", "priceChfMinor", "reference", "name"] as const)(
    "requires every exact catalogue snapshot %s",
    (field) => {
      for (const product of prepaidCatalog()) {
        const values = bindings();
        updateCatalog(values, (catalog) => {
          catalog[product.productKey][field] =
            field === "priceChfMinor" ? product.priceChfMinor + 1 : "altered";
        });
        refused(values);
        const missing = bindings();
        updateCatalog(missing, (catalog) => {
          delete catalog[product.productKey][field];
        });
        refused(missing);
      }
    },
  );
  it.each([
    {},
    null,
    [],
    { card: 91 },
    { postfinance_pay: "91" },
    { postfinance_pay: 0 },
    { postfinance_pay: -1 },
    { postfinance_pay: 1.1 },
    { postfinance_pay: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unknown/empty/invalid product method mapping %j", (value) => {
    const values = bindings();
    updateCatalog(values, (catalog) => {
      catalog.automation.methodConfigurations = value;
    });
    refused(values);
  });
  it("rejects an unknown product, an empty catalogue and additional provider/product fields", () => {
    const empty = bindings();
    empty.POSTFINANCE_PREPAID_CATALOG_JSON = "{}";
    refused(empty);
    const unknown = bindings();
    updateCatalog(unknown, (catalog) => {
      delete catalog.automation;
      catalog["unknown:plan"] = { ...Object.values(catalog)[0] };
    });
    refused(unknown);
    for (const field of ["productId", "token", "merchantSecret", "paidUntil"]) {
      const values = bindings();
      updateCatalog(values, (catalog) => {
        catalog.automation[field] = "synthetic-private-value";
      });
      refused(values);
    }
  });
  it("copies the approved product values rather than retaining a mutable parsed catalogue", () => {
    const values = bindings(),
      config = postFinancePurchaseConfiguration(reader(values));
    const before = JSON.stringify(config.connection.prepaidProducts);
    values.POSTFINANCE_PREPAID_CATALOG_JSON = "{}";
    values.POSTFINANCE_PREPAID_CONNECTORS_JSON = "{}";
    expect(JSON.stringify(config.connection.prepaidProducts)).toBe(before);
    expect(config.connectorConfigurations).toEqual({
      postfinance_pay: 92,
      twint: 94,
    });
  });
});

describe("private exact TEST identity allowlist independent of production entitlements", () => {
  function testConfiguration() {
    const values = bindings();
    values.POSTFINANCE_PREPAID_ENVIRONMENT = "TEST";
    values.POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED = "false";
    return postFinancePurchaseConfiguration(reader(values));
  }
  it("PRODUCTION requires loader evidence gate and does not read TEST identities", () => {
    const read = vi.fn(() => {
      throw Error("Production must not read private TEST allowlist.");
    });
    expect(
      postFinanceTestPurchaseAllowed(
        postFinancePurchaseConfiguration(reader(bindings())),
        accountId,
        read,
      ),
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const values = bindings();
    values.POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED = "false";
    refused(values);
  });
  it("permits only the exact authenticated ID in TEST and reads only the explicit allowlist", () => {
    const read = vi.fn((name: PostFinancePurchaseBinding) => {
      expect(name).toBe("POSTFINANCE_TEST_ACCOUNT_USER_IDS");
      return JSON.stringify([accountId]);
    });
    const config = testConfiguration();
    expect(postFinanceTestPurchaseAllowed(config, accountId, read)).toBe(true);
    expect(postFinanceTestPurchaseAllowed(config, otherId, read)).toBe(false);
    expect(
      postFinanceTestPurchaseAllowed(config, "ABCDEFAB-CDEF-ABCD-ABCD-ABCDEFABCDEF", read),
    ).toBe(false);
    expect(postFinanceTestPurchaseAllowed(config, `${accountId} `, read)).toBe(false);
    expect(config.settlementEvidenceVerified).toBe(false);
  });
  it.each([
    "",
    "{",
    "null",
    "{}",
    '"' + accountId + '"',
    "[]",
    JSON.stringify([accountId, accountId]),
    JSON.stringify([accountId, "owner@example.test"]),
    JSON.stringify([accountId, 12]),
    JSON.stringify([accountId, null]),
    JSON.stringify([accountId, {}]),
    JSON.stringify([`${accountId} `]),
    JSON.stringify(["abcdefab-cdef-abcd-abcd-abcdefabcdef".toUpperCase()]),
    JSON.stringify(["not-a-uuid"]),
    JSON.stringify([accountId.replaceAll("-", "")]),
  ])("rejects malformed/duplicate/non-UUID TEST list %j", (raw) => {
    const read = vi.fn(() => raw);
    expect(postFinanceTestPurchaseAllowed(testConfiguration(), accountId, read)).toBe(false);
  });
  it("permits 20 unique exact UUIDs and rejects a 21st even if the requested user is first", () => {
    const ids = Array.from(
      { length: 21 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(
      postFinanceTestPurchaseAllowed(testConfiguration(), ids[0], () =>
        JSON.stringify(ids.slice(0, 20)),
      ),
    ).toBe(true);
    expect(
      postFinanceTestPurchaseAllowed(testConfiguration(), ids[0], () => JSON.stringify(ids)),
    ).toBe(false);
  });
  it("rejects oversized allowlists and masks reader failures", () => {
    expect(
      postFinanceTestPurchaseAllowed(
        testConfiguration(),
        accountId,
        () => `${JSON.stringify([accountId])}${" ".repeat(4096)}`,
      ),
    ).toBe(false);
    expect(
      postFinanceTestPurchaseAllowed(testConfiguration(), accountId, () => {
        throw Error("fictional-secret-error");
      }),
    ).toBe(false);
  });
});

describe("explicit default-OFF PRODUCTION activation", () => {
  it.each(["", "false", "TRUE", "1", " true", "true "])(
    "PRODUCTION requires exact activation %j",
    (value) => {
      const v = bindings();
      v.POSTFINANCE_PRODUCTION_ENABLED = value;
      refused(v);
    },
  );
  it("TEST does not read the PRODUCTION activation flag", () => {
    const v = bindings();
    v.POSTFINANCE_PREPAID_ENVIRONMENT = "TEST";
    const read = reader(v);
    postFinancePurchaseConfiguration(read);
    expect(read.mock.calls.flat()).not.toContain("POSTFINANCE_PRODUCTION_ENABLED");
  });
});

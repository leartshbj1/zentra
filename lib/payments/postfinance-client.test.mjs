import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostFinanceCheckoutClient, CheckoutUnavailable, bearerToken,
  verifyWebhookSignature, acceptWebhook, derToP1363 } from "./postfinance-client.ts";

const fixture = JSON.parse(await readFile(new URL("./postfinance-fixtures.json", import.meta.url), "utf8"));
const encoded = new TextEncoder();
const bytes = encoded.encode(fixture.body);
const header = `algorithm=SHA256withECDSA, keyId=${fixture.keyId}, signature=${fixture.signatureDerBase64}`;
const resolveFixture = async () => fixture.publicKeySpkiBase64;
const fixedNow = Date.parse("2026-10-06T12:00:00Z");

// Test-only in-memory implementation. Production requires atomic durable storage.
class TestLedger {
  rows = new Map();
  async claim(scope, fingerprint) {
    const row = this.rows.get(scope);
    if (row && row.fingerprint !== fingerprint) return { kind: "conflict" };
    if (row?.json !== undefined) return { kind: "completed", json: row.json };
    if (row) return { kind: "uncertain" };
    this.rows.set(scope, { fingerprint });
    return { kind: "claimed" };
  }
  async complete(scope, json) { this.rows.get(scope).json = json; }
  async markUncertain(scope) { this.rows.get(scope).uncertain = true; }
}

function configuration(extra = {}) {
  return { enabled: true, applicationUserId: "512", spaceId: 405,
    authenticationKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    returnOrigin: "https://zentraapp.ch", merchantApproved: true,
    subscriptionFeatureEnabled: true, chargeFlowEnabled: true,
    postfinancePayTokenEnabled: true, twintUserOnFileEnabled: true,
    products: { gestion: { productId: 2, currency: "CHF", billingPeriod: "P1M",
      priceChfMinor: 5000, methods: ["postfinance_pay", "twint"] } }, ...extra };
}

function fixtureClient(config = configuration(), ledger = new TestLedger(), handler) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, ...init });
    if (handler) return handler(url, init);
    if (url.endsWith("/payment-page-url")) return new Response("https://checkout.postfinance.ch/s/405/payment-page/123");
    const body = url.endsWith("/initialize-subscriber-present") ? { transaction: { id: 123 } }
      : url.endsWith("/subscribers") ? { id: 11 }
      : init.method === "POST" ? { id: 99, subscription: { id: 71 }, billingCurrency: "CHF" }
      : { id: 71, state: "ACTIVE" };
    return Response.json(body);
  };
  return { requests, client: new PostFinanceCheckoutClient(config, { ledger, fetch: fetcher, now: () => fixedNow }) };
}

const createInput = { productKey: "gestion", subscriberId: 11, reference: "zentra-order-1", version: 1 };

test("validates the independent official SDK DER fixture and rejects changed raw bytes", async () => {
  await verifyWebhookSignature(bytes, header, resolveFixture);
  await assert.rejects(verifyWebhookSignature(encoded.encode(fixture.body.replace('"entityId":11', '"entityId":12')), header, resolveFixture), /Invalid webhook signature/);
  await assert.rejects(verifyWebhookSignature(encoded.encode(`${fixture.body}\n`), header, resolveFixture), /Invalid webhook signature/);
});

test("verifies P1363 signatures generated independently by WebCrypto", async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, bytes)).toString("base64");
  await verifyWebhookSignature(bytes, `algorithm=SHA256withECDSA, keyId=p1363-key, signature=${signature}`, async () => publicKey);
});

test("rejects unsupported algorithms, malformed DER, and trailing DER bytes", async () => {
  let resolutions = 0;
  await assert.rejects(verifyWebhookSignature(bytes, header.replace("SHA256withECDSA", "none"), async () => { resolutions++; return fixture.publicKeySpkiBase64; }), /unsupported/);
  assert.equal(resolutions, 0);
  assert.equal(derToP1363(new Uint8Array(Buffer.from(fixture.signatureDerBase64, "base64"))).length, 64);
  assert.throws(() => derToP1363(new Uint8Array([0x30, 6, 2, 1, 0x80, 2, 1, 1])), /Negative/);
  const original = Buffer.from(fixture.signatureDerBase64, "base64");
  assert.throws(() => derToP1363(new Uint8Array(Buffer.concat([original, Buffer.from([0])]))), /Invalid/);
});

test("durable inbox scope suppresses replay and rejects the wrong space/listener", async () => {
  const rows = new Map();
  let workCount = 0;
  const options = { keyResolver: resolveFixture, apiOrigin: "https://checkout.postfinance.ch",
    spaceId: 1, allowedListenerIds: [2], now: () => Date.parse("2023-12-19T13:43:35+0000"),
    inbox: { async acceptOnce(scope, event) { if (rows.has(scope)) return false;
      rows.set(scope, event); workCount++; return true; } } };
  assert.equal((await acceptWebhook(bytes, header, options)).duplicate, false);
  assert.equal((await acceptWebhook(bytes, header, options)).duplicate, true);
  assert.equal(workCount, 1);
  await assert.rejects(acceptWebhook(bytes, header, { ...options, spaceId: 405 }), /another configured/);
  await assert.rejects(acceptWebhook(bytes, header, { ...options, allowedListenerIds: [99] }), /another configured/);
  assert.equal(workCount, 1);
  await assert.rejects(acceptWebhook(bytes, header, { ...options, now: () => fixedNow, maxEventAgeMs: 86_400_000 }), /event-age/);
});

test("produces the official JWT header and binds method/path using independent HMAC", async () => {
  const config = configuration();
  const token = await bearerToken(config.applicationUserId, config.authenticationKeyBase64, "GET", "/api/v2.0/subscriptions/71", 1791288000);
  const [h, p, s] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "HS256", typ: "JWT", ver: 1 });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { sub: "512", iat: 1791288000,
    requestPath: "/api/v2.0/subscriptions/71", requestMethod: "GET" });
  assert.equal(createHmac("sha256", Buffer.from(config.authenticationKeyBase64, "base64")).update(`${h}.${p}`).digest("base64url"), s);
});

test("uses exact API v2 paths, Space header, scalar relations and the returned transaction ID", async () => {
  const { client, requests } = fixtureClient();
  await client.createSubscriber({ externalId: "customer-1", reference: "customer-1", emailAddress: "fixture@example.invalid", language: "fr-CH" }, "postfinance_pay");
  const created = await client.createSubscription(createInput, "postfinance_pay", "purchase-1");
  assert.equal(created.subscription.id, 71); // created.id=99 is a VERSION ID.
  const initialized = await client.initializeSubscriberPresent(created.subscription.id, "postfinance_pay",
    { successUrl: "https://zentraapp.ch/compte", failureUrl: "https://zentraapp.ch/tarifs" }, "purchase-1");
  await client.readSubscription(71);
  await client.paymentPageUrl(initialized.transaction.id);
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ["/api/v2.0/subscriptions/subscribers",
    "/api/v2.0/subscriptions", "/api/v2.0/subscriptions/71/initialize-subscriber-present",
    "/api/v2.0/subscriptions/71", "/api/v2.0/payment/transactions/123/payment-page-url"]);
  assert.deepEqual(JSON.parse(requests[1].body), { product: 2, currency: "CHF",
    subscription: { subscriber: 11, reference: "zentra-order-1", version: 1 } });
  for (const request of requests) {
    assert.equal(request.headers.Space, "405");
    assert.equal(new URL(request.url).search, "");
    assert.equal(request.headers["Idempotency-Key"], undefined);
    assert.equal(request.redirect, "error");
    const token = request.headers.Authorization.slice(7).split(".");
    const claims = JSON.parse(Buffer.from(token[1], "base64url"));
    assert.equal(claims.requestPath, new URL(request.url).pathname);
    assert.equal(claims.requestMethod, request.method);
  }
});

test("idempotence reuses a persisted result, rejects a changed body, and isolates spaces", async () => {
  const ledger = new TestLedger();
  const first = fixtureClient(configuration(), ledger);
  await first.client.createSubscription(createInput, "postfinance_pay", "purchase-1");
  await first.client.createSubscription(createInput, "postfinance_pay", "purchase-1");
  assert.equal(first.requests.length, 1);
  await assert.rejects(first.client.createSubscription({ ...createInput, subscriberId: 12 }, "postfinance_pay", "purchase-1"), /different request body/);
  assert.equal(first.requests.length, 1);
  const second = fixtureClient(configuration({ spaceId: 406 }), ledger);
  await second.client.createSubscription(createInput, "postfinance_pay", "purchase-1");
  assert.equal(second.requests.length, 1);
});

test("a journal failure after a provider success cannot trigger a second creation", async () => {
  const ledger = new TestLedger();
  ledger.complete = async () => { throw new Error("database completion unavailable"); };
  const { client, requests } = fixtureClient(configuration(), ledger);
  await assert.rejects(client.createSubscription(createInput, "postfinance_pay", "journal-failure"), /completion unavailable/);
  await assert.rejects(client.createSubscription(createInput, "postfinance_pay", "journal-failure"), /Reconcile/);
  assert.equal(requests.length, 1);
});

test("resolves the authenticated webhook key using the exact non-space-scoped SDK endpoint", async () => {
  const { client, requests } = fixtureClient(configuration(), new TestLedger(), async () => Response.json(fixture.publicKeySpkiBase64));
  await verifyWebhookSignature(bytes, header, keyId => client.webhookPublicKey(keyId));
  assert.equal(new URL(requests[0].url).pathname, `/api/v2.0/webhooks/encryption-keys/${fixture.keyId}`);
  assert.equal(requests[0].headers.Space, undefined);
  assert.match(requests[0].headers.Authorization, /^Bearer /);
});

test("a timed-out or concurrent mutation cannot produce an automatic second charge", async () => {
  let release;
  const { client, requests } = fixtureClient(configuration(), new TestLedger(), async () =>
    new Promise(resolve => { release = () => resolve(Response.json({ subscription: { id: 71 } })); }));
  const first = client.createSubscription(createInput, "postfinance_pay", "concurrent-1");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.createSubscription(createInput, "postfinance_pay", "concurrent-1"), /Reconcile/);
  release();
  await first;
  assert.equal(requests.length, 1);
  const failed = fixtureClient(configuration(), new TestLedger(), async () => { throw new Error("network timeout"); });
  await assert.rejects(failed.client.createSubscription(createInput, "postfinance_pay", "timeout-1"), /network timeout/);
  await assert.rejects(failed.client.createSubscription(createInput, "postfinance_pay", "timeout-1"), /Reconcile/);
  assert.equal(failed.requests.length, 1);
});

test("missing credentials, ledger, merchant approval, or recurring options cause zero API calls", async () => {
  for (const change of [{ enabled: false }, { authenticationKeyBase64: undefined }, { merchantApproved: false },
    { subscriptionFeatureEnabled: false }, { chargeFlowEnabled: false }, { postfinancePayTokenEnabled: false }]) {
    const { client, requests } = fixtureClient(configuration(change));
    await assert.rejects(client.createSubscription(createInput, "postfinance_pay", "blocked-1"), CheckoutUnavailable);
    assert.equal(requests.length, 0);
  }
  let called = false;
  const noLedger = new PostFinanceCheckoutClient(configuration(), { fetch: async () => { called = true; return Response.json({}); } });
  await assert.rejects(noLedger.createSubscription(createInput, "postfinance_pay", "blocked-1"), CheckoutUnavailable);
  assert.equal(called, false);
  const onlyPf = fixtureClient(configuration({ twintUserOnFileEnabled: false }));
  await onlyPf.client.createSubscription(createInput, "postfinance_pay", "pf-1");
  await assert.rejects(onlyPf.client.createSubscription(createInput, "twint", "twint-1"), CheckoutUnavailable);
  assert.equal(onlyPf.requests.length, 1);
});

test("rejects non-monthly/non-CHF products, unsafe returns, and external payment pages", async () => {
  for (const product of [{ currency: "USD" }, { billingPeriod: "P1Y" }, { priceChfMinor: 0 }, { methods: ["twint"] }]) {
    const config = configuration(); Object.assign(config.products.gestion, product);
    const { client, requests } = fixtureClient(config);
    await assert.rejects(client.createSubscription(createInput, "postfinance_pay", "invalid-product"), CheckoutUnavailable);
    assert.equal(requests.length, 0);
  }
  const { client, requests } = fixtureClient();
  await assert.rejects(client.initializeSubscriberPresent(71, "postfinance_pay",
    { successUrl: "https://attacker.invalid", failureUrl: "https://zentraapp.ch/tarifs" }, "bad-return"), /return URL/);
  assert.equal(requests.length, 0);
  const external = fixtureClient(configuration(), new TestLedger(), async () => new Response("https://attacker.invalid/pay"));
  await assert.rejects(external.client.paymentPageUrl(123), /Unapproved payment-page/);
});

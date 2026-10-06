/** Bounded PostFinance Checkout API v2 adapter. Server/Cloudflare only; no SDK. */
export type SwissMethod = "postfinance_pay" | "twint";
export type JsonObject = Record<string, unknown>;

export interface MonthlyProduct {
  productId: number;
  currency: "CHF";
  billingPeriod: "P1M";
  priceChfMinor: number;
  methods: SwissMethod[];
  componentConfigurations?: { productComponentReferenceId: number; quantity: number }[];
}

export interface CheckoutConfiguration {
  enabled: boolean;
  apiOrigin?: "https://checkout.postfinance.ch" | "https://app-wallee.com";
  applicationUserId?: string;
  authenticationKeyBase64?: string;
  spaceId?: number;
  returnOrigin?: string;
  merchantApproved?: boolean;
  subscriptionFeatureEnabled?: boolean;
  chargeFlowEnabled?: boolean;
  postfinancePayTokenEnabled?: boolean;
  twintUserOnFileEnabled?: boolean;
  products?: Record<string, MonthlyProduct>;
}

export type Claim = { kind: "claimed" } | { kind: "completed"; json: string }
  | { kind: "conflict" } | { kind: "uncertain" };

/** Implement using an atomic, durable database row. Never implement with KV get+put. */
export interface MutationLedger {
  claim(scope: string, fingerprint: string): Promise<Claim>;
  complete(scope: string, json: string): Promise<void>;
  markUncertain(scope: string): Promise<void>;
}

export interface WebhookInbox {
  /** Atomically insert this event and its queued work; false means already accepted. */
  acceptOnce(scope: string, event: CheckoutWebhook): Promise<boolean>;
}

export interface CheckoutWebhook {
  eventId: number;
  entityId: number;
  spaceId: number;
  webhookListenerId: number;
  listenerEntityId: number;
  listenerEntityTechnicalName?: string;
  timestamp: string;
  state?: string;
}

export class CheckoutUnavailable extends Error {}
export class CheckoutApiError extends Error {
  status: number;
  constructor(status: number) {
    super(`PostFinance Checkout API returned HTTP ${status}.`);
    this.status = status;
  }
}

const encoder = new TextEncoder();
const approvedOrigins = new Set(["https://checkout.postfinance.ch", "https://app-wallee.com"]);
const apiPrefix = "/api/v2.0";

function bytesBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid Base64.");
  }
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function id(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${label}.`);
}

function object(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object.");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Non-JSON request data.");
  return encoded;
}

async function fingerprint(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical(body)));
  return base64Url(new Uint8Array(digest));
}

/** Auth protocol verified against pfpayments/typescript-sdk HttpBearerAuth.ts. */
export async function bearerToken(userId: string, keyBase64: string, method: string,
  resourcePath: string, issuedAt: number): Promise<string> {
  if (!/^[1-9][0-9]*$/.test(userId)) throw new Error("Invalid application user ID.");
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("Invalid issued-at time.");
  if (!resourcePath.startsWith(`${apiPrefix}/`) || !["GET", "POST"].includes(method)) throw new Error("Invalid signed request.");
  const keyBytes = bytesBase64(keyBase64);
  if (keyBytes.length !== 32) throw new Error("The application authentication key must contain 32 bytes.");
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT", ver: 1 })));
  const payload = base64Url(encoder.encode(JSON.stringify({ sub: userId, iat: issuedAt,
    requestPath: resourcePath, requestMethod: method })));
  const key = await crypto.subtle.importKey("raw", bufferSource(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export class PostFinanceCheckoutClient {
  private config: CheckoutConfiguration;
  private fetcher: typeof fetch;
  private ledger?: MutationLedger;
  private now: () => number;

  constructor(configuration: CheckoutConfiguration, dependencies: {
    fetch?: typeof fetch; ledger?: MutationLedger; now?: () => number
  } = {}) {
    // A copy prevents callers from enabling methods by mutating the original object.
    this.config = structuredClone(configuration);
    this.fetcher = dependencies.fetch ?? fetch;
    this.ledger = dependencies.ledger;
    this.now = dependencies.now ?? Date.now;
  }

  private connection(): { origin: string; userId: string; key: string; spaceId: number } {
    const c = this.config;
    if (c.enabled !== true || !c.applicationUserId || !c.authenticationKeyBase64 || !c.spaceId) {
      throw new CheckoutUnavailable("PostFinance Checkout has no enabled merchant configuration.");
    }
    id(c.spaceId, "space ID");
    const origin = c.apiOrigin ?? "https://checkout.postfinance.ch";
    if (!approvedOrigins.has(origin)) throw new CheckoutUnavailable("Unapproved API origin.");
    return { origin, userId: c.applicationUserId, key: c.authenticationKeyBase64, spaceId: c.spaceId };
  }

  private requireRecurring(method: SwissMethod): void {
    this.connection();
    const c = this.config;
    if (!this.ledger || c.merchantApproved !== true || c.subscriptionFeatureEnabled !== true || c.chargeFlowEnabled !== true) {
      throw new CheckoutUnavailable("Merchant approval, subscriptions, Charge Flow and durable ledger are required.");
    }
    if (!(method === "postfinance_pay" ? c.postfinancePayTokenEnabled === true
      : method === "twint" && c.twintUserOnFileEnabled === true)) {
      throw new CheckoutUnavailable("The requested recurring payment method has not been activated.");
    }
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, spaceScoped = true): Promise<unknown> {
    const c = this.connection();
    const resourcePath = `${apiPrefix}${path}`;
    const token = await bearerToken(c.userId, c.key, method, resourcePath, Math.floor(this.now() / 1000));
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (spaceScoped) headers.Space = String(c.spaceId);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetcher(`${c.origin}${resourcePath}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new CheckoutApiError(response.status);
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error("Oversized API response.");
    return response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  }

  private async mutateOnce(path: string, body: unknown, businessKey: string): Promise<unknown> {
    const c = this.connection();
    if (!this.ledger || !/^[A-Za-z0-9_-]{1,120}$/.test(businessKey)) throw new Error("Durable ledger and stable business key required.");
    const scope = `${c.origin}|${c.spaceId}|POST|${path}|${businessKey}`;
    const claim = await this.ledger.claim(scope, await fingerprint(body));
    if (claim.kind === "completed") return JSON.parse(claim.json);
    if (claim.kind === "conflict") throw new Error("The business key already has a different request body.");
    if (claim.kind === "uncertain") throw new Error("Reconcile the previous provider operation before any retry.");
    try {
      const result = await this.request("POST", path, body);
      await this.ledger.complete(scope, JSON.stringify(result));
      return result;
    } catch (error) {
      await this.ledger.markUncertain(scope);
      throw error;
    }
  }

  async createSubscriber(input: { externalId: string; emailAddress: string; reference: string;
    language?: string }, method: SwissMethod): Promise<JsonObject> {
    this.requireRecurring(method);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(input.externalId) || !input.emailAddress || !input.reference) throw new Error("Invalid subscriber.");
    const body: JsonObject = { externalId: input.externalId, emailAddress: input.emailAddress, reference: input.reference };
    if (input.language !== undefined) body.language = input.language;
    const result = await this.mutateOnce("/subscriptions/subscribers", body, input.externalId);
    object(result);
    return result;
  }

  /** Returns a SubscriptionVersion, whose subscription.id is the subscription ID. */
  async createSubscription(input: { productKey: string; subscriberId: number; reference: string;
    version: number }, method: SwissMethod, businessKey: string): Promise<JsonObject> {
    this.requireRecurring(method);
    const product = this.config.products?.[input.productKey];
    if (!product || product.currency !== "CHF" || product.billingPeriod !== "P1M"
      || !Number.isSafeInteger(product.priceChfMinor) || product.priceChfMinor <= 0 || !product.methods.includes(method)) {
      throw new CheckoutUnavailable("A verified monthly CHF product for this method is required.");
    }
    id(product.productId, "product ID");
    id(input.subscriberId, "subscriber ID");
    if (!input.reference || !Number.isSafeInteger(input.version) || input.version < 0) throw new Error("Invalid subscription reference or provider version.");
    const body: JsonObject = { product: product.productId, currency: "CHF", subscription: {
      subscriber: input.subscriberId, reference: input.reference, version: input.version,
    } };
    if (product.componentConfigurations) body.componentConfigurations = product.componentConfigurations;
    const result = await this.mutateOnce("/subscriptions", body, businessKey);
    object(result);
    return result;
  }

  async initializeSubscriberPresent(subscriptionId: number, method: SwissMethod,
    urls: { successUrl: string; failureUrl: string }, businessKey: string): Promise<JsonObject> {
    this.requireRecurring(method);
    id(subscriptionId, "subscription ID");
    if (!this.config.returnOrigin) throw new CheckoutUnavailable("A fixed HTTPS return origin is required.");
    const origin = new URL(this.config.returnOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Invalid return origin.");
    for (const value of [urls.successUrl, urls.failureUrl]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password) throw new Error("Invalid checkout return URL.");
    }
    const result = await this.mutateOnce(`/subscriptions/${subscriptionId}/initialize-subscriber-present`, urls, businessKey);
    object(result);
    return result;
  }

  async readSubscription(subscriptionId: number): Promise<JsonObject> {
    id(subscriptionId, "subscription ID");
    const result = await this.request("GET", `/subscriptions/${subscriptionId}`);
    object(result);
    return result;
  }

  async paymentPageUrl(transactionId: number): Promise<string> {
    id(transactionId, "transaction ID");
    const result = await this.request("GET", `/payment/transactions/${transactionId}/payment-page-url`);
    if (typeof result !== "string") throw new Error("Expected provider payment-page URL.");
    const url = new URL(result);
    if (url.protocol !== "https:" || url.origin !== this.connection().origin || url.username || url.password) throw new Error("Unapproved payment-page URL.");
    return url.href;
  }

  async webhookPublicKey(keyId: string): Promise<string> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(keyId)) throw new Error("Invalid webhook key ID.");
    const result = await this.request("GET", `/webhooks/encryption-keys/${encodeURIComponent(keyId)}`, undefined, false);
    if (typeof result !== "string") throw new Error("Expected Base64 SPKI public key.");
    return result;
  }
}

/** Convert strict ASN.1 DER ECDSA r/s to the P1363 encoding required by WebCrypto. */
export function derToP1363(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("Invalid P-256 DER signature.");
  let cursor = 2;
  const output = new Uint8Array(64);
  for (let scalar = 0; scalar < 2; scalar++) {
    if (der[cursor++] !== 0x02) throw new Error("Invalid DER integer.");
    const length = der[cursor++];
    if (!length || length > 33 || cursor + length > der.length) throw new Error("Invalid DER scalar length.");
    let part = der.slice(cursor, cursor + length);
    cursor += length;
    if (part[0] & 0x80) throw new Error("Negative DER scalar.");
    if (part.length > 1 && part[0] === 0) {
      if (!(part[1] & 0x80)) throw new Error("Non-minimal DER scalar.");
      part = part.slice(1);
    }
    if (part.length > 32 || part.every(byte => byte === 0)) throw new Error("Invalid ECDSA scalar.");
    output.set(part, scalar * 32 + 32 - part.length);
  }
  if (cursor !== der.length) throw new Error("Trailing DER signature data.");
  return output;
}

export async function verifyWebhookSignature(rawBody: Uint8Array, signatureHeader: string,
  keyResolver: (keyId: string) => Promise<string>): Promise<void> {
  if (rawBody.length > 65_536) throw new Error("Oversized webhook.");
  const match = /^algorithm=SHA256withECDSA,\s*keyId=([A-Za-z0-9-]{1,128}),\s*signature=([A-Za-z0-9+/=]+)$/.exec(signatureHeader);
  if (!match) throw new Error("Invalid or unsupported webhook signature header.");
  const signature = bytesBase64(match[2]);
  const candidates: Uint8Array[] = [];
  if (signature.length === 64) candidates.push(signature);
  try { candidates.push(derToP1363(signature)); } catch { /* P1363 may not be DER. */ }
  if (!candidates.length) throw new Error("Invalid webhook signature encoding.");
  const publicKey = await crypto.subtle.importKey("spki", bufferSource(bytesBase64(await keyResolver(match[1]))),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  for (const candidate of candidates) {
    if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bufferSource(candidate), bufferSource(rawBody))) return;
  }
  throw new Error("Invalid webhook signature.");
}

/** Authenticate bytes before parsing; accept durable work once. Re-read provider state for entitlements. */
export async function acceptWebhook(rawBody: Uint8Array, signatureHeader: string, dependencies: {
  keyResolver: (keyId: string) => Promise<string>;
  inbox: WebhookInbox;
  apiOrigin: string;
  spaceId: number;
  allowedListenerIds: number[];
  now?: () => number;
  maxEventAgeMs?: number;
}): Promise<{ event: CheckoutWebhook; duplicate: boolean }> {
  if (!approvedOrigins.has(dependencies.apiOrigin)) throw new Error("Invalid webhook origin scope.");
  await verifyWebhookSignature(rawBody, signatureHeader, dependencies.keyResolver);
  const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  object(data);
  for (const key of ["eventId", "entityId", "spaceId", "webhookListenerId", "listenerEntityId"]) id(data[key], key);
  if (data.spaceId !== dependencies.spaceId || !dependencies.allowedListenerIds.includes(data.webhookListenerId as number)) throw new Error("Webhook belongs to another configured space or listener.");
  if (typeof data.timestamp !== "string" || !Number.isFinite(Date.parse(data.timestamp))) throw new Error("Invalid webhook timestamp.");
  const age = (dependencies.now ?? Date.now)() - Date.parse(data.timestamp);
  if (age < -600_000) throw new Error("Webhook timestamp is in the future.");
  if (dependencies.maxEventAgeMs !== undefined && (!Number.isFinite(dependencies.maxEventAgeMs)
    || dependencies.maxEventAgeMs <= 0 || age > dependencies.maxEventAgeMs)) throw new Error("Webhook exceeds the configured event-age policy.");
  const event = data as unknown as CheckoutWebhook;
  const scope = `${dependencies.apiOrigin}|${event.spaceId}|${event.webhookListenerId}|${event.eventId}`;
  const accepted = await dependencies.inbox.acceptOnce(scope, event);
  return { event, duplicate: !accepted };
}

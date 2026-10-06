import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
vi.mock('@/lib/runtime', () => ({ database: vi.fn(), runtimeValue: () => '' }));
import { postFinanceWebhookConfiguration } from './postfinance-runtime';
import { receivePostFinanceWebhook } from './postfinance-webhook';
import { POST } from '@/app/api/payments/postfinance/webhook/route';

const fixture = JSON.parse(
  readFileSync(new URL('./postfinance-fixtures.json', import.meta.url), 'utf8'),
);
const fixedNow = Date.parse('2026-10-06T12:00:00Z');
const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const signature = `algorithm=SHA256withECDSA, keyId=${fixture.keyId}, signature=${fixture.signatureDerBase64}`;
let sql: DatabaseSync;
function environment(patch: Record<string, string | undefined> = {}) {
  return {
    POSTFINANCE_WEBHOOKS_ENABLED: 'true',
    POSTFINANCE_API_ORIGIN: 'https://checkout.postfinance.ch',
    POSTFINANCE_APPLICATION_USER_ID: '512',
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: secret,
    POSTFINANCE_SPACE_ID: '1',
    POSTFINANCE_WEBHOOK_LISTENERS_JSON: JSON.stringify([
      { id: 2, entityId: 1472041829003, technicalName: 'Transaction' },
    ]),
    ...patch,
  };
}
function dependencies(patch: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = environment(patch);
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json(fixture.publicKeySpkiBase64),
  );
  const database = vi.fn(
    () =>
      ({
        prepare(query: string) {
          let bindings: SQLInputValue[] = [];
          const statement = {
            bind(...args: SQLInputValue[]) {
              bindings = args;
              return statement;
            },
            async run() {
              return { meta: sql.prepare(query).run(...bindings) };
            },
            async first() {
              return sql.prepare(query).get(...bindings) ?? null;
            },
          };
          return statement;
        },
      }) as unknown as Pick<D1Database, 'prepare'>,
  );
  return {
    read: (key: string) => env[key] ?? '',
    fetch: fetcher,
    database,
    now: () => fixedNow,
  };
}
function request(body = fixture.body, patch: Record<string, string> = {}) {
  return new Request('https://zentraapp.ch/api/payments/postfinance/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': signature,
      ...patch,
    },
    body,
  });
}
function rows() {
  return sql.prepare('SELECT * FROM postfinance_webhook_inbox').all();
}
async function signed(body: string) {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const key = btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
    ),
  );
  const sign = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.privateKey,
          new TextEncoder().encode(body),
        ),
      ),
    ),
  );
  return {
    key,
    header: `algorithm=SHA256withECDSA, keyId=test-key-2, signature=${sign}`,
  };
}
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(
    readFileSync(
      new URL('../../drizzle/0072_melodic_tinkerer.sql', import.meta.url),
      'utf8',
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  sql.close();
  vi.restoreAllMocks();
});

describe('PostFinance server-owned configuration', () => {
  it('is disabled by default and cannot be enabled by a request or an almost-true value', async () => {
    for (const value of ['', '1', 'TRUE', ' true']) {
      const deps = dependencies({ POSTFINANCE_WEBHOOKS_ENABLED: value });
      const response = await receivePostFinanceWebhook(request(), deps);
      expect(response.status).toBe(503);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    }
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each([
    {
      POSTFINANCE_API_ORIGIN:
        'https://checkout.postfinance.ch.attacker.example',
    },
    { POSTFINANCE_API_ORIGIN: 'https://checkout.postfinance.ch/path' },
    { POSTFINANCE_APPLICATION_USER_ID: '9007199254740992' },
    { POSTFINANCE_SPACE_ID: '0' },
    { POSTFINANCE_SPACE_ID: '1.1' },
    { POSTFINANCE_AUTHENTICATION_KEY_BASE64: btoa('wrong-key') },
    {
      POSTFINANCE_WEBHOOK_LISTENERS_JSON:
        '[{"id":2,"entityId":1,"spaceId":999}]',
    },
    {
      POSTFINANCE_WEBHOOK_LISTENERS_JSON:
        '[{"id":2,"entityId":1},{"id":2,"entityId":2}]',
    },
    {
      POSTFINANCE_WEBHOOK_LISTENERS_JSON:
        '[{"id":2,"entityId":1,"technicalName":"Transaction/url"}]',
    },
    { POSTFINANCE_WEBHOOK_LISTENERS_JSON: 'null' },
  ])(
    'refuses invalid merchant configuration without upstream or storage access: %j',
    async (patch) => {
      const deps = dependencies(patch);
      const response = await receivePostFinanceWebhook(request(), deps);
      expect(response.status).toBe(503);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        secret,
      );
    },
  );
  it('copies only explicit fixed listener fields and separates different Spaces', () => {
    const deps = dependencies();
    const value = postFinanceWebhookConfiguration(deps.read)!;
    expect(value.spaceId).toBe(1);
    expect(value.listeners).toEqual([
      { id: 2, entityId: 1472041829003, technicalName: 'Transaction' },
    ]);
    expect(value.connection.products).toBeUndefined();
    expect(value.connection.merchantApproved).toBeUndefined();
    expect(
      postFinanceWebhookConfiguration(
        dependencies({ POSTFINANCE_SPACE_ID: '405' }).read,
      )?.spaceId,
    ).toBe(405);
  });
});

describe('PostFinance public receipt boundary with real SQL and ECDSA', () => {
  it('authenticates an independent official fixture before durable insertion and acknowledges a replay once', async () => {
    const deps = dependencies();
    const response = await receivePostFinanceWebhook(request(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false });
    const repeated = await receivePostFinanceWebhook(request(), deps);
    expect(await repeated.json()).toEqual({ received: true, duplicate: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ state: 'pending', attempts: 0 });
    const [url, parameters] = deps.fetch.mock.calls[0];
    expect(url).toBe(
      `https://checkout.postfinance.ch/api/v2.0/webhooks/encryption-keys/${fixture.keyId}`,
    );
    expect(parameters?.method).toBe('GET');
    expect(
      (parameters?.headers as Record<string, string> | undefined)?.Space,
    ).toBeUndefined();
    expect(
      (parameters?.headers as Record<string, string> | undefined)
        ?.Authorization,
    ).toMatch(/^Bearer /);
  });
  it('has one durable receipt across simultaneous requests, with no mutation or entitlement query', async () => {
    const answers = await Promise.all(
      Array.from({ length: 12 }, () =>
        receivePostFinanceWebhook(request(), dependencies()),
      ),
    );
    const results = await Promise.all(
      answers.map((response) => response.json()),
    );
    expect(
      results.filter(
        (value) => (value as { duplicate: boolean }).duplicate === false,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (value) => (value as { duplicate: boolean }).duplicate === true,
      ),
    ).toHaveLength(11);
    expect(rows()).toHaveLength(1);
    expect(
      sql.prepare('SELECT count(*) as count FROM postfinance_mutations').get(),
    ).toMatchObject({ count: 0 });
  });
  it('rejects altered signed bytes without opening the database', async () => {
    const deps = dependencies();
    expect(
      (await receivePostFinanceWebhook(request(fixture.body + '\n'), deps))
        .status,
    ).toBe(401);
    expect(deps.database).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
  it('refuses absent or unsupported signatures without key lookup or storage', async () => {
    for (const header of [
      '',
      signature.replace('SHA256withECDSA', 'none'),
      'x'.repeat(1025),
    ]) {
      const deps = dependencies();
      expect(
        (
          await receivePostFinanceWebhook(
            request(fixture.body, { 'x-signature': header }),
            deps,
          )
        ).status,
      ).toBe(401);
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(deps.database).not.toHaveBeenCalled();
    }
  });
  it('refuses the wrong Space, listener or entity before storage', async () => {
    for (const patch of [
      { POSTFINANCE_SPACE_ID: '405' },
      {
        POSTFINANCE_WEBHOOK_LISTENERS_JSON:
          '[{"id":99,"entityId":1472041829003}]',
      },
      { POSTFINANCE_WEBHOOK_LISTENERS_JSON: '[{"id":2,"entityId":7}]' },
      {
        POSTFINANCE_WEBHOOK_LISTENERS_JSON:
          '[{"id":2,"entityId":1472041829003,"technicalName":"Subscription"}]',
      },
    ]) {
      const deps = dependencies(patch);
      expect((await receivePostFinanceWebhook(request(), deps)).status).toBe(
        401,
      );
      expect(deps.database).not.toHaveBeenCalled();
    }
  });
  it('rejects chunked oversized or wrong content type before key retrieval', async () => {
    const deps = dependencies();
    expect(
      (await receivePostFinanceWebhook(request('a'.repeat(65_537)), deps))
        .status,
    ).toBe(413);
    expect(
      (
        await receivePostFinanceWebhook(
          request(fixture.body, { 'Content-Type': 'text/plain' }),
          deps,
        )
      ).status,
    ).toBe(415);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.database).not.toHaveBeenCalled();
  });
  it('returns a retriable failure for key-provider errors, never a fake acknowledgement', async () => {
    const deps = dependencies();
    deps.fetch.mockResolvedValue(
      new Response('private upstream response', { status: 500 }),
    );
    const response = await receivePostFinanceWebhook(request(), deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(deps.database).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(
      'private upstream',
    );
  });
  it('rejects an unknown signing key rather than classifying it as an outage', async () => {
    const deps = dependencies();
    deps.fetch.mockResolvedValue(new Response('unknown key', { status: 404 }));
    const response = await receivePostFinanceWebhook(request(), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(deps.database).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
  it('rejects a signed invalid event and conflicting replay instead of retrying storage', async () => {
    const invalid = JSON.stringify({
      ...JSON.parse(fixture.body),
      state: { unexpected: 'value' },
    });
    const invalidSigned = await signed(invalid),
      deps = dependencies();
    deps.fetch.mockResolvedValue(Response.json(invalidSigned.key));
    const response = await receivePostFinanceWebhook(
      request(invalid, { 'x-signature': invalidSigned.header }),
      deps,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(rows()).toHaveLength(0);
    deps.fetch.mockResolvedValue(Response.json(fixture.publicKeySpkiBase64));
    expect((await receivePostFinanceWebhook(request(), deps)).status).toBe(200);
    const contradiction = JSON.stringify({
      ...JSON.parse(fixture.body),
      state: 'FULFILL',
    });
    const contradictionSigned = await signed(contradiction);
    deps.fetch.mockResolvedValue(Response.json(contradictionSigned.key));
    const refused = await receivePostFinanceWebhook(
      request(contradiction, { 'x-signature': contradictionSigned.header }),
      deps,
    );
    expect(refused.status).toBe(409);
    expect(refused.headers.get('retry-after')).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].event_json).toContain('PROCESSING');
    expect(console.warn).not.toHaveBeenCalled();
  });
  it('does not acknowledge an insertion when durable storage fails', async () => {
    const deps = dependencies();
    deps.database.mockImplementation(() => {
      throw new Error('private database details');
    });
    const response = await receivePostFinanceWebhook(request(), deps);
    expect(response.status).toBe(503);
    expect(rows()).toHaveLength(0);
    expect(JSON.stringify(await response.json())).not.toContain(
      'database details',
    );
  });
  it('persists only known event fields and rejects a signed future timestamp', async () => {
    const body = JSON.stringify({
      ...JSON.parse(fixture.body),
      privateEmail: 'must-not-persist@example.ch',
    });
    const signedBody = await signed(body),
      deps = dependencies();
    deps.fetch.mockResolvedValue(Response.json(signedBody.key));
    expect(
      (
        await receivePostFinanceWebhook(
          request(body, { 'x-signature': signedBody.header }),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(JSON.stringify(rows())).not.toContain('must-not-persist');
    const future = JSON.stringify({
      ...JSON.parse(fixture.body),
      eventId: 36,
      timestamp: new Date(fixedNow + 600_001).toISOString(),
    });
    const futureSigned = await signed(future);
    deps.fetch.mockResolvedValue(Response.json(futureSigned.key));
    expect(
      (
        await receivePostFinanceWebhook(
          request(future, { 'x-signature': futureSigned.header }),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(rows()).toHaveLength(1);
  });
});

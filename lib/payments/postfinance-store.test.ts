import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PostFinanceCheckoutClient } from './postfinance-client';
import {
  D1PostFinanceMutationLedger,
  D1PostFinanceWebhookInbox,
} from './postfinance-store';

let sql: DatabaseSync;
let clock: number;
const fingerprint = 'a'.repeat(43),
  otherFingerprint = 'b'.repeat(43);
const mutationScope =
  'https://checkout.postfinance.ch|405|POST|/subscriptions|purchase_1';
const config = {
  apiOrigin: 'https://checkout.postfinance.ch',
  spaceId: 405,
  listeners: [{ id: 2, entityId: 7, technicalName: 'Transaction' }],
};
function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 19,
    entityId: 11,
    spaceId: 405,
    webhookListenerId: 2,
    listenerEntityId: 7,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(clock * 1000).toISOString(),
    state: 'FULFILL',
    ...overrides,
  };
}
function scope(value = event(), origin = config.apiOrigin) {
  return `${origin}|${value.spaceId}|${value.webhookListenerId}|${value.eventId}`;
}
function migrate(db: DatabaseSync) {
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  }
}
// Execute the production prepared SQL, not an in-memory imitation of its state machine.
function d1(db: DatabaseSync) {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async run() {
          return { meta: db.prepare(query).run(...values) };
        },
        async first() {
          return db.prepare(query).get(...values) ?? null;
        },
      };
      return statement;
    },
  } as unknown as Pick<D1Database, 'prepare'>;
}
const ledger = (db = sql) =>
  new D1PostFinanceMutationLedger(d1(db), () => clock);
const inbox = (options = config, db = sql) =>
  new D1PostFinanceWebhookInbox(d1(db), options, () => clock);
function cleanupTestDirectory(folder: string, base: string) {
  if (
    dirname(resolve(folder)) !== base ||
    !basename(folder).startsWith('zentra-pf-')
  ) {
    throw new Error('Refusing unsafe test cleanup.');
  }
  rmSync(folder, { recursive: true, force: true });
}
beforeEach(() => {
  clock = 1_791_259_200;
  sql = new DatabaseSync(':memory:');
  migrate(sql);
});
afterEach(() => sql.close());

describe('PostFinance durable mutation journal', () => {
  it('has one winner across 32 independent worker instances and no lease stealing', async () => {
    const stores = Array.from({ length: 32 }, () => ledger());
    const results = await Promise.all(
      stores.map((store) => store.claim(mutationScope, fingerprint)),
    );
    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => result.kind === 'uncertain'),
    ).toHaveLength(31);
    clock += 86400 * 365;
    expect(await ledger().claim(mutationScope, fingerprint)).toEqual({
      kind: 'uncertain',
    });
    expect(
      sql.prepare('SELECT count(*) AS n FROM postfinance_mutations').get()?.n,
    ).toBe(1);
  });
  it('replays a persisted result and rejects body changes without changing it', async () => {
    const owner = ledger();
    expect(await owner.claim(mutationScope, fingerprint)).toEqual({
      kind: 'claimed',
    });
    await owner.complete(mutationScope, '{"subscription":{"id":71}}');
    expect(await ledger().claim(mutationScope, fingerprint)).toEqual({
      kind: 'completed',
      json: '{"subscription":{"id":71}}',
    });
    expect(await ledger().claim(mutationScope, otherFingerprint)).toEqual({
      kind: 'conflict',
    });
    await ledger().markUncertain(mutationScope);
    expect(
      sql.prepare('SELECT state,claim_token FROM postfinance_mutations').get(),
    ).toMatchObject({ state: 'completed', claim_token: null });
  });
  it('fences non-owner completion and uncertain results', async () => {
    const owner = ledger(),
      stranger = ledger();
    await owner.claim(mutationScope, fingerprint);
    await expect(stranger.complete(mutationScope, '{}')).rejects.toThrow(
      'does not own',
    );
    await stranger.markUncertain(mutationScope);
    expect(
      sql.prepare('SELECT state FROM postfinance_mutations').get()?.state,
    ).toBe('claimed');
    await owner.markUncertain(mutationScope);
    await expect(owner.complete(mutationScope, '{}')).rejects.toThrow(
      'does not own',
    );
    expect(await ledger().claim(mutationScope, fingerprint)).toEqual({
      kind: 'uncertain',
    });
  });
  it('survives database close and process-style reopen without reissuing an operation', async () => {
    const base = resolve(tmpdir()),
      folder = mkdtempSync(join(base, 'zentra-pf-')),
      file = join(folder, 'payments.db');
    let persistent: DatabaseSync | null = null;
    try {
      persistent = new DatabaseSync(file);
      migrate(persistent);
      const completed = ledger(persistent);
      await completed.claim(mutationScope, fingerprint);
      await completed.complete(mutationScope, '{"id":71}');
      await ledger(persistent).claim(mutationScope + '-uncertain', fingerprint);
      persistent.close();
      persistent = new DatabaseSync(file);
      expect(
        await ledger(persistent).claim(mutationScope, fingerprint),
      ).toEqual({ kind: 'completed', json: '{"id":71}' });
      expect(
        await ledger(persistent).claim(
          mutationScope + '-uncertain',
          fingerprint,
        ),
      ).toEqual({ kind: 'uncertain' });
    } finally {
      persistent?.close();
      cleanupTestDirectory(folder, base);
    }
  });
  it('isolates API origins, spaces, request paths and stable business keys', async () => {
    for (const key of [
      mutationScope,
      mutationScope.replace('|405|', '|406|'),
      mutationScope.replace('checkout.postfinance.ch', 'app-wallee.com'),
      mutationScope.replace('/subscriptions', '/subscriptions/subscribers'),
      mutationScope + '2',
    ]) {
      expect(await ledger().claim(key, fingerprint)).toEqual({
        kind: 'claimed',
      });
    }
    expect(
      sql.prepare('SELECT count(*) AS n FROM postfinance_mutations').get()?.n,
    ).toBe(5);
    expect(
      sql
        .prepare('SELECT scope_hash FROM postfinance_mutations')
        .all()
        .every((row) => /^[a-f0-9]{64}$/.test(String(row.scope_hash))),
    ).toBe(true);
  });
  it('rejects malformed or excessive data before a result can be committed', async () => {
    const store = ledger();
    await expect(store.claim('bad\nkey', fingerprint)).rejects.toThrow('scope');
    await expect(store.claim(mutationScope, 'invalid')).rejects.toThrow(
      'fingerprint',
    );
    await store.claim(mutationScope, fingerprint);
    await expect(store.complete(mutationScope, 'not json')).rejects.toThrow();
    await expect(
      store.complete(mutationScope, JSON.stringify('é'.repeat(524289))),
    ).rejects.toThrow('Oversized');
    expect(
      sql.prepare('SELECT state FROM postfinance_mutations').get()?.state,
    ).toBe('claimed');
  });
  const merchant = {
    enabled: true,
    applicationUserId: '512',
    spaceId: 405,
    authenticationKeyBase64: Buffer.alloc(32, 7).toString('base64'),
    merchantApproved: true,
    subscriptionFeatureEnabled: true,
    chargeFlowEnabled: true,
    postfinancePayTokenEnabled: true,
  };
  const subscriber = {
    externalId: 'account_purchase_1',
    emailAddress: 'owner@example.test',
    reference: 'purchase1',
  };
  it('integrates with the real adapter: repeats return one provider result', async () => {
    let posts = 0;
    const fetcher = (async () => {
      posts++;
      return Response.json({ id: 11 });
    }) as typeof fetch;
    const client = () =>
      new PostFinanceCheckoutClient(merchant, {
        ledger: ledger(),
        fetch: fetcher,
      });
    expect(
      await client().createSubscriber(subscriber, 'postfinance_pay'),
    ).toEqual({ id: 11 });
    expect(
      await client().createSubscriber(subscriber, 'postfinance_pay'),
    ).toEqual({ id: 11 });
    await expect(
      client().createSubscriber(
        { ...subscriber, emailAddress: 'changed@example.test' },
        'postfinance_pay',
      ),
    ).rejects.toThrow('different request');
    expect(posts).toBe(1);
  });
  it.each(['network timeout', 'persisting response'])(
    'never sends another POST after %s',
    async (failure) => {
      let posts = 0;
      if (failure === 'persisting response')
        sql.exec(`CREATE TRIGGER refuse_result BEFORE UPDATE OF response_json ON postfinance_mutations
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END`);
      const fetcher = (async () => {
        posts++;
        if (failure === 'network timeout') throw new Error('timeout');
        return Response.json({ id: 11 });
      }) as typeof fetch;
      const client = () =>
        new PostFinanceCheckoutClient(merchant, {
          ledger: ledger(),
          fetch: fetcher,
        });
      await expect(
        client().createSubscriber(subscriber, 'postfinance_pay'),
      ).rejects.toThrow();
      if (failure === 'persisting response')
        sql.exec('DROP TRIGGER refuse_result');
      await expect(
        client().createSubscriber(subscriber, 'postfinance_pay'),
      ).rejects.toThrow('Reconcile');
      expect(posts).toBe(1);
      expect(
        sql.prepare('SELECT state FROM postfinance_mutations').get()?.state,
      ).toBe('uncertain');
    },
  );
});

describe('PostFinance durable webhook work', () => {
  it('deduplicates concurrent deliveries into one persistent queue row', async () => {
    const body = event(),
      key = scope(body);
    const results = await Promise.all(
      Array.from({ length: 32 }, () => inbox().acceptOnce(key, body)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      sql.prepare('SELECT state,attempts FROM postfinance_webhook_inbox').all(),
    ).toEqual([{ state: 'pending', attempts: 0 }]);
    const work = await inbox().claimNext();
    expect(work?.event).toEqual(body);
    expect(await inbox().claimNext()).toBeNull();
    expect(await inbox().completeWork(work!)).toBe(true);
    expect(await inbox().acceptOnce(key, body)).toBe(false);
    expect(await inbox().claimNext()).toBeNull();
  });
  it('rejects conflicting replay and binds event identity to the expected listener entity', async () => {
    const body = event(),
      key = scope(body);
    await inbox().acceptOnce(key, body);
    await expect(
      inbox().acceptOnce(key, event({ entityId: 12 })),
    ).rejects.toThrow('Conflicting');
    await expect(
      inbox().acceptOnce(key, event({ listenerEntityId: 8 })),
    ).rejects.toThrow('configured');
    await expect(
      inbox().acceptOnce(
        key,
        event({ listenerEntityTechnicalName: 'Subscription' }),
      ),
    ).rejects.toThrow('configured');
    await expect(
      inbox().acceptOnce(key, event({ spaceId: 406 })),
    ).rejects.toThrow('configured');
    await expect(inbox().acceptOnce(key + '-wrong', body)).rejects.toThrow(
      'scope mismatch',
    );
    expect(
      sql.prepare('SELECT count(*) AS n FROM postfinance_webhook_inbox').get()
        ?.n,
    ).toBe(1);
  });
  it('ignores extraneous provider data and freezes the listener configuration', async () => {
    const mutable = structuredClone(config),
      store = inbox(mutable),
      body = event();
    mutable.spaceId = 999;
    await store.acceptOnce(scope(body), {
      ...body,
      extra: 'must not persist',
    } as typeof body);
    expect(
      await store.acceptOnce(scope(body), {
        ...body,
        extra: 'changed',
      } as typeof body),
    ).toBe(false);
    expect(
      String(
        sql.prepare('SELECT event_json FROM postfinance_webhook_inbox').get()
          ?.event_json,
      ),
    ).not.toContain('extra');
  });
  it('never steals or completes work belonging to another Space, origin or listener', async () => {
    const options = [
      config,
      { ...config, spaceId: 406 },
      { ...config, apiOrigin: 'https://app-wallee.com' },
      {
        ...config,
        listeners: [{ id: 3, entityId: 7, technicalName: 'Transaction' }],
      },
    ];
    const stores = options.map((value) => inbox(value));
    const bodies = options.map((value) =>
      event({
        spaceId: value.spaceId,
        webhookListenerId: value.listeners[0].id,
      }),
    );
    for (let i = 0; i < stores.length; i++)
      await stores[i].acceptOnce(
        scope(bodies[i], options[i].apiOrigin),
        bodies[i],
      );
    const works = await Promise.all(stores.map((store) => store.claimNext()));
    expect(works.every(Boolean)).toBe(true);
    expect(new Set(works.map((work) => work!.scopeHash)).size).toBe(4);
    for (let i = 0; i < stores.length; i++) {
      expect(works[i]!.event).toEqual(bodies[i]);
      expect(
        await stores[(i + 1) % stores.length].completeWork(works[i]!),
      ).toBe(false);
      expect(
        await stores[(i + 1) % stores.length].failWork(
          works[i]!,
          'provider_unavailable',
        ),
      ).toBe(false);
      expect(await stores[i].claimNext()).toBeNull();
    }
    clock += 301;
    const own = await stores[0].claimNext();
    expect(own!.event).toEqual(bodies[0]);
    expect(
      sql
        .prepare(
          'SELECT attempts FROM postfinance_webhook_inbox WHERE scope_hash<>?',
        )
        .all(own!.scopeHash)
        .map((row) => row.attempts),
    ).toEqual([1, 1, 1]);
  });
  it('recovers an expired reconciliation lease and fences the stale worker', async () => {
    await inbox().acceptOnce(scope(), event());
    const first = await inbox().claimNext(5);
    clock += 5;
    expect(await inbox().completeWork(first!)).toBe(false);
    const second = await inbox().claimNext(5);
    expect(second!.lease).not.toBe(first!.lease);
    expect(second!.attempts).toBe(2);
    expect(await inbox().completeWork(first!)).toBe(false);
    expect(await inbox().failWork(first!, 'provider_unavailable')).toBe(false);
    expect(await inbox().completeWork(second!)).toBe(true);
  });
  it('retries with backoff and bounds a poison event to eight attempts', async () => {
    await inbox().acceptOnce(scope(), event());
    for (let attempt = 1; attempt <= 8; attempt++) {
      const work = await inbox().claimNext();
      expect(work!.attempts).toBe(attempt);
      expect(await inbox().failWork(work!, 'ambiguous_period')).toBe(true);
      expect(await inbox().claimNext()).toBeNull();
      clock += 4000;
    }
    expect(
      sql
        .prepare(
          'SELECT state,attempts,lease,last_error_code FROM postfinance_webhook_inbox',
        )
        .get(),
    ).toMatchObject({
      state: 'failed',
      attempts: 8,
      lease: null,
      last_error_code: 'ambiguous_period',
    });
    expect(await inbox().claimNext()).toBeNull();
  });
  it('moves a crashed eighth lease to a visible failed state', async () => {
    await inbox().acceptOnce(scope(), event());
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect((await inbox().claimNext(5))!.attempts).toBe(attempt);
      clock += 5;
    }
    expect(await inbox().claimNext()).toBeNull();
    expect(
      sql.prepare('SELECT state,attempts FROM postfinance_webhook_inbox').get(),
    ).toMatchObject({ state: 'failed', attempts: 8 });
  });
  it('rejects raw error messages and corrupt states at the database boundary', async () => {
    await inbox().acceptOnce(scope(), event());
    const work = await inbox().claimNext();
    await expect(
      inbox().failWork(work!, 'password=secret' as never),
    ).rejects.toThrow('non-sensitive');
    expect(() =>
      sql.exec("UPDATE postfinance_webhook_inbox SET state='completed'"),
    ).toThrow('CHECK');
    expect(() =>
      sql.exec('UPDATE postfinance_webhook_inbox SET attempts=9'),
    ).toThrow('CHECK');
    await ledger().claim(mutationScope, fingerprint);
    expect(() =>
      sql.exec("UPDATE postfinance_mutations SET state='paid'"),
    ).toThrow('CHECK');
    expect(
      sql.prepare('SELECT count(*) AS n FROM subscriptions').get()?.n,
    ).toBe(0);
    expect(
      sql.prepare('SELECT count(*) AS n FROM complete_subscriptions').get()?.n,
    ).toBe(0);
  });
});

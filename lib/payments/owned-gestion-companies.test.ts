import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { ownedGestionPurchaseCompanies } from './owned-gestion-companies';
const state = vi.hoisted(() => ({
  db: null as unknown,
  user: null as unknown,
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: () => '',
  stripeConfiguration: () => ({ priceIds: {} }),
}));
vi.mock('@/app/zentra-auth', () => ({
  getZentraUser: vi.fn(async () => state.user),
}));
import { GET } from '@/app/api/payments/gestion/companies/route';
import { getZentraUser } from '@/app/zentra-auth';
let sql: DatabaseSync;
const clock = Math.floor(Date.now() / 1000);
function add(
  id: string,
  creator = 'owner',
  member = 'owner',
  role = 'owner',
  revoked: number | null = null,
) {
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,?,?,'canceled',0,?)",
    )
    .run(id, id, id, clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(id, 'Company ' + id, id, creator, clock, clock);
  sql
    .prepare(
      'INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at,revoked_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'member_' + id,
      id,
      member,
      'fixture@example.test',
      role,
      clock,
      revoked,
    );
}
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  state.db = {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const p = {
        bind(...values: SQLInputValue[]) {
          args = values;
          return p;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
      };
      return p;
    },
  };
  state.user = { userId: 'owner', emailConfirmed: true };
  vi.clearAllMocks();
});
afterEach(() => sql.close());
it('discovers billing companies without requiring an existing paid licence', async () => {
  add('a');
  add('b');
  expect(
    await ownedGestionPurchaseCompanies(
      state.db as Pick<D1Database, 'prepare'>,
      'owner',
    ),
  ).toEqual([
    { id: 'a', name: 'Company a' },
    { id: 'b', name: 'Company b' },
  ]);
  expect((await GET()).status).toBe(200);
  expect(getZentraUser).toHaveBeenCalledWith({ refreshSession: true });
});
it('returns only companies both created and currently owned by the account', async () => {
  add('visible');
  add('other-creator', 'other', 'owner');
  add('admin', 'owner', 'owner', 'admin');
  add('revoked', 'owner', 'owner', 'owner', clock);
  add('other-owner', 'owner', 'other');
  const response = await GET();
  expect(await response.json()).toEqual({
    companies: [{ id: 'visible', name: 'Company visible' }],
  });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
it('uses server authentication rather than any account supplied by a caller', async () => {
  state.user = null;
  expect((await GET()).status).toBe(401);
  state.user = { userId: 'owner', emailConfirmed: false };
  expect((await GET()).status).toBe(401);
});
it('has no implicit new-company or first-company fallback in discovery', async () => {
  expect(await (await GET()).json()).toEqual({ companies: [] });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM organizations').get()?.n).toBe(
    0,
  );
});
it('does not truncate a large account and accidentally hide the chosen company', async () => {
  for (let i = 0; i < 101; i++) add('a' + i);
  expect((await GET()).status).toBe(503);
});

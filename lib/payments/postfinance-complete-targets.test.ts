// Proposed destination: lib/payments/postfinance-complete-targets.test.ts.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { ownedPostFinanceTargets } from '@/lib/payments/postfinance-option';

let sql: DatabaseSync, network: ReturnType<typeof vi.spyOn>;
const owner = '11111111-1111-4111-8111-111111111111';
const otherOwner = '33333333-3333-4333-8333-333333333333';
function readOnlyDatabase() {
  return {
    prepare(query: string) {
      if (!/^\s*SELECT\b/i.test(query))
        throw Error('Target discovery must be read-only.');
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...parameters: SQLInputValue[]) {
          values = parameters;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
      };
      return statement;
    },
  } as unknown as Pick<D1Database, 'prepare'>;
}
function snapshot() {
  return JSON.stringify(
    sql
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => {
        if (typeof name !== 'string')
          throw Error('Invalid fixture table name.');
        return [
          name,
          sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ];
      }),
  );
}
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  for (const [id, workspaceOwner] of [
    ['good', owner],
    ['foreign-link', otherOwner],
  ]) {
    sql
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
      VALUES(?,?,?,'canceled',0,1)`)
      .run('local-' + id, 'customer-' + id, 'fixture');
    sql
      .prepare('INSERT INTO organizations VALUES(?,?,?,?,1,1)')
      .run('company-' + id, 'Synthetic ' + id, 'local-' + id, owner);
    sql
      .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES(?,?,?,'owner@example.test','owner',1)`)
      .run('membership-' + id, 'company-' + id, owner);
    sql
      .prepare(
        'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,1,1)',
      )
      .run('workspace-' + id, workspaceOwner, 'Synthetic ' + id);
    sql
      .prepare(
        'INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,1)',
      )
      .run('workspace-' + id, 'company-' + id, owner);
  }
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No target-discovery HTTP.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  sql.close();
});

it('hides a foreign-owned linked workspace company only for Complet and preserves the genuine Gestion target', async () => {
  const before = snapshot();
  const gestion = await ownedPostFinanceTargets(readOnlyDatabase(), owner);
  const complete = await ownedPostFinanceTargets(
    readOnlyDatabase(),
    owner,
    true,
  );
  expect(gestion.organizations.map((row) => row.id)).toEqual([
    'company-foreign-link',
    'company-good',
  ]);
  expect(complete.organizations).toEqual([
    { id: 'company-good', name: 'Synthetic good' },
  ]);
  expect(gestion.workspaces).toEqual([
    {
      id: 'workspace-good',
      name: 'Synthetic good',
      organizationId: 'company-good',
    },
  ]);
  expect(complete.workspaces).toEqual(gestion.workspaces);
  expect(snapshot()).toBe(before);
});

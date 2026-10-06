import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { authorizePrepaidPurchase } from './prepaid-purchase-access';

let sql: DatabaseSync;
const user = {
  userId: 'billing-owner',
  email: 'owner@example.test',
  emailConfirmed: true,
};
const request = { productKey: 'gestion:start', organizationId: 'company-a' };
function db() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
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
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'),
    );
  for (const org of ['a', 'b']) {
    sql
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
      VALUES(?,?,?,'canceled',0,1)`)
      .run('trial-' + org, 'local-' + org, 'trial');
    sql
      .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
      .run('company-' + org, 'PME fictive', 'trial-' + org, user.userId, 1, 1);
    sql
      .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES(?,?,?,?,'owner',1)`)
      .run('owner-' + org, 'company-' + org, user.userId, user.email);
  }
  sql
    .prepare(`INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at)
    VALUES('workspace-a',?,'PME fictive',1,1)`)
    .run(user.userId);
});
afterEach(() => sql.close());
const authorize = (input: Record<string, unknown> = request, actor = user) =>
  authorizePrepaidPurchase(db(), actor, {
    productKey: input.productKey,
    ...input,
  });
describe('fresh billing owner authorization without prematurely granting paid seats', () => {
  it('lets the genuine creator and active owner pay for an expired company', async () => {
    const before = sql
      .prepare('SELECT COUNT(*) AS n FROM subscriptions')
      .get()?.n;
    const owned = await authorize();
    expect(owned).toMatchObject({
      ownerId: user.userId,
      organizationId: 'company-a',
      workspaceId: null,
      product: { productKey: 'gestion:start' },
    });
    expect(Object.isFrozen(owned)).toBe(true);
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM prepaid_settlement_proofs').get()
        ?.n,
    ).toBe(0);
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()?.n,
    ).toBe(before);
  });
  it.each([
    { emailConfirmed: false },
    { email: 'bad' },
    { userId: '' },
    { userId: 'bad\nidentity' },
  ])('rejects invalid or unverified server identity %j', async (changed) => {
    await expect(
      authorize(request, { ...user, ...changed }),
    ).rejects.toMatchObject({ code: 'authentication' });
  });
  it.each(['unknown', null, 1])(
    'rejects an unknown product %j',
    async (productKey) => {
      await expect(authorize({ ...request, productKey })).rejects.toMatchObject(
        { code: 'target' },
      );
    },
  );
  it.each([null, '', 'missing', 'company-a\n'])(
    'requires an actual company target %j',
    async (organizationId) => {
      await expect(authorize({ ...request, organizationId })).rejects.toThrow();
    },
  );
  it.each(['admin', 'accountant', 'member'])(
    'does not confuse the %s role with billing ownership',
    async (role) => {
      sql
        .prepare('UPDATE organization_members SET role=? WHERE membership_id=?')
        .run(role, 'owner-a');
      await expect(authorize()).rejects.toMatchObject({ code: 'ownership' });
    },
  );
  it('requires both the creator and a current owner membership', async () => {
    sql
      .prepare(
        "UPDATE organizations SET created_by_user_id='stranger' WHERE organization_id='company-a'",
      )
      .run();
    await expect(authorize()).rejects.toMatchObject({ code: 'ownership' });
    sql
      .prepare(
        'UPDATE organizations SET created_by_user_id=? WHERE organization_id=?',
      )
      .run(user.userId, 'company-a');
    sql
      .prepare(
        "UPDATE organization_members SET revoked_at=1 WHERE membership_id='owner-a'",
      )
      .run();
    await expect(authorize()).rejects.toMatchObject({ code: 'ownership' });
  });
  it('rejects a forged owner even for a visible company', async () => {
    await expect(
      authorize(request, { ...user, userId: 'another-owner' }),
    ).rejects.toMatchObject({ code: 'ownership' });
  });
  it('keeps unrelated companies independent', async () => {
    expect(
      (await authorize({ ...request, organizationId: 'company-b' }))
        .organizationId,
    ).toBe('company-b');
  });
  it('authorizes owned standalone Support and derives its existing company link', async () => {
    const input = { productKey: 'support:starter', workspaceId: 'workspace-a' };
    expect((await authorize(input)).organizationId).toBeNull();
    sql
      .prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at)
      VALUES('workspace-a','company-a',?,1)`)
      .run(user.userId);
    expect((await authorize(input)).organizationId).toBe('company-a');
    await expect(
      authorize({ ...input, organizationId: 'company-b' }),
    ).rejects.toMatchObject({ code: 'link' });
  });
  it('refuses Support linked to a company the workspace owner no longer owns', async () => {
    sql
      .prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at)
      VALUES('workspace-a','company-a',?,1)`)
      .run(user.userId);
    sql
      .prepare(
        "UPDATE organization_members SET revoked_at=1 WHERE membership_id='owner-a'",
      )
      .run();
    await expect(
      authorize({ productKey: 'support:starter', workspaceId: 'workspace-a' }),
    ).rejects.toMatchObject({ code: 'ownership' });
  });
  it('requires Complete to capture an owned workspace before any payment', async () => {
    await expect(
      authorize({ ...request, productKey: 'complet:team' }),
    ).rejects.toMatchObject({ code: 'target' });
    expect(
      (
        await authorize({
          ...request,
          productKey: 'complet:team',
          workspaceId: 'workspace-a',
        })
      ).workspaceId,
    ).toBe('workspace-a');
    await expect(
      authorize({
        ...request,
        productKey: 'complet:team',
        workspaceId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'ownership' });
  });
  it('rejects a Complete workspace belonging to a different company', async () => {
    sql
      .prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at)
      VALUES('workspace-a','company-b',?,1)`)
      .run(user.userId);
    await expect(
      authorize({
        ...request,
        productKey: 'complet:team',
        workspaceId: 'workspace-a',
      }),
    ).rejects.toMatchObject({ code: 'link' });
  });
  it('does not accept irrelevant workspace targets for Gestion or Automation', async () => {
    for (const productKey of ['gestion:start', 'automation'])
      await expect(
        authorize({ ...request, productKey, workspaceId: 'workspace-a' }),
      ).rejects.toMatchObject({ code: 'target' });
  });
});

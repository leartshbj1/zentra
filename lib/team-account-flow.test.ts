import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const stubs = vi.hoisted(() => ({ database: vi.fn(), user: vi.fn() }));
vi.mock('@/lib/runtime', () => ({ database: stubs.database }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: stubs.user }));
import { POST as invite } from '../app/api/account/invitations/route';
import { POST as accept } from '../app/api/account/invitations/accept/route';
import { POST as revoke } from '../app/api/account/members/revoke/route';
import { POST as startDevice } from '../app/api/account/device/start/route';
import { POST as approveDevice } from '../app/api/account/device/approve/route';
import { requireBrowserMembership } from './account';
import { teamSeats } from './team-seats';
import { ZENTRA_PLANS } from './plans';

type SqlValue = string | number | null;
let db: DatabaseSync;
function prepared(sql: string) {
  const statement = db.prepare(sql);
  let args: SqlValue[] = [];
  const result = {
    bind: (...values: SqlValue[]) => {
      args = values;
      return result;
    },
    first: async () => statement.get(...args) ?? null,
    all: async () => ({ results: statement.all(...args) }),
    run: async () => ({
      meta: { changes: Number(statement.run(...args).changes) },
      success: true,
    }),
  };
  return result;
}
const actor = (id: string) =>
  stubs.user.mockResolvedValue({
    userId: id,
    email: `${id}@example.test`,
    displayName: id,
    provider: 'supabase',
    emailConfirmed: true,
  });
function request(path: string, body: unknown) {
  return new Request(`https://zentra.example${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://zentra.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    for (const sql of readFileSync(new URL(name, folder), 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) db.exec(sql);
  stubs.database.mockReturnValue({
    prepare: prepared,
    batch: async (statements: ReturnType<typeof prepared>[]) => {
      db.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,entitlement_plan_id,seat_limit) VALUES('sub_test','cus_test','price_start','active',2000000000,0,1,2000000000,'zentra-start-monthly-59-chf',3);
    INSERT INTO organizations VALUES('org_test','Test','sub_test','owner',1,1);
    INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('mem_owner','org_test','owner','owner@example.test','owner',1);`);
  actor('owner');
});
afterEach(() => db.close());
async function invitePerson(id: string, role = 'member') {
  actor('owner');
  const response = await invite(
    request('/api/account/invitations', {
      organizationId: 'org_test',
      email: `${id}@example.test`,
      role,
    }),
  );
  const body = (await response.json()) as {
    invitation: { url: string };
    error?: string;
  };
  expect(response.status, body.error).toBe(201);
  return new URL(body.invitation.url).searchParams.get('token')!;
}
describe('Team account routes on the migrated database', () => {
  it.each(ZENTRA_PLANS)(
    'fills exactly $seats personal accesses for $name, owner included',
    async (plan) => {
      db.prepare(
        'UPDATE subscriptions SET entitlement_plan_id=?,seat_limit=?',
      ).run(plan.licensePlan, plan.seats);
      for (let i = 1; i < plan.seats; i++) {
        const token = await invitePerson(
          `person${i}`,
          i % 2 ? 'accountant' : 'read_only',
        );
        actor(`person${i}`);
        const response = await accept(
          request('/api/account/invitations/accept', { token }),
        );
        expect(response.status).toBe(200);
        await expect(
          requireBrowserMembership(`person${i}`, 'org_test'),
        ).resolves.toMatchObject({ organizationId: 'org_test' });
      }
      actor('owner');
      expect(
        (
          await invite(
            request('/api/account/invitations', {
              organizationId: 'org_test',
              email: 'extra@example.test',
              role: 'member',
            }),
          )
        ).status,
      ).toBe(409);
      expect(await teamSeats('org_test')).toMatchObject({
        limit: plan.seats,
        used: plan.seats,
        available: 0,
      });
    },
  );
  it('binds an invitation to the intended personal email and rejects reuse', async () => {
    const token = await invitePerson('invited');
    actor('outsider');
    expect(
      (await accept(request('/api/account/invitations/accept', { token })))
        .status,
    ).toBe(403);
    actor('invited');
    expect(
      (await accept(request('/api/account/invitations/accept', { token })))
        .status,
    ).toBe(200);
    expect(
      (await accept(request('/api/account/invitations/accept', { token })))
        .status,
    ).toBe(410);
    expect(
      (
        await invite(
          request('/api/account/invitations', {
            organizationId: 'org_test',
            email: 'another@example.test',
            role: 'admin',
          }),
        )
      ).status,
    ).toBe(403);
  });
  it('frees a revoked personal access and prevents a previously approved user from reconnecting', async () => {
    const token = await invitePerson('invited');
    actor('invited');
    await accept(request('/api/account/invitations/accept', { token }));
    const started = await startDevice(
      request('/api/account/device/start', {
        installationId: crypto.randomUUID(),
      }),
    );
    const codes = (await started.json()) as { userCode: string };
    expect(started.status).toBe(201);
    expect(
      (
        await approveDevice(
          request('/api/account/device/approve', {
            organizationId: 'org_test',
            userCode: codes.userCode,
          }),
        )
      ).status,
    ).toBe(200);
    const membership = db
      .prepare(
        "SELECT membership_id FROM organization_members WHERE user_id='invited'",
      )
      .get()!;
    actor('owner');
    expect(
      (
        await revoke(
          request('/api/account/members/revoke', {
            organizationId: 'org_test',
            membershipId: membership.membership_id,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await teamSeats('org_test')).toMatchObject({
      used: 1,
      available: 2,
    });
    actor('invited');
    await expect(
      requireBrowserMembership('invited', 'org_test'),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await approveDevice(
          request('/api/account/device/approve', {
            organizationId: 'org_test',
            userCode: codes.userCode,
          }),
        )
      ).status,
    ).toBe(403);
  });
  it('requires a signed-in user and an active paid plan for invitations', async () => {
    stubs.user.mockResolvedValue(null);
    expect((await invite(request('/api/account/invitations', {}))).status).toBe(
      401,
    );
    actor('owner');
    db.exec('UPDATE subscriptions SET entitlement_valid_until=1');
    expect(
      (
        await invite(
          request('/api/account/invitations', {
            organizationId: 'org_test',
            email: 'new@example.test',
            role: 'member',
          }),
        )
      ).status,
    ).toBe(402);
  });
});

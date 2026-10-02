import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SUPPORT_WORKSPACES_SQL } from './workspace-access';

// The previous production query is an independent oracle for rows, roles and
// ordering. Keep all authorization predicates identical to the public contract.
const PREVIOUS_WORKSPACES_SQL = `WITH company_seats AS (
  SELECT m.*,s.seat_limit,ROW_NUMBER() OVER(PARTITION BY m.organization_id ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
  FROM organization_members m JOIN organizations o ON o.organization_id=m.organization_id JOIN subscriptions s ON s.subscription_id=o.subscription_id WHERE m.revoked_at IS NULL
) SELECT DISTINCT w.*,CASE WHEN w.owner_id=? THEN 'owner' WHEN m.id IS NOT NULL THEN m.role WHEN om.role IN ('owner','admin') THEN 'admin' ELSE 'member' END AS role
  FROM support_workspaces w LEFT JOIN support_members m ON m.workspace_id=w.id AND m.email=?
  LEFT JOIN support_gestion_links l ON l.workspace_id=w.id
  LEFT JOIN organizations o ON o.organization_id=l.organization_id
  LEFT JOIN complete_subscriptions c ON c.subscription_id=o.subscription_id
  LEFT JOIN company_seats om ON om.organization_id=o.organization_id AND om.user_id=? AND (om.seat_limit IS NULL OR om.seat<=om.seat_limit) AND om.role IN ('owner','admin','accountant','member')
  WHERE w.owner_id=? OR m.id IS NOT NULL OR (c.subscription_id IS NOT NULL AND om.user_id IS NOT NULL) ORDER BY w.created_at,w.id`;

let db: DatabaseSync;
type Member = { userId: string; role?: string; joinedAt?: number; revokedAt?: number };

function company(
  id: string,
  limit: number | null,
  members: Member[],
  { complete = true, enabled = true, createdAt = 1, paidUntil = 2_000_000_000 } = {},
) {
  const owner = `owner-${id}`, subscription = `sub-${id}`, workspace = `ws-${id}`;
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at)
    VALUES(?,?,?,'active',2000000000,2000000000,0,1)`).run(subscription, `cus-${id}`, 'fixture-price');
  db.prepare('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, id, subscription, owner);
  db.prepare('INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,1)').run(workspace, owner, id, createdAt);
  db.prepare('INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,?,0,?,1)').run(workspace, id, Number(enabled), owner);
  if (complete) db.prepare("INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until) VALUES(?,'pro','pro',1,?)").run(subscription, paidUntil);
  members.forEach((member, index) => db.prepare('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at,revoked_at) VALUES(?,?,?,?,?,?,?)').run(
    `${id}-${String(index).padStart(3, '0')}`, id, member.userId, `${member.userId}@example.test`, member.role ?? 'member', member.joinedAt ?? index, member.revokedAt ?? null,
  ));
  // A verified external downgrade can leave more existing members than seats.
  // Populate before reducing capacity, without bypassing any real trigger.
  db.prepare('UPDATE subscriptions SET seat_limit=? WHERE subscription_id=?').run(limit, subscription);
}

function direct(workspace: string, email: string, role: string) {
  db.prepare('INSERT INTO support_members(id,workspace_id,email,role,created_at) VALUES(?,?,?,?,1)').run(`${workspace}-${email}`, workspace, email, role);
}

function rows(userId: string, sql = SUPPORT_WORKSPACES_SQL) {
  return db.prepare(sql).all(userId, `${userId}@example.test`, userId, userId);
}

const roles = (result: ReturnType<typeof rows>) => result.map(row => ({ id: row.id, role: row.role }));

describe('Support workspace access with the migrated database', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
      db.exec(readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'));
    }
  });
  afterEach(() => db.close());

  it('preserves owners and explicit Support memberships without a company seat', () => {
    company('direct', 1, [], { complete: false });
    direct('ws-direct', 'owner-direct@example.test', 'read_only');
    direct('ws-direct', 'admin@example.test', 'admin');
    direct('ws-direct', 'reader@example.test', 'read_only');
    expect(roles(rows('owner-direct'))).toEqual([{ id: 'ws-direct', role: 'owner' }]);
    expect(roles(rows('admin'))).toEqual([{ id: 'ws-direct', role: 'admin' }]);
    expect(roles(rows('reader'))).toEqual([{ id: 'ws-direct', role: 'read_only' }]);
    expect(rows('outsider')).toEqual([]);
  });

  it.each([1, 3, 10])('counts every other active member before applying a %s-seat limit', limit => {
    company('capacity', limit, [
      { userId: 'owner-capacity', role: 'owner', joinedAt: 999 },
      ...Array.from({ length: limit - 1 }, (_, index) => ({ userId: `other-${index}`, role: index % 2 ? 'historical_custom' : 'read_only', joinedAt: index })),
      { userId: 'last-user', role: 'member', joinedAt: 500 },
    ]);
    expect(roles(rows('owner-capacity'))).toEqual([{ id: 'ws-capacity', role: 'owner' }]);
    expect(rows('last-user')).toEqual([]);
    // Negative control: filtering people before ROW_NUMBER wrongly grants this
    // user seat 1. The regression must detect that unsafe "optimization".
    const userOnly = SUPPORT_WORKSPACES_SQL.replace('WHERE m.revoked_at IS NULL', 'WHERE m.revoked_at IS NULL AND m.user_id=(SELECT member_id FROM actor)');
    expect(roles(rows('last-user', userOnly))).toEqual([{ id: 'ws-capacity', role: 'member' }]);
  });

  it('keeps owner priority and membership-id ordering for equal join dates', () => {
    company('ties', 2, [
      { userId: 'first', role: 'admin', joinedAt: 1 },
      { userId: 'second', role: 'accountant', joinedAt: 1 },
      { userId: 'owner-ties', role: 'owner', joinedAt: 999 },
    ]);
    expect(roles(rows('first'))).toEqual([{ id: 'ws-ties', role: 'admin' }]);
    expect(rows('second')).toEqual([]);
  });

  it('preserves allowed company roles, unlimited seats and revoked-member exclusion', () => {
    company('unlimited', null, [
      { userId: 'owner-unlimited', role: 'owner' },
      { userId: 'admin', role: 'admin' },
      { userId: 'accountant', role: 'accountant' },
      { userId: 'member', role: 'member' },
      { userId: 'reader', role: 'read_only' },
      { userId: 'custom', role: 'historical_custom' },
      { userId: 'revoked', role: 'member', revokedAt: 50 },
    ]);
    expect(roles(rows('admin'))).toEqual([{ id: 'ws-unlimited', role: 'admin' }]);
    for (const user of ['accountant', 'member']) expect(roles(rows(user))).toEqual([{ id: 'ws-unlimited', role: 'member' }]);
    for (const user of ['reader', 'custom', 'revoked']) expect(rows(user)).toEqual([]);
  });

  it('counts only active people while keeping direct-role precedence and existing listing conditions', () => {
    company('revoked', 2, [
      { userId: 'owner-revoked', role: 'owner' },
      { userId: 'former', role: 'admin', revokedAt: 50 },
      { userId: 'current', role: 'admin' },
    ], { enabled: false, paidUntil: 1 });
    direct('ws-revoked', 'current@example.test', 'member');
    company('no-bundle', null, [{ userId: 'current', role: 'admin' }], { complete: false });
    // Listing is separate from commercial admission and preserves the original
    // behavior of a Complete row even when its period/link is inactive.
    expect(roles(rows('current'))).toEqual([{ id: 'ws-revoked', role: 'member' }]);
    expect(rows('former')).toEqual([]);
  });

  it('matches the previous query exactly across organizations, roles, plans and four independent binds', () => {
    const users = new Set(['shared', 'outsider']);
    for (let i = 0; i < 50; i++) {
      const id = String(i).padStart(3, '0'), limit = [1, 3, 10, null][i % 4];
      const members = Array.from({ length: 14 }, (_, index): Member => {
        const userId = index === 0 ? `owner-${id}` : index === 2 && i < 8 ? 'shared' : `${id}-member-${index}`;
        if (i < 10) users.add(userId);
        return { userId, role: ['owner', 'admin', 'accountant', 'read_only', 'member'][Math.min(index, 4)], joinedAt: index === 0 ? 99 : 1 + Math.floor(index / 2), ...(index >= 12 ? { revokedAt: 200 } : {}) };
      });
      company(id, limit, members, { complete: i % 7 !== 6, enabled: i % 5 !== 0, createdAt: i % 3 });
      if (i < 5) direct(`ws-${id}`, 'shared@example.test', i % 2 ? 'admin' : 'read_only');
    }
    for (const user of users) expect(rows(user)).toEqual(rows(user, PREVIOUS_WORKSPACES_SQL));
    // Preserve parameter positions too, including callers supplying different
    // owner, email and organization-member identifiers.
    for (const args of [
      ['owner-000', 'shared@example.test', '002-member-11', 'owner-001'],
      ['shared', 'owner-004@example.test', 'shared', 'owner-006'],
      ['outsider', 'shared@example.test', '004-member-1', 'outsider'],
    ]) expect(db.prepare(SUPPORT_WORKSPACES_SQL).all(...args)).toEqual(db.prepare(PREVIOUS_WORKSPACES_SQL).all(...args));
  });
});

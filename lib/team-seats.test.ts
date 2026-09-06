import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({
  database: () => {
    throw new Error('Use the migrated fixture');
  },
}));
import { MEMBER_HAS_SEAT_SQL } from './team-seats';
import { ZENTRA_PLANS } from './plans';
import { UPSERT_SUBSCRIPTION_SQL } from './stripe-sql';

const open: DatabaseSync[] = [];
afterEach(() => {
  open.splice(0).forEach((db) => db.close());
});
function fixture(plan: (typeof ZENTRA_PLANS)[number] = ZENTRA_PLANS[1]) {
  const db = new DatabaseSync(':memory:');
  open.push(db);
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(new URL(name, folder), 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (statement.trim()) db.exec(statement);
  }
  db.prepare(
    `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,entitlement_plan_id,seat_limit) VALUES('sub_test','cus_test','price_test','active',2000000000,0,1,2000000000,?,?)`,
  ).run(plan.licensePlan, plan.seats);
  db.exec(
    "INSERT INTO organizations VALUES('org_test','Test','sub_test','owner',1,1)",
  );
  addMember(db, 'owner', 'owner');
  return db;
}
function addMember(db: DatabaseSync, id: string, role = 'member') {
  return db
    .prepare(
      `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,'org_test',?,?,?,1)`,
    )
    .run(id, id, `${id}@example.test`, role);
}
function invite(db: DatabaseSync, id: string, expires = 2000000000) {
  return db
    .prepare(
      `INSERT INTO organization_invitations(invitation_id,organization_id,token_hash,invited_email,role,created_by_user_id,created_at,expires_at) VALUES(?,'org_test',?,?,'member','owner',100,?)`,
    )
    .run(id, id, `${id}@example.test`, expires);
}

describe('Paid plan seats in the actual migrated database', () => {
  it('checks the seat again when an approved device session is inserted', () => {
    const db = fixture();
    addMember(db, 'collaborator');
    const session = (id: string, user: string) =>
      db
        .prepare(
          `INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at) VALUES(?,?,'org_test',?,?,100,100,2000000000)`,
        )
        .run(id, id, user, id);
    session('owner-device-one', 'owner');
    session('owner-device-two', 'owner');
    db.exec(
      "UPDATE organization_members SET revoked_at=101 WHERE user_id='collaborator'",
    );
    expect(() => session('revoked-user-device', 'collaborator')).toThrow(
      'zentra account access revoked',
    );
    expect(() => session('outsider-device', 'outsider')).toThrow(
      'zentra account access revoked',
    );
    db.exec('UPDATE subscriptions SET entitlement_valid_until=99');
    expect(() => session('expired-sub-device', 'owner')).toThrow(
      'zentra account access revoked',
    );
  });
  it('keeps the owner and oldest active accounts when a paid plan is reduced', () => {
    const db = fixture(ZENTRA_PLANS[2]);
    addMember(db, 'a');
    addMember(db, 'b');
    addMember(db, 'c');
    db.exec(
      "UPDATE subscriptions SET seat_limit=3,entitlement_plan_id='zentra-start-monthly-59-chf'",
    );
    const allowed = (user: string) =>
      db.prepare(MEMBER_HAS_SEAT_SQL).get('org_test', user);
    expect(allowed('owner')).toEqual({ user_id: 'owner' });
    expect(allowed('a')).toEqual({ user_id: 'a' });
    expect(allowed('b')).toEqual({ user_id: 'b' });
    expect(allowed('c')).toBeUndefined();
    db.exec("UPDATE organization_members SET revoked_at=102 WHERE user_id='a'");
    expect(allowed('a')).toBeUndefined();
    expect(allowed('c')).toEqual({ user_id: 'c' });
    db.exec(
      "UPDATE subscriptions SET seat_limit=1,entitlement_plan_id='zentra-solo-monthly-49-chf'",
    );
    expect(allowed('owner')).toEqual({ user_id: 'owner' });
    expect(allowed('b')).toBeUndefined();
  });
  it.each(ZENTRA_PLANS)(
    'enforces $name including owner and every member role',
    (plan) => {
      const db = fixture(plan);
      for (let index = 1; index < plan.seats; index++)
        addMember(db, `member${index}`, index % 2 ? 'accountant' : 'read_only');
      expect(() => addMember(db, 'overflow')).toThrow(
        'zentra seat limit reached',
      );
      expect(() => invite(db, 'overflow-invite')).toThrow(
        'zentra seat limit reached',
      );
      if (plan.seats > 1) {
        db.exec(
          "UPDATE organization_members SET revoked_at=101 WHERE membership_id='member1'",
        );
        addMember(db, 'replacement');
        expect(() =>
          db.exec(
            "UPDATE organization_members SET revoked_at=NULL WHERE membership_id='member1'",
          ),
        ).toThrow('zentra seat limit reached');
      }
      // The allowance is per person, not per device.
      for (let index = 0; index < 12; index++)
        db.prepare(
          `INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES(?,'sub_test',?,1,1)`,
        ).run(`lic${index}`, `device${index}`);
    },
  );
  it('reserves invitation places and frees expired or revoked invitations', () => {
    const db = fixture();
    invite(db, 'old', 99);
    invite(db, 'one');
    invite(db, 'two');
    expect(() => invite(db, 'three')).toThrow('zentra seat limit reached');
    db.exec(
      "UPDATE organization_invitations SET revoked_at=101 WHERE invitation_id='one'",
    );
    invite(db, 'replacement');
  });
  it('rolls back an invitation claim when the final seat was taken concurrently', () => {
    const db = fixture();
    invite(db, 'reserved');
    addMember(db, 'first');
    addMember(db, 'last');
    db.exec('BEGIN');
    try {
      db.exec(
        "UPDATE organization_invitations SET accepted_at=102,accepted_by_user_id='late' WHERE invitation_id='reserved'",
      );
      addMember(db, 'late');
    } catch {
      db.exec('ROLLBACK');
    }
    expect(
      db
        .prepare(
          "SELECT accepted_at FROM organization_invitations WHERE invitation_id='reserved'",
        )
        .get(),
    ).toEqual({ accepted_at: null });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM organization_members').get(),
    ).toEqual({ count: 3 });
  });
  it('changes the seat allowance only after a verified payment, and ignores older settlements', () => {
    const db = fixture(ZENTRA_PLANS[0]);
    function write(
      plan: (typeof ZENTRA_PLANS)[number],
      paidThrough: number,
      paidAt: number,
      paid: boolean,
    ) {
      db.prepare(UPSERT_SUBSCRIPTION_SQL).run(
        'sub_test',
        'cus_test',
        null,
        null,
        null,
        'price_' + plan.id,
        'active',
        2000000010,
        0,
        0,
        paid ? paidThrough : 0,
        paid ? `in_${plan.id}` : null,
        paid ? paidAt : null,
        null,
        null,
        10,
        plan.licensePlan,
        paid ? plan.licensePlan : '',
        paid ? plan.seats : 0,
      );
    }
    write(ZENTRA_PLANS[2], 2000000010, 20, false);
    expect(
      db
        .prepare(
          "SELECT seat_limit FROM subscriptions WHERE subscription_id='sub_test'",
        )
        .get(),
    ).toEqual({ seat_limit: 1 });
    write(ZENTRA_PLANS[2], 2000000010, 20, true);
    write(ZENTRA_PLANS[1], 2000000000, 10, true);
    expect(
      db
        .prepare(
          "SELECT entitlement_plan_id,seat_limit FROM subscriptions WHERE subscription_id='sub_test'",
        )
        .get(),
    ).toEqual({
      entitlement_plan_id: ZENTRA_PLANS[2].licensePlan,
      seat_limit: 10,
    });
  });
});

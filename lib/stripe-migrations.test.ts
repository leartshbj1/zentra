import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = [
  '../drizzle/0000_sweet_owl.sql',
  '../drizzle/0001_brief_mephisto.sql',
  '../drizzle/0002_wonderful_sheva_callister.sql',
  '../drizzle/0003_thin_the_santerians.sql',
  '../drizzle/0004_zippy_harry_osborn.sql',
  '../drizzle/0005_dashing_union_jack.sql',
  '../drizzle/0006_account_guards.sql',
  '../drizzle/0007_device_activation_revocation.sql',
  '../drizzle/0008_unlimited_collaborators.sql',
];

describe('Stripe D1 migrations', () => {
  it('applies from an empty database and exposes every readiness column', () => {
    const db = new DatabaseSync(':memory:');
    for (const migration of migrations) {
      db.exec(
        readFileSync(new URL(migration, import.meta.url), 'utf8').replaceAll(
          '--> statement-breakpoint',
          '',
        ),
      );
    }

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('stripe_events')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'event_created_at',
        'processing_started_at',
        'processing_attempts',
        'processed_at',
      ]),
    );
    const subscriptionColumns = db
      .prepare("SELECT name FROM pragma_table_info('subscriptions')")
      .all()
      .map((row) => row.name);
    expect(subscriptionColumns).toEqual(
      expect.arrayContaining([
        'entitlement_valid_until',
        'last_paid_invoice_id',
        'last_paid_at',
        'last_payment_failure_invoice_id',
        'last_payment_failure_at',
      ]),
    );
    const proofColumns = db
      .prepare("SELECT name FROM pragma_table_info('stripe_webhook_proofs')")
      .all()
      .map((row) => row.name);
    expect(proofColumns).toEqual(
      expect.arrayContaining([
        'endpoint_id',
        'secret_sha256',
        'livemode',
        'api_version',
        'last_verified_event_id',
        'verified_at',
      ]),
    );

    expect(() =>
      db
        .prepare(
          'SELECT event_id,event_created_at,processing_started_at,processing_attempts,processed_at FROM stripe_events LIMIT 0',
        )
        .all(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          'SELECT endpoint_id,secret_sha256,livemode,api_version,last_verified_event_id,verified_at FROM stripe_webhook_proofs LIMIT 0',
        )
        .all(),
    ).not.toThrow();

    const accountTables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name IN (
            'organizations','organization_members','organization_invitations',
            'device_authorizations','device_sessions','invoice_archives'
          ) ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(accountTables).toHaveLength(6);
    expect(accountTables).toEqual(
      expect.arrayContaining([
        'organizations',
        'organization_members',
        'organization_invitations',
        'device_authorizations',
        'device_sessions',
        'invoice_archives',
      ]),
    );

    const activationIndexes = db
      .prepare(
        "SELECT name,[unique] FROM pragma_index_list('license_activations')",
      )
      .all() as Array<{ name: string; unique: number }>;
    expect(activationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'license_activations_subscription_idx',
          unique: 0,
        }),
        expect.objectContaining({
          name: 'license_activations_subscription_installation_idx',
          unique: 1,
        }),
      ]),
    );
    const activationColumns = db
      .prepare("SELECT name FROM pragma_table_info('license_activations')")
      .all()
      .map((row) => row.name);
    expect(activationColumns).toContain('revoked_at');
    const organizationColumns = db
      .prepare("SELECT name FROM pragma_table_info('organizations')")
      .all()
      .map((row) => row.name);
    expect(organizationColumns).not.toContain('seat_limit');

    db.exec(`
      INSERT INTO subscriptions(
        subscription_id,customer_id,price_id,status,current_period_end,
        cancel_at_period_end,livemode,entitlement_valid_until,updated_at
      ) VALUES('sub_test','cus_test','price_test','active',2000000000,0,0,2000000000,1);
      INSERT INTO organizations(
        organization_id,name,subscription_id,created_by_user_id,created_at,updated_at
      ) VALUES('org_test','Entreprise','sub_test','user_owner',1,1);
      INSERT INTO organization_members(
        membership_id,organization_id,user_id,email,role,joined_at
      ) VALUES('mem_owner','org_test','user_owner','owner@example.test','owner',1);
    `);
    expect(() =>
      db.exec(`INSERT INTO organization_members(
        membership_id,organization_id,user_id,email,role,joined_at
      ) VALUES('mem_extra','org_test','user_extra','extra@example.test','member',1);`),
    ).not.toThrow();
    for (let index = 2; index <= 12; index += 1) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO organization_members(
               membership_id,organization_id,user_id,email,role,joined_at
             ) VALUES(?,?,?,?, 'member',1)`,
          )
          .run(
            `mem_${index}`,
            'org_test',
            `user_${index}`,
            `personne-${index}@example.test`,
          ),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO license_activations(
               license_id,subscription_id,installation_id,activated_at,last_issued_at
             ) VALUES(?,?,?,1,1)`,
          )
          .run(`lic_${index}`, 'sub_test', `installation_${index}`),
      ).not.toThrow();
    }
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM organization_members
            WHERE organization_id='org_test' AND revoked_at IS NULL`,
        )
        .get(),
    ).toEqual({ count: 13 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM license_activations
            WHERE subscription_id='sub_test' AND revoked_at IS NULL`,
        )
        .get(),
    ).toEqual({ count: 11 });
    db.prepare(
      `UPDATE license_activations SET revoked_at=2
        WHERE subscription_id='sub_test' AND installation_id='installation_2'`,
    ).run();
    const reactivated = db
      .prepare(
        `INSERT INTO license_activations(
           license_id,subscription_id,installation_id,activated_at,last_issued_at,revoked_at
         ) VALUES('lic_replacement','sub_test','installation_2',3,3,NULL)
         ON CONFLICT(subscription_id,installation_id) DO UPDATE SET
           last_issued_at=excluded.last_issued_at,revoked_at=NULL
         RETURNING license_id,revoked_at`,
      )
      .get();
    expect(reactivated).toEqual({ license_id: 'lic_2', revoked_at: null });

    db.exec(`INSERT INTO invoice_archives(
      archive_id,organization_id,source_invoice_id,revision,invoice_number,
      issue_date,correction_kind,object_key,content_sha256,size_bytes,media_type,
      chain_sha256,retention_until,stored_by_session_id,stored_at,storage_status
    ) VALUES(
      'arc_test','org_test','invoice_test',1,'F-1','2026-09-02','initial',
      'organizations/org_test/invoice.pdf','${'a'.repeat(64)}',42,'application/pdf',
      '${'b'.repeat(64)}','2036-12-31','session_test',1,'pending'
    );`);
    expect(() =>
      db.exec(
        "UPDATE invoice_archives SET storage_status='stored' WHERE archive_id='arc_test'",
      ),
    ).not.toThrow();
    expect(() =>
      db.exec(
        "UPDATE invoice_archives SET invoice_number='F-2' WHERE archive_id='arc_test'",
      ),
    ).toThrow('invoice archive metadata is immutable');
    expect(() =>
      db.exec("DELETE FROM invoice_archives WHERE archive_id='arc_test'"),
    ).toThrow('invoice archives cannot be deleted');
    db.exec(`INSERT INTO invoice_archives(
      archive_id,organization_id,source_invoice_id,revision,invoice_number,
      issue_date,correction_kind,object_key,content_sha256,size_bytes,media_type,
      chain_sha256,retention_until,stored_by_session_id,stored_at,storage_status
    ) VALUES(
      'arc_pending','org_test','invoice_pending',1,'F-2','2026-09-02','initial',
      'organizations/org_test/pending.pdf','${'c'.repeat(64)}',42,'application/pdf',
      '${'d'.repeat(64)}','2036-12-31','session_test',1,'pending'
    );`);
    expect(() =>
      db.exec("DELETE FROM invoice_archives WHERE archive_id='arc_pending'"),
    ).not.toThrow();
  });
});

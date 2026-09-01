import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = [
  '../drizzle/0000_sweet_owl.sql',
  '../drizzle/0001_brief_mephisto.sql',
  '../drizzle/0002_wonderful_sheva_callister.sql',
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

    expect(() =>
      db
        .prepare(
          'SELECT event_id,event_created_at,processing_started_at,processing_attempts,processed_at FROM stripe_events LIMIT 0',
        )
        .all(),
    ).not.toThrow();
  });
});

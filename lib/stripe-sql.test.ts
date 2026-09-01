import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_STRIPE_EVENT_SQL,
  COMPLETE_STRIPE_EVENT_SQL,
  INSERT_STRIPE_EVENT_SQL,
  RELEASE_STRIPE_EVENT_SQL,
  UPSERT_SUBSCRIPTION_SQL,
} from './stripe-sql';

type Settlement = {
  paidThrough?: number;
  paidInvoiceId?: string;
  paidAt?: number;
  failedInvoiceId?: string;
  failedAt?: number;
};

let db: DatabaseSync;

function write(settlement: Settlement) {
  db.prepare(UPSERT_SUBSCRIPTION_SQL).run(
    'sub_elyko',
    'cus_elyko',
    null,
    null,
    'Entreprise Elyko',
    'price_elyko',
    'active',
    2_000,
    0,
    0,
    settlement.paidThrough ?? 0,
    settlement.paidInvoiceId ?? null,
    settlement.paidAt ?? null,
    settlement.failedInvoiceId ?? null,
    settlement.failedAt ?? null,
    2_000,
  );
}

function state() {
  return db
    .prepare(
      `SELECT entitlement_valid_until,last_paid_invoice_id,last_paid_at,
              last_payment_failure_invoice_id,last_payment_failure_at
       FROM subscriptions WHERE subscription_id='sub_elyko'`,
    )
    .get() as Record<string, unknown>;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE subscriptions(
    subscription_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    checkout_session_id TEXT,
    customer_email TEXT,
    customer_name TEXT,
    price_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_end INTEGER NOT NULL,
    cancel_at_period_end INTEGER NOT NULL,
    livemode INTEGER NOT NULL,
    entitlement_valid_until INTEGER NOT NULL DEFAULT 0,
    last_paid_invoice_id TEXT,
    last_paid_at INTEGER,
    last_payment_failure_invoice_id TEXT,
    last_payment_failure_at INTEGER,
    updated_at INTEGER NOT NULL
  )`);
});

describe('Stripe settlement convergence', () => {
  it('never lets an older paid invoice replace the latest paid entitlement', () => {
    write({ paidThrough: 2_000, paidInvoiceId: 'in_p2', paidAt: 1_100 });
    write({ paidThrough: 1_000, paidInvoiceId: 'in_p1', paidAt: 900 });
    expect(state()).toMatchObject({
      entitlement_valid_until: 2_000,
      last_paid_invoice_id: 'in_p2',
      last_paid_at: 1_100,
    });
  });

  it('ignores an old payment failure delivered after a newer payment', () => {
    write({ paidThrough: 2_000, paidInvoiceId: 'in_p2', paidAt: 1_100 });
    write({ failedInvoiceId: 'in_p1', failedAt: 1_000 });
    expect(state()).toMatchObject({
      last_payment_failure_invoice_id: null,
      last_payment_failure_at: null,
    });
  });

  it('clears a current failure when that invoice is later paid', () => {
    write({ paidThrough: 1_000, paidInvoiceId: 'in_p1', paidAt: 900 });
    write({ failedInvoiceId: 'in_p2', failedAt: 1_100 });
    expect(state()).toMatchObject({
      last_payment_failure_invoice_id: 'in_p2',
      last_payment_failure_at: 1_100,
    });
    write({ paidThrough: 2_000, paidInvoiceId: 'in_p2', paidAt: 1_200 });
    expect(state()).toMatchObject({
      entitlement_valid_until: 2_000,
      last_paid_invoice_id: 'in_p2',
      last_payment_failure_invoice_id: null,
      last_payment_failure_at: null,
    });
  });

  it('keeps entitlement monotone when a later period fails', () => {
    write({ paidThrough: 1_000, paidInvoiceId: 'in_p1', paidAt: 900 });
    write({ failedInvoiceId: 'in_p2', failedAt: 1_100 });
    expect(state()).toMatchObject({
      entitlement_valid_until: 1_000,
      last_paid_invoice_id: 'in_p1',
      last_payment_failure_invoice_id: 'in_p2',
    });
  });
});

describe('Stripe webhook processing lease', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE stripe_events(
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      livemode INTEGER NOT NULL,
      event_created_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      processing_started_at INTEGER,
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER
    )`);
  });

  function insert() {
    db.prepare(INSERT_STRIPE_EVENT_SQL).run(
      'evt_same',
      'invoice.paid',
      0,
      1_000,
      1_010,
    );
  }

  function claim(now: number) {
    return db.prepare(CLAIM_STRIPE_EVENT_SQL).run(now, 'evt_same', now - 300)
      .changes;
  }

  it('allows only one active processor for the same event', () => {
    insert();
    insert();
    expect(claim(1_020)).toBe(1);
    expect(claim(1_021)).toBe(0);
  });

  it('releases a failed attempt so a retry can claim it', () => {
    insert();
    expect(claim(1_020)).toBe(1);
    db.prepare(RELEASE_STRIPE_EVENT_SQL).run('evt_same');
    expect(claim(1_021)).toBe(1);
    expect(
      db
        .prepare(
          "SELECT processing_attempts FROM stripe_events WHERE event_id='evt_same'",
        )
        .get(),
    ).toMatchObject({ processing_attempts: 2 });
  });

  it('recovers an abandoned lease but never reclaims a completed event', () => {
    insert();
    expect(claim(1_020)).toBe(1);
    expect(claim(1_400)).toBe(1);
    db.prepare(COMPLETE_STRIPE_EVENT_SQL).run(1_401, 'evt_same');
    expect(claim(2_000)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  checkoutAttemptFromSupabase,
  checkoutAttemptToSupabase,
  stripeEventFromSupabase,
  stripeEventToSupabase,
  subscriptionFromSupabase,
  subscriptionToSupabase,
  type LegacyStripeEvent,
  type LegacySubscription,
} from './supabase-repositories';

describe('Supabase repository boundary', () => {
  it('round-trips the legacy subscription contract', () => {
    const value: LegacySubscription = {
      subscription_id: 'sub_1',
      customer_id: 'cus_1',
      checkout_session_id: 'cs_test_1',
      customer_email: 'test@zentra.ch',
      customer_name: 'Zentra SA',
      price_id: 'price_1',
      status: 'active',
      current_period_end: 1_788_400_000,
      cancel_at_period_end: 0,
      livemode: 0,
      entitlement_valid_until: 1_788_400_000,
      last_paid_invoice_id: 'in_1',
      last_paid_at: 1_785_808_000,
      last_payment_failure_invoice_id: null,
      last_payment_failure_at: null,
      updated_at: 1_785_808_001,
    };
    expect(subscriptionFromSupabase(subscriptionToSupabase(value))).toEqual(
      value,
    );
  });

  it('maps an unpaid zero entitlement to a nullable PostgreSQL value', () => {
    const value: LegacySubscription = {
      subscription_id: 'sub_1',
      customer_id: 'cus_1',
      checkout_session_id: null,
      customer_email: null,
      customer_name: null,
      price_id: 'price_1',
      status: 'incomplete',
      current_period_end: 1_788_400_000,
      cancel_at_period_end: 0,
      livemode: 0,
      entitlement_valid_until: 0,
      last_paid_invoice_id: null,
      last_paid_at: null,
      last_payment_failure_invoice_id: null,
      last_payment_failure_at: null,
      updated_at: 1_785_808_001,
    };
    const row = subscriptionToSupabase(value);
    expect(row.entitlement_valid_until).toBeNull();
    expect(subscriptionFromSupabase(row)).toEqual(value);
  });

  it('round-trips checkout hashes and timestamps', () => {
    const hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const row = checkoutAttemptToSupabase({
      claim_hash: hash,
      checkout_session_id: 'cs_test_1',
      created_at: 1_785_808_000,
      expires_at: 1_817_344_000,
    });
    expect(row.claim_hash).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(checkoutAttemptFromSupabase(row).claim_hash).toBe(hash);
  });

  it('round-trips Stripe event processing state', () => {
    const value: LegacyStripeEvent = {
      event_id: 'evt_1',
      event_type: 'invoice.paid',
      livemode: 1,
      event_created_at: 1_785_808_000,
      received_at: 1_785_808_001,
      processing_started_at: 1_785_808_002,
      processing_attempts: 2,
      processed_at: null,
    };
    expect(stripeEventFromSupabase(stripeEventToSupabase(value))).toEqual(value);
  });
});

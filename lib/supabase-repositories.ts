import type { AccountRole } from './account-security';
import {
  base64UrlHashToPostgresBytea,
  booleanToD1Integer,
  d1BooleanToBoolean,
  epochSecondsToIso,
  isoToEpochSeconds,
  postgresByteaToBase64UrlHash,
} from './supabase-server-codec';

export type LegacySubscription = {
  subscription_id: string;
  customer_id: string;
  checkout_session_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  price_id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: 0 | 1;
  livemode: 0 | 1;
  entitlement_valid_until: number;
  last_paid_invoice_id: string | null;
  last_paid_at: number | null;
  last_payment_failure_invoice_id: string | null;
  last_payment_failure_at: number | null;
  updated_at: number;
};

export type SupabaseSubscriptionRow = {
  subscription_id: string;
  customer_id: string;
  checkout_session_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  price_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  livemode: boolean;
  entitlement_valid_until: string | null;
  last_paid_invoice_id: string | null;
  last_paid_at: string | null;
  last_payment_failure_invoice_id: string | null;
  last_payment_failure_at: string | null;
  updated_at: string;
};

export function subscriptionToSupabase(
  value: LegacySubscription,
): SupabaseSubscriptionRow {
  return {
    ...value,
    current_period_end: epochSecondsToIso(value.current_period_end)!,
    cancel_at_period_end: d1BooleanToBoolean(value.cancel_at_period_end),
    livemode: d1BooleanToBoolean(value.livemode),
    entitlement_valid_until:
      value.entitlement_valid_until > 0
        ? epochSecondsToIso(value.entitlement_valid_until)
        : null,
    last_paid_at: epochSecondsToIso(value.last_paid_at),
    last_payment_failure_at: epochSecondsToIso(value.last_payment_failure_at),
    updated_at: epochSecondsToIso(value.updated_at)!,
  };
}

export function subscriptionFromSupabase(
  value: SupabaseSubscriptionRow,
): LegacySubscription {
  return {
    ...value,
    current_period_end: isoToEpochSeconds(value.current_period_end)!,
    cancel_at_period_end: booleanToD1Integer(value.cancel_at_period_end),
    livemode: booleanToD1Integer(value.livemode),
    entitlement_valid_until:
      isoToEpochSeconds(value.entitlement_valid_until) ?? 0,
    last_paid_at: isoToEpochSeconds(value.last_paid_at),
    last_payment_failure_at: isoToEpochSeconds(
      value.last_payment_failure_at,
    ),
    updated_at: isoToEpochSeconds(value.updated_at)!,
  };
}

export type LegacyCheckoutAttempt = {
  claim_hash: string;
  checkout_session_id: string | null;
  created_at: number;
  expires_at: number;
};

export type SupabaseCheckoutAttemptRow = {
  claim_hash: string;
  checkout_session_id: string | null;
  created_at: string;
  expires_at: string;
};

export function checkoutAttemptToSupabase(
  value: LegacyCheckoutAttempt,
): SupabaseCheckoutAttemptRow {
  return {
    claim_hash: base64UrlHashToPostgresBytea(value.claim_hash),
    checkout_session_id: value.checkout_session_id,
    created_at: epochSecondsToIso(value.created_at)!,
    expires_at: epochSecondsToIso(value.expires_at)!,
  };
}

export function checkoutAttemptFromSupabase(
  value: SupabaseCheckoutAttemptRow,
): LegacyCheckoutAttempt {
  return {
    claim_hash: postgresByteaToBase64UrlHash(value.claim_hash),
    checkout_session_id: value.checkout_session_id,
    created_at: isoToEpochSeconds(value.created_at)!,
    expires_at: isoToEpochSeconds(value.expires_at)!,
  };
}

export type LegacyStripeEvent = {
  event_id: string;
  event_type: string;
  livemode: 0 | 1;
  event_created_at: number;
  received_at: number;
  processing_started_at: number | null;
  processing_attempts: number;
  processed_at: number | null;
};

export type SupabaseStripeEventRow = {
  event_id: string;
  event_type: string;
  livemode: boolean;
  event_created_at: string;
  received_at: string;
  processing_started_at: string | null;
  processing_attempts: number;
  processed_at: string | null;
};

export function stripeEventToSupabase(
  value: LegacyStripeEvent,
): SupabaseStripeEventRow {
  return {
    ...value,
    livemode: d1BooleanToBoolean(value.livemode),
    event_created_at: epochSecondsToIso(value.event_created_at)!,
    received_at: epochSecondsToIso(value.received_at)!,
    processing_started_at: epochSecondsToIso(value.processing_started_at),
    processed_at: epochSecondsToIso(value.processed_at),
  };
}

export function stripeEventFromSupabase(
  value: SupabaseStripeEventRow,
): LegacyStripeEvent {
  return {
    ...value,
    livemode: booleanToD1Integer(value.livemode),
    event_created_at: isoToEpochSeconds(value.event_created_at)!,
    received_at: isoToEpochSeconds(value.received_at)!,
    processing_started_at: isoToEpochSeconds(value.processing_started_at),
    processed_at: isoToEpochSeconds(value.processed_at),
  };
}

export type OrganizationMembershipRecord = {
  organizationId: string;
  organizationName: string;
  subscriptionId: string;
  role: AccountRole;
};

export type DeviceSessionRecord = OrganizationMembershipRecord & {
  sessionId: string;
  userId: string;
  installationId: string;
  entitlementValidUntil: number;
};

export type StripeEventClaim = 'claimed' | 'already_processed' | 'busy';

/**
 * Account writes that span several tables are deliberately represented as one
 * repository call. Their Supabase implementation must use a database function
 * so concurrent requests cannot leave a half-created organization, invitation
 * or device session.
 */
export interface ZentraAccountRepository {
  membershipsForUser(userId: string): Promise<OrganizationMembershipRecord[]>;
  deviceSessionByTokenHash(
    tokenHash: string,
    now: number,
  ): Promise<DeviceSessionRecord | null>;
  touchDeviceSession(sessionId: string, now: number): Promise<void>;
  consumeRateLimit(input: {
    rateKey: string;
    windowStartedAt: number;
    expiresAt: number;
  }): Promise<number>;
  linkSubscriptionOwner(input: {
    subscriptionId: string;
    organizationId: string;
    organizationName: string;
    membershipId: string;
    userId: string;
    email: string;
    displayName: string;
    now: number;
  }): Promise<{ organizationId: string; organizationName: string; created: boolean }>;
  createDeviceAuthorization(input: {
    deviceCodeHash: string;
    userCode: string;
    installationId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  approveDeviceAuthorization(input: {
    userCode: string;
    organizationId: string;
    approvedByUserId: string;
    now: number;
  }): Promise<boolean>;
  exchangeDeviceAuthorization(input: {
    deviceCodeHash: string;
    sessionId: string;
    sessionTokenHash: string;
    expiresAt: number;
    now: number;
  }): Promise<DeviceSessionRecord | 'pending' | 'expired' | 'consumed'>;
}

/**
 * Stripe event claiming and monotonic subscription settlement are atomic by
 * contract. A future adapter must map these methods to SECURITY DEFINER RPCs;
 * implementing them as read-then-write REST calls would reintroduce races.
 */
export interface ZentraStripeRepository {
  saveCheckoutAttempt(value: LegacyCheckoutAttempt): Promise<void>;
  checkoutAttemptByHash(hash: string): Promise<LegacyCheckoutAttempt | null>;
  upsertSubscriptionMonotonic(value: LegacySubscription): Promise<void>;
  subscriptionById(id: string): Promise<LegacySubscription | null>;
  claimEvent(value: LegacyStripeEvent, staleBefore: number): Promise<StripeEventClaim>;
  completeEvent(eventId: string, processedAt: number): Promise<void>;
  releaseEvent(eventId: string): Promise<void>;
  recordWebhookProof(input: {
    endpointId: string;
    secretSha256: string;
    livemode: boolean;
    apiVersion: string;
    eventId: string;
    verifiedAt: number;
  }): Promise<void>;
}

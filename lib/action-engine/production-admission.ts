import { requireDeviceSession } from '@/lib/account';
import {
  ACCOUNT_ROLES,
  AccountPublicError,
  bearerSessionToken,
  hashOpaqueToken,
  roleCanWriteInvoices,
  sha256Hex,
} from '@/lib/account-security';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { COMPLETE_PLANS, completePlan } from '@/lib/complete/plans';
import { database, runtimeValue } from '@/lib/runtime';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';
import type { QuoteLedgerPredicate } from './ledger-types';
import type { ActionActor, ActionAdmission } from './types';

/** A separate, explicit consent for drafts AND conditional customer creation. */
export const QUOTE_PREPARATION_CONSENT_VERSION =
  'action-engine-quote-draft-customer-2026-10-11';
export type QuoteAuthorityPurpose = 'read' | 'progression';

export type DeviceQuoteAuthority = Readonly<{
  actor: ActionActor;
  installationId: string;
  /** Current authority only. Never use this alone as a ledger/intake fence. */
  predicate: (purpose: QuoteAuthorityPurpose) => QuoteLedgerPredicate;
  /** Progression only: read access never claims permission to create a draft. */
  preflight: () => Promise<ActionAdmission>;
  authorizeRead: () => Promise<void>;
}>;

const WRITE_ROLES = ACCOUNT_ROLES.filter(roleCanWriteInvoices);
const CATALOGUE = COMPLETE_PLANS.map((value) => completePlan(value.id)!);
const NATIVE_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 160 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new AccountPublicError('Session Zentra absente ou invalide.', 401);
  return value;
}

const denied = () =>
  new AccountPublicError(
    'Votre accès ne permet pas cette préparation de devis. Vérifiez le compte et les réglages Automation.',
    403,
  );

/**
 * Private server composition, not an HTTP DTO or a complete financial fence.
 * Supports authenticated devices with a CURRENT PAID Stripe Complete period.
 * Trials, grants, prepaid products and transition-only rights never contribute.
 *
 * SQL rechecks D1 authority inside the caller's atomic batch. A caller MUST also
 * fence source/catalogue/customer identity and, for confirmation, corroborate a
 * canonical business publication. This module supplies neither. It writes no
 * business data, exposes no activation endpoint and grants no default opt-in.
 * Never log the request, token, predicate bindings or an authentication error.
 */
export async function createDeviceQuoteAuthority(
  request: Request,
): Promise<DeviceQuoteAuthority> {
  // Capture before any await: later mutation of Request.headers cannot switch
  // the session used by requireDeviceSession and the one bound into SQL.
  const headers = new Headers(request.headers);
  const origin = headers.get('Origin');
  if (origin !== null && !NATIVE_ORIGINS.includes(origin))
    throw new AccountPublicError('Ouvrez cette action dans Zentra.', 403);
  const capturedRequest = new Request(request.url, {
    method: 'GET',
    headers,
  });
  const token = bearerSessionToken(capturedRequest);
  const session = await requireDeviceSession(capturedRequest, WRITE_ROLES);
  const identity = Object.freeze({
    sessionId: identifier(session.sessionId),
    organizationId: identifier(session.organizationId),
    userId: identifier(session.userId),
    installationId: identifier(session.installationId),
    subscriptionId: identifier(session.subscriptionId),
  });
  const tokenHash = await hashOpaqueToken('device-session', token);
  const db = database();
  const actor: ActionActor = Object.freeze({
    organizationId: identity.organizationId,
    userId: identity.userId,
  });

  function predicate(purpose: QuoteAuthorityPurpose): QuoteLedgerPredicate {
    if (purpose !== 'read' && purpose !== 'progression') throw denied();
    // Read the server configuration again; an invalid/mismatched Stripe mode
    // cannot inherit authority from the factory's earlier authentication.
    const live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
    if (live === null)
      return Object.freeze({ sql: '0', bindings: Object.freeze([]) });
    const bindings: (string | number | null)[] = CATALOGUE.flatMap((plan) => [
      plan.id,
      plan.licensePlan,
      plan.seats,
    ]);
    bindings.push(
      identity.organizationId,
      identity.sessionId,
      tokenHash,
      identity.organizationId,
      identity.userId,
      identity.installationId,
      identity.subscriptionId,
      ...WRITE_ROLES,
      Number(live),
    );
    let sql = `EXISTS(
      WITH paid_catalogue(paid_plan_id,license_plan_id,seat_limit) AS (
        VALUES ${CATALOGUE.map(() => '(?,?,?)').join(',')}
      ), ranked_members AS (
        SELECT user_id, ROW_NUMBER() OVER (
          ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END,joined_at,membership_id
        ) AS seat
        FROM organization_members
        WHERE organization_id=? AND revoked_at IS NULL
      )
      SELECT 1 FROM device_sessions ds
      JOIN organizations o ON o.organization_id=ds.organization_id
      JOIN subscriptions s ON s.subscription_id=o.subscription_id
      JOIN complete_subscriptions c ON c.subscription_id=s.subscription_id
      JOIN paid_catalogue catalogue ON catalogue.paid_plan_id=c.paid_plan_id
      JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=ds.user_id
      JOIN ranked_members ranked ON ranked.user_id=m.user_id
      WHERE ds.session_id=? AND ds.token_hash=?
        AND ds.organization_id=? AND ds.user_id=? AND ds.installation_id=?
        AND s.subscription_id=? AND substr(s.subscription_id,1,4)='sub_'
        AND ds.revoked_at IS NULL
        AND typeof(ds.created_at)='integer' AND ds.created_at>0 AND ds.created_at<=unixepoch()
        AND typeof(ds.expires_at)='integer' AND ds.expires_at>=unixepoch()
        AND m.revoked_at IS NULL AND m.role IN (${WRITE_ROLES.map(() => '?').join(',')})
        AND s.status IN ('active','past_due') AND s.livemode=?
        AND typeof(s.livemode)='integer'
        AND typeof(c.paid_from)='integer' AND c.paid_from>0 AND c.paid_from<=unixepoch()
        AND typeof(c.paid_until)='integer' AND c.paid_until>unixepoch()
        AND typeof(s.entitlement_valid_until)='integer' AND s.entitlement_valid_until>unixepoch()
        AND typeof(c.last_paid_invoice_id)='text' AND length(trim(c.last_paid_invoice_id))>0
        AND s.entitlement_plan_id=catalogue.license_plan_id
        AND typeof(s.seat_limit)='integer' AND s.seat_limit=catalogue.seat_limit
        AND ranked.seat<=catalogue.seat_limit
        AND EXISTS(SELECT 1 FROM license_activations activation
          WHERE activation.subscription_id=s.subscription_id
            AND activation.installation_id=ds.installation_id AND activation.revoked_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM account_session_policy policy
          WHERE policy.user_id=ds.user_id AND (policy.deleted_at IS NOT NULL
            OR typeof(policy.revoked_before)<>'integer' OR policy.revoked_before<0
            OR ds.created_at<=policy.revoked_before))
        AND NOT EXISTS(SELECT 1 FROM complete_refunds refund
          WHERE refund.invoice_id=c.last_paid_invoice_id
            AND refund.customer_id=s.customer_id AND refund.livemode=s.livemode)`;
    if (purpose === 'progression') {
      sql += `
        AND EXISTS(SELECT 1 FROM automation_settings settings
          WHERE settings.organization_id=o.organization_id AND settings.enabled=1
            AND settings.mode='suggest' AND settings.consent_version=?
            AND typeof(settings.revision)='integer' AND settings.revision>=1
            AND typeof(settings.medium_threshold) IN ('integer','real')
            AND typeof(settings.high_threshold) IN ('integer','real')
            AND settings.medium_threshold>=0.5
            AND settings.medium_threshold<settings.high_threshold AND settings.high_threshold<=1
            AND CASE WHEN json_valid(settings.flags) THEN
              json_type(settings.flags)='array' AND EXISTS(
                SELECT 1 FROM json_each(settings.flags) flag
                WHERE flag.type='text' AND flag.value='email_classification'
              ) ELSE 0 END)
        AND EXISTS(SELECT 1 FROM automation_platform platform
          WHERE platform.id='features' AND CASE WHEN json_valid(platform.value) THEN
            json_type(platform.value)='array' AND EXISTS(
              SELECT 1 FROM json_each(platform.value) flag
              WHERE flag.type='text' AND flag.value='email_classification'
            ) ELSE 0 END)
        AND EXISTS(SELECT 1 FROM action_engine_quote_settings action
          JOIN organization_members grantor ON grantor.organization_id=action.organization_id
            AND grantor.user_id=action.granted_by
          WHERE action.organization_id=o.organization_id AND action.enabled=1
            AND typeof(action.revision)='integer' AND action.revision>=1
            AND action.consent_version=?
            AND typeof(action.granted_at)='integer' AND action.granted_at>0 AND action.granted_at<=unixepoch()
            AND grantor.revoked_at IS NULL AND grantor.role IN ('owner','admin'))`;
      bindings.push(
        AUTOMATION_CONSENT_VERSION,
        QUOTE_PREPARATION_CONSENT_VERSION,
      );
    }
    sql += ')';
    return Object.freeze({ sql, bindings: Object.freeze(bindings) });
  }

  async function authorizeRead(): Promise<void> {
    const gate = predicate('read');
    const row = await db
      .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`)
      .bind(...gate.bindings)
      .first<{ allowed: number }>();
    if (row?.allowed !== 1) throw denied();
  }

  async function preflight(): Promise<ActionAdmission> {
    const gate = predicate('progression');
    const row = await db
      .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed,
        json_object(
          'session',(SELECT json_array(expires_at,revoked_at) FROM device_sessions WHERE session_id=?),
          'membership',(SELECT json_array(role,joined_at,revoked_at) FROM organization_members WHERE organization_id=? AND user_id=?),
          'payment',(SELECT json_array(s.subscription_id,s.entitlement_plan_id,s.seat_limit,s.status,s.livemode,s.entitlement_valid_until,c.paid_plan_id,c.paid_from,c.paid_until,c.last_paid_invoice_id) FROM subscriptions s JOIN complete_subscriptions c ON c.subscription_id=s.subscription_id WHERE s.subscription_id=?),
          'automation',(SELECT json_array(revision,enabled,mode,flags,consent_version) FROM automation_settings WHERE organization_id=?),
          'platform',(SELECT value FROM automation_platform WHERE id='features'),
          'action',(SELECT json_array(revision,enabled,consent_version,granted_by,granted_at) FROM action_engine_quote_settings WHERE organization_id=?)
        ) AS revision_json`)
      .bind(
        ...gate.bindings,
        identity.sessionId,
        identity.organizationId,
        identity.userId,
        identity.subscriptionId,
        identity.organizationId,
        identity.organizationId,
      )
      .first<{ allowed: number; revision_json: string }>();
    if (row?.allowed !== 1 || typeof row.revision_json !== 'string')
      throw denied();
    return Object.freeze({
      ...actor,
      revision: await sha256Hex(`quote-authority-v1:${row.revision_json}`),
      automationActive: true,
      mayPrepareQuote: true,
    });
  }

  return Object.freeze({
    actor,
    installationId: identity.installationId,
    predicate,
    preflight,
    authorizeRead,
  });
}

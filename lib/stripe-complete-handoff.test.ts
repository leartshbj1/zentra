import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as ts from 'typescript';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

/** Evaluate the actual public settlement entry point, with a closed transport.
 * Product verification/projection has separate full-schema integration tests.
 * This boundary proves every upsert caller reaches it before legacy caches. */
function harness() {
  const trace: string[] = [];
  const cashInvoice = { id: 'in_bound', object: 'invoice' };
  const provider = { kind: 'closed-fixture' };
  let handled = true;
  let reject = false;
  let invoiceUnavailable = false;
  let hookArgs: unknown[] = [];
  const db = {
    prepare() {
      trace.push('legacy-prepare');
      return { bind() { return {}; } };
    },
    async batch() { trace.push('legacy-batch'); return []; },
  };
  class ClosedStripe {
    static createFetchHttpClient() { return {}; }
    invoices = { retrieve: async (id: string) => {
      trace.push('invoice:' + id);
      if (invoiceUnavailable) throw Error('invoice-unavailable');
      return cashInvoice;
    } };
  }
  const configuration = {
    secretKey: 'sk_test_closed_fixture', priceIds: { start: 'price_gestion' },
  };
  const modules: Record<string, unknown> = {
    stripe: { default: ClosedStripe },
    '@/lib/complete/stripe': {
      subscriptionCompletePlan: (subscription: Stripe.Subscription) =>
        subscription.metadata.service === 'zentra-complet'
          ? { id: 'team', priceChfCents: 9900 } : null,
    },
    '@/lib/complete/access': { UPSERT_COMPLETE_SQL: 'bundle-cache' },
    '@/lib/complete/change': { finishPlanChange: async () => trace.push('legacy-change') },
    '@/lib/automation/billing': { automationStripe: () => provider },
    './subscription-account': { linkPaidCheckoutAccount: async () => trace.push('legacy-link') },
    '@/lib/plans': { planByLicense: () => ({ id: 'start', licensePlan: 'plan-start', seats: 3 }) },
    '@/lib/runtime': { database: () => db, stripeConfiguration: () => configuration },
    '@/lib/stripe-sql': { UPSERT_SUBSCRIPTION_SQL: 'gestion-cache' },
    '@/lib/stripe-test-access': { stripeAutomaticTaxRequired: () => false },
    '@/lib/stripe-event': {
      stripeSecretKeyLivemode: () => false,
      stripeReferenceId: (value: string | { id: string } | null) =>
        typeof value === 'string' ? value : value?.id ?? '',
    },
    '@/lib/payments/stripe-complete-provisioning': {
      provisionStripeCompletePurchase: async (...args: unknown[]) => {
        trace.push('frozen-handoff'); hookArgs = args;
        if (reject) throw Error('target-changed');
        return handled;
      },
    },
  };
  const inertImports = new Set([
    '@/lib/site-origins', '@/lib/request-body', '@/lib/stripe-account',
    '@/lib/stripe-checkout', '@/lib/site-language-server',
    '@/lib/stripe-webhook', '@/lib/stripe-webhook-proof', '@/lib/referrals',
    '@/lib/license-constants',
  ]);
  const context = createContext({
    exports: {}, crypto: webcrypto, URL, TextEncoder, TextDecoder,
    Uint8Array, console: { error() {}, log() {} },
    require(id: string) {
      if (id in modules) return modules[id];
      if (inertImports.has(id)) return {};
      throw Error('UNEXPECTED_IMPORT:' + id);
    },
  });
  const source = readFileSync(new URL('./stripe.ts', import.meta.url), 'utf8');
  runInContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const entry = (context.exports as { upsertSubscription: (...args: unknown[]) => Promise<void> }).upsertSubscription;
  const subscription = {
    id: 'sub_bound', customer: 'cus_bound', status: 'active', livemode: false,
    metadata: { plan: 'plan-start', service: 'zentra-complet', complete_request_id: 'cpr_bound' },
    automatic_tax: { enabled: false }, cancel_at_period_end: false,
    items: { data: [{ quantity: 1, current_period_end: 300, price: {
      id: 'price_complete', currency: 'chf', unit_amount: 9900,
      tax_behavior: 'inclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    } }] },
  } as unknown as Stripe.Subscription;
  return {
    entry, trace, subscription, cashInvoice, provider,
    arguments: () => hookArgs,
    closed() { handled = false; },
    changed() { reject = true; },
    lostInvoice() { invoiceUnavailable = true; },
  };
}

describe('Complet settlement entry-point handoff', () => {
  it('intercepts status-only purchases before any cache or company mutation', async () => {
    const h = harness();
    await h.entry(h.subscription);
    expect(h.trace).toEqual(['frozen-handoff']);
    expect(h.arguments()[1]).toBeNull();
  });
  it('re-reads the bound paid invoice and passes the exact subscription/session', async () => {
    const h = harness(), session = { id: 'cs_bound' };
    await h.entry(h.subscription, session, { paidInvoiceId: 'in_bound', paidThrough: 300, paidAt: 120 });
    expect(h.trace).toEqual(['invoice:in_bound', 'frozen-handoff']);
    expect(h.arguments()).toEqual([h.subscription, h.cashInvoice, h.provider, 'sk_test_closed_fixture', session]);
  });
  it('never falls back to legacy grants when target or proof validation rejects', async () => {
    const h = harness(); h.changed();
    await expect(h.entry(h.subscription)).rejects.toThrow('target-changed');
    expect(h.trace).toEqual(['frozen-handoff']);
  });
  it('cannot grant anything if the paid invoice cannot be independently read', async () => {
    const h = harness(); h.lostInvoice();
    await expect(h.entry(h.subscription, null, { paidInvoiceId: 'in_bound', paidThrough: 300, paidAt: 120 })).rejects.toMatchObject({ status: 502 });
    expect(h.trace).toEqual(['invoice:in_bound']);
  });
  it('permits the historical renewal path only when the verifier returns false', async () => {
    const h = harness(); h.closed();
    await h.entry(h.subscription, null, { paidInvoiceId: 'in_bound', paidThrough: 300, paidAt: 120, paidFrom: 100 });
    expect(h.trace[0]).toBe('invoice:in_bound');
    expect(h.trace[1]).toBe('frozen-handoff');
    expect(h.trace).toContain('legacy-batch');
    expect(h.trace).toContain('legacy-link');
  });
  it('does not add provider reads to legacy bundle status updates', async () => {
    const h = harness(); delete h.subscription.metadata.complete_request_id;
    await h.entry(h.subscription);
    expect(h.trace).not.toContain('frozen-handoff');
    expect(h.trace.some(item => item.startsWith('invoice:'))).toBe(false);
    expect(h.trace).toContain('legacy-batch');
  });
});

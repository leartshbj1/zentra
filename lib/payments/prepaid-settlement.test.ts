import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepaidProduct } from './prepaid-catalog';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import {
  verifyPrepaidSettlement,
  type ExpectedPrepaidSettlement,
  type PrepaidSettlementEvidence,
} from './prepaid-settlement';

let expected: ExpectedPrepaidSettlement;
let evidence: PrepaidSettlementEvidence;
let network: ReturnType<typeof vi.spyOn>;
const periodId = `pfperiod_${'1'.repeat(64)}`;
const contractId = 'pfp_11111111-1111-4111-8111-111111111111';
type Json = Record<string, unknown>;
const transaction = () => evidence.transaction as Json;
const invoice = () => evidence.invoices[0] as Json;
function refunded(state = 'SUCCESSFUL', type = 'MERCHANT_INITIATED_ONLINE') {
  return {
    id: 51,
    linkedSpaceId: 405,
    transaction: { id: 71, linkedSpaceId: 405 },
    environment: 'LIVE',
    state,
    type,
    amount: 10,
    totalSettledAmount: state === 'FAILED' ? 0 : 10,
  };
}
beforeEach(() => {
  const catalog = prepaidProduct('complet:team')!;
  const dates = prepaidMonthlyPeriod(
    Date.parse('2026-10-06T10:11:12Z') / 1000,
    0,
  );
  expected = {
    contractId,
    ownerId: 'owner-fixture',
    organizationId: 'company-fixture',
    workspaceId: 'support-fixture',
    apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 405,
    environment: 'PRODUCTION',
    productKey: catalog.productKey,
    period: {
      periodId,
      contractId,
      ordinal: 0,
      startsAt: dates.startSeconds,
      endsAt: dates.endSeconds,
      currency: 'CHF',
      priceChfMinor: 9900,
      catalogVersion: catalog.catalogVersion,
      catalog,
    },
    transactionId: 71,
    customerReference: 'payer-fixture',
    planReference: 'complet-team-v1',
    paymentMethodConfigurationId: 20,
    connectorConfigurationId: 30,
    settlementEvidenceVerified: true,
  };
  const line = {
    type: 'PRODUCT',
    quantity: 1,
    uniqueId: periodId,
    sku: expected.planReference,
    amountIncludingTax: 99,
  };
  evidence = {
    apiOrigin: expected.apiOrigin,
    spaceId: 405,
    environment: 'PRODUCTION',
    transaction: {
      id: 71,
      linkedSpaceId: 405,
      state: 'FULFILL',
      environment: 'LIVE',
      authorizationEnvironment: 'PRODUCTION',
      currency: 'CHF',
      customerId: 'payer-fixture',
      merchantReference: periodId,
      invoiceMerchantReference: periodId,
      metaData: {
        zentra_period_id: periodId,
        zentra_plan_version: expected.planReference,
      },
      authorizationAmount: 99,
      completedAmount: 99,
      totalSettledAmount: 99,
      refundedAmount: 0,
      lineItems: [{ ...line }],
      paymentConnectorConfiguration: {
        id: 30,
        linkedSpaceId: 405,
        paymentMethodConfiguration: { id: 20 },
      },
    },
    invoices: [
      {
        id: 81,
        linkedSpaceId: 405,
        linkedTransaction: 71,
        state: 'PAID',
        environment: 'LIVE',
        merchantReference: periodId,
        amount: 99,
        outstandingAmount: 0,
        lineItems: [{ ...line }],
      },
    ],
    invoiceSearchComplete: true,
    refunds: [],
    refundSearchComplete: true,
  };
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('No merchant call is allowed.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
});

describe('pure prepaid settlement verifier of SDK-v2 re-read JSON', () => {
  it('accepts only a bound fully settled paid invoice and returns the exact store proof with pack price', async () => {
    const result = await verifyPrepaidSettlement(expected, evidence);
    expect(result).toMatchObject({
      state: 'paid',
      proof: {
        periodId,
        contractId,
        transactionId: 71,
        invoiceId: 81,
        apiOrigin: expected.apiOrigin,
        spaceId: 405,
        environment: 'PRODUCTION',
        ownerId: 'owner-fixture',
        organizationId: 'company-fixture',
        workspaceId: 'support-fixture',
        startsAt: expected.period.startsAt,
        endsAt: expected.period.endsAt,
        currency: 'CHF',
        priceChfMinor: 9900,
        catalogVersion: expected.period.catalogVersion,
      },
    });
    if (result.state !== 'paid')
      throw new Error('Expected local verified proof.');
    expect(result.proof.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proof)).toBe(true);
    expect(result.proof.priceChfMinor).not.toBe(
      expected.period.catalog.gestion!.licensePriceChfMinor,
    );
  });
  it('fingerprints only critical proof fields, preserving replay stability and excluding keys, payer PII and arbitrary provider metadata', async () => {
    const before = await verifyPrepaidSettlement(expected, evidence);
    Object.assign(transaction(), {
      customerEmailAddress: 'secret-pii@example.test',
      Authorization: 'secret-bearer',
      token: { secret: 'secret-token' },
      version: 900,
    });
    (transaction().metaData as Json).secret = 'secret-api-key';
    invoice().billingAddress = { familyName: 'Private person' };
    const after = await verifyPrepaidSettlement(expected, evidence);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(
      /secret|Private person|example.test/,
    );
  });
  it.each([
    ['transaction', 'environment', 'PREVIEW', 'transaction_environment'],
    [
      'transaction',
      'authorizationEnvironment',
      'TEST',
      'transaction_environment',
    ],
    [
      'transaction',
      'authorizationEnvironment',
      undefined,
      'transaction_environment',
    ],
    ['transaction', 'id', 72, 'transaction_scope'],
    ['transaction', 'linkedSpaceId', 406, 'transaction_scope'],
    ['transaction', 'customerId', 'another-payer', 'transaction_binding'],
    [
      'transaction',
      'merchantReference',
      'another-period',
      'transaction_binding',
    ],
    [
      'transaction',
      'invoiceMerchantReference',
      'another-period',
      'transaction_binding',
    ],
    [
      'transaction',
      'metaData',
      { zentra_period_id: periodId, zentra_plan_version: 'other-plan' },
      'transaction_binding',
    ],
    ['transaction', 'currency', 'EUR', 'transaction_amount'],
    ['transaction', 'completedAmount', 59, 'transaction_amount'],
    ['transaction', 'authorizationAmount', 100, 'transaction_amount'],
    ['transaction', 'completedAmount', '99', 'transaction_amount'],
    ['transaction', 'completedAmount', 99.00000000000001, 'transaction_amount'],
    ['invoice', 'linkedTransaction', 72, 'invoice_scope'],
    ['invoice', 'linkedSpaceId', 406, 'invoice_scope'],
    ['invoice', 'merchantReference', 'another-period', 'invoice_scope'],
    ['invoice', 'environment', 'PREVIEW', 'invoice_environment'],
    ['invoice', 'amount', 59, 'invoice_amount'],
    ['invoice', 'outstandingAmount', 1, 'invoice_amount'],
    ['invoice', 'outstandingAmount', -1, 'invoice_amount'],
    ['invoice', 'outstandingAmount', undefined, 'invoice_amount'],
  ])(
    'denies changed financial or scope evidence %s.%s=%j',
    async (entity, field, value, reason) => {
      (entity === 'transaction' ? transaction() : invoice())[field as string] =
        value;
      expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
        state: 'manual',
        reason,
      });
    },
  );
  it.each(['TEST', 'PREVIEW'] as const)(
    'never accepts a production proof from %s read provenance',
    async (mode) => {
      if (mode === 'TEST') evidence = { ...evidence, environment: 'TEST' };
      else expected = { ...expected, environment: 'TEST' };
      expect((await verifyPrepaidSettlement(expected, evidence)).state).toBe(
        'manual',
      );
    },
  );
  it('checks origin, requested method configuration and actual connector configuration independently', async () => {
    const foreign = { ...evidence, apiOrigin: 'https://app-wallee.com' };
    expect(await verifyPrepaidSettlement(expected, foreign)).toEqual({
      state: 'manual',
      reason: 'read_scope',
    });
    transaction().paymentConnectorConfiguration = {
      id: 31,
      linkedSpaceId: 405,
      paymentMethodConfiguration: { id: 20 },
    };
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'connector_scope',
    });
    transaction().paymentConnectorConfiguration = {
      id: 30,
      linkedSpaceId: 405,
      paymentMethodConfiguration: { id: 21 },
    };
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'connector_scope',
    });
  });
  it.each(['AUTHORIZED', 'COMPLETED', 'PROCESSING'])(
    'does not grant on an intermediate %s, even with a PAID invoice',
    async (state) => {
      transaction().state = state;
      expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
        state: 'pending',
        reason: 'transaction_pending',
      });
    },
  );
  it.each([undefined, 0, 98.99])(
    'FULFILL plus PAID without exact full settlement remains pending (%s)',
    async (amount) => {
      transaction().totalSettledAmount = amount;
      expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
        state: 'pending',
        reason: 'settlement_incomplete',
      });
    },
  );
  it('does not accept an over-settlement or waive missing connector guarantees', async () => {
    transaction().totalSettledAmount = 100;
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'transaction_amount',
    });
    transaction().totalSettledAmount = 99;
    expect(
      await verifyPrepaidSettlement(
        { ...expected, settlementEvidenceVerified: false },
        evidence,
      ),
    ).toEqual({ state: 'manual', reason: 'connector_settlement_unverified' });
  });
  it('requires complete unique invoice discovery, not a selected paid winner or a return-page indication', async () => {
    expect(
      await verifyPrepaidSettlement(expected, {
        ...evidence,
        invoiceSearchComplete: false,
      }),
    ).toEqual({ state: 'pending', reason: 'invoice_search_incomplete' });
    expect(
      await verifyPrepaidSettlement(expected, { ...evidence, invoices: [] }),
    ).toEqual({ state: 'pending', reason: 'invoice_missing' });
    expect(
      await verifyPrepaidSettlement(expected, {
        ...evidence,
        invoices: [invoice(), invoice()],
      }),
    ).toEqual({ state: 'manual', reason: 'invoice_ambiguous' });
    expect(
      await verifyPrepaidSettlement(expected, {
        ...evidence,
        invoices: [invoice(), { ...invoice(), id: 82, state: 'OPEN' }],
      }),
    ).toEqual({ state: 'manual', reason: 'invoice_ambiguous' });
  });
  it.each(['OPEN', 'CANCELED', 'DERECOGNIZED', 'NOT_APPLICABLE'])(
    'does not convert invoice state %s into paid coverage',
    async (state) => {
      invoice().state = state;
      expect(
        (await verifyPrepaidSettlement(expected, evidence)).state,
      ).not.toBe('paid');
    },
  );
  it('denies derecognized PAID evidence and lines from another period or product', async () => {
    invoice().derecognizedOn = '2026-10-06T11:00:00Z';
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'invoice_state',
    });
    delete invoice().derecognizedOn;
    (invoice().lineItems as Json[])[0].uniqueId = 'another-period';
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'invoice_items',
    });
    (transaction().lineItems as Json[])[0].sku = 'another-plan';
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'transaction_items',
    });
  });
  it.each([
    'MERCHANT_INITIATED_ONLINE',
    'MERCHANT_INITIATED_OFFLINE',
    'CUSTOMER_INITIATED_AUTOMATIC',
    'CUSTOMER_INITIATED_MANUAL',
  ])(
    'returns a bound revocation for successful %s before requiring an invoice or original paid grant',
    async (type) => {
      const result = await verifyPrepaidSettlement(expected, {
        ...evidence,
        invoices: [],
        invoiceSearchComplete: false,
        refunds: [refunded('SUCCESSFUL', type)],
        refundSearchComplete: false,
      });
      expect(result).toMatchObject({
        state: 'revoked',
        reason: 'refunded',
        proof: {
          periodId,
          contractId,
          transactionId: 71,
          invoiceId: null,
          ownerId: expected.ownerId,
        },
      });
      if (result.state !== 'revoked')
        throw new Error('Expected negative payment proof.');
      expect(result.proof.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );
  it('uses the bound transaction refund aggregate even if refund discovery has not completed, without revoking foreign scope', async () => {
    transaction().refundedAmount = 0.01;
    expect(
      await verifyPrepaidSettlement(expected, {
        ...evidence,
        invoices: [],
        refundSearchComplete: false,
      }),
    ).toMatchObject({ state: 'revoked', reason: 'refunded' });
    transaction().customerId = 'wrong-payer';
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'transaction_binding',
    });
  });
  it.each(['VOIDED', 'DECLINE'])(
    'negative final transaction %s never needs fabricated invoice proof',
    async (state) => {
      transaction().state = state;
      expect(
        await verifyPrepaidSettlement(expected, { ...evidence, invoices: [] }),
      ).toMatchObject({ state: 'revoked', reason: 'transaction_reversed' });
    },
  );
  it.each(['CREATE', 'SCHEDULED', 'PENDING', 'MANUAL_CHECK'])(
    'a %s refund blocks any grant until resolved',
    async (state) => {
      expect(
        await verifyPrepaidSettlement(expected, {
          ...evidence,
          refunds: [refunded(state)],
        }),
      ).toEqual({ state: 'pending', reason: 'refund_pending' });
    },
  );
  it('ignores only a fully understood failed zero-settlement refund and requires exhaustive negative discovery', async () => {
    expect(
      (
        await verifyPrepaidSettlement(expected, {
          ...evidence,
          refunds: [refunded('FAILED')],
        })
      ).state,
    ).toBe('paid');
    expect(
      await verifyPrepaidSettlement(expected, {
        ...evidence,
        refundSearchComplete: false,
      }),
    ).toEqual({ state: 'pending', reason: 'refund_search_incomplete' });
    delete transaction().refundedAmount;
    expect(await verifyPrepaidSettlement(expected, evidence)).toEqual({
      state: 'manual',
      reason: 'refund_unknown',
    });
  });
  it('refuses foreign, duplicate, preview and unknown refund facts instead of dropping them from a positive proof', async () => {
    const base = refunded('FAILED');
    for (const [refund, reason] of [
      [{ ...base, transaction: { id: 72 } }, 'refund_scope'],
      [{ ...base, transaction: { id: 71 } }, 'refund_scope'],
      [
        { ...base, transaction: { id: 71, linkedSpaceId: 406 } },
        'refund_scope',
      ],
      [{ ...base, environment: 'PREVIEW' }, 'refund_environment'],
      [{ ...base, state: 'UNKNOWN' }, 'refund_unknown'],
      [{ ...base, type: 'UNKNOWN' }, 'refund_unknown'],
      [{ ...base, totalSettledAmount: 1 }, 'refund_unknown'],
    ] as const)
      expect(
        await verifyPrepaidSettlement(expected, {
          ...evidence,
          refunds: [refund],
        }),
      ).toEqual({ state: 'manual', reason });
    expect(
      await verifyPrepaidSettlement(expected, {
        ...evidence,
        refunds: [base, base],
      }),
    ).toEqual({ state: 'manual', reason: 'refund_ambiguous' });
  });
  it('fails closed on incomplete local binding objects or a snapshot with another currency', async () => {
    for (const invalid of [
      null,
      { ...expected, productKey: undefined },
      { ...expected, period: undefined },
      {
        ...expected,
        period: {
          ...expected.period,
          catalog: { ...expected.period.catalog, currency: 'EUR' },
        },
      },
    ])
      expect(
        await verifyPrepaidSettlement(
          invalid as unknown as ExpectedPrepaidSettlement,
          evidence,
        ),
      ).toEqual({ state: 'manual', reason: 'invalid_binding' });
  });
  it('rejects invalid local bindings and never moves covered dates from provider paidOn', async () => {
    expect(
      await verifyPrepaidSettlement(
        {
          ...expected,
          period: { ...expected.period, endsAt: expected.period.startsAt },
        },
        evidence,
      ),
    ).toEqual({ state: 'manual', reason: 'invalid_binding' });
    invoice().paidOn = '2099-01-01T00:00:00Z';
    const result = await verifyPrepaidSettlement(expected, evidence);
    expect(result).toMatchObject({
      state: 'paid',
      proof: {
        startsAt: expected.period.startsAt,
        endsAt: expected.period.endsAt,
      },
    });
  });
});

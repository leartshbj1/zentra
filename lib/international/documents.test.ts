import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPrintableDocument,
  renderPrintableDocumentHtml,
  reserveDocumentNumber,
  type CreditMemoDocument,
  type DocumentNumberingStore,
  type NumberCounter,
  type NumberReservation,
  type NumberReservationRequest,
  type PublicSellerDetails,
} from './documents';
import {
  buildTaxRequest,
  invoiceFromEstimate,
  recordCustomerPayment,
  type Estimate,
  type TaxAssessment,
  type PublicSellerSnapshot,
} from './invoicing';
import { money } from './money';
import { validateCompanyConfiguration } from './country-config';
import type { CompanyConfiguration } from './types';

// Every company, customer, tax determination and persistence port below is a fictitious contract fixture.
const US: CompanyConfiguration = {
  schemaVersion: 1,
  organizationId: 'org-us-mock',
  country: 'US',
  currency: 'USD',
  language: 'en',
  timeZone: 'America/New_York',
  address: {
    country: 'US',
    line1: '18 Fictional Street',
    postalCode: '10001',
    city: 'New York',
    subdivision: 'NY',
  },
  accountingBasis: 'accrual',
  invoiceNumberPrefix: 'DEMO',
  taxConfiguration: { status: 'configured' },
};
const CH: CompanyConfiguration = {
  schemaVersion: 1,
  organizationId: 'org-ch-mock',
  country: 'CH',
  currency: 'CHF',
  language: 'fr',
  timeZone: 'Europe/Zurich',
  address: {
    country: 'CH',
    line1: '18 Rue fictive',
    postalCode: '1201',
    city: 'Genève',
    subdivision: 'GE',
  },
  accountingBasis: 'accrual',
  invoiceNumberPrefix: 'DEMO',
  taxConfiguration: { status: 'configured' },
};
const seller = (company: CompanyConfiguration = US): PublicSellerDetails => ({
  organizationId: company.organizationId,
  displayName: 'Fictitious Services',
  contactEmail: 'fixture@example.invalid',
  contactPhone: '+1 212 555 0100',
});
function estimate(company: CompanyConfiguration = US): Estimate {
  return {
    id: 'estimate-mock',
    organizationId: company.organizationId,
    revision: 1,
    currency: company.currency,
    number: 'DEMO-EST-000001',
    customer: {
      id: 'private-customer-id',
      organizationId: company.organizationId,
      name: 'Fictitious Customer',
      kind: 'business',
      billingAddress: company.address,
      email: 'private-customer@example.invalid',
      phone: 'private-phone',
      paymentTermsDays: 30,
    },
    date: '2026-10-07',
    expiresAt: '2026-11-06',
    paymentTermsDays: 30,
    status: 'accepted',
    notes: 'First line\nSecond line\nThird line',
    lines: [
      {
        id: 'mock-line',
        description: 'Fictitious reviewed service',
        quantityUnits: '1',
        quantityScale: 0,
        unitPrice: money(company.currency, '45000'),
        discountBasisPoints: 0,
        taxTreatment: 'taxable',
      },
    ],
  };
}
function assessment(
  company: CompanyConfiguration = US,
  quote = estimate(company),
  taxMinor = '3645',
): TaxAssessment {
  const request = buildTaxRequest(company, quote, '2026-10-07');
  return {
    ...request,
    source: company.country === 'US' ? 'external-provider' : 'swiss-vat',
    providerReference: 'mock-provider-not-a-real-rate',
    determinedAt: '2026-10-07T10:00:00Z',
    validUntil: '2026-10-07T12:00:00Z',
    lines: request.lines.map((line) => ({
      id: line.id,
      taxMinor,
      jurisdiction: 'fictitious-jurisdiction',
      evidenceReference: 'mock-evidence',
    })),
  };
}
function invoice(
  company: CompanyConfiguration = US,
  quote = estimate(company),
  tax = assessment(company, quote),
) {
  return invoiceFromEstimate(
    company,
    quote,
    {
      id: 'invoice-mock',
      number: 'DEMO-INV-000001',
      date: '2026-10-07',
      accountingDate: '2026-10-07',
      dueDate: '2026-11-06',
    },
    tax,
    {
      organizationId: company.organizationId,
      userId: 'private-user-id',
      managementEntitled: true,
      canIssue: true,
      timestamp: '2026-10-07T11:00:00Z',
    }, seller(company),
  );
}
function credit(company: CompanyConfiguration = US): CreditMemoDocument {
  const quote = {
      ...estimate(company),
      id: 'credit-mock',
      number: 'DEMO-CM-000001',
    },
    totals = invoice(company, quote, assessment(company, quote));
  return {
    id: quote.id,
    organizationId: company.organizationId,
    revision: quote.revision,
    currency: company.currency,
    number: quote.number,
    referencedInvoiceId: 'private-original-invoice',
    referencedInvoiceNumber: 'DEMO-INV-000001',
    date: quote.date,
    customer: quote.customer,
    lines: quote.lines,
    notes: 'Reviewed credit fixture only',
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    taxAssessment: totals.taxAssessment,
    issuedAt: totals.issuedAt,
  };
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('External network forbidden in document tests');
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('safe offline printable projections', () => {
  it('renders US invoice with exact USD totals, Letter, Net terms and no Swiss QR/VAT UI', () => {
    const snapshot = buildPrintableDocument(US, seller(), {
      type: 'invoice',
      document: invoice(),
    });
    const html = renderPrintableDocumentHtml(snapshot);
    expect(snapshot).toMatchObject({
      currency: 'USD',
      paper: 'Letter',
      termsDays: 30,
      total: { currency: 'USD', minorUnits: '48645' },
    });
    expect(html).toContain('Invoice');
    expect(html).toContain('Sales tax');
    expect(html).toContain('Net 30');
    expect(html).toContain('$486.45');
    expect(html).toContain('@page{size:Letter;');
    expect(html).not.toMatch(/QR|TVA|swiss-vat/);
    expect(html).toContain('New York, NY 10001');
    expect(html).not.toMatch(/<script|<img|<iframe|<form|src=/);
    expect(html).toContain("default-src 'none'");
  });
  it('keeps totals beyond IEEE precision exact in display and snapshots', () => {
    const quote = estimate();
    const huge = {
      ...quote,
      lines: [
        { ...quote.lines[0], unitPrice: money('USD', '900719925474099301') },
      ],
    };
    const snapshot = buildPrintableDocument(US, seller(), {
      type: 'invoice',
      document: invoice(US, huge, assessment(US, huge, '0')),
    });
    expect(snapshot.total.minorUnits).toBe('900719925474099301');
    expect(renderPrintableDocumentHtml(snapshot)).toContain(
      '$9,007,199,254,740,993.01',
    );
  });
  it('prints a Swiss projection on A4 without impersonating the native QR renderer', () => {
    const snapshot = buildPrintableDocument(CH, seller(CH), {
      type: 'invoice',
      document: invoice(CH),
    });
    const html = renderPrintableDocumentHtml(snapshot);
    expect(snapshot.paper).toBe('A4');
    expect(html).toContain('Facture');
    expect(html).toContain('TVA');
    expect(html).not.toMatch(/<svg|<canvas|<img/);
  });
  it('keeps estimate tax explicitly undetermined and preserves multiline notes', () => {
    const snapshot = buildPrintableDocument(US, seller(), {
      type: 'estimate',
      document: estimate(),
    });
    const html = renderPrintableDocumentHtml(snapshot);
    expect(snapshot.tax).toBeNull();
    expect(html).toContain('Estimated subtotal');
    expect(html).toContain('Tax not determined');
    expect(html).toContain('First line\nSecond line\nThird line');
    expect(html).toContain('white-space:pre-line');
  });
  it.each([US, CH])(
    'prints an old $country invoice with its issuance context after preferences and tax configuration change',
    (originalCompany) => {
      const issued = invoice(originalCompany),
        changedCompany = validateCompanyConfiguration({
          ...originalCompany,
          language: originalCompany.language === 'en' ? 'fr' : 'en',
          address: {
            ...originalCompany.address,
            line1: '99 Changed Company Street',
          },
          taxConfiguration: { status: 'unconfigured' },
        });
      const snapshot = buildPrintableDocument(
        changedCompany,
        seller(originalCompany),
        { type: 'invoice', document: issued },
      );
      expect(snapshot.country).toBe(originalCompany.country);
      expect(snapshot.language).toBe(originalCompany.language);
      expect(snapshot.currency).toBe(originalCompany.currency);
      expect(snapshot.seller.address).toEqual(originalCompany.address);
      expect(snapshot.total.minorUnits).toBe('48645');
      const html = renderPrintableDocumentHtml(snapshot);
      expect(html).toContain(
        originalCompany.country === 'US' ? 'Invoice' : 'Facture',
      );
      expect(html).not.toContain('99 Changed Company Street');
    },
  );
  it('rejects a foreign issuance snapshot even when the current company and invoice match', () => {
    const issued = invoice();
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: {
          ...issued,
          companyConfiguration: { ...US, organizationId: 'foreign-snapshot' },
        },
      }),
    ).toThrow('scope_mismatch');
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: {
          ...issued,
          companyConfiguration: { ...CH, organizationId: US.organizationId },
        },
      }),
    ).toThrow('scope_mismatch');
  });
  it('still validates the current company before using a valid invoice snapshot', () => {
    const issued = invoice();
    expect(() =>
      buildPrintableDocument(
        { ...US, timeZone: 'invalid/current-zone' },
        seller(),
        { type: 'invoice', document: issued },
      ),
    ).toThrow();
    expect(() =>
      buildPrintableDocument(
        { ...US, organizationId: 'foreign-current-company' },
        seller(),
        { type: 'invoice', document: issued },
      ),
    ).toThrow('scope_mismatch');
  });
  it('reprints the original invoice seller after company name and contacts change, while estimates use current details', () => {
    const issued = invoice(),
      currentSeller = { ...seller(), displayName: 'Renamed Fictitious Services', contactEmail: 'changed@example.invalid', contactPhone: '+1 212 555 0199' };
    const historical = buildPrintableDocument(US, currentSeller, { type: 'invoice', document: JSON.parse(JSON.stringify(issued)) });
    expect(historical.seller).toMatchObject({ name: 'Fictitious Services', contactEmail: 'fixture@example.invalid', contactPhone: '+1 212 555 0100' });
    const html = renderPrintableDocumentHtml(historical);
    expect(html).not.toContain('Renamed Fictitious Services');
    expect(html).not.toContain('changed@example.invalid');
    expect(html).not.toContain('+1 212 555 0199');
    const draft = buildPrintableDocument(US, currentSeller, { type: 'estimate', document: estimate() });
    expect(draft.seller).toMatchObject({ name: currentSeller.displayName, contactEmail: currentSeller.contactEmail, contactPhone: currentSeller.contactPhone });
  });
  it('fails closed for missing, foreign or unwhitelisted historical seller records', () => {
    const issued = invoice();
    for (const invalidSeller of [undefined, { ...issued.sellerSnapshot, apiToken: 'not-for-print' }, { ...issued.sellerSnapshot, logoRef: { assetId: 'https://outside.example.invalid', contentSha256: 'a'.repeat(64) } }]) {
      expect(() => buildPrintableDocument(US, seller(), { type: 'invoice', document: { ...issued, sellerSnapshot: invalidSeller as PublicSellerSnapshot } })).toThrow('invalid_document');
    }
    expect(() => buildPrintableDocument(US, seller(), { type: 'invoice', document: { ...issued, sellerSnapshot: { ...issued.sellerSnapshot, organizationId: 'foreign-seller' } } })).toThrow('scope_mismatch');
  });
  it('does not dereference or render a reference-only seller logo until an immutable archive resolver exists', () => {
    const issued = invoice(),
      withLogo = { ...issued, sellerSnapshot: { ...issued.sellerSnapshot, logoRef: { assetId: '11111111-1111-4111-8111-111111111111', contentSha256: 'a'.repeat(64) } } };
    const snapshot = buildPrintableDocument(US, seller(), { type: 'invoice', document: withLogo });
    const html = renderPrintableDocumentHtml(snapshot);
    expect(html).not.toMatch(/<img|src=|11111111-1111-4111-8111-111111111111/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('prints reviewed credit memo with referenced invoice and no false balance due', () => {
    const snapshot = buildPrintableDocument(US, seller(), {
      type: 'credit_memo',
      document: credit(),
    });
    const html = renderPrintableDocumentHtml(snapshot);
    expect(html).toContain('Credit memo');
    expect(html).toContain('Credit total');
    expect(html).toContain('Referenced invoice');
    expect(html).not.toContain('Balance due');
    expect(snapshot.total.minorUnits).toBe('48645');
  });
  it.each(['en', 'fr', 'de', 'it'] as const)(
    'keeps translated headings for %s while preserving user text',
    (language) => {
      const configured = { ...US, language },
        snapshot = buildPrintableDocument(configured, seller(), {
          type: 'estimate',
          document: estimate(),
        });
      expect(renderPrintableDocumentHtml(snapshot)).toContain(
        `lang="${language}"`,
      );
      expect(snapshot.notes).toBe(estimate().notes);
    },
  );
  it('escapes injected markup in every printed text position; forged CSS paper cannot break out', () => {
    const attack =
      '</style><script>alert("XSS")</script><img src="https://bad.invalid" onerror="attack()">';
    const quote = estimate();
    const dirty = {
      ...quote,
      number: attack.slice(0, 100),
      notes: attack,
      customer: {
        ...quote.customer,
        name: attack,
        billingAddress: { ...US.address, line1: attack },
      },
      lines: [{ ...quote.lines[0], description: attack }],
    };
    const snapshot = buildPrintableDocument(
      US,
      { ...seller(), displayName: attack },
      { type: 'estimate', document: dirty },
    );
    const html = renderPrintableDocumentHtml(snapshot);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;XSS&quot;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</style><script>');
    expect(() =>
      renderPrintableDocumentHtml({ ...snapshot, paper: attack as 'A4' }),
    ).toThrow('invalid_document');
  });
  it('clones public seller/customer snapshots and never includes internal IDs, contacts, providers or audit actors', () => {
    const issued = invoice(),
      sellerInput = { ...seller(), apiToken: 'not-for-print' };
    const snapshot = buildPrintableDocument(US, sellerInput, {
      type: 'invoice',
      document: issued,
    });
    const html = renderPrintableDocumentHtml(snapshot),
      serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      'private-customer-id',
      'private-customer@example.invalid',
      'private-phone',
      'private-user-id',
      'mock-provider-not-a-real-rate',
      'not-for-print',
      US.organizationId,
    ]) {
      expect(html).not.toContain(privateValue);
      expect(serialized).not.toContain(privateValue);
    }
    sellerInput.displayName = 'changed';
    expect(snapshot.seller.name).toBe('Fictitious Services');
    expect(Object.isFrozen(snapshot.customer.address)).toBe(true);
    expect(Object.isFrozen(snapshot.lines[0].unitPrice)).toBe(true);
  });
  it.each(['document', 'seller', 'customer'] as const)(
    'refuses a foreign %s before rendering',
    (target) => {
      const quote = estimate();
      const selected =
        target === 'document'
          ? { ...quote, organizationId: 'other' }
          : target === 'customer'
            ? {
                ...quote,
                customer: { ...quote.customer, organizationId: 'other' },
              }
            : quote;
      expect(() =>
        buildPrintableDocument(
          US,
          target === 'seller'
            ? { ...seller(), organizationId: 'other' }
            : seller(),
          { type: 'estimate', document: selected },
        ),
      ).toThrow('scope_mismatch');
    },
  );
  it('refuses CHF/Swiss VAT determinations for US and inconsistent stored totals', () => {
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: { ...invoice(), currency: 'CHF' },
      }),
    ).toThrow('currency_mismatch');
    const issued = invoice();
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: {
          ...issued,
          taxAssessment: { ...issued.taxAssessment, source: 'swiss-vat' },
        },
      }),
    ).toThrow('INVALID_TAX_SYSTEM');
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: { ...issued, total: money('USD', '1') },
      }),
    ).toThrow('tax_mismatch');
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: { ...issued, tax: money('CHF', '3645') },
      }),
    ).toThrow('currency_mismatch');
  });
  it('historical invoice tax expiry does not prevent printing or invent a new determination', () => {
    const issued = invoice();
    expect(
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: issued,
      }).tax?.minorUnits,
    ).toBe('3645');
    expect(issued.taxAssessment.validUntil).toBe('2026-10-07T12:00:00Z');
  });
  it('prints paid balance only after checking payment tenant/currency/duplicates', () => {
    const issued = invoice();
    const payment = {
      id: 'mock-payment',
      idempotencyKey: 'mock-payment-request',
      organizationId: US.organizationId,
      invoiceId: issued.id,
      amount: money('USD', '10000'),
      paymentDate: '2026-10-08',
      accountingDate: '2026-10-08',
      reference: 'mock-bank-reference',
    };
    const actor = {
      organizationId: US.organizationId,
      userId: 'private-user-id',
      managementEntitled: true,
      canIssue: true,
      timestamp: '2026-10-08T11:00:00Z',
    };
    const paid = recordCustomerPayment(US, issued, payment, actor);
    expect(
      buildPrintableDocument(US, seller(), { type: 'invoice', document: paid })
        .balance?.minorUnits,
    ).toBe('38645');
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: {
          ...paid,
          payments: [{ ...paid.payments[0], organizationId: 'other' }],
        },
      }),
    ).toThrow('scope_mismatch');
    expect(() =>
      buildPrintableDocument(US, seller(), {
        type: 'invoice',
        document: { ...paid, payments: [paid.payments[0], paid.payments[0]] },
      }),
    ).toThrow('invalid_document');
  });
});

/** Fictitious CAS model. Real adapters must implement this transaction in persistent storage. */
class MockNumberingStore implements DocumentNumberingStore {
  readonly counters = new Map<string, NumberCounter>();
  readonly reservations = new Map<string, NumberReservation>();
  readonly conversions = new Map<string, NumberReservation>();
  beforeCas: (() => void) | null = null;
  loseNextResponse = false;
  async readCounter(org: string, type: string) {
    return structuredClone(this.counters.get(`${org}/${type}`) ?? null);
  }
  async readReservation(org: string, type: string, request: string) {
    return structuredClone(
      this.reservations.get(`${org}/${type}/${request}`) ?? null,
    );
  }
  async readConversion(org: string, estimateId: string, revision: number) {
    return structuredClone(
      this.conversions.get(`${org}/${estimateId}/${revision}`) ?? null,
    );
  }
  async compareAndSwap(
    input: Parameters<DocumentNumberingStore['compareAndSwap']>[0],
  ) {
    this.beforeCas?.();
    const row = input.reservation,
      counterKey = `${row.organizationId}/${row.documentType}`,
      requestKey = `${counterKey}/${row.idempotencyKey}`;
    const old = this.counters.get(counterKey);
    if (
      (old?.revision ?? null) !== input.expectedRevision ||
      this.reservations.has(requestKey)
    )
      return null;
    const conversionKey = row.conversion
      ? `${row.organizationId}/${row.conversion.estimateId}/${row.conversion.revision}`
      : null;
    if (conversionKey && this.conversions.has(conversionKey)) return null;
    this.counters.set(counterKey, structuredClone(input.counter));
    this.reservations.set(requestKey, structuredClone(row));
    if (conversionKey)
      this.conversions.set(conversionKey, structuredClone(row));
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('Mock storage response lost after atomic commit');
    }
    return structuredClone(row);
  }
}
const request = (id = 'mock-document'): NumberReservationRequest => ({
  documentType: 'invoice',
  documentId: id,
  idempotencyKey: id,
  documentFingerprint: 'a'.repeat(64),
});

describe('organization/document-type CAS numbering and conversion identity', () => {
  it('separates organization/type counters instead of a global counter', async () => {
    const store = new MockNumberingStore();
    expect((await reserveDocumentNumber(US, request(), store)).number).toBe(
      'DEMO-INV-000001',
    );
    expect(
      (
        await reserveDocumentNumber(
          US,
          { ...request('estimate-2'), documentType: 'estimate' },
          store,
        )
      ).number,
    ).toBe('DEMO-EST-000001');
    expect((await reserveDocumentNumber(CH, request(), store)).number).toBe(
      'DEMO-INV-000001',
    );
    expect(
      (await reserveDocumentNumber(US, request('second-invoice'), store))
        .number,
    ).toBe('DEMO-INV-000002');
    expect(store.counters.size).toBe(3);
  });
  it('eight exact concurrent retries allocate one number and one document', async () => {
    const store = new MockNumberingStore(),
      input = request();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveDocumentNumber(US, input, store)),
    );
    expect(new Set(results.map((result) => result.number)).size).toBe(1);
    expect(store.reservations.size).toBe(1);
    expect(
      store.counters.get(`${US.organizationId}/invoice`)?.nextSequence,
    ).toBe('2');
  });
  it('concurrent distinct requests receive different numbers without gaps from losing CAS attempts', async () => {
    const store = new MockNumberingStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reserveDocumentNumber(US, request(`mock-${i}`), store),
      ),
    );
    expect(new Set(results.map((result) => result.number)).size).toBe(8);
    expect(
      store.counters.get(`${US.organizationId}/invoice`)?.nextSequence,
    ).toBe('9');
  });
  it('same source estimate/revision/content converges to the winning invoice ID across different requests', async () => {
    const store = new MockNumberingStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reserveDocumentNumber(
          US,
          {
            ...request(`click-${i}`),
            conversion: { estimateId: 'source-estimate', revision: 3 },
          },
          store,
        ),
      ),
    );
    expect(new Set(results.map((result) => result.documentId)).size).toBe(1);
    expect(new Set(results.map((result) => result.number)).size).toBe(1);
    expect(store.conversions.size).toBe(1);
    expect(store.reservations.size).toBe(1);
  });
  it('refuses changed content/target with a reused request and a changed conversion source', async () => {
    const store = new MockNumberingStore(),
      input = {
        ...request(),
        conversion: { estimateId: 'source-estimate', revision: 1 },
      };
    await reserveDocumentNumber(US, input, store);
    await expect(
      reserveDocumentNumber(
        US,
        { ...input, documentFingerprint: 'b'.repeat(64) },
        store,
      ),
    ).rejects.toThrow('idempotency_conflict');
    await expect(
      reserveDocumentNumber(
        US,
        { ...input, documentId: 'different-target' },
        store,
      ),
    ).rejects.toThrow('idempotency_conflict');
    await expect(
      reserveDocumentNumber(
        US,
        {
          ...input,
          conversion: { estimateId: 'another-estimate', revision: 1 },
        },
        store,
      ),
    ).rejects.toThrow('invalid_store_record');
    await expect(
      reserveDocumentNumber(
        US,
        {
          ...request('other-click'),
          documentFingerprint: 'b'.repeat(64),
          conversion: input.conversion,
        },
        store,
      ),
    ).rejects.toThrow('idempotency_conflict');
  });
  it('lost response resumes the original reservation without recycling a number', async () => {
    const store = new MockNumberingStore();
    store.loseNextResponse = true;
    await expect(reserveDocumentNumber(US, request(), store)).rejects.toThrow(
      'Mock storage response lost',
    );
    const recovered = await reserveDocumentNumber(US, request(), store);
    expect(recovered.number).toBe('DEMO-INV-000001');
    expect(store.reservations.size).toBe(1);
    expect(
      (await reserveDocumentNumber(US, request('next'), store)).number,
    ).toBe('DEMO-INV-000002');
  });
  it('captures mutable request fields before awaited CAS and preserves prefix history', async () => {
    const store = new MockNumberingStore(),
      mutable = {
        ...request(),
        conversion: { estimateId: 'source-estimate', revision: 1 },
      };
    store.beforeCas = () => {
      mutable.conversion.revision = 2;
    };
    const result = await reserveDocumentNumber(US, mutable, store);
    expect(result.conversion?.revision).toBe(1);
    await expect(
      reserveDocumentNumber(
        { ...US, invoiceNumberPrefix: 'NEW' },
        {
          ...request(),
          conversion: { estimateId: 'source-estimate', revision: 1 },
        },
        store,
      ),
    ).rejects.toThrow('idempotency_conflict');
    expect(store.reservations.values().next().value?.number).toBe(
      'DEMO-INV-000001',
    );
  });
  it('refuses foreign/malformed counters rather than borrowing their sequence', async () => {
    const store = new MockNumberingStore();
    store.counters.set(`${US.organizationId}/invoice`, {
      organizationId: 'foreign',
      documentType: 'invoice',
      revision: 1,
      nextSequence: '99',
    });
    await expect(reserveDocumentNumber(US, request(), store)).rejects.toThrow(
      'invalid_store_record',
    );
    expect(store.reservations.size).toBe(0);
  });
  it.each([
    { documentFingerprint: '' },
    { documentId: '../bad' },
    { conversion: { estimateId: 'source', revision: 0 } },
    {
      documentType: 'estimate' as const,
      conversion: { estimateId: 'source', revision: 1 },
    },
  ])('refuses invalid numbering request %j', async (patch) => {
    const store = new MockNumberingStore();
    await expect(
      reserveDocumentNumber(US, { ...request(), ...patch }, store),
    ).rejects.toThrow('invalid_document');
    expect(store.reservations.size).toBe(0);
  });
});

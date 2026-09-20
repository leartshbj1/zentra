import { beforeEach, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
import {
  automationRequest,
  automationFeedback,
  bankContext,
  anomalyContext,
  featureReady,
  workflowScreens,
  type AutomationState,
} from './automation';
import {
  previewMappedCatalog,
  catalogHeaders,
  type CatalogMappingSource,
} from './catalogImport';
import type { BankMovement } from './types';
const state: AutomationState = {
  organizationId: 'org_a',
  active: true,
  canManage: true,
  available: ['transaction_classification'],
  settings: {
    enabled: true,
    consent: true,
    mode: 'suggest',
    flags: ['transaction_classification'],
    thresholds: { medium: 0.65, high: 0.9 },
  },
};
beforeEach(() => {
  mock.invoke.mockReset();
});
it.each([
  null,
  { ...state, active: false },
  { ...state, settings: { ...state.settings, consent: false } },
  { ...state, available: [] },
])(
  'does not send business context without active consent and flags',
  async (value) => {
    mock.invoke.mockResolvedValue(value);
    expect(
      await automationRequest('transaction_classification', {
        text: 'private',
      }),
    ).toEqual({ status: 'disabled' });
    expect(mock.invoke).toHaveBeenCalledTimes(1);
  },
);
it('retains manual use during a provider outage', async () => {
  mock.invoke
    .mockResolvedValueOnce(state)
    .mockRejectedValueOnce(Error('offline'));
  expect(
    await automationRequest(
      'transaction_classification',
      { text: 'Supplies' },
      'id',
    ),
  ).toMatchObject({ status: 'manual' });
});
it('uses stable identifiers for the same operation but separates companies', async () => {
  mock.invoke.mockImplementation(async (_command, input) =>
    input.data ? { status: 'suggestion' } : state,
  );
  await automationRequest(
    'transaction_classification',
    { text: 'Supplies' },
    'id',
  );
  await automationRequest(
    'transaction_classification',
    { text: 'Supplies' },
    'id',
  );
  const requests = mock.invoke.mock.calls
    .filter(([, input]) => input.data)
    .map(([, input]) => input.data.requestId);
  expect(requests[0]).toBe(requests[1]);
  expect(requests[0]).toMatch(/^[a-f0-9]{64}$/);
});
it('does not invent a completed feedback record after a network failure', async () => {
  mock.invoke.mockRejectedValue(Error('offline'));
  expect(
    await automationFeedback(
      { status: 'shadow', id: 'decision' },
      { category: 'material' },
    ),
  ).toBe(false);
});
it('does not include bank identifiers in decision context', () => {
  const movement = {
    id: 'a',
    accountId: 'SECRET-ACCOUNT',
    counterpartyIban: 'SECRET-IBAN',
    counterpartyName: 'Shop',
    unstructured: 'Supplies',
    amountCents: 100,
    currency: 'CHF',
    creditDebit: 'DBIT',
    bookingDate: '2026-09-20',
    valueDate: '',
  } as BankMovement;
  const context = bankContext(movement);
  expect(JSON.stringify(context)).not.toContain('SECRET');
  const other = {
    ...movement,
    id: 'b',
    amountCents: 500,
    currency: 'EUR',
    bookingDate: '2026-09-19',
  };
  expect(anomalyContext(movement, [other]).medianAmountCents).toBeUndefined();
});
it('offers only navigation destinations, never payment/deletion/permission tools', () => {
  expect(workflowScreens.payment).toBeUndefined();
  expect(workflowScreens.delete).toBeUndefined();
  expect(featureReady(state, 'supplier_routing')).toBe(false);
});
const source: CatalogMappingSource = {
  fileName: 'source.csv',
  sheetName: 'CSV',
  headerIndex: 0,
  rows: [
    ['Code externe', 'Libellé externe', 'Tarif', 'Taxe'],
    ['A1', 'Produit', 12.5, '8.1 %'],
  ].map((row) => row.map((value) => ({ value }))),
};
it('maps unrecognized headers while retaining money parsing and preview', () => {
  expect(catalogHeaders(source, 0)).toEqual([
    'Code externe',
    'Libellé externe',
    'Tarif',
    'Taxe',
  ]);
  const preview = previewMappedCatalog(source, 0, [
    'sku',
    'name',
    'salesPriceCents',
    'vatBp',
  ]);
  expect(preview.rows[0]).toMatchObject({
    sku: 'A1',
    name: 'Produit',
    salesPriceCents: 1250,
    vatBp: 810,
  });
});
it.each(
  [
    ['sku', 'sku', 'salesPriceCents', 'ignore'],
    ['sku', 'name', 'foreign', 'ignore'],
    ['ignore', 'name', 'salesPriceCents', 'ignore'],
  ].map((mapping) => [mapping]),
)('rejects duplicate, invented and missing required mapping %j', (mapping) => {
  expect(() => previewMappedCatalog(source, 0, mapping)).toThrow();
});

it('keeps wide catalogs manually importable without sending their data to the provider', () => {
  const wide = {
    ...source,
    rows: source.rows.map((row) => [
      ...row,
      ...Array.from({ length: 30 }, () => ({ value: '' })),
    ]),
  };
  expect(catalogHeaders(wide, 0)).toHaveLength(34);
  expect(
    previewMappedCatalog(wide, 0, [
      'sku',
      'name',
      'salesPriceCents',
      'vatBp',
      ...Array(30).fill('ignore'),
    ]).rows[0].salesPriceCents,
  ).toBe(1250);
});
it('rejects prototype names as import destinations', () => {
  expect(() =>
    previewMappedCatalog(source, 0, [
      'sku',
      'name',
      'salesPriceCents',
      'toString',
    ]),
  ).toThrow();
});

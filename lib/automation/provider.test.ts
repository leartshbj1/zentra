import { expect, it, vi } from 'vitest';
import {
  JevDecisionProvider,
  parseProviderResult,
  JEV_ENDPOINT,
} from './provider';
import { sanitizeState, sanitizeText } from './sanitize';
import { buildPolicy, ACTIONS } from './policies';
import { confidenceBand, thresholds, DecisionFailure } from './types';
const input = {
  state: { excerpt: 'Une facture de matériel' },
  questions: {
    category: {
      instructions: 'Classify.',
      options: { material: 'Matériel', other: 'Autre' },
    },
  },
};
const result = (patch: Record<string, unknown> = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    category: {
      type: 'choice',
      choice: 'material',
      confidence: 0.95,
      probabilities: { material: 0.98, other: 0.02 },
      ...patch,
    },
  },
  usage: { input_tokens: 20, output_tokens: 10, cost: 0.000001 },
});
const empty = { suppliers: [], projects: [], expenseCategories: [] };
it('sends actual typed API contract, sanitized state and no redirect credential forwarding', async () => {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result()));
  const value = await new JevDecisionProvider('fixture-key', mock).decide({
    ...input,
    state: {
      ...input.state,
      iban: 'CH9300762011623852957',
      secret: 'DO_NOT_SEND',
    },
  });
  const [url, options] = mock.mock.calls[0];
  expect(url).toBe(JEV_ENDPOINT);
  expect(options?.redirect).toBe('manual');
  const sent = JSON.parse(
    typeof options?.body === 'string' ? options.body : '',
  );
  expect(sent.questions.category).toEqual({
    type: 'choice',
    instructions: 'Classify.',
    criteria: input.questions.category.options,
  });
  expect(sent.state).toEqual(input.state);
  expect(value.usage).toEqual({
    inputTokens: 20,
    outputTokens: 10,
    cost: 0.000001,
  });
});
it.each([
  { choice: 'foreign_id' },
  { choice: '__proto__' },
  { confidence: -1 },
  { confidence: NaN },
  { confidence: 1.1 },
  { type: 'noul' },
  { probabilities: { material: 1.1, other: -0.1 } },
  { probabilities: { material: 0.5 } },
  { probabilities: { material: 0.1, other: 0.9 } },
  { probabilities: { material: 0.8, other: 0.8 } },
  { probabilities: { material: 0.9, other: 0.1, hidden: 0 } },
])('rejects invalid answer %j', (patch) => {
  expect(() => parseProviderResult(result(patch), input, 1)).toThrow(
    DecisionFailure,
  );
});
it.each([401, 403, 402, 422, 301, 302])(
  'does not retry status %i',
  async (status) => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private error', { status }));
    await expect(
      new JevDecisionProvider('fixture', mock).decide(input),
    ).rejects.toBeInstanceOf(DecisionFailure);
    expect(mock).toHaveBeenCalledTimes(1);
  },
);
it.each([429, 503, 529])(
  'retries transient status %i once with backoff',
  async (status) => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(Response.json(result()));
    const sleep = vi.fn(async () => {});
    await new JevDecisionProvider('fixture', mock, 100, sleep).decide(input);
    expect(sleep).toHaveBeenCalledWith(350);
    expect(mock).toHaveBeenCalledTimes(2);
  },
);
it('respects longer retry-after by falling back', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    );
  await expect(
    new JevDecisionProvider('fixture', mock).decide(input),
  ).rejects.toMatchObject({ code: 'rate_limit' });
  expect(mock).toHaveBeenCalledTimes(1);
});
it('times out and preserves manual fallback path', async () => {
  const mock = vi.fn<typeof fetch>().mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () =>
          reject(new DOMException('timeout', 'TimeoutError')),
        );
      }),
  );
  await expect(
    new JevDecisionProvider('fixture', mock, 15).decide(input),
  ).rejects.toMatchObject({ code: 'timeout' });
  expect(mock).toHaveBeenCalledTimes(1);
});
it.each(['not JSON', 'x'.repeat(65000)])(
  'rejects invalid or oversized body',
  async (text) => {
    await expect(
      new JevDecisionProvider(
        'fixture',
        vi.fn<typeof fetch>().mockResolvedValue(new Response(text)),
      ).decide(input),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  },
);
it('requires real key before request', async () => {
  const mock = vi.fn<typeof fetch>();
  await expect(
    new JevDecisionProvider('', mock).decide(input),
  ).rejects.toMatchObject({ code: 'configuration' });
  expect(mock).not.toHaveBeenCalled();
});
it('strips bank/account identifiers, auth keys, mails and links', () => {
  const text = sanitizeText(
    'Facture CH93 0076 2011 6238 5295 7 user@example.ch https://example.ch?token=x password=hunter2 Bearer secret-token-value 756.1234.5678.90',
  );
  expect(text).not.toMatch(/hunter2|secret-token-value|example.ch|CH93|756/);
  expect(
    sanitizeState({
      text: 'Facture',
      password: 'x',
      address: 'private',
      iban: 'CH99',
      rawDocument: 'all',
      amountCents: 120,
    }),
  ).toEqual({ text: 'Facture', amountCents: 120 });
});
it('centralizes confidence boundaries and rejects invalid settings', () => {
  const limits = thresholds({ medium: 0.65, high: 0.9 });
  expect(confidenceBand(0.649, limits)).toBe('low');
  expect(confidenceBand(0.65, limits)).toBe('medium');
  expect(confidenceBand(0.9, limits)).toBe('high');
  expect(() => thresholds({ medium: 0.9, high: 0.9 })).toThrow();
});
it('restricts assistant to known, role-permitted actions', () => {
  const p = buildPolicy(
    'agent_routing',
    { text: 'Crée une facture' },
    empty,
    'read_only',
  );
  expect(p.input.questions.action.options.create_invoice).toBeUndefined();
  expect(p.input.questions.action.options.get_project).toBeTruthy();
  expect(Object.keys(ACTIONS)).not.toContain('pay_invoice');
});
it('keeps raw resource IDs out of provider choices', () => {
  const p = buildPolicy(
    'supplier_routing',
    { text: 'Facture fournisseur' },
    {
      suppliers: [{ id: 'supplier-only-tenant-a', label: 'Matériel SA' }],
      projects: [],
      expenseCategories: [],
    },
    'owner',
  );
  expect(JSON.stringify(p.input)).not.toContain('supplier-only-tenant-a');
  expect(p.mappings.supplier.option_0).toBe('supplier-only-tenant-a');
  expect(p.input.questions.supplier.options.none).toBeTruthy();
});
it('refuses routing without actual resources', () => {
  expect(() =>
    buildPolicy('supplier_routing', { text: 'Facture' }, empty, 'owner'),
  ).toThrow();
});
it('uses deterministic date comparison and never crashes on invalid date', () => {
  const p = buildPolicy(
    'priority',
    { dueDate: '2026-09-19' },
    empty,
    'owner',
    '2026-09-20',
  );
  expect(p.minimumPriority).toBe('important');
  expect(p.input.state.overdue).toBe(true);
  expect(
    buildPolicy('priority', { dueDate: '2026-99-99' }, empty, 'owner')
      .minimumPriority,
  ).toBeUndefined();
  expect(
    buildPolicy('priority', { dueDate: '2026-02-31' }, empty, 'owner').input
      .state.overdue,
  ).toBe(false);
});
it('only sends import headers, not customer samples', () => {
  const p = buildPolicy(
    'import_mapping',
    {
      columns: ['Société', 'Date facture'],
      rows: [{ name: 'Private Person' }],
    },
    empty,
    'owner',
  );
  expect(p.input.state.headers).toEqual(['Société', 'Date facture']);
  expect(JSON.stringify(p.input)).not.toContain('Private Person');
});
it('requires minimal data', () => {
  expect(() => buildPolicy('document_routing', {}, empty, 'owner')).toThrow();
  expect(() =>
    buildPolicy('import_mapping', { columns: [] }, empty, 'owner'),
  ).toThrow();
});
it('limits catalogue mapping to fields the actual importer supports', () => {
  const p = buildPolicy(
    'import_mapping',
    { target: 'catalog', columns: ['Supplier product code'] },
    empty,
    'owner',
  );
  expect(p.input.questions.column_0.options.sku).toBeTruthy();
  expect(p.input.questions.column_0.options.invoice_number).toBeUndefined();
});

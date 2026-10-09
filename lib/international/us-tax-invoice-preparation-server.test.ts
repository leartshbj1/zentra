import { describe, expect, it } from 'vitest';
import { createUsTaxInvoicePreparationHandlers } from './us-tax-invoice-preparation-server';
import { invoicePreparationFixture } from './us-tax-invoice-preparation.test-fixtures';

async function body(response: Response, status: number) { expect(response.status).toBe(status); expect(response.headers.get('Cache-Control')).toContain('no-store'); const value = await response.json(); expect(JSON.stringify(value)).not.toMatch(/PRIVATE|acct_|settingsSha256|configurationFingerprint|legalName/); return value; }
describe('private TEST human invoice preparation HTTP', () => {
  it('stores actual financial actor and observed catalogue choices with a minimal response', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    expect(await body(await handlers.POST(f.http(), f.organizationId), 200)).toEqual({ schemaVersion: 1, organizationId: f.organizationId, status: 'prepared_test', idempotencyKey: f.request.idempotencyKey, replayed: false });
    expect(f.saved()?.actorUserId).toBe(f.actor.userId); expect(f.saved()?.classifications[0]).toMatchObject({ revision: 1, kind: 'service', taxBehavior: 'exclusive', evidenceReference: expect.stringMatching(/^ztaxprep_/) });
    expect(f.catalogue.readTaxCode).toHaveBeenCalledExactlyOnceWith('txcd_99999999'); expect(f.gateway.calculate).not.toHaveBeenCalled(); expect(f.erpStore.commit).not.toHaveBeenCalled(); expect(f.dependencies.preparations).toHaveBeenCalledWith(4);
  });
  it('replays saved exact choices before current merchant resolution or binding expiry', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    await handlers.POST(f.http(), f.organizationId); f.removeMerchant(); f.advance(200_000); f.dependencies.merchant.mockClear();
    expect(await body(await handlers.POST(f.http(), f.organizationId), 200)).toMatchObject({ replayed: true }); expect(f.dependencies.merchant).not.toHaveBeenCalled(); expect(f.catalogue.readTaxCode).toHaveBeenCalledOnce();
  });
  it('recovers a persisted preparation after a lost create response without a second create', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies); f.loseCreateResponse();
    expect(await body(await handlers.POST(f.http(), f.organizationId), 503)).toEqual({ error: 'service_unavailable' }); expect(f.saved()).not.toBeNull();
    expect(await body(await handlers.POST(f.http(), f.organizationId), 200)).toMatchObject({ replayed: true });
    expect(f.rpc.mock.calls.filter(([name]) => name === 'zentra_create_us_tax_invoice_preparation')).toHaveLength(1);
  });
  it('rejects changed choices under an existing exact ERP key', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies); await handlers.POST(f.http(), f.organizationId);
    expect(await body(await handlers.POST(f.http({ request: f.request, choices: { ...f.choices, addressSource: 'shipping' } }), f.organizationId), 409)).toEqual({ error: 'tax_preparation_conflict' }); expect(f.catalogue.readTaxCode).toHaveBeenCalledOnce();
  });
  it.each(['actor', 'account', 'confirmation', 'extra-choice', 'wrong-command'] as const)('rejects %s input without provider calls', async kind => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    const input = structuredClone({ request: f.request, choices: f.choices }) as unknown as { request: Record<string, unknown>; choices: Record<string, unknown>; actor?: string; account?: string };
    if (kind === 'actor') input.actor = 'forged'; if (kind === 'account') input.account = 'acct_Forged'; if (kind === 'confirmation') (input.choices.classifications as { confirmedService: boolean }[])[0].confirmedService = false;
    if (kind === 'extra-choice') input.choices.revision = 1; if (kind === 'wrong-command') input.request.command = { type: 'initialize', periods: [] };
    expect((await body(await handlers.POST(f.http(input), f.organizationId), 422) as { error: string }).error).toBe('invalid_request'); expect(f.gateway.verify).not.toHaveBeenCalled(); expect(f.saved()).toBeNull();
  });
  it.each(['member', 'read_only'])('rejects the actual %s role', async role => {
    const f = invoicePreparationFixture(); f.setRole(role); const handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    expect(await body(await handlers.POST(f.http(), f.organizationId), 403)).toEqual({ error: 'financial_permission_required' }); expect(f.dependencies.merchant).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'rotated', 'context', 'erp', 'late'] as const)('fences %s during catalogue read before creating preparation', async change => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    f.catalogue.readTaxCode.mockImplementationOnce(async id => {
      if (change === 'revoked') f.revoke(); if (change === 'rotated') f.rotate(); if (change === 'context') (f.context as { taxFactsRevision: number }).taxFactsRevision++;
      if (change === 'erp') f.editState(state => ({ ...state, revision: state.revision + 1 })); if (change === 'late') f.advance(30_001);
      return { id, name: 'Fictitious code', description: 'Technical catalogue entry' };
    });
    const response = await handlers.POST(f.http(), f.organizationId); expect(response.status).toBe(change === 'revoked' ? 401 : 409); await body(response, response.status); expect(f.saved()).toBeNull();
  });
  it('requires same-origin browser writes', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies), request = f.http(); request.headers.set('Origin', 'https://foreign.example');
    expect((await handlers.POST(request, f.organizationId)).status).toBe(403); expect(f.saved()).toBeNull();
  });
  it.each(['missing', 'extra', 'reversed'] as const)('rejects %s classification coverage before catalogue reads', async kind => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies), classifications = structuredClone(f.choices.classifications);
    if (kind === 'missing') classifications.length = 0;
    else classifications.push({ ...classifications[0], lineId: 'second' });
    if (kind === 'reversed') { f.editState(state => ({ ...state, estimates: [{ ...state.estimates[0], lines: [...state.estimates[0].lines, { ...state.estimates[0].lines[0], id: 'second' }] }] })); classifications.reverse(); }
    expect((await handlers.POST(f.http({ request: f.request, choices: { ...f.choices, classifications } }), f.organizationId)).status).toBe(422); expect(f.catalogue.readTaxCode).not.toHaveBeenCalled();
  });
  it('rejects fractional quantity before catalogue reads', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    f.editState(state => ({ ...state, estimates: [{ ...state.estimates[0], lines: [{ ...state.estimates[0].lines[0], quantityUnits: '15', quantityScale: 1 }] }] }));
    expect((await handlers.POST(f.http(), f.organizationId)).status).toBe(422); expect(f.catalogue.readTaxCode).not.toHaveBeenCalled();
  });
  it('returns bounded actual catalogue pages and individual code projections without writes', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies);
    expect(await body(await handlers.CATALOGUE_GET(f.http(undefined, '', 'GET'), f.organizationId), 200)).toEqual({ schemaVersion: 1, organizationId: f.organizationId, taxCodes: [{ id: 'txcd_99999999', name: 'Fictitious catalogue code', description: 'Technical catalogue entry' }], hasMore: false, nextCursor: null });
    expect(await body(await handlers.CATALOGUE_GET(f.http(undefined, '?code=txcd_99999999', 'GET'), f.organizationId), 200)).toMatchObject({ taxCode: { id: 'txcd_99999999' } }); expect(f.rpc).not.toHaveBeenCalled(); expect(f.gateway.calculate).not.toHaveBeenCalled();
  });
  it.each(['?code=txcd_99999999&cursor=txcd_99999999', '?code=wrong', '?cursor=wrong', '?secret=value'])('rejects invalid catalogue query %s', async query => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies); expect((await handlers.CATALOGUE_GET(f.http(undefined, query, 'GET'), f.organizationId)).status).toBe(422); expect(f.catalogue.listTaxCodes).not.toHaveBeenCalled(); expect(f.catalogue.readTaxCode).not.toHaveBeenCalled();
  });
  it('sanitizes a mismatched catalogue body and never creates preparation', async () => {
    const f = invoicePreparationFixture(), handlers = createUsTaxInvoicePreparationHandlers(f.dependencies); f.catalogue.readTaxCode.mockResolvedValueOnce({ id: 'txcd_11111111', name: 'PRIVATE name', description: 'PRIVATE raw body' });
    expect(await body(await handlers.POST(f.http(), f.organizationId), 503)).toEqual({ error: 'service_unavailable' }); expect(f.saved()).toBeNull();
  });
  it('rejects a valid but foreign context returned from the create port', async () => {
    const foreign = invoicePreparationFixture(); (foreign.context as { sellerRevision: number }).sellerRevision++;
    expect((await createUsTaxInvoicePreparationHandlers(foreign.dependencies).POST(foreign.http(), foreign.organizationId)).status).toBe(200);
    const f = invoicePreparationFixture(), forged = foreign.saved()!;
    f.dependencies.preparations.mockResolvedValueOnce({ read: async () => null, create: async () => forged });
    expect(await body(await createUsTaxInvoicePreparationHandlers(f.dependencies).POST(f.http(), f.organizationId), 409)).toEqual({ error: 'tax_preparation_changed' });
  });
  it('detaches the accepted estimate before catalogue awaits', async () => {
    const f = invoicePreparationFixture(), returned = f.state(); f.erpStore.read = async () => returned;
    f.catalogue.readTaxCode.mockImplementationOnce(async id => {
      (returned.estimates[0].lines[0] as { description: string }).description = 'Changed after review';
      return { id, name: 'Fictitious code', description: 'Technical entry' };
    });
    expect(await body(await createUsTaxInvoicePreparationHandlers(f.dependencies).POST(f.http(), f.organizationId), 409)).toEqual({ error: 'revision_conflict' }); expect(f.saved()).toBeNull();
  });
});

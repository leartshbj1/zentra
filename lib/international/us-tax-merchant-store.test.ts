import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { createSupabaseUsTaxMerchantStore, validateUsTaxMerchantReceipt, type UsTaxMerchantActivation, type UsTaxMerchantContext, type UsTaxMerchantReceipt } from './us-tax-merchant-store';

const org = 'TEST-org', requestId = '00000000-0000-4000-8000-000000000001';
const actor: FinancialAuthority = { organizationId: org, userId: 'TEST-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-10T12:00:00.000Z' };
function context(): UsTaxMerchantContext {
  return { organizationId: org, countryRevision: 1, configuration: { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } }, sellerRevision: 1, seller: { displayName: 'TEST Fictitious Seller' }, taxFactsRevision: 1, taxFacts: { schemaVersion: 1, legalName: 'PRIVATE_FICTITIOUS_NAME', taxOrigin: { country: 'US', line1: '9 Fictitious Private Origin', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' }, bindingRevision: 0 };
}
function activation(): UsTaxMerchantActivation {
  const captured = context();
  return { requestId, context: captured, credential: { reference: 'TEST-credential', revision: 1, accountId: 'acct_TEST' }, configurationFingerprint: 'c'.repeat(64), observation: { organizationId: org, accountId: 'acct_TEST', mode: 'test', apiVersion: '2026-08-26.dahlia', settingsSha256: 'a'.repeat(64), registrationsSha256: 'b'.repeat(64), observedAt: '2026-10-10T12:00:00.000Z', taxOrigin: captured.taxFacts.taxOrigin }, validUntil: '2026-10-10T12:02:00.000Z' };
}
function receipt(input = activation()): UsTaxMerchantReceipt {
  return { schemaVersion: 1, organizationId: org, requestId, actorUserId: actor.userId, countryRevision: 2, configurationChanged: true, configurationFingerprint: input.configurationFingerprint, credential: input.credential, binding: { organizationId: org, accountId: input.credential.accountId, mode: 'test', apiVersion: '2026-08-26.dahlia', revision: 1, settingsSha256: input.observation.settingsSha256, registrationsSha256: input.observation.registrationsSha256, observedAt: input.observation.observedAt, validUntil: input.validUntil, evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' } };
}
function client(rpc: (name: string, parameters: Record<string, unknown>) => Promise<unknown>) { return { rpc } as Pick<SupabaseServerClient, 'rpc'>; }
describe('US merchant private transport validation', () => {
  it('rejects non-owner bootstrap and uses the genuine financial actor for credential lookup', async () => {
    const input = activation(), rpc = vi.fn(async () => ({ credential: input.credential, configurationFingerprint: input.configurationFingerprint })), store = createSupabaseUsTaxMerchantStore(client(rpc));
    await expect(store.readContext({ ...actor, role: 'admin' })).rejects.toMatchObject({ code: 'owner_permission_required' });
    await expect(store.readReceipt({ ...actor, managementEntitled: false }, requestId)).rejects.toMatchObject({ status: 402 });
    expect(rpc).not.toHaveBeenCalled();
    expect(await store.readCredential({ ...actor, role: 'accountant' }, 1)).toEqual({ credential: input.credential, configurationFingerprint: input.configurationFingerprint });
    expect(rpc).toHaveBeenCalledWith('zentra_read_us_tax_merchant_credential', { p_organization: org, p_actor: { ...actor, role: 'accountant' }, p_binding_revision: 1 });
  });
  it('rejects storage tenant/extra fields, canonicalization changes and mismatched facts', async () => {
    for (const malformed of [{ ...context(), organizationId: 'OTHER' }, { ...context(), secret: 'PRIVATE_TEST_SENTINEL' }, { ...context(), seller: { displayName: ' leading' } }, { ...context(), taxFacts: { ...context().taxFacts, timeZone: 'America/Chicago' } }]) {
      const store = createSupabaseUsTaxMerchantStore(client(async () => malformed));
      await expect(store.readContext(actor)).rejects.toMatchObject({ code: 'invalid_stored_tax_merchant', status: 503 });
    }
  });
  it('detaches actor and the entire activation before the RPC await', async () => {
    const input = activation(), mutableActor = { ...actor }; let complete!: (value: unknown) => void;
    const rpc = vi.fn((_name: string, _parameters: Record<string, unknown>) => new Promise<unknown>(resolve => { complete = resolve; })), store = createSupabaseUsTaxMerchantStore(client(rpc));
    const pending = store.activate(mutableActor, input), expected = receipt(input);
    mutableActor.userId = 'CHANGED';
    (input.credential as { reference: string }).reference = 'CHANGED';
    (input.context.seller as { displayName: string }).displayName = 'CHANGED';
    (input.observation as { settingsSha256: string }).settingsSha256 = 'd'.repeat(64);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_actor: actor, p_credential: { reference: 'TEST-credential' }, p_context: { seller: { displayName: 'TEST Fictitious Seller' } }, p_observation: { settingsSha256: 'a'.repeat(64) } });
    // The fake response is independent JSON, just as a real HTTP/RPC decode is.
    complete({ ...expected, credential: { reference: 'TEST-credential', revision: 1, accountId: 'acct_TEST' }, binding: { ...expected.binding, settingsSha256: 'a'.repeat(64) } });
    expect(await pending).toMatchObject({ actorUserId: actor.userId, credential: { reference: 'TEST-credential' } });
  });
  it('rejects malformed activation observations before storage and never retries a mutation', async () => {
    const rpc = vi.fn(async () => { throw new SupabaseServerError(503, 'PM001', 'PRIVATE_TEST_SENTINEL'); }), store = createSupabaseUsTaxMerchantStore(client(rpc));
    for (const observation of [{ ...activation().observation, mode: 'live' }, { ...activation().observation, evidenceKind: 'test_fixture' }, { ...activation().observation, taxOrigin: context().configuration.address }]) await expect(store.activate(actor, { ...activation(), observation } as UsTaxMerchantActivation)).rejects.toMatchObject({ code: 'invalid_stored_tax_merchant' });
    expect(rpc).not.toHaveBeenCalled();
    await expect(store.activate(actor, activation())).rejects.toMatchObject({ code: 'tax_configuration_changed', status: 409, message: 'tax_configuration_changed' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('validates activation output against exact captured provenance and revision transition', async () => {
    for (const changed of [{ ...receipt(), configurationFingerprint: 'd'.repeat(64) }, { ...receipt(), configurationChanged: false }, { ...receipt(), countryRevision: 1 }, { ...receipt(), binding: { ...receipt().binding, revision: 2 } }]) {
      const store = createSupabaseUsTaxMerchantStore(client(async () => changed));
      await expect(store.activate(actor, activation())).rejects.toMatchObject({ code: 'invalid_stored_tax_merchant' });
    }
  });
  it('reads expired historical receipts without implying a current grant and rejects foreign actors/fixtures', async () => {
    expect(validateUsTaxMerchantReceipt(receipt(), org, requestId, actor.userId)).toEqual(receipt());
    const store = createSupabaseUsTaxMerchantStore(client(async () => receipt()));
    expect(await store.readReceipt(actor, requestId)).toEqual(receipt());
    expect(() => validateUsTaxMerchantReceipt(receipt(), org, requestId, 'OTHER')).toThrow('invalid_stored_tax_merchant');
    expect(() => validateUsTaxMerchantReceipt({ ...receipt(), binding: { ...receipt().binding, evidenceKind: 'test_fixture' } }, org, requestId, actor.userId)).toThrow('invalid_stored_tax_merchant');
  });
  it('sanitizes unknown storage/provider-shaped errors and preserves null credential absence', async () => {
    for (const failure of [Error('PRIVATE_TEST_SECRET'), new SupabaseServerError(500, 'unrecognized', 'PRIVATE_TEST_SECRET')]) {
      const store = createSupabaseUsTaxMerchantStore(client(async () => { throw failure; }));
      await expect(store.readContext(actor)).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable', status: 503 });
    }
    expect(await createSupabaseUsTaxMerchantStore(client(async () => null)).readCredential(actor, 1)).toBeNull();
  });
});

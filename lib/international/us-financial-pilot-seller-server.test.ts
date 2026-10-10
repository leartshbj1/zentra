import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsFinancialPilotSellerProof, type UsFinancialPilotSellerAppend, type UsFinancialPilotSellerProof, type UsFinancialPilotSellerRead, type UsFinancialPilotSellerRequest } from './us-financial-pilot-seller';
import { createUsFinancialPilotSellerHandlers, type UsFinancialPilotSellerServerDependencies } from './us-financial-pilot-seller-server';

const org = 'abcdef00-0000-4000-8000-000000000001';
async function fixture() {
  const seed = await financialKernelFixture(), data = JSON.parse(JSON.stringify(seed).replaceAll(seed.actor.organizationId, org)) as typeof seed;
  let current: UsFinancialPilotSellerRead = { head: { consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: 4, bankRevision: 2, sellerRevision: 7 }, presentation: {
    origin: 'legacy-frozen', baseSellerRevision: 7, sellerRevision: 7, changeCount: 0, profile: { displayName: 'Synthetic original' }, updatedBy: data.actor.userId, updatedAt: data.actor.timestamp, changeSha256: null } };
  const receipts = new Map<string, UsFinancialPilotSellerProof>();
  const store = {
    read: vi.fn(async () => structuredClone(current)), head: vi.fn(async () => structuredClone(current.head)), receipt: vi.fn(async (id: string) => structuredClone(receipts.get(id) ?? null)),
    append: vi.fn(async (input: UsFinancialPilotSellerAppend) => { current = await applyUsFinancialPilotSellerProof(current, input.proof); receipts.set(input.request.requestId, input.proof); return structuredClone(input.proof); }),
  };
  const scope = { scope: { organizationId: org, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const deps: UsFinancialPilotSellerServerDependencies = { enabled: vi.fn(async () => true), writeEnabled: vi.fn(async () => true), authority: vi.fn(async () => ({ mode: 'browser' as const, actor: data.actor })),
    configuration: vi.fn(async () => data.configuration), scope: vi.fn(async () => scope), store: vi.fn(async () => store), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn() };
  const request = (query = '', init: RequestInit = {}) => {
    const headers = new Headers({ 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': data.actor.userId, 'Sec-Fetch-Site': 'same-origin' });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return new Request(`https://zentraapp.ch/api/international/workspaces/${org}/financial-pilot/seller${query}`, { ...init, headers });
  };
  const input: UsFinancialPilotSellerRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: 'abcdef00-0000-4000-8000-000000000002', expectedRevision: 4, expectedSellerRevision: 7,
    command: { type: 'update_seller_presentation', displayName: 'Synthetic corrected', contactEmail: 'synthetic@example.test', contactPhone: null } };
  const post = (body: unknown = input, headers: Record<string, string> = {}) => request('', { method: 'POST', headers: { Origin: 'https://zentraapp.ch', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { data, current: () => current, setCurrent: (value: UsFinancialPilotSellerRead) => { current = value; }, receipts, store, scope, deps, request, input, post, handlers: createUsFinancialPilotSellerHandlers(deps) };
}
describe('seller HTTP — real B0/B1 domain, controlled state and synthetic Auth/D1', () => {
  it('reads one closed composite head/detail then appends S without changing F/B', async () => {
    const t = await fixture(), before = t.current();
    const head = await t.handlers.GET(t.request('?view=head'), org); expect(head.status).toBe(200); expect(await head.json()).toEqual(before.head); expect(t.store.read).not.toHaveBeenCalled();
    const detail = await t.handlers.GET(t.request('?revision=4&sellerRevision=7'), org); expect(detail.status).toBe(200); expect(await detail.json()).toEqual(before); expect(detail.headers.get('Cache-Control')).toContain('no-store');
    const response = await t.handlers.POST(t.post(), org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ sourceRevision: 4, sellerRevision: 8, replayed: false });
    expect(t.current().head).toEqual({ ...before.head, sellerRevision: 8 });
  });
  it('recovers an exact historical receipt while new writes are paused and F/S have advanced', async () => {
    const t = await fixture(); expect((await t.handlers.POST(t.post(), org)).status).toBe(200);
    t.setCurrent({ ...t.current(), head: { ...t.current().head, revision: 99, bankRevision: 12 } });
    t.deps.writeEnabled = async () => false; const handlers = createUsFinancialPilotSellerHandlers(t.deps); t.store.read.mockClear();
    const replay = await handlers.POST(t.post(), org); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ sourceRevision: 4, sellerRevision: 8, replayed: true }); expect(t.store.read).not.toHaveBeenCalled(); expect(t.store.append).toHaveBeenCalledOnce();
    const refused = await handlers.POST(t.post({ ...t.input, requestId: 'abcdef00-0000-4000-8000-000000000003', expectedRevision: 99, expectedSellerRevision: 8 }), org);
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: 'seller_writes_disabled' });
  });
  it('renews admission after commit and withholds a receipt after logout until exact recovery', async () => {
    const t = await fixture(), append = t.store.append.getMockImplementation()!; let revoked = false;
    t.store.append.mockImplementation(async input => { const proof = await append(input); revoked = true; return proof; });
    t.deps.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE LOGOUT', 401); return { mode: 'browser', actor: t.data.actor }; };
    const h = createUsFinancialPilotSellerHandlers(t.deps); expect((await h.POST(t.post(), org)).status).toBe(401); expect(t.receipts.size).toBe(1); revoked = false;
    expect((await h.POST(t.post(), org)).status).toBe(200); expect(t.store.append).toHaveBeenCalledOnce();
  });
  it('preserves uncertainty on a lost response/receipt outage, then recovers without a second append', async () => {
    const t = await fixture(), append = t.store.append.getMockImplementation()!, receipt = t.store.receipt.getMockImplementation()!; let offline = false;
    t.store.append.mockImplementation(async input => { await append(input); offline = true; throw new Error('PRIVATE LOST RESPONSE'); });
    t.store.receipt.mockImplementation(async id => { if (offline) throw new Error('PRIVATE RECEIPT OUTAGE'); return receipt(id); });
    expect((await t.handlers.POST(t.post(), org)).status).toBe(503); expect(t.receipts.size).toBe(1); offline = false;
    expect((await t.handlers.POST(t.post(), org)).status).toBe(200); expect(t.store.append).toHaveBeenCalledOnce();
  });
  it('fences F/S after detail resolution but permits B-only changes', async () => {
    const t = await fixture(); t.store.head.mockResolvedValueOnce({ ...t.current().head, bankRevision: 99 });
    expect((await t.handlers.GET(t.request('?revision=4&sellerRevision=7'), org)).status).toBe(200);
    t.store.head.mockResolvedValueOnce({ ...t.current().head, sellerRevision: 8 });
    expect((await t.handlers.GET(t.request('?revision=4&sellerRevision=7'), org)).status).toBe(409);
    t.store.head.mockResolvedValueOnce({ ...t.current().head, revision: 5 });
    expect((await t.handlers.GET(t.request('?revision=4&sellerRevision=7'), org)).status).toBe(409);
  });
  it.each(['admin', 'accountant'] as const)('allows %s reads but refuses every POST including receipt recovery', async role => {
    const t = await fixture(), actor = { ...t.data.actor, role }; t.deps.authority = async () => ({ mode: 'browser', actor }); t.deps.scope = async () => ({ ...t.scope, scope: { ...t.scope.scope, actor } });
    const h = createUsFinancialPilotSellerHandlers(t.deps); expect((await h.GET(t.request('?view=head'), org)).status).toBe(200); expect((await h.POST(t.post(), org)).status).toBe(403); expect(t.store.receipt).not.toHaveBeenCalled();
  });
  it.each(['', '?view=head&revision=4', '?view=head&view=head', '?revision=04&sellerRevision=7', '?revision=4', '?revision=4&sellerRevision=7&authority=owner'])('rejects closed query %s without touching a store', async query => {
    const t = await fixture(); expect((await t.handlers.GET(t.request(query), org)).status).toBe(422); expect(t.deps.store).not.toHaveBeenCalled();
  });
  it('refuses device, cross-origin, missing headers, oversized body and disabled installation', async () => {
    const t = await fixture(); expect((await t.handlers.POST(t.post(t.input, { Authorization: 'Bearer PRIVATE' }), org)).status).toBe(403);
    expect((await t.handlers.POST(t.post(t.input, { Origin: 'https://foreign.test' }), org)).status).toBe(403);
    expect((await t.handlers.GET(t.request('?view=head', { headers: { 'X-Zentra-Financial-Pilot': '' } }), org)).status).toBe(422);
    expect((await t.handlers.POST(t.post({ ...t.input, huge: 'x'.repeat(5000) }), org)).status).toBe(413);
    t.deps.enabled = async () => false; const h = createUsFinancialPilotSellerHandlers(t.deps); expect((await h.GET(t.request('?view=head'), org)).status).toBe(404); expect(t.store.append).not.toHaveBeenCalled();
  });
  it('renews full admission after a rejected source and exposes only stable error metadata', async () => {
    const t = await fixture(); let revoked = false;
    t.store.read.mockImplementation(async () => { revoked = true; throw new ErpError('seller_revision_conflict', 409); });
    t.deps.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE', 401); return { mode: 'browser', actor: t.data.actor }; };
    const response = await createUsFinancialPilotSellerHandlers(t.deps).GET(t.request('?revision=4&sellerRevision=7'), org);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

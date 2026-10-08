import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceCreationHandlers, workspaceCreationDependencies } from './workspace-creation-server';
import type { WorkspaceCreationIntent, WorkspaceCreationReceipt, WorkspaceCreationRequest } from './workspace-creation';

const binding = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: binding.user }));

const actorA = '10000000-0000-4000-8000-000000000001';
const actorB = '10000000-0000-4000-8000-000000000002';
const requestId = '10000000-0000-4000-8000-000000000003';
const url = 'https://zentraapp.ch/api/international/workspaces';
const timestamp = '2026-10-08T01:00:00.000Z';
const input: WorkspaceCreationRequest = {
  requestId, confirmationVersion: 1, companyName: 'Fictitious US company',
  configuration: {
    schemaVersion: 1, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
    address: { country: 'US', line1: '10 Fictitious Avenue', postalCode: '10001', city: 'New York', subdivision: 'NY' },
    accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789',
  },
};
const post = (value: unknown = input, headers: Record<string, string> = {}) => new Request(url, {
  method: 'POST', headers: { Origin: 'https://zentraapp.ch', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
});
const get = () => new Request(url + '?requestId=' + requestId);

// This fixture models durable receipts and response loss, not D1/PG locking.
// Real D1/PG concurrency is not proved here. Two-connection staging remains
// required; those guarantees are not claimed by this fixture.
function fixture() {
  let currentActor: string | null = actorA;
  const intents = new Map<string, WorkspaceCreationIntent>();
  const pgReceipts = new Map<string, WorkspaceCreationReceipt>();
  const key = (actor: string, request: string) => actor + ':' + request;
  const find = vi.fn(async (actor: string, request: string) => intents.get(key(actor, request)) ?? null);
  const reserve = vi.fn(async (candidate: WorkspaceCreationIntent) => {
    const existing = intents.get(key(candidate.actorUserId, candidate.requestId));
    if (existing) return existing;
    intents.set(key(candidate.actorUserId, candidate.requestId), candidate);
    return candidate;
  });
  const confirm = vi.fn(async (intent: WorkspaceCreationIntent, receipt: WorkspaceCreationReceipt, updatedAt: string) => {
    const existing = intents.get(key(intent.actorUserId, intent.requestId));
    if (existing?.state === 'postgres_confirmed') return existing;
    const saved: WorkspaceCreationIntent = { ...intent, state: 'postgres_confirmed', receipt, updatedAt };
    intents.set(key(intent.actorUserId, intent.requestId), saved);
    return saved;
  });
  const admit = vi.fn(async (intent: WorkspaceCreationIntent): Promise<unknown> => {
    const existing = pgReceipts.get(intent.creationId);
    if (existing) return { ...existing, replayed: true };
    const receipt: WorkspaceCreationReceipt = {
      creationId: intent.creationId, organizationId: intent.organizationId, actorUserId: intent.actorUserId,
      requestId: intent.requestId, configurationFingerprint: intent.fingerprint, configuration: intent.configuration,
      revision: 1, updatedBy: intent.actorUserId, updatedAt: timestamp, replayed: false,
    };
    pgReceipts.set(intent.creationId, receipt);
    return receipt;
  });
  const dependencies: Parameters<typeof createWorkspaceCreationHandlers>[0] = {
    enabled: vi.fn(() => true), user: vi.fn(async () => currentActor ? { userId: currentActor } : null),
    rateLimit: vi.fn(async () => undefined), store: vi.fn(async () => ({ find, reserve, confirm })),
    allocateId: vi.fn(() => crypto.randomUUID()), now: () => timestamp,
    fingerprint: vi.fn(async (value: string) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }),
    admit, diagnostic: vi.fn(),
  };
  return {
    dependencies, intents, pgReceipts, find, reserve, confirm, admit,
    handlers: createWorkspaceCreationHandlers(dependencies),
    changeActor(actor: string | null) { currentActor = actor; },
  };
}

beforeEach(() => { vi.clearAllMocks(); binding.user.mockResolvedValue({ userId: actorA }); });

describe('independent browser creation admission review', () => {
  it('uses the production identity binding without automatically claiming offered access', async () => {
    await workspaceCreationDependencies.user();
    expect(binding.user).toHaveBeenCalledExactlyOnceWith({ offerAccess: false });
  });

  it('defaults to closed without production flag bindings', async () => {
    expect(await workspaceCreationDependencies.enabled()).toBe(false);
  });

  it.each(['Bearer zds_fictitious', '', 'Basic fictitious'])('rejects Authorization %s without a browser-cookie fallback', async Authorization => {
    const f = fixture();
    const response = await f.handlers.POST(post(input, { Authorization }));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'browser_session_required' });
    expect(f.dependencies.user).not.toHaveBeenCalled(); expect(f.dependencies.store).not.toHaveBeenCalled();
  });

  it('rejects cross-site requests before identity or privileged storage', async () => {
    const f = fixture();
    expect((await f.handlers.POST(post(input, { Origin: 'https://attacker.test' }))).status).toBe(403);
    expect(f.dependencies.user).not.toHaveBeenCalled(); expect(f.dependencies.store).not.toHaveBeenCalled();
  });

  it('does not read the body, identity or state when disabled', async () => {
    const f = fixture(); vi.mocked(f.dependencies.enabled).mockReturnValue(false);
    expect((await f.handlers.POST(post())).status).toBe(404);
    expect((await f.handlers.GET(get())).status).toBe(404);
    expect(f.dependencies.user).not.toHaveBeenCalled(); expect(f.dependencies.store).not.toHaveBeenCalled();
  });

  it.each(['organizationId', 'userId', 'role', 'subscriptionId', 'entitlementValidUntil'])('refuses submitted authority field %s', async field => {
    const f = fixture();
    expect((await f.handlers.POST(post({ ...input, [field]: actorB }))).status).toBe(422);
    expect(f.dependencies.store).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });

  it.each([
    { ...input.configuration, organizationId: actorB },
    { ...input.configuration, taxConfiguration: { status: 'configured' } },
    { ...input.configuration, country: 'CH', currency: 'CHF' },
  ])('rejects an existing identity or non-initial national configuration', async configuration => {
    const f = fixture();
    expect((await f.handlers.POST(post({ ...input, configuration }))).status).toBe(422);
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('captures the creator before async fingerprinting and refuses a changed session before reservation', async () => {
    const f = fixture(); const fingerprint = vi.mocked(f.dependencies.fingerprint).getMockImplementation()!;
    vi.mocked(f.dependencies.fingerprint).mockImplementation(async value => {
      const result = await fingerprint(value); f.changeActor(actorB); return result;
    });
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'session_changed' });
    expect(f.find).toHaveBeenCalledExactlyOnceWith(actorA, requestId);
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('rechecks the creation flag after fingerprinting before any durable reservation', async () => {
    const f = fixture(); const fingerprint = vi.mocked(f.dependencies.fingerprint).getMockImplementation()!;
    vi.mocked(f.dependencies.fingerprint).mockImplementation(async value => {
      const result = await fingerprint(value); vi.mocked(f.dependencies.enabled).mockReturnValue(false); return result;
    });
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'feature_unavailable' });
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('rechecks identity after a durable reservation before calling PG', async () => {
    const f = fixture(); const reserve = f.reserve.getMockImplementation()!;
    f.reserve.mockImplementation(async candidate => { const saved = await reserve(candidate); f.changeActor(null); return saved; });
    expect((await f.handlers.POST(post())).status).toBe(401);
    expect(f.intents.size).toBe(1); expect(f.admit).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled();
  });

  it('does not confirm or disclose when identity changes after the PG commit', async () => {
    const f = fixture(); const admit = f.admit.getMockImplementation()!;
    f.admit.mockImplementation(async intent => { const receipt = await admit(intent); f.changeActor(actorB); return receipt; });
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'session_changed' });
    expect(f.pgReceipts.size).toBe(1); expect(f.confirm).not.toHaveBeenCalled();
    expect([...f.intents.values()][0].state).toBe('reserved');
  });

  it('preserves the durable state but withholds the response if permission disappears after D1 confirmation', async () => {
    const f = fixture(); const confirm = f.confirm.getMockImplementation()!;
    f.confirm.mockImplementation(async (...args) => { const saved = await confirm(...args); f.changeActor(null); return saved; });
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect([...f.intents.values()][0].state).toBe('postgres_confirmed');
  });

  it('uses a stable DTO fingerprint and replays reordered JSON without allocating another organization', async () => {
    const f = fixture(); const first = await f.handlers.POST(post()); const firstBody = await first.json() as { organizationId: string; creationId: string };
    const reordered = { configuration: Object.fromEntries(Object.entries(input.configuration).reverse()), companyName: input.companyName, confirmationVersion: 1, requestId };
    const second = await f.handlers.POST(post(reordered));
    expect(first.status).toBe(202); expect(second.status).toBe(202); expect(await second.json()).toEqual(firstBody);
    expect(f.dependencies.allocateId).toHaveBeenCalledTimes(2); expect(f.reserve).toHaveBeenCalledOnce(); expect(f.admit).toHaveBeenCalledOnce();
    const fingerprints = vi.mocked(f.dependencies.fingerprint).mock.calls.map(([value]) => value);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    for (const id of [firstBody.organizationId, firstBody.creationId, actorA, requestId]) expect(fingerprints[0]).not.toContain(id);
  });

  it('rejects changed content under the same actor/requestId before a second PG admission', async () => {
    const f = fixture(); await f.handlers.POST(post());
    const response = await f.handlers.POST(post({ ...input, companyName: 'Different fictitious company' }));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'request_id_conflict' });
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.dependencies.allocateId).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost PG response with the same durable creation and exact receipt', async () => {
    const f = fixture(); const admit = f.admit.getMockImplementation()!; let loseResponse = true;
    f.admit.mockImplementation(async intent => {
      const receipt = await admit(intent);
      if (loseResponse) { loseResponse = false; throw new Error('Fictitious PG response lost after commit'); }
      return receipt;
    });
    expect((await f.handlers.POST(post())).status).toBe(503);
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(202); expect(f.intents.size).toBe(1); expect(f.pgReceipts.size).toBe(1);
    expect(f.dependencies.allocateId).toHaveBeenCalledTimes(2); expect(f.confirm).toHaveBeenCalledOnce();
  });

  it.each(['organizationId', 'actorUserId', 'requestId', 'configurationFingerprint'])('refuses a PG receipt with mismatched %s without confirming or disclosing it', async field => {
    const f = fixture(); const admit = f.admit.getMockImplementation()!;
    f.admit.mockImplementation(async intent => ({ ...await admit(intent) as WorkspaceCreationReceipt, [field]: actorB }));
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(f.confirm).not.toHaveBeenCalled(); expect([...f.intents.values()][0].state).toBe('reserved');
  });

  it('recovers a lost D1 confirmation response without repeating PG admission', async () => {
    const f = fixture(); const confirm = f.confirm.getMockImplementation()!; let loseResponse = true;
    f.confirm.mockImplementation(async (...args) => {
      const saved = await confirm(...args);
      if (loseResponse) { loseResponse = false; throw new Error('Fictitious D1 response lost after confirmation'); }
      return saved;
    });
    expect((await f.handlers.POST(post())).status).toBe(503);
    expect((await f.handlers.POST(post())).status).toBe(202);
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce(); expect(f.intents.size).toBe(1);
  });

  it('converges simultaneous identical requests on one persisted intention and PG receipt', async () => {
    const f = fixture(); const responses = await Promise.all([f.handlers.POST(post()), f.handlers.POST(post())]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(f.intents.size).toBe(1); expect(f.pgReceipts.size).toBe(1);
    expect(new Set(f.admit.mock.calls.map(([intent]) => intent.organizationId)).size).toBe(1);
  });

  it('GET binds the lookup to the authenticated actor without revealing another actor’s creation', async () => {
    const f = fixture(); await f.handlers.POST(post()); f.changeActor(actorB);
    const response = await f.handlers.GET(get());
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
    expect(f.find).toHaveBeenLastCalledWith(actorB, requestId);
  });

  it('GET withholds a found receipt if the actor changes during the read', async () => {
    const f = fixture(); await f.handlers.POST(post()); const find = f.find.getMockImplementation()!;
    f.find.mockImplementation(async (...args) => { const saved = await find(...args); f.changeActor(actorB); return saved; });
    const response = await f.handlers.GET(get());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'session_changed' });
  });

  it('never exposes EIN, private receipt, fingerprint or a functional ready/subscription claim in POST or GET', async () => {
    const f = fixture(); const posted = await f.handlers.POST(post()); const read = await f.handlers.GET(get());
    for (const response of [posted, read]) {
      const text = await response.text(); const body = JSON.parse(text);
      expect(text).not.toContain(input.configuration.ein); expect(text).not.toContain('fingerprint'); expect(text).not.toContain(actorA);
      expect(body.receipt).toBeUndefined(); expect(body.subscriptionId).toBeUndefined(); expect(body.ready).toBeUndefined();
      expect(body.state).toBe('postgres_confirmed'); expect(body.setupStatus).toBe('us_subscription_required');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
    expect([...f.intents.values()][0].configuration.ein).toBe(input.configuration.ein);
  });

  it('reduces raw upstream errors and diagnostics to public codes without submitted or private values', async () => {
    const f = fixture(); f.admit.mockRejectedValue(new Error('PRIVATE_UPSTREAM_SECRET ' + input.configuration.ein));
    const response = await f.handlers.POST(post());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(f.dependencies.diagnostic).toHaveBeenCalledExactlyOnceWith({ operation: 'create', code: 'service_unavailable', status: 503 });
  });
});

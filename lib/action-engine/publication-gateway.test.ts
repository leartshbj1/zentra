import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from '@/lib/account';
import type {
  PublicationAttempt,
  PublicationIdentity,
  PublicationResult,
} from './publication-ledger-types';

const stubs = vi.hoisted(() => ({
  config: '',
  client: vi.fn(),
  begin: vi.fn(),
  settle: vi.fn(),
  read: vi.fn(),
  country: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtime', () => ({
  runtimeValue: () => stubs.config,
  database: () => ({}),
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: stubs.client,
}));
vi.mock('@/lib/international/legacy-country-guard', () => ({
  requireLegacyCountryTransport: stubs.country,
}));
vi.mock('./publication-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./publication-ledger')>()),
  createPublicationLedger: () => ({
    begin: stubs.begin,
    settle: stubs.settle,
    read: stubs.read,
    publicationPredicate: () => ({ sql: '0', bindings: [] }),
  }),
}));
import {
  commitCoordinatedCollaboration,
  publicationCoordinationEnabled,
  verifyPublicationFact,
} from './publication-gateway';
import { sha256Hex } from '@/lib/account-security';
import { backupManifest } from '@/lib/workspace-backup';

const id = '10000000-0000-4000-8000-000000000001';
const operation = '20000000-0000-4000-8000-000000000001';
const installation = '30000000-0000-4000-8000-000000000001';
const actor = {
  organizationId: 'qa-company',
  userId: 'qa-owner',
  installationId: installation,
  role: 'owner',
} as DeviceSessionContext;
const manifest = {
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: 'a'.repeat(64),
  size_bytes: 123,
  chunks: [{ sha256: 'c'.repeat(64), size_bytes: 123 }],
};
const success = { committed: true, revision: 1, snapshotId: id };
let attempt: PublicationAttempt,
  fact: Record<string, unknown>,
  snapshot: Record<string, unknown>;
let client: { select: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };
let order: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  stubs.config = '["qa-company"]';
  order = [];
  stubs.read.mockResolvedValue(null);
  attempt = {
    organizationId: actor.organizationId,
    snapshotId: id,
    installationId: installation,
    userId: actor.userId,
    baseRevision: 0,
    archiveSha256: manifest.sha256,
    manifestSha256: await sha256Hex(JSON.stringify(backupManifest(manifest))),
    sizeBytes: 123,
    id: operation,
    state: 'pending',
    result: null,
    createdAt: 1000,
    settledAt: null,
  };
  fact = {
    operationId: operation,
    organizationId: actor.organizationId,
    snapshotId: id,
    installationId: installation,
    userId: actor.userId,
    baseRevision: 0,
    state: 'committed',
    manifest,
    sizeBytes: 123,
    contentVersion: 0,
    result: success,
  };
  snapshot = {
    id,
    organization_id: actor.organizationId,
    installation_id: installation,
    created_by: actor.userId,
    base_revision: 0,
    revision: null,
    manifest,
    size_bytes: 123,
  };
  client = {
    select: vi.fn(async () => {
      order.push('snapshot');
      return [snapshot];
    }),
    rpc: vi.fn(async (name: string) => {
      order.push(name);
      if (name === 'zentra_enable_action_publication_guard_v1')
        return { guarded: true, revision: 0, snapshotId: null };
      if (name === 'zentra_action_publication_fact_v1') return fact;
      return success;
    }),
  };
  stubs.client.mockReturnValue(client);
  stubs.begin.mockImplementation(async (identity: PublicationIdentity) => {
    order.push('begin');
    return { state: 'owned', attempt: { ...attempt, ...identity } };
  });
  stubs.settle.mockImplementation(
    async (value: PublicationAttempt, result: PublicationResult) => {
      order.push('settle');
      return {
        ...value,
        state: result.committed ? 'committed' : 'cancelled',
        result,
      };
    },
  );
});

describe('private gateway opt-in', () => {
  it('defaults off and requires an explicit exact company allowlist', () => {
    stubs.config = '';
    expect(publicationCoordinationEnabled(actor.organizationId)).toBe(false);
    stubs.config = '[]';
    expect(publicationCoordinationEnabled(actor.organizationId)).toBe(false);
    stubs.config = '["other-company"]';
    expect(publicationCoordinationEnabled(actor.organizationId)).toBe(false);
    stubs.config = '["qa-company"]';
    expect(publicationCoordinationEnabled(actor.organizationId)).toBe(true);
  });
  it.each([
    'true',
    '{}',
    'null',
    '["../company"]',
    '["qa-company","qa-company"]',
    '[42]',
    'invalid',
  ])('fails closed on invalid server configuration %s', (config) => {
    stubs.config = config;
    expect(() => publicationCoordinationEnabled(actor.organizationId)).toThrow(
      'configuration',
    );
  });
  it('refuses an unselected company or consultation role without touching PG', async () => {
    stubs.config = '[]';
    await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
      'mode',
    );
    stubs.config = '["qa-company"]';
    await expect(
      commitCoordinatedCollaboration({ ...actor, role: 'read_only' }, id),
    ).rejects.toThrow('rôle');
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('guards before reading metadata, verifies permanent PG fact before D1 settlement', async () => {
    expect(await commitCoordinatedCollaboration(actor, id)).toEqual(success);
    expect(order).toEqual([
      'zentra_enable_action_publication_guard_v1',
      'snapshot',
      'begin',
      'zentra_commit_workspace_v2',
      'zentra_action_publication_fact_v1',
      'settle',
    ]);
    expect(client.rpc).toHaveBeenCalledWith('zentra_commit_workspace_v2', {
      p_organization: actor.organizationId,
      p_snapshot: id,
      p_installation: installation,
      p_actor: actor.userId,
      p_base: 0,
      p_operation: operation,
    });
    expect(stubs.begin).toHaveBeenCalledWith({
      organizationId: actor.organizationId,
      snapshotId: id,
      installationId: installation,
      userId: actor.userId,
      baseRevision: 0,
      archiveSha256: manifest.sha256,
      manifestSha256: attempt.manifestSha256,
      sizeBytes: 123,
    });
    expect(
      client.rpc.mock.calls.every(
        ([name]) => name !== 'zentra_commit_workspace',
      ),
    ).toBe(true);
  });
  it.each(['organization_id', 'created_by', 'installation_id', 'id'])(
    'refuses foreign %s before any D1 barrier',
    async (key) => {
      snapshot[key] = 'other';
      await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
        'autre version',
      );
      expect(stubs.begin).not.toHaveBeenCalled();
      expect(client.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps pending on mismatched canonical manifest after PG committed', async () => {
    fact.manifest = { ...manifest, app_version: '1.90.16' };
    await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
      'autre version',
    );
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it('keeps pending on missing or failed canonical proof and NEVER falls back', async () => {
    client.rpc.mockImplementation(async (name: string) => {
      if (name === 'zentra_enable_action_publication_guard_v1')
        return { guarded: true, revision: 0, snapshotId: null };
      if (name === 'zentra_action_publication_fact_v1')
        throw new Error('unavailable');
      return success;
    });
    await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
      'reprendra',
    );
    expect(stubs.settle).not.toHaveBeenCalled();
    expect(
      client.rpc.mock.calls.some(
        ([name]) => name === 'zentra_commit_workspace',
      ),
    ).toBe(false);
  });
  it('returns no completion if D1 settlement fails after verified PG commit', async () => {
    stubs.settle.mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
      'reprendra',
    );
    expect(client.rpc).toHaveBeenCalledWith(
      'zentra_action_publication_fact_v1',
      {
        p_organization: actor.organizationId,
        p_operation: operation,
      },
    );
  });
  it('does not bootstrap a stale D1 catalogue from a historical pre-opt-in replay', async () => {
    snapshot.revision = 1;
    client.rpc.mockResolvedValue({
      guarded: true,
      revision: 2,
      snapshotId: '10000000-0000-4000-8000-000000000002',
    });
    expect(await commitCoordinatedCollaboration(actor, id)).toEqual(success);
    expect(stubs.begin).not.toHaveBeenCalled();
    expect(stubs.settle).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
  it('can reconcile a currently published snapshot after a lost D1 settlement', async () => {
    snapshot.revision = 1;
    client.rpc.mockImplementation(async (name: string) => {
      if (name === 'zentra_enable_action_publication_guard_v1')
        return { guarded: true, revision: 1, snapshotId: id };
      if (name === 'zentra_action_publication_fact_v1') return fact;
      return success;
    });
    expect(await commitCoordinatedCollaboration(actor, id)).toEqual(success);
    expect(stubs.settle).toHaveBeenCalledTimes(1);
  });
  it('keeps the guarded protocol after the preparation allowlist is removed', async () => {
    stubs.config = '[]';
    client.select.mockResolvedValueOnce([
      { organization_id: actor.organizationId },
    ]);
    expect(await commitCoordinatedCollaboration(actor, id)).toEqual(success);
    expect(client.select).toHaveBeenNthCalledWith(
      1,
      'zentra_action_publication_guards',
      {
        organization_id: `eq.${actor.organizationId}`,
        select: 'organization_id',
        limit: 1,
      },
    );
    expect(stubs.settle).toHaveBeenCalledTimes(1);
  });
  it('refuses a foreign or absent permanent guard after the allowlist is removed', async () => {
    stubs.config = '[]';
    for (const rows of [[], [{ organization_id: 'other-company' }]]) {
      client.select.mockResolvedValueOnce(rows);
      await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
        'mode',
      );
    }
    expect(client.rpc).not.toHaveBeenCalled();
    expect(stubs.begin).not.toHaveBeenCalled();
  });
  it('recovers the original settled receipt after the transport copy was pruned', async () => {
    stubs.read.mockResolvedValue({
      ...attempt,
      state: 'committed',
      result: success,
      settledAt: 1300,
    });
    client.select.mockRejectedValue(new Error('transport copy pruned'));
    expect(await commitCoordinatedCollaboration(actor, id)).toEqual(success);
    expect(client.select).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith(
      'zentra_action_publication_fact_v1',
      {
        p_organization: actor.organizationId,
        p_operation: operation,
      },
    );
    expect(stubs.begin).not.toHaveBeenCalled();
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it('reconciles a pending operation through its permanent fact without reloading the archive', async () => {
    stubs.read.mockResolvedValue(attempt);
    client.select.mockRejectedValue(new Error('metadata unavailable'));
    expect(await commitCoordinatedCollaboration(actor, id)).toEqual(success);
    expect(client.select).not.toHaveBeenCalled();
    expect(stubs.begin).toHaveBeenCalledTimes(1);
    expect(stubs.settle).toHaveBeenCalledTimes(1);
  });
  it('refuses an original receipt owned by another user or installation', async () => {
    for (const patch of [
      { userId: 'other-user' },
      { installationId: 'other-pc' },
    ]) {
      stubs.read.mockResolvedValue({
        ...attempt,
        ...patch,
        state: 'committed',
        result: success,
        settledAt: 1300,
      });
      await expect(commitCoordinatedCollaboration(actor, id)).rejects.toThrow(
        'autre version',
      );
    }
    expect(client.select).not.toHaveBeenCalled();
    expect(stubs.begin).not.toHaveBeenCalled();
  });
});

describe('permanent publication proof', () => {
  it('checks the normalized manifest rather than PostgreSQL JSON key order', async () => {
    fact.manifest = {
      chunks: manifest.chunks,
      size_bytes: 123,
      sha256: manifest.sha256,
      app_version: '1.90.15',
      version: 1,
      format: 'zentra-cloud-backup',
    };
    await expect(
      verifyPublicationFact(fact, attempt, success),
    ).resolves.toBeUndefined();
  });
  it.each([
    ['operationId', '40000000-0000-4000-8000-000000000001'],
    ['organizationId', 'other'],
    ['snapshotId', '40000000-0000-4000-8000-000000000001'],
    ['installationId', 'other'],
    ['userId', 'other'],
    ['baseRevision', 1],
    ['state', 'pending'],
    ['contentVersion', 2],
    ['contentVersion', null],
    ['manifest', null],
    ['sizeBytes', 124],
    ['result', { committed: true, revision: 2, snapshotId: id }],
  ])('rejects invalid %s from canonical fact', async (key, value) => {
    fact[key as string] = value;
    await expect(
      verifyPublicationFact(fact, attempt, success),
    ).rejects.toThrow();
  });
  it('accepts a durable cancellation tombstone even when no snapshot ever existed', async () => {
    const cancellation = { committed: false, revision: 0, snapshotId: null };
    Object.assign(fact, {
      state: 'cancelled',
      manifest: null,
      sizeBytes: null,
      contentVersion: null,
      result: cancellation,
    });
    await expect(
      verifyPublicationFact(fact, attempt, cancellation),
    ).resolves.toBeUndefined();
  });
  it('rejects extended, missing or accessor-bearing facts without invoking accessors', async () => {
    await expect(
      verifyPublicationFact({ ...fact, authorized: true }, attempt, success),
    ).rejects.toThrow();
    await expect(
      verifyPublicationFact(null, attempt, success),
    ).rejects.toThrow();
    const getter = vi.fn(() => actor.organizationId);
    Object.defineProperty(fact, 'organizationId', {
      enumerable: true,
      get: getter,
    });
    await expect(
      verifyPublicationFact(fact, attempt, success),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

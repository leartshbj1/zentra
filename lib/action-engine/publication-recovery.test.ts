import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from '@/lib/account';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { backupManifest } from '@/lib/workspace-backup';
import type { PublicationAttempt } from './publication-ledger-types';

const stubs = vi.hoisted(() => ({
  read: vi.fn(),
  settle: vi.fn(),
  begin: vi.fn(),
  client: vi.fn(),
  country: vi.fn(),
  config: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => ({}),
  runtimeValue: stubs.config,
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: stubs.client,
}));
vi.mock('@/lib/international/legacy-country-guard', () => ({
  requireLegacyCountryTransport: stubs.country,
}));
vi.mock('./publication-ledger', async (original) => ({
  ...(await original<typeof import('./publication-ledger')>()),
  createPublicationLedger: () => ({
    read: stubs.read,
    settle: stubs.settle,
    begin: stubs.begin,
  }),
}));
import { recoverCoordinatedPublication } from './publication-recovery';

const id = '10000000-0000-4000-8000-000000000001';
const operation = '20000000-0000-4000-8000-000000000001';
const installation = '30000000-0000-4000-8000-000000000001';
const other = '40000000-0000-4000-8000-000000000001';
const principal = {
  organizationId: 'qa-company',
  installationId: installation,
  userId: 'qa-owner',
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
const cancelled = { committed: false, revision: 4, snapshotId: other };
let attempt: PublicationAttempt;
let fact: Record<string, unknown>;
let rpc: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.fn>;
const body = () => ({
  action: 'recover-publication',
  id,
  baseRevision: 0,
  manifest: structuredClone(manifest),
});
const recover = (input: unknown = body(), actor = principal) =>
  recoverCoordinatedPublication(actor, input);

beforeEach(async () => {
  vi.resetAllMocks();
  stubs.country.mockResolvedValue(undefined);
  stubs.config.mockImplementation(() => {
    throw new Error('Allowlist must not gate historical recovery');
  });
  attempt = {
    organizationId: principal.organizationId,
    snapshotId: id,
    installationId: installation,
    userId: principal.userId,
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
    organizationId: principal.organizationId,
    snapshotId: id,
    installationId: installation,
    userId: principal.userId,
    baseRevision: 0,
    state: 'committed',
    manifest: structuredClone(manifest),
    sizeBytes: 123,
    contentVersion: 1,
    result: success,
  };
  stubs.read.mockImplementation(async () => attempt);
  stubs.settle.mockImplementation(async (saved, result) => ({
    ...saved,
    state: 'committed',
    result,
    settledAt: 1001,
  }));
  rpc = vi.fn(async () => fact);
  select = vi.fn(() => {
    throw new Error('No archive/head lookup allowed');
  });
  stubs.client.mockReturnValue({ rpc, select });
});

describe('guarded publication receipt recovery', () => {
  it('returns unknown only for genuine absence, without PG or writes', async () => {
    stubs.read.mockResolvedValue(null);
    expect(await recover()).toEqual({ known: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it('returns pending after reservation survived a crash before PG, without releasing it', async () => {
    rpc.mockResolvedValue(null);
    expect(await recover()).toEqual({ known: true, pending: true });
    expect(stubs.settle).not.toHaveBeenCalled();
    expect(stubs.begin).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      'zentra_action_publication_fact_v1',
      {
        p_organization: principal.organizationId,
        p_operation: operation,
      },
    );
  });
  it('corroborates and settles before returning the exact old revision, without reading current archives', async () => {
    const order: string[] = [];
    rpc.mockImplementation(async () => {
      order.push('fact');
      return fact;
    });
    stubs.settle.mockImplementation(async (saved, result) => {
      order.push('settle');
      return { ...saved, result, state: 'committed', settledAt: 1001 };
    });
    expect(await recover()).toEqual({ known: true, ...success });
    expect(order).toEqual(['fact', 'settle']);
    expect(select).not.toHaveBeenCalled();
    expect(stubs.settle).toHaveBeenCalledExactlyOnceWith(attempt, success);
  });
  it('replays a settled historical receipt independently of the opt-in flag', async () => {
    attempt = {
      ...attempt,
      state: 'committed',
      result: success,
      settledAt: 1001,
    };
    expect(await recover()).toEqual({ known: true, ...success });
    expect(stubs.config).not.toHaveBeenCalled();
    expect(stubs.settle).not.toHaveBeenCalled();
    expect(stubs.begin).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
  it('leaves pending intact when PG has a cancellation tombstone; exact commit must settle', async () => {
    fact = {
      ...fact,
      state: 'cancelled',
      result: cancelled,
      manifest: null,
      sizeBytes: null,
      contentVersion: null,
    };
    expect(await recover()).toEqual({ known: true, pending: true });
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it('returns a terminal cancellation distinctly from an absent receipt', async () => {
    attempt = {
      ...attempt,
      state: 'cancelled',
      result: cancelled,
      settledAt: 1001,
    };
    fact = {
      ...fact,
      state: 'cancelled',
      result: cancelled,
      manifest: null,
      sizeBytes: null,
      contentVersion: null,
    };
    expect(await recover()).toEqual({ known: true, ...cancelled });
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it.each(['read', 'rpc', 'settle', 'country'])(
    'does not turn a %s outage into an absent or successful receipt',
    async (port) => {
      const error = new Error('unavailable');
      if (port === 'read') stubs.read.mockRejectedValue(error);
      if (port === 'rpc') rpc.mockRejectedValue(error);
      if (port === 'settle') stubs.settle.mockRejectedValue(error);
      if (port === 'country') stubs.country.mockRejectedValue(error);
      await expect(recover()).rejects.toMatchObject({ status: 503 });
    },
  );
  it('does not turn missing D1 schema into unknown', async () => {
    stubs.read.mockRejectedValue(
      new Error('no such table: action_engine_publication_attempts'),
    );
    await expect(recover()).rejects.toMatchObject({ status: 503 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('retains a pending attempt on lost settlement ACK and permits its exact replay', async () => {
    stubs.settle.mockRejectedValueOnce(new Error('ACK lost'));
    await expect(recover()).rejects.toMatchObject({ status: 503 });
    attempt = {
      ...attempt,
      state: 'committed',
      result: success,
      settledAt: 1001,
    };
    expect(await recover()).toEqual({ known: true, ...success });
    expect(stubs.settle).toHaveBeenCalledTimes(1);
  });
  it.each(['committed', 'cancelled'] as const)(
    'rejects a missing PG proof for terminal %s',
    async (state) => {
      attempt = {
        ...attempt,
        state,
        result: state === 'committed' ? success : cancelled,
        settledAt: 1001,
      };
      rpc.mockResolvedValue(null);
      await expect(recover()).rejects.toMatchObject({ status: 503 });
    },
  );
  it('rejects a terminal cancellation contradicted by a committed PG proof', async () => {
    attempt = {
      ...attempt,
      state: 'cancelled',
      result: cancelled,
      settledAt: 1001,
    };
    await expect(recover()).rejects.toMatchObject({ status: 409 });
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it('passes through a legitimate country boundary refusal', async () => {
    stubs.country.mockRejectedValue(new AccountPublicError('country', 409));
    await expect(recover()).rejects.toMatchObject({ status: 409 });
    expect(stubs.read).not.toHaveBeenCalled();
  });
});

describe('publication identity and closed proof', () => {
  it.each([
    ['organizationId', 'other-company'],
    ['installationId', other],
    ['userId', 'other-user'],
    ['snapshotId', other],
    ['baseRevision', 1],
    ['archiveSha256', 'b'.repeat(64)],
    ['manifestSha256', 'd'.repeat(64)],
    ['sizeBytes', 124],
  ])('rejects a mismatched D1 %s before any PG query', async (key, value) => {
    attempt = { ...attempt, [key]: value };
    await expect(recover()).rejects.toMatchObject({ status: 409 });
    expect(rpc).not.toHaveBeenCalled();
    expect(stubs.settle).not.toHaveBeenCalled();
  });
  it.each([
    ['operationId', other],
    ['organizationId', 'other-company'],
    ['snapshotId', other],
    ['installationId', other],
    ['userId', 'other-user'],
    ['baseRevision', 1],
    ['state', 'pending'],
    ['contentVersion', 2],
    ['sizeBytes', 124],
    ['result', { ...success, revision: 2 }],
    ['result', { ...success, snapshotId: other }],
    ['result', { ...success, secret: 'no' }],
    ['extra', true],
    ['manifest', { ...manifest, sha256: 'b'.repeat(64) }],
    ['manifest', { ...manifest, app_version: '1.90.16' }],
    [
      'manifest',
      { ...manifest, chunks: [{ sha256: 'd'.repeat(64), size_bytes: 123 }] },
    ],
    ['manifest', null],
  ])(
    'rejects an inconsistent or malformed service fact %s = %j',
    async (key, value) => {
      fact = { ...fact, [key]: value };
      await expect(recover()).rejects.toMatchObject({
        status: expect.any(Number),
      });
      expect(stubs.settle).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, false, [], {}, { state: 'pending', result: null }])(
    'fails closed on malformed fact %j',
    async (value) => {
      rpc.mockResolvedValue(value);
      await expect(recover()).rejects.toMatchObject({ status: 503 });
      expect(stubs.settle).not.toHaveBeenCalled();
    },
  );
  it.each([
    { state: 'pending', result: null, settledAt: null },
    { id: other },
    { organizationId: 'foreign' },
    { result: { ...success, revision: 2 } },
    { settledAt: null },
    { createdAt: 1001 },
  ])(
    'rejects a malformed or changed settlement before native ACK %j',
    async (change) => {
      stubs.settle.mockResolvedValue({
        ...attempt,
        state: 'committed',
        result: success,
        settledAt: 1001,
        ...change,
      });
      await expect(recover()).rejects.toMatchObject({ status: 503 });
    },
  );
  it('does not invoke a service result accessor', async () => {
    const getter = vi.fn(() => success);
    Object.defineProperty(fact, 'result', { enumerable: true, get: getter });
    await expect(recover()).rejects.toMatchObject({ status: 503 });
    expect(getter).not.toHaveBeenCalled();
  });
  it('does not invoke a nested service manifest accessor', async () => {
    const getter = vi.fn(() => manifest.sha256);
    const value = structuredClone(manifest);
    Object.defineProperty(value, 'sha256', { enumerable: true, get: getter });
    fact.manifest = value;
    await expect(recover()).rejects.toMatchObject({ status: 503 });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('recovery request boundary', () => {
  it.each(['read_only', 'forged', null])(
    'rejects role %s before any persistence',
    async (role) => {
      await expect(
        recover(body(), { ...principal, role } as DeviceSessionContext),
      ).rejects.toMatchObject({ status: 403 });
      expect(stubs.read).not.toHaveBeenCalled();
      expect(stubs.country).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    null,
    [],
    { ...body(), action: 'commit' },
    { ...body(), organizationId: 'foreign' },
    { ...body(), id: 'invalid' },
    { ...body(), baseRevision: -1 },
    { ...body(), baseRevision: Number.MAX_SAFE_INTEGER },
    { ...body(), baseRevision: 1.5 },
    { ...body(), manifest: { ...manifest, chunks: [] } },
    { ...body(), manifest: { ...manifest, extra: true } },
    { ...body(), manifest: { ...manifest, size_bytes: 124 } },
  ])('rejects malformed input %j without a read', async (input) => {
    await expect(recover(input)).rejects.toMatchObject({ status: 400 });
    expect(stubs.read).not.toHaveBeenCalled();
  });
  it('captures actor and nested manifest before the first await', async () => {
    const input = body();
    const actor = { ...principal };
    stubs.country.mockImplementation(async () => {
      actor.organizationId = 'foreign';
      actor.userId = 'foreign';
      actor.installationId = other;
      input.id = other;
      input.baseRevision = 7;
      input.manifest.chunks[0].sha256 = 'f'.repeat(64);
      input.manifest.sha256 = 'e'.repeat(64);
    });
    expect(await recover(input, actor)).toEqual({ known: true, ...success });
    expect(stubs.read).toHaveBeenCalledExactlyOnceWith(
      principal.organizationId,
      id,
    );
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      'zentra_action_publication_fact_v1',
      {
        p_organization: principal.organizationId,
        p_operation: operation,
      },
    );
  });
  it('rejects input and chunk accessors without invoking them', async () => {
    for (const nested of [false, true]) {
      const input = body(),
        getter = vi.fn(() => 'a'.repeat(64));
      Object.defineProperty(
        nested ? input.manifest.chunks[0] : input,
        nested ? 'sha256' : 'id',
        { enumerable: true, get: getter },
      );
      await expect(recover(input)).rejects.toMatchObject({ status: 400 });
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it('does not confuse chunk order with the same publication identity', async () => {
    const input = body();
    input.manifest.size_bytes = 16 * 1024 * 1024;
    input.manifest.chunks = [
      { sha256: 'd'.repeat(64), size_bytes: 8 * 1024 * 1024 },
      { sha256: 'c'.repeat(64), size_bytes: 8 * 1024 * 1024 },
    ];
    attempt = {
      ...attempt,
      sizeBytes: input.manifest.size_bytes,
      manifestSha256: await sha256Hex(
        JSON.stringify(
          backupManifest({
            ...input.manifest,
            chunks: [...input.manifest.chunks].reverse(),
          }),
        ),
      ),
    };
    await expect(recover(input)).rejects.toMatchObject({ status: 409 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

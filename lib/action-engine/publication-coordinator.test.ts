import { describe, expect, it, vi } from 'vitest';
import {
  capturePublicationIdentity,
  capturePublicationRpcResult,
  createPublicationCoordinator,
} from './publication-coordinator';
import {
  PublicationLedgerError,
  type PublicationAttempt,
  type PublicationIdentity,
  type PublicationLedger,
  type PublicationResult,
} from './publication-ledger-types';

const first = '10000000-0000-4000-8000-000000000001';
const second = '10000000-0000-4000-8000-000000000002';
const operation = '20000000-0000-4000-8000-000000000001';
const identity: PublicationIdentity = {
  organizationId: 'qa-company',
  snapshotId: first,
  installationId: '30000000-0000-4000-8000-000000000001',
  userId: 'qa-owner',
  baseRevision: 0,
  archiveSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  sizeBytes: 123,
};
const success = { committed: true, revision: 1, snapshotId: first } as const;
const pending: PublicationAttempt = {
  ...identity,
  id: operation,
  state: 'pending',
  result: null,
  createdAt: 1000,
  settledAt: null,
};

function fixture() {
  let attempt: PublicationAttempt | null = null;
  const order: string[] = [];
  const begin = vi.fn(async (input: PublicationIdentity) => {
    order.push('begin');
    if (attempt?.state === 'pending' && attempt.snapshotId !== input.snapshotId)
      return { state: 'held' as const, attempt };
    if (attempt?.snapshotId === input.snapshotId)
      return {
        state:
          attempt.state === 'pending'
            ? ('owned' as const)
            : ('settled' as const),
        attempt,
      };
    attempt = Object.freeze({
      ...input,
      id: operation,
      state: 'pending',
      result: null,
      createdAt: 1000,
      settledAt: null,
    });
    return { state: 'owned' as const, attempt };
  });
  const settle = vi.fn(
    async (input: PublicationAttempt, result: PublicationResult) => {
      order.push('settle');
      attempt = Object.freeze({
        ...input,
        state: result.committed ? 'committed' : 'cancelled',
        result,
        settledAt: 1300,
      });
      return attempt;
    },
  );
  const ledger: PublicationLedger = {
    begin,
    settle,
    read: async () => null,
    publicationPredicate: () => ({ sql: '0', bindings: [] }),
  };
  const enableGuard = vi.fn(async () => {
    order.push('guard');
    return { guarded: true, revision: 0, snapshotId: null };
  });
  const commit = vi.fn(async (input: PublicationAttempt): Promise<unknown> => {
    order.push('commit');
    return {
      committed: true,
      revision: input.baseRevision + 1,
      snapshotId: input.snapshotId,
    };
  });
  const close = vi.fn(async (): Promise<unknown> => {
    order.push('close');
    return { committed: false, revision: 0, snapshotId: null };
  });
  const now = vi.fn(() => 1300);
  return {
    begin,
    settle,
    enableGuard,
    commit,
    close,
    now,
    order,
    setAttempt: (value: PublicationAttempt) => {
      attempt = value;
    },
    getAttempt: () => attempt,
    coordinate: createPublicationCoordinator({
      ledger,
      enableGuard,
      commit,
      close,
      now,
    }),
  };
}

describe('private publication coordinator', () => {
  it('guards PG, opens D1 barrier, commits PG, then settles D1 in that order', async () => {
    const f = fixture();
    expect(await f.coordinate(identity)).toEqual(success);
    expect(f.order).toEqual(['guard', 'begin', 'commit', 'settle']);
    expect(f.getAttempt()?.state).toBe('committed');
  });
  it('returns the durable original result on replay without another PG commit', async () => {
    const f = fixture();
    await f.coordinate(identity);
    expect(await f.coordinate(identity)).toEqual(success);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.settle).toHaveBeenCalledTimes(1);
  });
  it('keeps a pending barrier after a lost PG response; retries the SAME operation', async () => {
    const f = fixture();
    f.commit.mockRejectedValueOnce(new Error('response lost after commit'));
    await expect(f.coordinate(identity)).rejects.toThrow('response lost');
    expect(f.getAttempt()?.state).toBe('pending');
    expect(f.settle).not.toHaveBeenCalled();
    await f.coordinate(identity);
    expect(f.commit.mock.calls.map(([attempt]) => attempt.id)).toEqual([
      operation,
      operation,
    ]);
  });
  it('does not advertise completion when the D1 acknowledgement is lost', async () => {
    const f = fixture();
    f.settle.mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(f.coordinate(identity)).rejects.toThrow('D1 unavailable');
    expect(f.getAttempt()?.state).toBe('pending');
    expect(await f.coordinate(identity)).toEqual(success);
  });
  it('never releases another in-flight publication because a lease expired', async () => {
    const f = fixture();
    f.setAttempt(pending);
    f.now.mockReturnValue(1119);
    await expect(
      f.coordinate({ ...identity, snapshotId: second }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('asks PG to tombstone an old attempt BEFORE releasing its D1 barrier', async () => {
    const f = fixture();
    f.setAttempt(pending);
    const next = { ...identity, snapshotId: second };
    expect(await f.coordinate(next)).toEqual({
      committed: true,
      revision: 1,
      snapshotId: second,
    });
    expect(f.order).toEqual([
      'guard',
      'begin',
      'close',
      'settle',
      'begin',
      'commit',
      'settle',
    ]);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(pending);
  });
  it('recovers a previous PG commit via close without re-executing it', async () => {
    const f = fixture();
    f.setAttempt(pending);
    f.close.mockResolvedValue(success);
    const next = { ...identity, snapshotId: second, baseRevision: 1 };
    expect(await f.coordinate(next)).toEqual({
      committed: true,
      revision: 2,
      snapshotId: second,
    });
    expect(f.settle.mock.calls[0]).toEqual([pending, success]);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][0].snapshotId).toBe(second);
  });
  it('leaves the barrier intact when PG close is uncertain', async () => {
    const f = fixture();
    f.setAttempt(pending);
    f.close.mockRejectedValue(new Error('timeout'));
    await expect(
      f.coordinate({ ...identity, snapshotId: second }),
    ).rejects.toThrow('timeout');
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.getAttempt()).toEqual(pending);
  });
  it('leaves the barrier intact when the close result is malformed', async () => {
    const f = fixture();
    f.setAttempt(pending);
    f.close.mockResolvedValue({
      committed: false,
      revision: 1,
      snapshotId: null,
    });
    await expect(
      f.coordinate({ ...identity, snapshotId: second }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('normalizes a durable PG conflict into a terminal cancellation', async () => {
    const f = fixture();
    f.commit.mockResolvedValue({
      committed: false,
      revision: 1,
      snapshotId: second,
      cancelled: true,
      conflict: true,
    });
    expect(await f.coordinate(identity)).toEqual({
      committed: false,
      revision: 1,
      snapshotId: second,
    });
    expect(f.getAttempt()?.state).toBe('cancelled');
  });
  it('does not call D1 or commit if guard activation fails or has a corrupt head', async () => {
    for (const result of [
      null,
      { guarded: true, revision: 1, snapshotId: null },
      { guarded: false, revision: 0, snapshotId: null },
    ]) {
      const f = fixture();
      f.enableGuard.mockResolvedValue(result as never);
      await expect(f.coordinate(identity)).rejects.toBeInstanceOf(
        PublicationLedgerError,
      );
      expect(f.begin).not.toHaveBeenCalled();
      expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it('rejects a cross-tenant held capability without invoking PG close', async () => {
    const f = fixture();
    f.setAttempt({ ...pending, organizationId: 'other-company' });
    await expect(
      f.coordinate({ ...identity, snapshotId: second }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(f.close).not.toHaveBeenCalled();
  });
});

describe('closed publication transport validation', () => {
  it('copies and freezes the identity before the first await', async () => {
    const f = fixture();
    const input = { ...identity };
    const promise = f.coordinate(input);
    input.organizationId = 'other-company';
    await promise;
    expect(f.begin.mock.calls[0][0].organizationId).toBe(
      identity.organizationId,
    );
    expect(Object.isFrozen(f.begin.mock.calls[0][0])).toBe(true);
  });
  it.each([
    { ...identity, organizationId: '../company' },
    { ...identity, snapshotId: 'not-a-uuid' },
    { ...identity, installationId: 'installation' },
    { ...identity, userId: '' },
    { ...identity, baseRevision: Number.MAX_SAFE_INTEGER },
    { ...identity, baseRevision: 0.5 },
    { ...identity, sizeBytes: 0 },
    { ...identity, sizeBytes: 2 * 1024 * 1024 * 1024 + 1 },
    { ...identity, archiveSha256: 'a'.repeat(63) },
    { ...identity, manifestSha256: 'B'.repeat(64) },
    { ...identity, authorized: true },
    null,
  ])('rejects invalid/extended identity %j', (value) => {
    expect(() => capturePublicationIdentity(value)).toThrow(
      PublicationLedgerError,
    );
  });
  it.each([
    null,
    { ...success, revision: 2 },
    { ...success, snapshotId: second },
    { ...success, extra: true },
    { ...success, cancelled: true, conflict: true },
    { committed: false, revision: 0, snapshotId: first },
    { committed: false, revision: 1, snapshotId: null },
    { committed: false, revision: 1, snapshotId: first },
    { committed: false, revision: 1, snapshotId: second, conflict: true },
    {
      committed: false,
      revision: 1,
      snapshotId: second,
      cancelled: false,
      conflict: true,
    },
    { committed: false, revision: NaN, snapshotId: null },
  ])('rejects ambiguous or forged PG proof %j', (raw) => {
    expect(() => capturePublicationRpcResult(raw, pending)).toThrow(
      PublicationLedgerError,
    );
  });
  it('does not invoke getters during closed input/result capture', () => {
    const getter = vi.fn(() => identity.organizationId);
    const raw = { ...identity };
    Object.defineProperty(raw, 'organizationId', {
      get: getter,
      enumerable: true,
    });
    expect(() => capturePublicationIdentity(raw)).toThrow();
    const proof = { ...success };
    Object.defineProperty(proof, 'revision', { get: getter, enumerable: true });
    expect(() => capturePublicationRpcResult(proof, pending)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

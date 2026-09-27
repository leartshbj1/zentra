import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ db: vi.fn(), enabled: '1' }));
vi.mock('./runtime', () => ({
  database: runtime.db,
  runtimeValue: () => runtime.enabled,
}));
import {
  schedulerHealth,
  readSchedulerHealth,
  startSchedulerHeartbeat,
  finishSchedulerHeartbeat,
  SCHEDULER_STALE_MS,
  SCHEDULER_STALLED_MS,
  type SchedulerHealthRow,
} from './scheduler-health';
import { schedulerHealthCopy } from './scheduler-health-copy';
const now = Date.parse('2026-09-27T12:00:00Z');
const row = (patch: Partial<SchedulerHealthRow> = {}): SchedulerHealthRow => ({
  last_started_at: now - 2000,
  last_started_run_id: null,
  last_finished_run_id: null,
  last_finished_at: now - 1000,
  last_success_at: now - 1000,
  last_failure_at: null,
  last_outcome: 'completed',
  last_reference: null,
  ...patch,
});
afterEach(() => vi.restoreAllMocks());
describe('fresh worker execution, rather than a configuration flag', () => {
  it('requires a successful finished cycle before claiming closed-page operation', () => {
    expect(schedulerHealth(null, true, now)).toMatchObject({
      state: 'unverified',
      background: false,
    });
    expect(
      schedulerHealth(
        row({
          last_started_at: now,
          last_finished_at: null,
          last_success_at: null,
          last_outcome: null,
        }),
        true,
        now,
      ),
    ).toMatchObject({ state: 'running', background: false });
    expect(schedulerHealth(row(), true, now)).toMatchObject({
      state: 'current',
      background: true,
    });
    expect(schedulerHealth(row(), false, now)).toMatchObject({
      state: 'inactive',
      background: false,
    });
  });
  it('detects stalled starts, late execution and failed cycles even after a previous success', () => {
    expect(
      schedulerHealth(
        row({
          last_started_at: now - SCHEDULER_STALLED_MS - 1,
          last_finished_at: null,
        }),
        true,
        now,
      ),
    ).toMatchObject({ state: 'delayed', background: false });
    expect(
      schedulerHealth(
        row({
          last_started_at: now - SCHEDULER_STALE_MS - 2,
          last_finished_at: now - SCHEDULER_STALE_MS - 1,
        }),
        true,
        now,
      ),
    ).toMatchObject({ state: 'delayed', background: false });
    expect(
      schedulerHealth(row({ last_outcome: 'failed' }), true, now),
    ).toMatchObject({ state: 'failed', background: false });
    expect(
      schedulerHealth(row({ last_started_at: now }), true, now),
    ).toMatchObject({ state: 'running', background: true });
  });
  it('handles the freshness boundary and partial but healthy batches', () => {
    expect(
      schedulerHealth(
        row({
          last_started_at: now - SCHEDULER_STALE_MS - 1,
          last_finished_at: now - SCHEDULER_STALE_MS,
          last_success_at: now - SCHEDULER_STALE_MS,
          last_outcome: 'partial',
        }),
        true,
        now,
      ),
    ).toMatchObject({ state: 'current', background: true });
  });
  it.each([NaN, Infinity, -1, now + 1])(
    'does not trust malformed or future timestamps (%s)',
    (invalid) => {
      const health = schedulerHealth(
        row({
          last_started_at: invalid,
          last_finished_at: invalid,
          last_success_at: invalid,
        }),
        true,
        now,
      );
      expect(health).toMatchObject({
        state: 'unverified',
        background: false,
        lastFinishedAt: null,
        lastSuccessAt: null,
      });
    },
  );
  it('provides an action for every incident and never claims reception on a configuration-only fixture', () => {
    for (const state of [
      'failed',
      'delayed',
      'unverified',
      'unavailable',
    ] as const) {
      const copy = schedulerHealthCopy({ state, background: false });
      expect(copy.attention).toBe(true);
      expect(copy.detail).toContain('Gardez Support ouvert');
      expect(copy.detail).not.toContain('continue lorsque Support est fermé');
    }
    expect(schedulerHealthCopy({ background: true }).detail).not.toContain(
      'continue lorsque Support est fermé',
    );
  });
});
describe('durable SQLite heartbeat with the production migration', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    runtime.enabled = '1';
    vi.spyOn(Date, 'now').mockReturnValue(now);
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(
        new URL('../drizzle/0062_scheduler_health.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(readFileSync(new URL('../drizzle/0065_scheduler_run_identity.sql', import.meta.url), 'utf8'));
    runtime.db.mockImplementation(() => ({
      prepare: (sql: string) => ({
        bind: (...values: (string | number | null)[]) => ({
          first: async () => db.prepare(sql).get(...values) ?? null,
          run: async () => db.prepare(sql).run(...values),
        }),
      }),
    }));
  });
  afterEach(() => db.close());
  it('persists success, failure and recovery across separate reads', async () => {
    expect(await readSchedulerHealth()).toMatchObject({
      state: 'unverified',
      background: false,
    });
    const first = await startSchedulerHeartbeat(now - 1000);
    await finishSchedulerHeartbeat(first!, 'completed');
    expect(await readSchedulerHealth()).toMatchObject({
      state: 'current',
      background: true,
      lastSuccessAt: new Date(now).toISOString(),
    });
    vi.mocked(Date.now).mockReturnValue(now + 2000);
    const second = await startSchedulerHeartbeat(now + 1000);
    await finishSchedulerHeartbeat(second!, 'failed', 'private@example.test');
    expect(await readSchedulerHealth()).toMatchObject({
      state: 'failed',
      background: false,
    });
    expect(
      db.prepare('SELECT last_reference FROM service_scheduler_health').get(),
    ).toMatchObject({ last_reference: null });
    vi.mocked(Date.now).mockReturnValue(now + 4000);
    const third = await startSchedulerHeartbeat(now + 3000);
    await finishSchedulerHeartbeat(third!, 'idle');
    expect(await readSchedulerHealth()).toMatchObject({
      state: 'current',
      background: true,
    });
    expect(
      db
        .prepare('SELECT count(*) AS total FROM service_scheduler_health')
        .get(),
    ).toMatchObject({ total: 1 });
  });
  it('keeps later starts and outcomes when an older worker writes out of order', async () => {
    const latest = await startSchedulerHeartbeat(now - 1000);
    const lateStart = await startSchedulerHeartbeat(now - 2000);
    await finishSchedulerHeartbeat(
      latest!,
      'failed',
      '6b7b8220-4b90-4e24-a2c4-e9c5d64e1f01',
    );
    vi.mocked(Date.now).mockReturnValue(now + 500);
    await finishSchedulerHeartbeat(lateStart!, 'completed');
    const stored = db.prepare('SELECT * FROM service_scheduler_health').get();
    expect(stored).toMatchObject({
      last_started_at: now - 1000,
      last_finished_at: now,
      last_outcome: 'failed',
      last_success_at: null,
      last_failure_at: now,
      last_reference: '6b7b8220-4b90-4e24-a2c4-e9c5d64e1f01',
    });
    expect(await readSchedulerHealth()).toMatchObject({
      state: 'failed',
      background: false,
    });
  });
  it('never lets an older completion hide a newer stalled run', async () => {
    const previous = await startSchedulerHeartbeat(now - 1000);
    const latest = await startSchedulerHeartbeat(now);
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    await finishSchedulerHeartbeat(previous!, 'completed');
    expect(await readSchedulerHealth()).toMatchObject({state:'running',background:false,lastFinishedAt:null});
    vi.mocked(Date.now).mockReturnValue(now + SCHEDULER_STALLED_MS + 1);
    expect(await readSchedulerHealth()).toMatchObject({state:'delayed',background:false});
    await finishSchedulerHeartbeat(latest!, 'completed');
    expect(await readSchedulerHealth()).toMatchObject({state:'current',background:true});
  });
  it('separates starts in the same millisecond and ignores an older late failure', async () => {
    const first = await startSchedulerHeartbeat(now);
    const second = await startSchedulerHeartbeat(now);
    expect(first).not.toBe(second);
    await finishSchedulerHeartbeat(first!, 'idle');
    expect(await readSchedulerHealth()).toMatchObject({state:'running',background:false});
    await finishSchedulerHeartbeat(second!, 'idle');
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    await finishSchedulerHeartbeat(first!, 'failed');
    expect(await readSchedulerHealth()).toMatchObject({state:'current',background:true,lastFinishedAt:new Date(now).toISOString()});
    expect(db.prepare('SELECT last_failure_at FROM service_scheduler_health').get()).toMatchObject({last_failure_at:null});
  });
  it('does not refresh freshness or change outcomes when completion is replayed', async () => {
    const runId = await startSchedulerHeartbeat(now);
    await finishSchedulerHeartbeat(runId!, 'failed');
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    await finishSchedulerHeartbeat(runId!, 'completed');
    expect(await readSchedulerHealth()).toMatchObject({state:'failed',background:false,lastSuccessAt:null});
    vi.mocked(Date.now).mockReturnValue(now + SCHEDULER_STALE_MS + 1);
    await finishSchedulerHeartbeat(runId!, 'completed');
    expect(await readSchedulerHealth()).toMatchObject({state:'delayed',background:false,lastFinishedAt:new Date(now).toISOString()});
  });
  it('preserves existing heartbeat history through the additive migration', async () => {
    db.close();
    db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../drizzle/0062_scheduler_health.sql', import.meta.url), 'utf8'));
    db.prepare(`INSERT INTO service_scheduler_health(job,last_started_at,last_finished_at,last_success_at,last_outcome)
      VALUES ('support.mail',?,?,?,'completed')`).run(now - 2000,now - 1000,now - 1000);
    db.exec(readFileSync(new URL('../drizzle/0065_scheduler_run_identity.sql', import.meta.url), 'utf8'));
    expect(await readSchedulerHealth()).toMatchObject({state:'current',background:true});
    const runId = await startSchedulerHeartbeat(now);
    expect(await readSchedulerHealth()).toMatchObject({state:'running',background:true});
    await finishSchedulerHeartbeat('unknown-run', 'completed');
    expect(await readSchedulerHealth()).toMatchObject({state:'running',lastFinishedAt:new Date(now - 1000).toISOString()});
    await finishSchedulerHeartbeat(runId!, 'completed');
    expect(await readSchedulerHealth()).toMatchObject({state:'current',background:true});
  });
  it('expires without another write and excludes tenant data from the public view', async () => {
    const runId = await startSchedulerHeartbeat(now - 1000);
    await finishSchedulerHeartbeat(runId!, 'partial');
    vi.mocked(Date.now).mockReturnValue(now + SCHEDULER_STALE_MS + 1);
    expect(await readSchedulerHealth()).toEqual({
      configured: true,
      background: false,
      state: 'delayed',
      checkedAt: new Date(now + SCHEDULER_STALE_MS + 1).toISOString(),
      lastFinishedAt: new Date(now).toISOString(),
      lastSuccessAt: new Date(now).toISOString(),
    });
  });
  it('fails visibly and safely when storage is unavailable, without leaking error contents', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    runtime.db.mockImplementation(() => {
      throw new Error('private@example.test secret-token');
    });
    expect(await readSchedulerHealth()).toMatchObject({
      state: 'unavailable',
      background: false,
    });
    expect(await startSchedulerHeartbeat(now)).toBe(null);
    await expect(
      finishSchedulerHeartbeat('fixture-run', 'completed'),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private@example|secret-token/,
    );
  });
});

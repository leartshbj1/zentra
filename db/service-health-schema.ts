import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// One bounded heartbeat per internal job. No tenant data, secrets or mail content.
export const serviceSchedulerHealth = sqliteTable('service_scheduler_health', {
  job: text('job').primaryKey(),
  lastStartedAt: integer('last_started_at').notNull(),
  lastStartedRunId: text('last_started_run_id'),
  lastFinishedRunId: text('last_finished_run_id'),
  lastFinishedAt: integer('last_finished_at'),
  lastSuccessAt: integer('last_success_at'),
  lastFailureAt: integer('last_failure_at'),
  lastOutcome: text('last_outcome'),
  lastReference: text('last_reference'),
});

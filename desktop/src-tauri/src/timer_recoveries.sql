-- Device-private stopped time, without foreign keys to a discarded project.
CREATE TABLE timer_recoveries (
  id TEXT PRIMARY KEY NOT NULL,
  timer_sha256 TEXT NOT NULL UNIQUE CHECK(length(timer_sha256)=64),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  entry_id TEXT UNIQUE,
  assignment_json TEXT CHECK(assignment_json IS NULL OR json_valid(assignment_json)),
  resolved_at TEXT,
  CHECK ((entry_id IS NULL AND assignment_json IS NULL AND resolved_at IS NULL)
      OR (entry_id IS NOT NULL AND assignment_json IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE TRIGGER timer_recoveries_insert_guard BEFORE INSERT ON timer_recoveries
WHEN (SELECT synchronous FROM pragma_synchronous)<>2 OR NEW.entry_id IS NOT NULL
  OR NEW.snapshot_sha256<>zentra_sha256(NEW.snapshot_json)
  OR NEW.timer_sha256<>zentra_sha256(json_extract(NEW.snapshot_json,'$.timer'))
  OR json_extract(NEW.snapshot_json,'$.timer') IS NOT (
    SELECT json_object('id',id,'project_id',project_id,'task_id',task_id,'employee_id',employee_id,
      'started_at',started_at,'note',note,'billable',billable,'billing_rate_cents',billing_rate_cents,'cost_rate_cents',cost_rate_cents)
    FROM active_timers WHERE id=1)
BEGIN SELECT RAISE(ABORT,'timer recovery requires a durable pending snapshot'); END;
CREATE TRIGGER timer_recoveries_update_guard BEFORE UPDATE ON timer_recoveries
WHEN (SELECT synchronous FROM pragma_synchronous)<>2 OR OLD.entry_id IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.timer_sha256 IS NOT OLD.timer_sha256
  OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256
  OR NEW.entry_id IS NULL OR NOT EXISTS(SELECT 1 FROM time_entries e WHERE e.id=NEW.entry_id
    AND e.project_id IS json_extract(NEW.assignment_json,'$.project_id')
    AND e.task_id IS json_extract(NEW.assignment_json,'$.task_id')
    AND e.employee_id IS json_extract(NEW.assignment_json,'$.employee_id')
    AND e.started_at IS json_extract(NEW.snapshot_json,'$.timer.started_at')
    AND e.ended_at IS json_extract(NEW.snapshot_json,'$.ended_at')
    AND e.minutes IS json_extract(NEW.snapshot_json,'$.minutes')
    AND e.break_minutes IS json_extract(NEW.snapshot_json,'$.break_minutes')
    AND e.note IS json_extract(NEW.snapshot_json,'$.timer.note')
    AND e.billable IS json_extract(NEW.snapshot_json,'$.timer.billable')
    AND e.billing_rate_cents IS json_extract(NEW.snapshot_json,'$.timer.billing_rate_cents')
    AND e.cost_rate_cents IS json_extract(NEW.snapshot_json,'$.timer.cost_rate_cents'))
BEGIN SELECT RAISE(ABORT,'timer recovery evidence is immutable'); END;
CREATE TRIGGER timer_recoveries_delete_guard BEFORE DELETE ON timer_recoveries
BEGIN SELECT RAISE(ABORT,'timer recovery evidence is retained'); END;
CREATE TRIGGER active_timers_resolution_insert_guard BEFORE INSERT ON active_timers
WHEN EXISTS(SELECT 1 FROM business_sync_resolution_intent)
BEGIN SELECT RAISE(ABORT,'resume the protected resolution before starting a timer'); END;
CREATE TRIGGER active_timers_resolution_update_guard BEFORE UPDATE ON active_timers
WHEN EXISTS(SELECT 1 FROM business_sync_resolution_intent)
BEGIN SELECT RAISE(ABORT,'preserve the active timer before resuming the protected resolution'); END;
PRAGMA user_version=65;

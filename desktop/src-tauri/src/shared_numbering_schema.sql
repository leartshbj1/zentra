CREATE TABLE IF NOT EXISTS shared_numbering_binding (
  id INTEGER PRIMARY KEY CHECK(id=1),
  organization_id TEXT NOT NULL,
  enabled_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_number_ranges (
  request_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  year INTEGER NOT NULL CHECK(year BETWEEN 1900 AND 9999),
  minimum INTEGER NOT NULL CHECK(minimum BETWEEN 1 AND 999999999),
  count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 1000),
  start_value INTEGER,
  end_value INTEGER,
  next_value INTEGER,
  CHECK((start_value IS NULL AND end_value IS NULL AND next_value IS NULL)
    OR (start_value IS NOT NULL AND end_value IS NOT NULL AND next_value IS NOT NULL
      AND start_value>=minimum AND end_value=start_value+count-1
      AND end_value<=999999999 AND next_value BETWEEN start_value AND end_value+1))
);
CREATE INDEX IF NOT EXISTS device_number_ranges_available
  ON device_number_ranges(organization_id,installation_id,prefix,year,start_value);
PRAGMA user_version=59;

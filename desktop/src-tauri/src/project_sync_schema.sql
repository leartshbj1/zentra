CREATE TABLE IF NOT EXISTS project_sync_binding (
  id INTEGER PRIMARY KEY CHECK(id=1),
  organization_id TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS project_document_sync (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('upload','delete','synced','deleted')),
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_document_sync_pending ON project_document_sync(state,updated_at);
INSERT OR IGNORE INTO project_document_sync(document_id,project_id,state,updated_at)
  SELECT id,project_id,'upload',updated_at FROM attachments WHERE entity_type='project' AND entity_id=project_id;
CREATE TRIGGER IF NOT EXISTS project_document_queue_insert AFTER INSERT ON attachments
WHEN NEW.entity_type='project' AND NEW.entity_id=NEW.project_id
BEGIN
  INSERT OR IGNORE INTO project_document_sync(document_id,project_id,state,updated_at)
    VALUES(NEW.id,NEW.project_id,'upload',NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS project_document_queue_delete AFTER DELETE ON attachments
WHEN OLD.entity_type='project' AND OLD.entity_id=OLD.project_id
BEGIN
  INSERT INTO project_document_sync(document_id,project_id,state,updated_at)
    VALUES(OLD.id,OLD.project_id,'delete',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(document_id) DO UPDATE SET state='delete',last_error=NULL,updated_at=excluded.updated_at;
END;
PRAGMA user_version=58;

-- Notes are shared company records. A soft deletion remains in the company
-- archive and three-way merge so an old offline copy cannot resurrect its UUID.
CREATE TABLE IF NOT EXISTS work_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title)<=200),
  body TEXT NOT NULL CHECK(length(body)<=100000),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  created_by_member_id TEXT,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS work_notes_active ON work_notes(pinned DESC,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS work_notes_project ON work_notes(project_id,updated_at DESC) WHERE deleted_at IS NULL AND project_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS work_notes_author_immutable BEFORE UPDATE ON work_notes
WHEN NEW.created_by_member_id IS NOT OLD.created_by_member_id
  OR NEW.author_name IS NOT OLD.author_name OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'L’auteur original de la note doit être conservé.'); END;
CREATE TRIGGER IF NOT EXISTS work_notes_no_resurrection BEFORE UPDATE ON work_notes
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN SELECT RAISE(ABORT,'Une note supprimée ne peut pas être recréée avec le même identifiant.'); END;
-- Private draft namespace. It is regenerated on import/new company, preserved
-- on ordinary company receives, and never sent as a shared company identity.
CREATE TABLE IF NOT EXISTS company_local_notes_scope (
  id INTEGER PRIMARY KEY CHECK(id=1),
  scope TEXT NOT NULL
);
PRAGMA user_version=61;

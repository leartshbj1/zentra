"""Portable verification of the actual notes migration; no live profile access.

Rust command, audit and company-merge tests live in work_notes_tests.rs. This
suite verifies SQLite integrity/persistence if native test binaries are blocked.
"""
from pathlib import Path
from contextlib import closing
import sqlite3
import tempfile
import unittest

MIGRATION = (Path(__file__).resolve().parents[1] / "src-tauri/src/work_notes_schema.sql").read_text(encoding="utf-8")


class NotesSchemaTests(unittest.TestCase):
    def database(self):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('project-a','Cuisine'); PRAGMA user_version=60;")
        db.executescript(MIGRATION)
        return db

    def note(self, db, id="note-a", project="project-a"):
        db.execute("INSERT INTO work_notes(id,title,body,project_id,pinned,created_by_member_id,author_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                   (id, "Mesures", "Mur nord : 2,40 m\nFenêtre : 1,20 m", project, 1, "alice", "Alice", "created", "updated"))

    def test_migration_is_idempotent_and_preserves_existing_company_data(self):
        db = self.database()
        self.note(db)
        db.executescript(MIGRATION)
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 61)
        self.assertEqual(db.execute("SELECT name FROM projects").fetchone()[0], "Cuisine")
        self.assertEqual(db.execute("SELECT COUNT(*) FROM work_notes").fetchone()[0], 1)
        self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_sql_constraints_reject_bad_pin_lengths_and_foreign_project(self):
        db = self.database()
        self.note(db)
        for sql, args in [
            ("UPDATE work_notes SET pinned=?", (2,)),
            ("UPDATE work_notes SET title=?", ("x" * 201,)),
            ("UPDATE work_notes SET body=?", ("x" * 100001,)),
            ("UPDATE work_notes SET project_id=?", ("another-company-project",)),
        ]:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(sql, args)
        self.assertEqual(db.execute("SELECT title,pinned FROM work_notes").fetchone(), ("Mesures", 1))

    def test_creator_and_creation_timestamp_are_immutable(self):
        db = self.database()
        self.note(db)
        for column in ("created_by_member_id", "author_name", "created_at"):
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(f"UPDATE work_notes SET {column}='replacement'")
        db.execute("UPDATE work_notes SET body='Nouvelle mesure',updated_at='next'")
        self.assertEqual(db.execute("SELECT author_name,created_at,body FROM work_notes").fetchone(), ("Alice", "created", "Nouvelle mesure"))

    def test_deletion_remains_a_tombstone_and_project_removal_retains_note(self):
        db = self.database()
        self.note(db)
        db.execute("DELETE FROM projects WHERE id='project-a'")
        self.assertIsNone(db.execute("SELECT project_id FROM work_notes").fetchone()[0])
        db.execute("UPDATE work_notes SET deleted_at='deleted',updated_at='deleted'")
        self.assertEqual(db.execute("SELECT COUNT(*) FROM work_notes WHERE deleted_at IS NULL").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM work_notes WHERE deleted_at IS NOT NULL").fetchone()[0], 1)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("UPDATE work_notes SET deleted_at=NULL")

    def test_offline_backup_and_restart_keep_plain_text_and_deleted_ids(self):
        db = self.database()
        self.note(db)
        self.note(db, "deleted-note", None)
        db.execute("UPDATE work_notes SET deleted_at='deleted' WHERE id='deleted-note'")
        db.commit()
        with tempfile.TemporaryDirectory(prefix="zentra-notes-sql-") as folder:
            path = Path(folder) / "offline-backup.sqlite3"
            with closing(sqlite3.connect(path)) as backup:
                db.backup(backup)
            with closing(sqlite3.connect(path)) as restarted:
                self.assertEqual(restarted.execute("SELECT body FROM work_notes WHERE deleted_at IS NULL").fetchone()[0], "Mur nord : 2,40 m\nFenêtre : 1,20 m")
                self.assertEqual(restarted.execute("SELECT COUNT(*) FROM work_notes WHERE deleted_at IS NOT NULL").fetchone()[0], 1)
                self.assertEqual(restarted.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            isolated = sqlite3.connect(":memory:")
            try:
                isolated.executescript("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);")
                isolated.executescript(MIGRATION)
                self.assertEqual(isolated.execute("SELECT COUNT(*) FROM work_notes").fetchone()[0], 0)
            finally:
                isolated.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

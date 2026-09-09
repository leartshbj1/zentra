//! SQLite's online backup owns one destination write transaction. A zero-page
//! first step acquires it without copying data; a separate private WAL reader
//! then checks the actual live cutoff. Never access the destination connection
//! while its Backup handle exists. Dropping an unfinished backup rolls it back.
use super::*;
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};

pub(super) fn replace<T>(
    source: &Connection,
    destination: &Path,
    begin: impl FnOnce(&Connection) -> AppResult<T>,
    before_step: impl Fn(&T, bool) -> AppResult<()>,
    copied: impl Fn(usize, bool) -> AppResult<()>,
) -> AppResult<T> {
    if source.is_autocommit() {
        return Err(invalid(
            "La copie à installer doit conserver un instantané de lecture.",
        ));
    }
    if !snapshot::regular_metadata(destination)?.is_file() {
        return Err(invalid("La base de travail est absente."));
    }
    let mut target = Connection::open_with_flags(
        destination,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
    )?;
    target.busy_timeout(std::time::Duration::ZERO)?;
    let mode: String = target.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    if mode != "wal" {
        return Err(invalid(
            "La base doit utiliser son journal transactionnel avant l’installation.",
        ));
    }
    target.pragma_update(None, "synchronous", "FULL")?;
    let page_count: i64 = source.pragma_query_value(None, "page_count", |r| r.get(0))?;
    if !(1..=i64::from(i32::MAX)).contains(&page_count) {
        return Err(invalid("La taille de la copie à installer est invalide."));
    }
    // SQLITE_OPEN_PRIVATE_CACHE is essential: SQLite forbids using another
    // connection sharing the destination cache during an online backup.
    let reader = Connection::open_with_flags(
        destination,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
    )?;
    reader.busy_timeout(std::time::Duration::ZERO)?;
    let backup = Backup::new(source, &mut target)?;
    if backup.step(0)? != StepResult::More {
        return Err(invalid(
            "Une autre écriture utilise la base. Réessayez la synchronisation.",
        ));
    }
    let progress = backup.progress();
    if progress.remaining != page_count as i32 || progress.pagecount != page_count as i32 {
        return Err(invalid(
            "Le verrou d’installation n’a pas conservé la copie attendue.",
        ));
    }
    let state = begin(&reader)?;
    drop(reader);
    loop {
        let final_step = backup.progress().remaining <= 256;
        before_step(&state, final_step)?;
        let done = match backup.step(256)? {
            StepResult::More => false,
            StepResult::Done => true,
            StepResult::Busy | StepResult::Locked => return Err(invalid(
                "La copie transactionnelle a été interrompue. La reprise conservera les données.",
            )),
            _ => {
                return Err(invalid(
                    "La copie transactionnelle a renvoyé un état inconnu.",
                ))
            }
        };
        let progress = backup.progress();
        copied((progress.pagecount - progress.remaining) as usize, done)?;
        if done {
            break;
        }
    }
    drop(backup);
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Connection, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("working.sqlite");
        let target = Connection::open(&path).unwrap();
        target.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE data(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO data VALUES(1,'original');").unwrap();
        let source = Connection::open(root.path().join("candidate.sqlite")).unwrap();
        source.execute_batch("CREATE TABLE data(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO data VALUES(1,'merged');CREATE TABLE large(payload BLOB);INSERT INTO large VALUES(zeroblob(3000000));BEGIN;").unwrap();
        source
            .query_row("SELECT COUNT(*) FROM data", [], |r| r.get::<_, i64>(0))
            .unwrap();
        (root, source, path)
    }
    fn value(path: &Path) -> String {
        Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
        )
        .unwrap()
        .query_row("SELECT value FROM data WHERE id=1", [], |r| r.get(0))
        .unwrap()
    }
    #[test]
    fn zero_page_gate_keeps_old_rows_readable_and_rejects_independent_writers_until_commit() {
        let (_root, source, path) = fixture();
        let observations = std::cell::Cell::new(0);
        replace(
            &source,
            &path,
            |reader| {
                assert_eq!(
                    reader
                        .query_row("SELECT value FROM data", [], |r| r.get::<_, String>(0))
                        .unwrap(),
                    "original"
                );
                let writer = Connection::open(&path).unwrap();
                writer.busy_timeout(std::time::Duration::ZERO).unwrap();
                let error = writer
                    .execute("UPDATE data SET value='competing'", [])
                    .unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                Ok(())
            },
            |_, _| Ok(()),
            |_, done| {
                observations.set(observations.get() + 1);
                assert_eq!(value(&path), if done { "merged" } else { "original" });
                Ok(())
            },
        )
        .unwrap();
        assert!(observations.get() > 1);
        assert_eq!(value(&path), "merged");
        Connection::open(&path)
            .unwrap()
            .execute("UPDATE data SET value='after commit'", [])
            .unwrap();
        assert_eq!(value(&path), "after commit");
    }
    #[test]
    fn a_failed_cutoff_check_or_partial_copy_rolls_back_without_rewriting_original_rows() {
        let (_root, source, path) = fixture();
        let result = replace(
            &source,
            &path,
            |_| Err::<(), _>(invalid("Cutoff changed")),
            |_, _| Ok(()),
            |_, _| Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(value(&path), "original");
        let result = replace(
            &source,
            &path,
            |_| Ok(()),
            |_, _| Ok(()),
            |_, done| {
                assert!(!done);
                Err(invalid("Stop after partial copy"))
            },
        );
        assert!(result.is_err());
        assert_eq!(value(&path), "original");
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='large'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    #[test]
    fn an_existing_writer_cannot_be_bypassed_and_final_step_is_the_commit_decision() {
        let (_root, source, path) = fixture();
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("BEGIN IMMEDIATE;UPDATE data SET value='pending writer';")
            .unwrap();
        let result = replace(
            &source,
            &path,
            |_| panic!("Must not pass the writer gate"),
            |_: &(), _| Ok(()),
            |_, _| Ok(()),
        );
        assert!(result.is_err());
        writer.execute_batch("ROLLBACK").unwrap();
        assert_eq!(value(&path), "original");
        let result = replace(
            &source,
            &path,
            |_| Ok(()),
            |_, _| Ok(()),
            |_, done| {
                if done {
                    Err(invalid("Lost response after commit"))
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(
            value(&path),
            "merged",
            "Recovery must inspect the installed receipt, not the returned error"
        );
    }
}

//! Canonical rows and immutable event aliases belong to the private attachment
//! tree so existing full backups preserve them and business uploads exclude them.
use super::*;
use std::{fs, path::PathBuf};

pub(super) fn path(
    store: &LocalStore,
    generation: &str,
    revision: i64,
    sha: &str,
    create: bool,
) -> AppResult<PathBuf> {
    if uuid::Uuid::parse_str(generation).is_err()
        || revision < 1
        || sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("La référence du cache canonique est invalide."));
    }
    let mut path = store.attachments_dir.clone();
    if !crate::business_sync::snapshot::regular_metadata(&path)?.is_dir() {
        return Err(invalid("Le stockage privé des documents est invalide."));
    }
    for part in [
        crate::business_sync::files::DIRECTORY,
        "canonical",
        generation,
    ] {
        path.push(part);
        if !path.try_exists()? && create {
            fs::create_dir(&path)?;
            crate::business_sync::snapshot::sync_directory(path.parent().unwrap())?;
        }
        if path.try_exists()? && !crate::business_sync::snapshot::regular_metadata(&path)?.is_dir()
        {
            return Err(invalid("Le dossier du cache canonique est invalide."));
        }
    }
    path.push(format!("{revision}-{sha}.sqlite"));
    if path.try_exists()? && !crate::business_sync::snapshot::regular_metadata(&path)?.is_file() {
        return Err(invalid(
            "Le cache canonique ne peut pas remplacer ce chemin.",
        ));
    }
    Ok(path)
}
// Call only under the destination writer gate after verifying the live cutoff.
// An existing file for the NEXT revision is an uninstalled derived attempt; it
// may be atomically replaced. The current revision's cache is never overwritten.
pub(super) fn write(model: &model::Model, store: &LocalStore, context: &Context) -> AppResult<()> {
    if model.conflict_count != 0 || model.merged_sha256.is_none() {
        return Err(invalid(
            "Un cache ne peut pas confirmer une fusion en conflit.",
        ));
    }
    let destination = path(
        store,
        &context.generation,
        context
            .base_revision
            .checked_add(1)
            .ok_or_else(|| invalid("Révision trop élevée."))?,
        &context.target_state_sha256,
        true,
    )?;
    let directory = destination.parent().unwrap();
    let file = tempfile::NamedTempFile::new_in(directory)?;
    let mut c = Connection::open(file.path())?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE canonical_rows(table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(table_name,row_key_json),UNIQUE(table_name,canonical_rowid));
        CREATE TABLE row_aliases(capture_generation TEXT NOT NULL,sequence INTEGER NOT NULL,original_sha256 TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,PRIMARY KEY(capture_generation,sequence));")?;
    let mut q=model.connection.prepare("SELECT table_name,row_key_json,canonical_rowid,row_json FROM canonical_rows ORDER BY table_name,row_key_json")?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        tx.execute(
            "INSERT INTO canonical_rows VALUES(?1,?2,?3,?4)",
            params![
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?
            ],
        )?;
    }
    let mut q=model.connection.prepare("SELECT capture_generation,sequence,original_sha256,canonical_rowid FROM row_aliases ORDER BY capture_generation,sequence")?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        tx.execute(
            "INSERT INTO row_aliases VALUES(?1,?2,?3,?4)",
            params![
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?
            ],
        )?;
    }
    if fingerprint(&tx, "canonical_rows")? != context.target_state_sha256 {
        return Err(invalid("Le cache ne reproduit pas la révision canonique."));
    }
    tx.commit()?;
    drop(c);
    file.as_file().sync_all()?;
    file.persist(&destination).map_err(|e| e.error)?;
    crate::business_sync::snapshot::sync_directory(directory)?;
    let c = Connection::open_with_flags(
        &destination,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
    )?;
    if fingerprint(&c, "canonical_rows")? != context.target_state_sha256 {
        return Err(invalid(
            "Le cache durable a changé pendant son installation.",
        ));
    }
    drop(c);
    prune(directory, context.base_revision, &destination)?;
    Ok(())
}

// Under the same writer gate, keep the active base and this next revision.
// Previous revisions can no longer be needed by any successful installation;
// unfinished attempts are derived files and can be recreated. Unknown paths and
// other generations are never removed by this bounded, non-recursive cleanup.
fn prune(directory: &std::path::Path, base: i64, destination: &std::path::Path) -> AppResult<()> {
    let mut count = 0usize;
    for entry in fs::read_dir(directory)? {
        count += 1;
        if count > 50_000 {
            return Err(invalid("Le dossier du cache contient trop de fichiers."));
        }
        let entry = entry?;
        let path = entry.path();
        if path == destination {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str().and_then(|s| s.strip_suffix(".sqlite")) else {
            continue;
        };
        let Some((revision, sha)) = name.split_once('-') else {
            continue;
        };
        let Ok(revision) = revision.parse::<i64>() else {
            continue;
        };
        if revision < 1
            || sha.len() != 64
            || !sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            continue;
        }
        if (revision < base || revision == base + 1)
            && crate::business_sync::snapshot::regular_metadata(&path)?.is_file()
        {
            fs::remove_file(&path)?;
        }
    }
    crate::business_sync::snapshot::sync_directory(directory)
}

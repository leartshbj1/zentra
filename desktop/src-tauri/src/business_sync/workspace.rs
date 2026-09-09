//! Disposable workspaces use SQLite process locks, never timestamps or PIDs.
//! The registry gate serializes creation and collection. Each owner holds an
//! exclusive DELETE-journal lease until its last workspace user has finished.
use super::snapshot;
use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const DIRECTORY: &str = "business-workspaces";
const MAGIC: i64 = 1515679793;
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn busy(error: &rusqlite::Error) -> bool {
    matches!(error,rusqlite::Error::SqliteFailure(e,_) if matches!(e.code,rusqlite::ErrorCode::DatabaseBusy|rusqlite::ErrorCode::DatabaseLocked))
}
fn root(store: &LocalStore, create: bool) -> AppResult<Option<PathBuf>> {
    if !snapshot::regular_metadata(&store.data_dir)?.is_dir() {
        return Err(invalid("Le dossier de travail est invalide."));
    }
    let profile = fs::canonicalize(&store.data_dir)?;
    let root = profile.join(DIRECTORY);
    if !root.try_exists()? {
        if !create {
            return Ok(None);
        }
        match fs::create_dir(&root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        snapshot::sync_directory(&profile)?;
    }
    if !snapshot::regular_metadata(&root)?.is_dir() || fs::canonicalize(&root)? != root {
        return Err(invalid("Le stockage temporaire sort du profil local."));
    }
    Ok(Some(root))
}
fn connection(path: &Path, create: bool, timeout: Duration) -> AppResult<Connection> {
    if path.try_exists()? {
        let meta = snapshot::regular_metadata(path)?;
        if !meta.is_file() || meta.len() > 64 * 1024 {
            return Err(invalid("Le verrou temporaire est invalide."));
        }
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", path.to_string_lossy()));
        if side.try_exists()? && !snapshot::regular_metadata(&side)?.is_file() {
            return Err(invalid("Le journal temporaire est invalide."));
        }
    }
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let c = Connection::open_with_flags(path, flags)?;
    c.busy_timeout(timeout)?;
    c.pragma_update(None, "trusted_schema", false)?;
    Ok(c)
}
pub(super) fn gate(root: &Path, timeout: Duration) -> AppResult<Connection> {
    if !snapshot::regular_metadata(root)?.is_dir() || fs::canonicalize(root)? != root {
        return Err(invalid("Le dossier du verrou temporaire a changé."));
    }
    let path = root.join("registry.sqlite");
    let c = connection(&path, true, timeout)?;
    let mode: String = c.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    if mode != "delete" {
        return Err(invalid("Le verrou temporaire a un format inattendu."));
    }
    c.pragma_update(None, "synchronous", "FULL")?;
    c.execute_batch("BEGIN EXCLUSIVE")?;
    let marker: i64 = c.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if marker == 0 {
        let objects: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))?;
        if objects != 0 {
            return Err(invalid(
                "Le registre temporaire contient des données inconnues.",
            ));
        }
        c.pragma_update(None, "application_id", MAGIC)?;
        c.execute_batch("COMMIT;BEGIN EXCLUSIVE")?;
        snapshot::sync_directory(root)?;
    } else if marker != MAGIC {
        return Err(invalid(
            "Le registre temporaire appartient à un autre format.",
        ));
    }
    Ok(c)
}

pub(crate) struct Workspace {
    path: PathBuf,
    root: PathBuf,
    installation: String,
    lease: Option<Connection>,
}
impl Workspace {
    pub(crate) fn new(store: &LocalStore, kind: &str) -> AppResult<Self> {
        if !matches!(
            kind,
            "reconciliation-model" | "reconciliation-native" | "reconciliation-files"
        ) {
            return Err(invalid("Le type de copie temporaire est inconnu."));
        }
        let root = root(store, true)?.unwrap();
        let _gate = gate(&root, Duration::from_secs(2))?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = root.join(format!("v1-{id}"));
        fs::create_dir(&path)?;
        let lease = connection(&path.join("lease.sqlite"), true, Duration::ZERO)?;
        lease.pragma_update(None, "synchronous", "FULL")?;
        lease.execute_batch("CREATE TABLE owner(version INTEGER NOT NULL,id TEXT NOT NULL,installation TEXT NOT NULL,root TEXT NOT NULL,kind TEXT NOT NULL)")?;
        lease.execute(
            "INSERT INTO owner VALUES(1,?1,?2,?3,?4)",
            params![id, store.installation_id, root.to_string_lossy(), kind],
        )?;
        lease.execute_batch("BEGIN EXCLUSIVE")?;
        fs::OpenOptions::new()
            .write(true)
            .open(path.join("lease.sqlite"))?
            .sync_all()?;
        snapshot::sync_directory(&path)?;
        snapshot::sync_directory(&root)?;
        Ok(Self {
            path,
            root,
            installation: store.installation_id.clone(),
            lease: Some(lease),
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        // If another collector owns the gate, releasing our lease makes this
        // workspace collectable later. Never wait on it while holding a lease.
        if let Ok(_gate) = gate(&self.root, Duration::ZERO) {
            self.lease.take();
            let _ = collect_one(&self.root, &self.path, &self.installation);
        } else {
            self.lease.take();
        }
    }
}

#[derive(Default, Debug, Serialize)]
pub(crate) struct Cleanup {
    pub removed: usize,
    pub active: usize,
    pub preserved: usize,
    pub deferred: bool,
}
enum Decision {
    Removed,
    Active,
    Preserved,
}
fn collect_one(root: &Path, path: &Path, installation: &str) -> AppResult<Decision> {
    let Some(id) = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("v1-"))
    else {
        return Ok(Decision::Preserved);
    };
    if uuid::Uuid::parse_str(id).is_err() || path.parent() != Some(root) {
        return Ok(Decision::Preserved);
    }
    if !snapshot::regular_metadata(path)?.is_dir() || fs::canonicalize(path)? != path {
        return Ok(Decision::Preserved);
    }
    let lease = match connection(&path.join("lease.sqlite"), false, Duration::ZERO) {
        Ok(c) => c,
        Err(AppError::Database(e)) if busy(&e) => return Ok(Decision::Active),
        Err(_) => return Ok(Decision::Preserved),
    };
    if let Err(e) = lease.execute_batch("BEGIN EXCLUSIVE") {
        if busy(&e) {
            return Ok(Decision::Active);
        }
        return Ok(Decision::Preserved);
    }
    let mode: String = lease.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    let objects: i64 = lease.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='owner'",
        [],
        |r| r.get(0),
    )?;
    if mode != "delete" || objects != 1 {
        return Ok(Decision::Preserved);
    }
    let owned:bool=lease.query_row("SELECT COUNT(*)=1 AND MIN(version)=1 AND MIN(id)=?1 AND MIN(installation)=?2 AND MIN(root)=?3 AND MIN(kind) IN ('reconciliation-model','reconciliation-native','reconciliation-files') FROM owner",params![id,installation,root.to_string_lossy()],|r|r.get(0))?;
    if !owned {
        return Ok(Decision::Preserved);
    }
    // Preflight the complete tree before deleting anything; never recurse into
    // symlinks, junctions or unknown filesystem objects. Paths stay under this
    // resolved, UUID-scoped workspace. No remove_dir_all follows a changed tree.
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(path)
        .follow_links(false)
        .contents_first(true)
    {
        let entry =
            entry.map_err(|_| invalid("Une copie temporaire ne peut pas être vérifiée."))?;
        let meta = snapshot::regular_metadata(entry.path())?;
        if (!meta.is_file() && !meta.is_dir())
            || fs::canonicalize(entry.path())?.strip_prefix(path).is_err()
        {
            return Ok(Decision::Preserved);
        }
        entries.push((entry.path().to_path_buf(), meta.is_dir()));
        if entries.len() > 50_100 {
            return Ok(Decision::Preserved);
        }
    }
    // The registry gate is still held; no owner can start using this old id
    // between releasing the abandoned lease and removing its files on Windows.
    drop(lease);
    for (entry, is_dir) in entries {
        if fs::canonicalize(&entry)?.strip_prefix(path).is_err() {
            return Err(invalid("Le chemin temporaire a changé."));
        }
        let meta = snapshot::regular_metadata(&entry)?;
        if is_dir && meta.is_dir() {
            fs::remove_dir(&entry)?;
        } else if !is_dir && meta.is_file() {
            fs::remove_file(&entry)?;
        } else {
            return Err(invalid("La copie temporaire a changé."));
        }
    }
    snapshot::sync_directory(root)?;
    Ok(Decision::Removed)
}
pub(crate) fn cleanup(store: &LocalStore) -> AppResult<Cleanup> {
    let Some(root) = root(store, false)? else {
        return Ok(Cleanup::default());
    };
    let _gate = match gate(&root, Duration::ZERO) {
        Ok(c) => c,
        Err(AppError::Database(e)) if busy(&e) => {
            return Ok(Cleanup {
                deferred: true,
                ..Default::default()
            })
        }
        Err(e) => return Err(e),
    };
    let mut result = Cleanup::default();
    for (index, entry) in fs::read_dir(&root)?.enumerate() {
        if index >= 1024 || result.removed >= 32 {
            result.deferred = true;
            break;
        }
        let path = entry?.path();
        if !path
            .file_name()
            .is_some_and(|v| v.to_string_lossy().starts_with("v1-"))
        {
            continue;
        }
        match collect_one(&root, &path, &store.installation_id) {
            Ok(Decision::Removed) => result.removed += 1,
            Ok(Decision::Active) => result.active += 1,
            Ok(Decision::Preserved) | Err(_) => result.preserved += 1,
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests;

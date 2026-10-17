//! Complete-company sharing. Revisions are published with a server-side CAS;
//! divergent local work is kept, never silently replaced by the last uploader.
use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};
use reqwest::Method;
use rusqlite::{functions::FunctionFlags, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{Emitter, State};

pub(crate) const PATH: &str = "/api/account/collaboration";
#[path = "company_account.rs"]
pub(crate) mod account;
const STATE: &str = "company-collaboration.json";
#[cfg(any(test, feature = "maintenance"))]
#[path = "company_link_repair.rs"]
pub(crate) mod repair;
static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<AtomicBool>>>> = OnceLock::new();
type ChangeListener = Arc<dyn Fn() + Send + Sync>;
static LISTENERS: OnceLock<Mutex<HashMap<PathBuf, ChangeListener>>> = OnceLock::new();
pub(crate) fn install_change_events(store: &LocalStore, app: tauri::AppHandle) {
    LISTENERS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            store.data_dir.clone(),
            Arc::new(move || {
                let _ = app.emit("zentra-company-data-changed", ());
            }),
        );
}
thread_local! { static APPLYING:Cell<bool>=const {Cell::new(false)}; }
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn gate(store: &LocalStore) -> Arc<AtomicBool> {
    GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(store.data_dir.clone())
        .or_default()
        .clone()
}
pub(crate) fn register(store: &LocalStore, connection: &Connection) -> AppResult<()> {
    connection.create_scalar_function(
        "zentra_company_logo_key",
        1,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_INNOCUOUS
            | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let value: Option<String> = ctx.get(0)?;
            Ok(value.map(|s| {
                crate::company_sync_digest::shared_text("settings", "logo_path", &s).to_owned()
            }))
        },
    )?;
    // The clock covers every shared table, including writes outside UI commands.
    // Notify once per transaction, never for rolled-back edits or remote imports.
    let dirty = Arc::new(AtomicBool::new(false));
    let changed = dirty.clone();
    connection.update_hook(Some(
        move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
            if table == "company_local_clock" && !APPLYING.get() {
                changed.store(true, Ordering::Release);
            }
        },
    ));
    let rolled_back = dirty.clone();
    connection.rollback_hook(Some(move || {
        rolled_back.store(false, Ordering::Release);
    }));
    let directory = store.data_dir.clone();
    connection.commit_hook(Some(move || {
        // A previously prepared statement must not acknowledge a write once a
        // failed restore leaves an ambiguous profile behind.
        if crate::backup::require_restore_statement_access(&directory).is_err() {
            dirty.store(false, Ordering::Release);
            return true;
        }
        if dirty.swap(false, Ordering::AcqRel) && !APPLYING.get() {
            let callback = LISTENERS
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&directory)
                .cloned();
            // No database work here. The receiver coalesces notifications and
            // takes the normal SQLite lock before reading the committed state.
            if let Some(callback) = callback {
                callback();
            }
        }
        false
    }));
    let gate = gate(store);
    let directory = store.data_dir.clone();
    connection.create_scalar_function(
        "zentra_company_write_allowed",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS,
        move |_| Ok((!gate.load(Ordering::Acquire) || APPLYING.get())
            && crate::backup::require_restore_statement_access(&directory).is_ok()),
    )?;
    Ok(())
}
pub(crate) fn migrate(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS company_local_identity(id INTEGER PRIMARY KEY CHECK(id=1),organization_id TEXT NOT NULL,user_id TEXT NOT NULL,display_name TEXT NOT NULL,role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS company_local_clock(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
      INSERT OR IGNORE INTO company_local_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS document_creators(entity TEXT NOT NULL CHECK(entity IN ('quotes','invoices')),document_id TEXT NOT NULL,user_id TEXT,display_name TEXT NOT NULL,installation_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity,document_id));
      CREATE TRIGGER IF NOT EXISTS document_creators_immutable_update BEFORE UPDATE ON document_creators BEGIN SELECT RAISE(ABORT,'Le créateur original du document ne peut pas être remplacé.'); END;
      CREATE TRIGGER IF NOT EXISTS document_creators_immutable_delete BEFORE DELETE ON document_creators BEGIN SELECT RAISE(ABORT,'Le créateur original du document doit être conservé.'); END;
    "#)?;
    crate::member_context::migrate(connection)?;
    for table in ["quotes", "invoices"] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            [table],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        connection.execute_batch(&format!(r#"
          CREATE TRIGGER IF NOT EXISTS company_creator_{table} AFTER INSERT ON {table} BEGIN
            INSERT INTO document_creators(entity,document_id,user_id,display_name,installation_id,created_at)
            VALUES('{table}',NEW.id,(SELECT user_id FROM company_local_identity WHERE id=1),
              COALESCE((SELECT display_name FROM company_local_identity WHERE id=1),'Créé sur cet appareil'),zentra_installation_id(),NEW.created_at);
          END;
        "#))?;
    }
    let tables = query_all(
        connection,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        [],
    )?;
    for row in tables {
        let table = row["name"].as_str().unwrap_or_default();
        if local_table(table) {
            continue;
        }
        if !table
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(invalid("Table inconnue pendant la préparation du partage."));
        }
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            connection.execute_batch(&format!(r#"
              CREATE TRIGGER IF NOT EXISTS company_guard_{table}_{operation} BEFORE {operation} ON "{table}"
              WHEN zentra_company_write_allowed()=0
              BEGIN SELECT RAISE(ABORT,'L’entreprise se met à jour. Attendez quelques secondes puis enregistrez à nouveau.'); END;
              CREATE TRIGGER IF NOT EXISTS company_clock_{table}_{operation} AFTER {operation} ON "{table}"
              BEGIN UPDATE company_local_clock SET value=value+1 WHERE id=1; END;
            "#))?;
        }
    }
    upgrade_tracking(connection)?;
    connection.pragma_update(None, "user_version", 60)?;
    Ok(())
}
#[cfg(test)]
#[path = "member_context_private_tests.rs"]
mod member_context_private_tests;
#[cfg(test)]
#[path = "action_engine_collaboration_tests.rs"]
mod action_engine_collaboration_tests;
#[cfg(test)]
#[path = "company_collaboration_action_publication_tests.rs"]
mod action_publication_tests;

#[cfg(all(test, windows))]
#[path = "company_collaboration_live_a41_g4_support.rs"]
pub(crate) mod live_a41_g4_support;

pub(crate) fn local_table(table: &str) -> bool {
    table.starts_with("sqlite_")
        || table.starts_with("company_local_")
        || matches!(
            table,
            "license_state"
                | "device_number_ranges"
                | "project_sync_binding"
                | "project_document_sync"
                | "project_document_tombstones"
                | "project_sync_events"
                | "active_timers"
        )
}
#[cfg(test)]
pub(crate) fn remove_tracking_for_legacy_fixture(db: &Connection) {
    // Tests construct old schemas from a current fixture. Those versions never
    // contained column-aware collaboration triggers; remove that later layer
    // before ALTER TABLE DROP COLUMN, then exercise the real migration normally.
    let names = {
        let mut q=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'company_clock_%' OR name LIKE 'company_guard_%')").unwrap();
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    };
    for name in names {
        db.execute_batch(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\"")))
            .unwrap();
    }
    db.execute_batch("DROP TABLE IF EXISTS company_local_tracking_version; DROP TABLE IF EXISTS company_local_clock;").unwrap();
}
pub(crate) fn upgrade_tracking(connection: &Connection) -> AppResult<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS company_local_tracking_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)")?;
    let ready: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM company_local_tracking_version WHERE id=1 AND version=3)",
        [],
        |r| r.get(0),
    )?;
    if ready {
        return Ok(());
    }
    for row in query_all(
        connection,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        [],
    )? {
        let table = row["name"].as_str().unwrap_or_default();
        if local_table(table) {
            continue;
        }
        if !table
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err(invalid("Table de partage inconnue."));
        }
        let columns = query_all(connection, &format!("PRAGMA table_info(\"{table}\")"), [])?;
        let changed = columns
            .iter()
            .filter_map(|r| r["name"].as_str())
            .filter(|c| !crate::company_sync_digest::ignored_column(table, c))
            .map(|c| if table=="settings" && c=="logo_path" { "zentra_company_logo_key(OLD.logo_path) IS NOT zentra_company_logo_key(NEW.logo_path)".into() } else {format!("OLD.\"{c}\" IS NOT NEW.\"{c}\"")})
            .collect::<Vec<_>>()
            .join(" OR ");
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            let mut conditions = Vec::new();
            if operation == "UPDATE" {
                conditions.push(format!("({changed})"));
            }
            if table == "reminder_operation_requests" {
                let real = |prefix| {
                    format!(
                        "NOT COALESCE(({}),0)",
                        crate::company_sync_digest::noop_scan_sql(prefix)
                    )
                };
                conditions.push(match operation {
                    "UPDATE" => format!("({} OR {})", real("OLD."), real("NEW.")),
                    "DELETE" => real("OLD."),
                    _ => real("NEW."),
                });
            }
            let when = if conditions.is_empty() {
                String::new()
            } else {
                format!("WHEN {}", conditions.join(" AND "))
            };
            connection.execute_batch(&format!("DROP TRIGGER IF EXISTS company_clock_{table}_{operation};
              CREATE TRIGGER company_clock_{table}_{operation} AFTER {operation} ON \"{table}\" {when}
              BEGIN UPDATE company_local_clock SET value=value+1 WHERE id=1; END;"))?;
        }
    }
    connection.execute("INSERT INTO company_local_tracking_version VALUES(1,3) ON CONFLICT(id) DO UPDATE SET version=3",[])?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Baseline {
    organization: String,
    revision: u64,
    digest: String,
}
fn save_baseline(
    store: &LocalStore,
    organization: &str,
    revision: u64,
    digest: String,
) -> AppResult<()> {
    store.require_usable_profile()?;
    let mut file = tempfile::NamedTempFile::new_in(&store.data_dir)?;
    serde_json::to_writer(
        file.as_file_mut(),
        &Baseline {
            organization: organization.into(),
            revision,
            digest,
        },
    )?;
    file.as_file_mut().sync_all()?;
    file.persist(store.data_dir.join("company-sync-baseline.json"))
        .map_err(|e| AppError::Io(e.error))?;
    Ok(())
}
fn baseline(store: &LocalStore, prefs: &Preferences) -> Option<String> {
    let path = store.data_dir.join("company-sync-baseline.json");
    if fs::metadata(&path).ok()?.len() > 2048 {
        return None;
    }
    let value: Baseline = serde_json::from_reader(File::open(path).ok()?).ok()?;
    (prefs.organization_id.as_deref() == Some(&value.organization)
        && prefs.revision == value.revision
        && value.digest.len() == 64
        && value.digest.bytes().all(|c| c.is_ascii_hexdigit()))
    .then_some(value.digest)
}
fn remember_reference(
    store: &LocalStore,
    path: &Path,
    organization: &str,
    revision: u64,
) -> AppResult<()> {
    store.require_usable_profile()?;
    let digest = crate::company_sync_digest::archive(path)?;
    let mut copy = tempfile::NamedTempFile::new_in(&store.data_dir)?;
    std::io::copy(&mut File::open(path)?, copy.as_file_mut())?;
    copy.as_file().sync_all()?;
    copy.persist(store.data_dir.join("company-sync-reference.zentra"))
        .map_err(|e| AppError::Io(e.error))?;
    save_baseline(store, organization, revision, digest)
}

/// A local connection generation, not evidence of server identity or rights.
/// The callers hold the account operation lock before any of these workers
/// acquire LocalStore.lock; a worker never takes the account lock in reverse.
#[derive(Clone)]
struct LocalTransferOrigin {
    workspace_scope: String,
    member_context: String,
    organization: String,
}
impl LocalTransferOrigin {
    fn capture(store: &LocalStore, organization: &str) -> AppResult<Self> {
        let connection = store.connect()?;
        Ok(Self {
            workspace_scope: crate::work_notes::workspace_scope(&connection)?,
            member_context: crate::member_context::read(&connection)?,
            organization: organization.into(),
        })
    }
    fn require_unchanged(&self, store: &LocalStore) -> AppResult<()> {
        let connection = store.connect()?;
        if crate::work_notes::workspace_scope(&connection)? != self.workspace_scope {
            return Err(invalid("L’entreprise ouverte a changé. Ce brouillon appartient à l’espace précédent et y reste conservé."));
        }
        crate::member_context::require_unchanged(&connection, Some(&self.member_context))?;
        if load(store)?.organization_id.as_deref() != Some(self.organization.as_str()) {
            return Err(invalid("La connexion ou l’entreprise ouverte a changé. Relancez la synchronisation."));
        }
        Ok(())
    }
}

fn require_archive_content(
    path: &Path,
    expected: &crate::cloud_backup::Manifest,
    message: &str,
) -> AppResult<()> {
    expected.validate()?;
    let actual = crate::cloud_backup::file_manifest(path)?;
    // file_manifest stamps the current binary version, not the archive's
    // original producer version. An upgrade must still confirm the identical
    // durable pending bytes and accept the exact older reference revision.
    if !same_archive_content(&actual, expected) {
        return Err(invalid(message));
    }
    Ok(())
}
fn same_archive_content(actual: &crate::cloud_backup::Manifest, expected: &crate::cloud_backup::Manifest) -> bool {
    actual.sha256 == expected.sha256
        && actual.size_bytes == expected.size_bytes
        && actual.chunks == expected.chunks
}

/// Hashing/extracting an archive and copying/fsyncing its reference can be
/// substantial. Keep this complete operation off the asynchronous executor.
async fn read_reference_worker(
    store: &LocalStore,
    organization: &str,
    expected_revision: u64,
) -> AppResult<(LocalTransferOrigin, Option<PathBuf>)> {
    let owned = store.clone();
    let organization = organization.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _local = owned.lock()?;
        let origin = LocalTransferOrigin::capture(&owned, &organization)?;
        origin.require_unchanged(&owned)?;
        let prefs = load(&owned)?;
        if prefs.revision != expected_revision {
            return Err(invalid("La version de référence a changé. Relancez la synchronisation."));
        }
        let path = owned.data_dir.join("company-sync-reference.zentra");
        let existing = baseline(&owned, &prefs).filter(|digest| {
            path.is_file()
                && crate::company_sync_digest::archive(&path).ok().as_ref() == Some(digest)
        }).map(|_| path);
        Ok((origin, existing))
    })
    .await
    .map_err(|_| invalid("La vérification de la référence a été interrompue. Elle reprendra automatiquement."))?
}

async fn install_reference_worker(
    store: &LocalStore,
    origin: LocalTransferOrigin,
    expected_revision: u64,
    downloaded: PathBuf,
    expected_manifest: crate::cloud_backup::Manifest,
) -> AppResult<PathBuf> {
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _local = owned.lock()?;
        origin.require_unchanged(&owned)?;
        if load(&owned)?.revision != expected_revision {
            return Err(invalid("La version de référence a changé. Relancez la synchronisation."));
        }
        require_archive_content(&downloaded, &expected_manifest,
            "La copie de référence a changé. Relancez la synchronisation.")?;
        remember_reference(&owned, &downloaded, &origin.organization, expected_revision)?;
        Ok(owned.data_dir.join("company-sync-reference.zentra"))
    })
    .await
    .map_err(|_| invalid("La préparation de la référence a été interrompue. Elle reprendra automatiquement."))?
}
async fn reference_copy(
    store: &LocalStore,
    session: &ProjectSyncSession,
    prefs: &Preferences,
) -> AppResult<PathBuf> {
    let (origin, existing) = read_reference_worker(store, &session.organization_id, prefs.revision).await?;
    if let Some(path) = existing {
        return Ok(path);
    }
    let head = request(
        session,
        Method::GET,
        &[("revision", &prefs.revision.to_string())],
        None,
    )
    .await?;
    if checked_head(session, &head)? != prefs.revision {
        return Err(invalid("La copie de référence de cette entreprise est indisponible. Vos changements sont conservés."));
    }
    let manifest: crate::cloud_backup::Manifest = serde_json::from_value(head["manifest"].clone())?;
    let downloaded = download(store, session, &head).await?;
    // Older versions stored only a digest; recover their EXACT accepted revision.
    // A v1.70 digest may include the now-ignored logo verification timestamp.
    install_reference_worker(store, origin, prefs.revision, downloaded, manifest).await
}
fn reconcile_unchanged_local(store: &LocalStore, expected: &str) -> AppResult<bool> {
    let _lock = store.lock()?;
    let mut prefs = load(store)?;
    if prefs.base_clock < 0 {
        return Ok(false);
    }
    if crate::company_sync_digest::local(store)? != expected {
        return Ok(false);
    }
    // Only bookkeeping changed. Every shared record, audit entry and attachment
    // was compared to the last accepted revision before clearing the conflict.
    prefs.base_clock = clock(store)?;
    prefs.pending = None;
    prefs.conflict = false;
    prefs.conflict_reason = None;
    save(store, &prefs)?;
    Ok(true)
}
async fn reconcile_idle_device(store: &LocalStore, session: &ProjectSyncSession) -> AppResult<()> {
    let prefs = load(store)?;
    if prefs.base_clock < 0 || prefs.revision == 0 {
        return Ok(());
    }
    let dirty = clock(store)? != prefs.base_clock || prefs.conflict || prefs.pending.is_some();
    let mut digest = baseline(store, &prefs);
    if !dirty {
        if digest.is_none()
            || !store
                .data_dir
                .join("company-sync-reference.zentra")
                .is_file()
        {
            let owned = store.clone();
            let org = session.organization_id.clone();
            tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
                let _lock = owned.lock()?;
                let _gate = WriteGate::take(&owned)?;
                if clock(&owned)? == prefs.base_clock && load(&owned)?.revision == prefs.revision {
                    let temp = tempfile::tempdir_in(&owned.data_dir)?;
                    let reference = temp.path().join("reference.zentra");
                    owned.create_backup_at(&reference, env!("CARGO_PKG_VERSION"))?;
                    remember_reference(&owned, &reference, &org, prefs.revision)?;
                }
                Ok(())
            })
            .await
            .map_err(|_| invalid("La copie de référence sera préparée au prochain échange."))??;
        }
        return Ok(());
    }
    if digest.is_none() {
        // Upgrade an installation already held by an old false conflict. The
        // reference must be the exact committed revision of this company.
        let Ok(head) = request(
            session,
            Method::GET,
            &[("revision", &prefs.revision.to_string())],
            None,
        )
        .await
        else {
            return Ok(());
        };
        if checked_head(session, &head)? != prefs.revision {
            return Ok(());
        }
        let path = download(store, session, &head).await?;
        let value = tauri::async_runtime::spawn_blocking(move || {
            crate::company_sync_digest::archive(&path)
        })
        .await
        .map_err(|_| invalid("La vérification de la copie de référence a été interrompue."))??;
        save_baseline(
            store,
            &session.organization_id,
            prefs.revision,
            value.clone(),
        )?;
        digest = Some(value);
    }
    if let Some(digest) = digest {
        let owned = store.clone();
        tauri::async_runtime::spawn_blocking(move || reconcile_unchanged_local(&owned, &digest))
            .await
            .map_err(|_| invalid("La vérification des changements locaux a été interrompue."))??;
    }
    Ok(())
}
pub(crate) fn strip_private(connection: &Connection) -> AppResult<()> {
    crate::action_engine_quote_publication::strip_private(connection)?;
    let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_local_identity')",[],|r|r.get(0))?;
    if exists {
        connection.execute("DELETE FROM company_local_identity", [])?;
    }
    crate::member_context::strip(connection)?;
    let has_notes_scope:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_local_notes_scope')",[],|r|r.get(0))?;
    if has_notes_scope {
        connection.execute("DELETE FROM company_local_notes_scope", [])?;
    }
    let has_action_outbox:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_local_action_engine_quote_outbox')",[],|r|r.get(0))?;
    if has_action_outbox {
        connection.execute("DELETE FROM company_local_action_engine_quote_outbox", [])?;
    }
    Ok(())
}
pub(crate) fn set_identity(
    store: &LocalStore,
    organization: &str,
    user_id: &str,
    name: &str,
    role: &str,
) -> AppResult<()> {
    if user_id.is_empty() || name.is_empty() {
        return Err(invalid(
            "Reconnectez votre compte pour identifier le créateur des documents.",
        ));
    }
    let _local = store.lock()?;
    store.connect()?.execute("INSERT INTO company_local_identity VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,user_id=excluded.user_id,display_name=excluded.display_name,role=excluded.role",params![organization,user_id,name,role])?;
    Ok(())
}

/// The quote contact is its author, never the person currently opening it.
pub(crate) fn quote_contact(connection: &Connection, id: &str) -> AppResult<String> {
    let author: Option<(Option<String>, String)> = connection.query_row(
        "SELECT user_id,display_name FROM document_creators WHERE entity='quotes' AND document_id=?",
        [id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((Some(_), name)) = author {
        return Ok(if name.contains('@') { String::new() } else { name.trim().to_owned() });
    }
    // Standalone companies have no account author; use their declared contact.
    Ok(connection.query_row("SELECT COALESCE(owner_name,'') FROM settings WHERE id=1", [], |row| row.get::<_, String>(0)).optional()?.unwrap_or_default())
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Preferences {
    organization_id: Option<String>,
    revision: u64,
    base_clock: i64,
    pending: Option<Pending>,
    last_synced_at: Option<String>,
    conflict: bool,
    conflict_reason: Option<String>,
    duplicate_receipt: Option<crate::company_merge::DuplicateReceipt>,
    received: Option<Received>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Received {
    id: String,
    organization: String,
    revision: u64,
    clock: i64,
    manifest: crate::cloud_backup::Manifest,
    #[serde(default)]
    merge: Option<MergeReception>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MergeReception {
    local_digest: String,
    reference_id: String,
    reference_manifest: crate::cloud_backup::Manifest,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Pending {
    id: String,
    base_revision: u64,
    clock: i64,
    manifest: crate::cloud_backup::Manifest,
    // 0: legacy/in-flight before this upgrade; 1: content upload; 2: new,
    // protocol not negotiated yet. Never change an already prepared upload.
    #[serde(default)]
    content_version: u8,
}
fn folder(store: &LocalStore) -> AppResult<PathBuf> {
    store.require_usable_profile()?;
    let p = store.data_dir.join("company-sync");
    fs::create_dir_all(&p)?;
    Ok(p)
}
fn load(store: &LocalStore) -> AppResult<Preferences> {
    store.require_usable_profile()?;
    let path = store.data_dir.join(STATE);
    if !path.exists() {
        return Ok(Preferences::default());
    }
    if fs::metadata(&path)?.len() > 65536 {
        return Err(invalid("Les réglages de synchronisation sont illisibles."));
    }
    let value: Preferences = serde_json::from_reader(File::open(path)?)?;
    if let Some(p) = &value.pending {
        crate::cloud_backup::validate_id(&p.id)?;
        p.manifest.validate()?;
    }
    if let Some(r) = &value.received {
        crate::cloud_backup::validate_id(&r.id)?;
        r.manifest.validate()?;
        if let Some(m) = &r.merge {
            crate::cloud_backup::validate_id(&m.reference_id)?;
            m.reference_manifest.validate()?;
        }
    }
    Ok(value)
}
fn save(store: &LocalStore, value: &Preferences) -> AppResult<()> {
    store.require_usable_profile()?;
    let mut f = tempfile::Builder::new()
        .prefix(".company-sync-")
        .tempfile_in(&store.data_dir)?;
    serde_json::to_writer(f.as_file_mut(), value)?;
    f.as_file_mut().sync_all()?;
    f.persist(store.data_dir.join(STATE))
        .map_err(|e| AppError::Io(e.error))?;
    Ok(())
}
pub(crate) fn after_manual_restore(store: &LocalStore) -> AppResult<()> {
    let mut prefs = load(store)?;
    if prefs.organization_id.is_some() {
        prefs.pending = None;
        prefs.received = None;
        prefs.base_clock = -1;
        prefs.conflict = true;
        prefs.duplicate_receipt = None;
        save(store, &prefs)?;
    }
    Ok(())
}
fn clock(store: &LocalStore) -> AppResult<i64> {
    Ok(store.connect()?.query_row(
        "SELECT value FROM company_local_clock WHERE id=1",
        [],
        |r| r.get(0),
    )?)
}
/// Forget the revisions of a server that no longer has this organisation's
/// workspace, keeping every local record; the next send publishes revision 1.
fn restart_after_empty_server(store: &LocalStore, organization: &str) -> AppResult<()> {
    let _lock = store.lock()?;
    let mut prefs = load(store)?;
    if prefs.organization_id.as_deref() != Some(organization) {
        return Err(invalid("Reconnectez le compte correspondant à cette entreprise."));
    }
    if let Some(pending) = prefs.pending.take() {
        if let Ok(path) = file_path(store, &pending.id) {
            let _ = fs::remove_file(path);
        }
    }
    if let Some(received) = prefs.received.take() {
        if let Ok(path) = file_path(store, &received.id) {
            let _ = fs::remove_file(path);
        }
    }
    prefs.revision = 0;
    prefs.conflict = false;
    prefs.conflict_reason = None;
    prefs.duplicate_receipt = None;
    save(store, &prefs)
}

fn file_path(store: &LocalStore, id: &str) -> AppResult<PathBuf> {
    crate::cloud_backup::validate_id(id)?;
    Ok(folder(store)?.join(format!("{id}.zentra")))
}
fn clean_transport_copies(store: &LocalStore) -> AppResult<()> {
    let prefs = load(store)?;
    let retained = crate::action_engine_quote_publication::retained_snapshot_ids(&store.connect()?)?;
    let directory = folder(store)?;
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.parent() != Some(directory.as_path())
            || path.extension().and_then(|x| x.to_str()) != Some("zentra")
        {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|x| x.to_str()) else {
            continue;
        };
        if crate::cloud_backup::validate_id(id).is_err()
            || retained.iter().any(|snapshot| snapshot == id)
            || prefs.pending.as_ref().is_some_and(|p| p.id == id)
            || prefs.received.as_ref().is_some_and(|r| r.id == id)
            || prefs
                .received
                .as_ref()
                .and_then(|r| r.merge.as_ref())
                .is_some_and(|m| m.reference_id == id)
        {
            continue;
        }
        fs::remove_file(&path)?;
    }
    Ok(())
}
async fn request(
    session: &ProjectSyncSession,
    method: Method,
    query: &[(&str, &str)],
    value: Option<Value>,
) -> AppResult<Value> {
    let (_, bytes) = session
        .request(
            method,
            PATH,
            query,
            &[("Content-Type", "application/json".into())],
            value.map(|v| serde_json::to_vec(&v)).transpose()?,
            false,
        )
        .await?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn checked_head(session: &ProjectSyncSession, value: &Value) -> AppResult<u64> {
    if value["organizationId"].as_str() != Some(&session.organization_id) {
        return Err(invalid(
            "La réponse appartient à une autre entreprise. Aucune donnée n’a été modifiée.",
        ));
    }
    value["revision"]
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("La version partagée est invalide."))
}
pub(crate) fn status(store: &LocalStore) -> AppResult<Value> {
    let prefs = load(store)?;
    Ok(
        json!({"enabled":prefs.organization_id.is_some(),"organizationId":prefs.organization_id,"revision":prefs.revision,
      "pending":prefs.pending.is_some()||prefs.organization_id.is_some()&&clock(store)?!=prefs.base_clock,
      "conflict":prefs.conflict,"conflictReason":prefs.conflict_reason,"duplicateReceipt":prefs.duplicate_receipt,"ready":prefs.received.as_ref().is_some_and(|r|(r.merge.is_some()||r.clock==prefs.base_clock)&&clock(store).ok()==Some(r.clock)),"lastSyncedAt":prefs.last_synced_at,"syncing":gate(store).load(Ordering::Acquire)}),
    )
}
#[tauri::command]
pub fn get_company_sync_state(state: State<'_, LocalStore>) -> Result<Value, String> {
    status(&state).map_err(command_error)
}

#[tauri::command]
pub async fn watch_company_workspace(
    state: State<'_, LocalStore>,
    after: Option<u64>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let prefs = load(&store).map_err(command_error)?;
    if prefs.organization_id.is_none() {
        return Ok(json!({"enabled":false}));
    }
    // Never hold operation_lock over a long poll: saving, sending, logout and
    // account changes must remain available while waiting for a colleague.
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or("Reconnectez votre compte pour recevoir les changements de l’équipe.")?;
    if prefs.organization_id.as_deref() != Some(&session.organization_id) {
        return Err("Reconnectez le compte de cette entreprise.".into());
    }
    let known = prefs
        .received
        .as_ref()
        .map_or(prefs.revision, |r| r.revision.max(prefs.revision))
        .max(after.filter(|n| *n <= 9_007_199_254_740_991).unwrap_or(0));
    let head = request(
        &session,
        Method::GET,
        &[("watch", &known.to_string())],
        None,
    )
    .await
    .map_err(command_error)?;
    let revision = checked_head(&session, &head).map_err(command_error)?;
    // Return only a hint. Applying data always revalidates current membership,
    // organization, revision and hashes through the existing synchronization.
    Ok(
        json!({"enabled":true,"organizationId":session.organization_id,"revision":revision,
        "changed":revision>known,"realtime":head["realtime"]==true}),
    )
}

struct WriteGate(Arc<AtomicBool>);
impl WriteGate {
    fn take(store: &LocalStore) -> AppResult<Self> {
        let state = gate(store);
        state
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| invalid("L’entreprise se met déjà à jour."))?;
        let guard = Self(state);
        APPLYING.set(true);
        // Drain the previous writer before preparing or replacing a snapshot.
        // Every subsequent shared-table statement checks the gate at execution.
        let connection = store.connect()?;
        connection.execute_batch("BEGIN IMMEDIATE; COMMIT;")?;
        Ok(guard)
    }
}
impl Drop for WriteGate {
    fn drop(&mut self) {
        APPLYING.set(false);
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
fn prepare(store: &LocalStore, organization: &str, activate: bool) -> AppResult<Pending> {
    let _lock = store.lock()?;
    prepare_locked(store, organization, activate)
}
fn prepare_locked(store: &LocalStore, organization: &str, activate: bool) -> AppResult<Pending> {
    store.require_usable_profile()?;
    let mut prefs = load(store)?;
    if prefs
        .organization_id
        .as_deref()
        .is_some_and(|id| id != organization)
    {
        return Err(invalid(
            "Reconnectez le compte correspondant à cette entreprise.",
        ));
    }
    if let Some(p) = prefs.pending {
        crate::action_engine_quote_publication::link_prepared(store, organization, &p.id, p.base_revision, p.clock, &p.manifest)?;
        return Ok(p);
    }
    let _gate = WriteGate::take(store)?;
    if activate {
        store.connect()?.execute(
            "INSERT INTO shared_numbering_binding VALUES(1,?,?) ON CONFLICT(id) DO NOTHING",
            params![organization, now_iso()],
        )?;
        let bound: String = store.connect()?.query_row(
            "SELECT organization_id FROM shared_numbering_binding WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if bound != organization {
            return Err(invalid(
                "Ces données sont déjà liées à une autre entreprise.",
            ));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = file_path(store, &id)?;
    let before = clock(store)?;
    store.create_collaboration_backup_at(&path, env!("CARGO_PKG_VERSION"), organization, &id, prefs.revision)?;
    let manifest = crate::cloud_backup::file_manifest(&path)?;
    if before != clock(store)? {
        return Err(invalid(
            "Une modification est en cours. La synchronisation reprendra après l’enregistrement.",
        ));
    }
    let pending = Pending {
        id,
        manifest,
        clock: before,
        base_revision: prefs.revision,
        content_version: 2,
    };
    prefs.pending = Some(pending.clone());
    prefs.organization_id = Some(organization.into());
    save(store, &prefs)?;
    crate::action_engine_quote_publication::link_prepared(store, organization, &pending.id, pending.base_revision, pending.clock, &pending.manifest)?;
    Ok(pending)
}

/// The caller already owns LocalStore's non-reentrant mutex. A historical
/// receipt is recovered BEFORE this guard; it grants no new local write.
/// The organisation this company is linked to for collaboration, if any.
pub(crate) fn bound_organization(store: &LocalStore) -> AppResult<Option<String>> {
    Ok(load(store)?.organization_id)
}

pub(crate) fn require_action_engine_quote_write_ready(store: &LocalStore, organization: &str) -> AppResult<()> {
    let prefs = load(store)?;
    if prefs.pending.is_some() || prefs.received.is_some() || prefs.conflict
        || prefs.organization_id.as_deref().is_some_and(|bound| bound != organization)
    {
        return Err(invalid("Terminez la synchronisation de cette entreprise avant de préparer un nouveau devis Automation. Vos données sont conservées."));
    }
    Ok(())
}

async fn prepare_for_send_worker(
    store: &LocalStore,
    organization: &str,
    activate: bool,
) -> AppResult<(Pending, LocalTransferOrigin)> {
    prepare_for_send_origin_worker(store, organization, activate, None, None).await
}

async fn prepare_for_send_origin_worker(
    store: &LocalStore,
    organization: &str,
    activate: bool,
    expected_origin: Option<LocalTransferOrigin>,
    expected_state: Option<(u64,Option<Pending>)>,
) -> AppResult<(Pending, LocalTransferOrigin)> {
    let owned = store.clone();
    let organization = organization.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _local = owned.lock()?;
        let origin = match expected_origin {
            Some(origin) => { origin.require_unchanged(&owned)?; origin },
            None => LocalTransferOrigin::capture(&owned, &organization)?,
        };
        if let Some((revision,pending))=expected_state {
            let current=load(&owned)?;
            if current.revision!=revision || current.pending!=pending || current.conflict || current.received.is_some() {
                return Err(invalid("L’envoi local a changé. Vos données sont conservées."));
            }
        }
        let pending = prepare_locked(&owned, &organization, activate)?;
        Ok((pending, origin))
    })
    .await
    .map_err(|_| invalid("L’envoi a été interrompu. Il reprendra automatiquement."))?
}

#[cfg(test)]
pub(crate) async fn prepare_recovery_test_publication(store: &LocalStore, organization: &str) -> AppResult<String> {
    prepare_for_send_worker(store, organization, true).await.map(|(pending, _)| pending.id)
}

async fn confirm_sent_worker(
    store: &LocalStore,
    origin: LocalTransferOrigin,
    expected: Pending,
    revision: u64,
) -> AppResult<()> {
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _local = owned.lock()?;
        origin.require_unchanged(&owned)?;
        if load(&owned)?.pending.as_ref() != Some(&expected) {
            return Err(invalid("L’envoi local a changé. Relancez la synchronisation."));
        }
        if revision <= expected.base_revision {
            return Err(invalid("La confirmation du serveur est incohérente."));
        }
        require_archive_content(&file_path(&owned, &expected.id)?, &expected.manifest,
            "L’envoi local a été modifié. Vos données originales sont conservées.")?;
        confirm_sent(&owned, &expected.id, revision)
    })
    .await
    .map_err(|_| invalid("La confirmation de l’envoi a été interrompue. Elle reprendra automatiquement."))?
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PublicationRecovery {
    Unknown,
    Pending,
    Committed(u64),
    Cancelled,
}

fn invalid_publication_recovery() -> AppError {
    invalid("La confirmation de l’envoi est invalide. Vos données sont conservées.")
}

/// A failed operation's historical result describes another head, never an
/// acknowledgement of this pending archive. Revision zero alone has no ID.
fn valid_cancelled_publication(response: &Value, pending: &Pending) -> bool {
    let Some(revision) = response["revision"].as_u64() else { return false; };
    let Some(snapshot) = response.get("snapshotId") else { return false; };
    if revision < pending.base_revision || revision > 9_007_199_254_740_991 {
        return false;
    }
    if revision == 0 {
        return snapshot.is_null();
    }
    snapshot.as_str().is_some_and(|id| {
        id != pending.id.as_str() && crate::cloud_backup::validate_id(id).is_ok()
    })
}

fn recovered_publication_revision(response: &Value, pending: &Pending) -> AppResult<u64> {
    let revision = response["revision"].as_u64();
    if response["snapshotId"].as_str() != Some(pending.id.as_str())
        || revision.is_none()
        || revision != pending.base_revision.checked_add(1)
        || revision.is_some_and(|value| value > 9_007_199_254_740_991)
    {
        return Err(invalid_publication_recovery());
    }
    revision.ok_or_else(invalid_publication_recovery)
}

/// Closed receipt-only response. Only the historical successor of this exact
/// pending publication can acknowledge its bytes and original clock.
fn publication_recovery_response(response: &Value, pending: &Pending) -> AppResult<PublicationRecovery> {
    let object = response.as_object()
        .ok_or_else(invalid_publication_recovery)?;
    if object.len() == 1 && response["known"] == false {
        return Ok(PublicationRecovery::Unknown);
    }
    if object.len() == 2 && response["known"] == true && response["pending"] == true {
        return Ok(PublicationRecovery::Pending);
    }
    if object.len() == 4 && response["known"] == true {
        if response["committed"] == true {
            return recovered_publication_revision(response, pending).map(PublicationRecovery::Committed);
        }
        if response["committed"] == false && valid_cancelled_publication(response, pending) {
            return Ok(PublicationRecovery::Cancelled);
        }
    }
    Err(invalid_publication_recovery())
}

async fn require_pending_recovery_origin(
    store: &LocalStore,
    origin: LocalTransferOrigin,
    pending: Pending,
    verify_archive: bool,
) -> AppResult<()> {
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let _local = owned.lock()?;
        origin.require_unchanged(&owned)?;
        if load(&owned)?.pending.as_ref() != Some(&pending) {
            return Err(invalid("L’envoi local a changé. Relancez la synchronisation."));
        }
        if verify_archive {
            require_archive_content(&file_path(&owned, &pending.id)?, &pending.manifest,
                "L’envoi local a été modifié. Vos données originales sont conservées.")?;
        }
        Ok(())
    }).await.map_err(|_| invalid("La vérification de l’envoi a été interrompue. Elle reprendra automatiquement."))?
}

/// Probe before any merge. A known pending server operation resumes only the
/// existing commit ID, without prepare/upload/new ID. No operation is closed
/// here. The caller holds the account operation lock across every await.
/// True means that preferences and the server head must be read again; a
/// cancelled/conflicting result preserves all local evidence just like unknown.
async fn recover_pending_publication_with<F, Fut>(
    store: &LocalStore,
    organization: &str,
    mut transport: F,
) -> AppResult<bool>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    let owned = store.clone();
    let organization = organization.to_owned();
    let captured = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        let _local = owned.lock()?;
        let prefs = load(&owned)?;
        let Some(pending) = prefs.pending else { return Ok(None); };
        let origin = LocalTransferOrigin::capture(&owned, &organization)?;
        origin.require_unchanged(&owned)?;
        Ok(Some((pending, origin)))
    }).await.map_err(|_| invalid("La vérification de l’envoi a été interrompue. Elle reprendra automatiquement."))??;
    let Some((pending, origin)) = captured else { return Ok(false); };
    let response = transport(json!({
        "action":"recover-publication", "id":pending.id,
        "baseRevision":pending.base_revision, "manifest":pending.manifest,
    })).await?;
    let recovered = publication_recovery_response(&response, &pending)?;
    match recovered {
        PublicationRecovery::Committed(revision) => {
            confirm_sent_worker(store, origin, pending, revision).await?;
            return Ok(true);
        }
        PublicationRecovery::Pending => {
            // Never commit a different account generation, changed pending or
            // damaged local archive after the probe's asynchronous boundary.
            require_pending_recovery_origin(store, origin.clone(), pending.clone(), true).await?;
            let result = transport(json!({"action":"commit","id":pending.id})).await?;
            let object = result.as_object().ok_or_else(invalid_publication_recovery)?;
            if object.len() == 3 && result["committed"] == true {
                let revision = recovered_publication_revision(&result, &pending)?;
                confirm_sent_worker(store, origin, pending, revision).await?;
                return Ok(true);
            }
            if object.len() != 4 || result["committed"] != false
                || result["conflict"] != true || !valid_cancelled_publication(&result, &pending)
            {
                return Err(invalid_publication_recovery());
            }
        }
        PublicationRecovery::Unknown | PublicationRecovery::Cancelled => {}
    }
    // Even a negative reply cannot let a caller resume an obsolete company's
    // merge after its account generation or durable pending state changed.
    require_pending_recovery_origin(store, origin, pending, false).await?;
    Ok(recovered != PublicationRecovery::Unknown)
}

fn confirm_sent(store: &LocalStore, id: &str, revision: u64) -> AppResult<()> {
    let mut prefs = load(store)?;
    let p = prefs
        .pending
        .as_ref()
        .filter(|p| p.id == id)
        .ok_or_else(|| invalid("L’envoi local a changé. Relancez la synchronisation."))?;
    if revision <= p.base_revision {
        return Err(invalid("La confirmation du serveur est incohérente."));
    }
    crate::action_engine_quote_publication::mark_published(store,
        prefs.organization_id.as_deref().ok_or_else(|| invalid("Entreprise de publication absente."))?,
        id, p.base_revision, &p.manifest, revision)?;
    remember_reference(
        store,
        &file_path(store, id)?,
        prefs
            .organization_id
            .as_deref()
            .ok_or_else(|| invalid("Entreprise de référence absente."))?,
        revision,
    )?;
    prefs.base_clock = p.clock;
    prefs.revision = revision;
    prefs.pending = None;
    prefs.conflict = false;
    prefs.conflict_reason = None;
    prefs.last_synced_at = Some(now_iso());
    save(store, &prefs)?;
    let _ = clean_transport_copies(store);
    Ok(())
}
async fn send(
    store: &LocalStore,
    session: &ProjectSyncSession,
    activate: bool,
    supports_content: bool,
) -> AppResult<bool> {
    send_with_origin(store, session, activate, supports_content, None).await
}

struct PublicationUploadRequest {
    method: Method,
    query: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

async fn publication_upload(session: &ProjectSyncSession, packet: PublicationUploadRequest) -> AppResult<Value> {
    let query = packet.query.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect::<Vec<_>>();
    let is_upload = packet.method == Method::PUT;
    let headers = if is_upload { Vec::new() } else { vec![("Content-Type", "application/json".into())] };
    let (_, bytes) = session.request(packet.method, PATH, &query, &headers, packet.body, false).await?;
    if is_upload { Ok(Value::Null) } else { Ok(serde_json::from_slice(&bytes)?) }
}

async fn send_with_origin(
    store: &LocalStore,
    session: &ProjectSyncSession,
    activate: bool,
    supports_content: bool,
    origin: Option<LocalTransferOrigin>,
) -> AppResult<bool> {
    send_with(store, &session.organization_id, activate, supports_content, origin, None,
        |packet| publication_upload(session, packet),
        |id| async move {
            let current = project_sync_session(store).await?
                .ok_or_else(|| invalid("Reconnectez votre compte pour terminer l’envoi."))?;
            if current.organization_id != session.organization_id {
                return Err(invalid("Le compte a changé pendant l’envoi."));
            }
            request(&current,Method::POST,&[],Some(json!({"action":"commit","id":id}))).await
        }).await
}

/// The exact existing prepare/upload/commit pipeline, with only its HTTP edge
/// injectable for closed native tests. This is not another transport protocol.
async fn send_with<F, Fut, C, CommitFuture>(
    store: &LocalStore,
    organization: &str,
    activate: bool,
    supports_content: bool,
    expected_origin: Option<LocalTransferOrigin>,
    expected_state: Option<(u64,Option<Pending>)>,
    mut transport: F,
    mut commit: C,
) -> AppResult<bool>
where
    F: FnMut(PublicationUploadRequest) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
    C: FnMut(String) -> CommitFuture,
    CommitFuture: std::future::Future<Output = AppResult<Value>>,
{
    store.require_usable_profile()?;
    let (mut p, origin) = prepare_for_send_origin_worker(store, organization, activate, expected_origin, expected_state).await?;
    require_pending_recovery_origin(store,origin.clone(),p.clone(),false).await?;
    let numbers = crate::shared_numbering::active_series(
        store,
        chrono::Datelike::year(&chrono::Local::now()) as i64,
    )?
    .map(|(_, series)| {
        series
            .into_iter()
            .map(|((year, prefix), minimum)| json!({"year":year,"prefix":prefix,"minimum":minimum}))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    if p.content_version == 2 {
        p.content_version = u8::from(supports_content);
        let mut prefs = load(store)?;
        prefs.pending = Some(p.clone());
        save(store, &prefs)?;
    }
    let cache = crate::company_content::directory(&store.data_dir, organization)?;
    let entries = if p.content_version == 1 {
        let path = file_path(store, &p.id)?;
        let directory = cache.clone();
        let parts = tauri::async_runtime::spawn_blocking(move || {
            crate::company_content::prepare(&path, &directory)
        })
        .await
        .map_err(|_| invalid("La préparation reprendra automatiquement."))??;
        crate::company_content::validate(&parts, &p.manifest)?;
        Some(parts)
    } else {
        None
    };
    require_pending_recovery_origin(store,origin.clone(),p.clone(),true).await?;
    let response=transport(PublicationUploadRequest { method:Method::POST,query:Vec::new(),body:Some(serde_json::to_vec(&json!({"action":if entries.is_some(){"prepare-content"}else{"prepare"},"entries":entries,"id":p.id,"baseRevision":p.base_revision,"manifest":p.manifest,"confirmFullAccess":activate,"numbers":numbers}))?) }).await;
    require_pending_recovery_origin(store,origin.clone(),p.clone(),false).await?;
    let response=response?;
    if response["conflict"] == true {
        let mut prefs = load(store)?;
        prefs.conflict = true;
        save(store, &prefs)?;
        return Ok(false);
    }
    if let Some(revision) = response["revision"].as_u64() {
        confirm_sent_worker(store, origin, p, revision).await?;
        return Ok(true);
    }
    if let Some(parts) = &entries {
        let missing = response["missing"]
            .as_array()
            .ok_or_else(|| invalid("La liste des changements reçus est invalide."))?;
        let mut sent = std::collections::HashSet::new();
        for value in missing {
            let hash = value
                .as_str()
                .ok_or_else(|| invalid("Référence de changement invalide."))?;
            let part = parts
                .iter()
                .find(|p| p.sha256 == hash)
                .ok_or_else(|| invalid("Le serveur demande un changement inconnu."))?;
            if !sent.insert(hash) {
                continue;
            }
            let bytes = crate::company_content::cached(&cache, part)?
                .ok_or_else(|| invalid("Le cache d’envoi doit être préparé à nouveau."))?;
            let uploaded=transport(PublicationUploadRequest {method:Method::PUT,
                query:vec![("id".into(),p.id.clone()),("blob".into(),hash.to_owned())],body:Some(bytes)}).await;
            require_pending_recovery_origin(store,origin.clone(),p.clone(),false).await?;
            uploaded?;
        }
    } else {
        let received = response["received"]
            .as_array()
            .ok_or_else(|| invalid("La liste des documents reçus est invalide."))?;
        let mut file = File::open(file_path(store, &p.id)?)?;
        for (index, part) in p.manifest.chunks.iter().enumerate() {
            let mut bytes = vec![0; part.size_bytes as usize];
            file.read_exact(&mut bytes)?;
            if format!("{:x}", Sha256::digest(&bytes)) != part.sha256 {
                return Err(invalid(
                    "L’envoi local a été modifié. Vos données originales sont conservées.",
                ));
            }
            if received.iter().any(|v| v.as_u64() == Some(index as u64)) {
                continue;
            }
            let uploaded=transport(PublicationUploadRequest {method:Method::PUT,
                query:vec![("id".into(),p.id.clone()),("index".into(),index.to_string())],body:Some(bytes)}).await;
            require_pending_recovery_origin(store,origin.clone(),p.clone(),false).await?;
            uploaded?;
        }
    }
    require_pending_recovery_origin(store,origin.clone(),p.clone(),true).await?;
    let result = commit(p.id.clone()).await;
    require_pending_recovery_origin(store,origin.clone(),p.clone(),false).await?;
    let result = result?;
    if result["committed"] == true && result["snapshotId"].as_str() == Some(&p.id) {
        confirm_sent_worker(
            store,
            origin,
            p,
            result["revision"]
                .as_u64()
                .ok_or_else(|| invalid("La confirmation de version est invalide."))?,
        ).await?;
        let _ = crate::company_content::trim(&cache);
        return Ok(true);
    }
    if result["conflict"] == true {
        let mut prefs = load(store)?;
        prefs.conflict = true;
        save(store, &prefs)?;
        return Ok(false);
    }
    Err(invalid(
        "L’envoi n’a pas encore été confirmé. Il reprendra automatiquement.",
    ))
}

#[derive(Clone)]
struct ActionPublicationOrigin {
    local: LocalTransferOrigin,
    user_id: String,
    role: String,
    installation_id: String,
}

fn action_publication_identity(store: &LocalStore, organization: &str, role: &str) -> AppResult<String> {
    if !matches!(role,"owner"|"admin"|"accountant"|"member") {
        return Err(invalid("Ce compte ne peut pas publier un brouillon Automation."));
    }
    let identity: Option<(String,String,String)> = store.connect()?.query_row(
        "SELECT organization_id,user_id,role FROM company_local_identity WHERE id=1",[],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
    let Some((bound,user,current_role))=identity else { return Err(invalid("Reconnectez votre compte avant de publier ce brouillon.")); };
    if bound!=organization || current_role!=role || user.is_empty() || user.len()>160 || user.chars().any(char::is_control) {
        return Err(invalid("Le compte ou ses droits ont changé. Ce brouillon reste conservé."));
    }
    crate::cloud_backup::validate_id(&store.installation_id)?;
    Ok(user)
}

async fn action_publication_state_worker(
    store: &LocalStore, organization: &str, role: &str,
    expected: Option<ActionPublicationOrigin>, allow_pending: bool,
) -> AppResult<(ActionPublicationOrigin,Preferences)> {
    let owned=store.clone();
    let organization=organization.to_owned();
    let role=role.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _local=owned.lock()?;
        let user=action_publication_identity(&owned,&organization,&role)?;
        let origin=match expected {
            Some(origin) => {
                origin.local.require_unchanged(&owned)?;
                if origin.user_id!=user || origin.role!=role || origin.installation_id!=owned.installation_id {
                    return Err(invalid("Le contexte du brouillon Automation a changé. Vos données sont conservées."));
                }
                origin
            },
            None => ActionPublicationOrigin {local:LocalTransferOrigin::capture(&owned,&organization)?,
                user_id:user,role,installation_id:owned.installation_id.clone()},
        };
        origin.local.require_unchanged(&owned)?;
        let prefs=load(&owned)?;
        // Enabled is represented by this exact binding, never inferred from an
        // account, a server head or an earlier consent on another workspace.
        if prefs.organization_id.as_deref()!=Some(organization.as_str()) || prefs.conflict || prefs.received.is_some()
            || prefs.base_clock<0 || (!allow_pending && prefs.pending.is_some()) {
            return Err(invalid("Terminez la synchronisation de cette entreprise avant de continuer ce brouillon Automation. Vos données sont conservées."));
        }
        Ok((origin,prefs))
    }).await.map_err(|_| invalid("La vérification de l’envoi Automation a été interrompue."))?
}

async fn action_publication_upload_with<F,Fut>(
    store:&LocalStore, origin:&ActionPublicationOrigin,
    transport:&Mutex<F>, packet:PublicationUploadRequest,
) -> AppResult<Value>
where F:FnMut(PublicationUploadRequest)->Fut+Send,
    Fut:std::future::Future<Output=AppResult<Value>>+Send,
{
    action_publication_state_worker(store,&origin.local.organization,&origin.role,Some(origin.clone()),true).await?;
    let future={
        let mut transport=transport.lock().map_err(|_| invalid("L’envoi Automation est indisponible."))?;
        transport(packet)
    };
    let outcome=future.await;
    // Even a failed transport must not return into an obsolete workspace.
    action_publication_state_worker(store,&origin.local.organization,&origin.role,Some(origin.clone()),true).await?;
    outcome
}

async fn action_publication_transport(store:&LocalStore,session:&ProjectSyncSession,packet:PublicationUploadRequest)->AppResult<Value> {
    let is_commit=packet.method==Method::POST && packet.body.as_deref().map(serde_json::from_slice::<Value>).transpose()?
        .is_some_and(|value| value["action"]=="commit");
    if is_commit {
        let current=project_sync_session(store).await?.ok_or_else(|| invalid("Reconnectez votre compte pour terminer l’envoi."))?;
        if current.organization_id!=session.organization_id || current.role!=session.role {
            return Err(invalid("Le compte ou ses droits ont changé pendant l’envoi."));
        }
        publication_upload(&current,packet).await
    } else { publication_upload(session,packet).await }
}

/// Private consumer only: its caller already holds the account operation lock
/// (including cancellation-safe worker lifetime) and corroborates its original
/// remote admission stamp before/after this helper. No State/IPC or nested lock.
/// This helper never enables sharing, accepts a remote branch or merges data.
pub(crate) async fn recover_action_engine_publication(store:&LocalStore,session:&ProjectSyncSession)->AppResult<()> {
    let _transfer=crate::cloud_backup::TransferGuard::take()?;
    let _sync=crate::project_sync::pause_for_workspace_change()?;
    recover_action_engine_publication_with(store,&session.organization_id,&session.role,
        |packet| action_publication_transport(store,session,packet)).await
}

async fn recover_action_engine_publication_with<F,Fut>(store:&LocalStore,organization:&str,role:&str,transport:F)->AppResult<()>
where F:FnMut(PublicationUploadRequest)->Fut+Send,
    Fut:std::future::Future<Output=AppResult<Value>>+Send,
{
    let (origin,prefs)=action_publication_state_worker(store,organization,role,None,true).await?;
    let Some(original)=prefs.pending else { return Ok(()); };
    if original.base_revision>9_007_199_254_740_990 || prefs.revision>9_007_199_254_740_991 {
        return Err(invalid("La version de l’ancien envoi est invalide. Vos données sont conservées."));
    }
    let transport=Mutex::new(transport);
    let outcome=recover_pending_publication_with(store,organization,|body| {
        action_publication_upload_with(store,&origin,&transport,PublicationUploadRequest {
            method:Method::POST,query:Vec::new(),body:Some(body.to_string().into_bytes()),
        })
    }).await;
    let (_,current)=action_publication_state_worker(store,organization,role,Some(origin.clone()),true).await?;
    let known=outcome?;
    if current.pending.is_none() { return Ok(()); }
    // Cancelled/known-but-unresolved receipts require explicit review. Unknown
    // means a crash may precede prepare: resume this same archive only when its
    // original base is still the actual server head, never replace its ID.
    if known || current.pending.as_ref()!=Some(&original) {
        return Err(invalid("L’ancien envoi doit être vérifié avant de préparer un nouveau devis. Vos données sont conservées."));
    }
    let head=action_publication_upload_with(store,&origin,&transport,PublicationUploadRequest {
        method:Method::GET,query:Vec::new(),body:None,
    }).await?;
    if head["organizationId"].as_str()!=Some(organization) || head["revision"].as_u64()!=Some(original.base_revision) {
        return Err(invalid("L’équipe a enregistré une autre version. Vérifiez la synchronisation avant ce brouillon."));
    }
    let sent=send_with(store,organization,false,head["contentTransfer"]==1,Some(origin.local.clone()),Some((original.base_revision,Some(original))),
        |packet| action_publication_upload_with(store,&origin,&transport,packet),
        |id| action_publication_upload_with(store,&origin,&transport,PublicationUploadRequest {
            method:Method::POST,query:Vec::new(),body:Some(json!({"action":"commit","id":id}).to_string().into_bytes()),
        })).await;
    action_publication_state_worker(store,organization,role,Some(origin),false).await?;
    if !sent? { return Err(invalid("L’ancien envoi est en conflit. Vos données sont conservées.")); }
    Ok(())
}

/// Publish only after the private consumer has recovered candidates and made
/// its exact draft commit. A preexisting pending is never uploaded here; the
/// separate recovery helper must resolve it BEFORE any new business write.
pub(crate) async fn publish_action_engine_quote(store:&LocalStore,session:&ProjectSyncSession)->AppResult<()> {
    let _transfer=crate::cloud_backup::TransferGuard::take()?;
    let _sync=crate::project_sync::pause_for_workspace_change()?;
    publish_action_engine_quote_with(store,&session.organization_id,&session.role,
        |packet| action_publication_transport(store,session,packet)).await
}

async fn publish_action_engine_quote_with<F,Fut>(store:&LocalStore,organization:&str,role:&str,transport:F)->AppResult<()>
where F:FnMut(PublicationUploadRequest)->Fut+Send,
    Fut:std::future::Future<Output=AppResult<Value>>+Send,
{
    let (origin,prefs)=action_publication_state_worker(store,organization,role,None,false).await?;
    let transport=Mutex::new(transport);
    let head=action_publication_upload_with(store,&origin,&transport,PublicationUploadRequest {
        method:Method::GET,query:Vec::new(),body:None,
    }).await?;
    if head["organizationId"].as_str()!=Some(organization) || head["revision"].as_u64()!=Some(prefs.revision)
        || prefs.revision>9_007_199_254_740_990 {
        return Err(invalid("La version partagée a changé. Vérifiez la synchronisation avant de publier ce brouillon."));
    }
    let (_,current)=action_publication_state_worker(store,organization,role,Some(origin.clone()),false).await?;
    if current.revision!=prefs.revision { return Err(invalid("La version de référence a changé. Vos données sont conservées.")); }
    let sent=send_with(store,organization,false,head["contentTransfer"]==1,Some(origin.local.clone()),Some((prefs.revision,None)),
        |packet| action_publication_upload_with(store,&origin,&transport,packet),
        |id| action_publication_upload_with(store,&origin,&transport,PublicationUploadRequest {
            method:Method::POST,query:Vec::new(),body:Some(json!({"action":"commit","id":id}).to_string().into_bytes()),
        })).await;
    action_publication_state_worker(store,organization,role,Some(origin),false).await?;
    if !sent? { return Err(invalid("La publication est en conflit. Vos données sont conservées.")); }
    Ok(())
}

#[cfg(test)]
#[path = "company_collaboration_reference_worker_tests.rs"]
mod reference_worker_tests;

#[cfg(test)]
#[path = "company_collaboration_publication_recovery_tests.rs"]
mod publication_recovery_tests;

#[cfg(test)]
#[path = "company_collaboration_action_execution_tests.rs"]
mod action_execution_tests;

#[cfg(test)]
#[path = "company_collaboration_content_version_compat_tests.rs"]
mod content_version_compat_tests;

#[cfg(test)]
#[path = "company_collaboration_merge_version_compat_tests.rs"]
mod merge_version_compat_tests;

fn cached_download(
    store: &LocalStore,
    id: &str,
    manifest: &crate::cloud_backup::Manifest,
) -> AppResult<Option<PathBuf>> {
    crate::cloud_backup::validate_id(id)?;
    manifest.validate()?;
    let path = file_path(store, id)?;
    if path.is_file() && same_archive_content(&crate::cloud_backup::file_manifest(&path)?, manifest) {
        return Ok(Some(path));
    }
    Ok(None)
}
async fn download(
    store: &LocalStore,
    session: &ProjectSyncSession,
    head: &Value,
) -> AppResult<PathBuf> {
    checked_head(session, head)?;
    let id = head["snapshotId"]
        .as_str()
        .ok_or_else(|| invalid("Le titulaire doit terminer le premier partage de l’entreprise."))?;
    crate::cloud_backup::validate_id(id)?;
    let manifest: crate::cloud_backup::Manifest = serde_json::from_value(head["manifest"].clone())?;
    manifest.validate()?;
    let path = file_path(store, id)?;
    if let Some(cached) = cached_download(store, id, &manifest)? {
        return Ok(cached);
    }
    if head["contentVersion"] == 1 {
        return download_content(store, session, id, &path, &manifest).await;
    }
    let mut file = tempfile::Builder::new()
        .prefix(".receive-")
        .tempfile_in(folder(store)?)?;
    let mut hash = Sha256::new();
    for (index, part) in manifest.chunks.iter().enumerate() {
        let (_, bytes) = session
            .request(
                Method::GET,
                PATH,
                &[("id", id), ("index", &index.to_string())],
                &[],
                None,
                true,
            )
            .await?;
        if bytes.len() as u64 != part.size_bytes
            || format!("{:x}", Sha256::digest(&bytes)) != part.sha256
        {
            return Err(invalid(
                "Un document reçu est incomplet. Vos données sont conservées.",
            ));
        }
        hash.update(&bytes);
        file.write_all(&bytes)?;
    }
    if format!("{:x}", hash.finalize()) != manifest.sha256 {
        return Err(invalid(
            "La copie de l’entreprise est incomplète. Aucune donnée n’a été modifiée.",
        ));
    }
    file.as_file().sync_all()?;
    file.persist(&path).map_err(|e| AppError::Io(e.error))?;
    if head["contentTransfer"] == 1 {
        let cache = crate::company_content::directory(&store.data_dir, &session.organization_id)?;
        let copy = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::company_content::prepare(&copy, &cache)?;
            crate::company_content::trim(&cache)
        })
        .await
        .map_err(|_| invalid("La préparation du cache a été interrompue."))??;
    }
    Ok(path)
}
async fn download_content(
    store: &LocalStore,
    session: &ProjectSyncSession,
    id: &str,
    path: &Path,
    manifest: &crate::cloud_backup::Manifest,
) -> AppResult<PathBuf> {
    let value = request(session, Method::GET, &[("id", id), ("content", "1")], None).await?;
    let parts: Vec<crate::cloud_backup::Chunk> = serde_json::from_value(value["entries"].clone())?;
    download_content_with(store, &session.organization_id, path, manifest, parts,
        |part: crate::cloud_backup::Chunk| async move {
            let (_, bytes) = session.request(Method::GET, PATH,
                &[("id", id), ("blob", &part.sha256)], &[], None, true).await?;
            Ok(bytes)
        }).await
}

/// The production reconstruction is shared with closed transport witnesses.
/// Only fetching a missing fragment is injected; every byte still passes the
/// real cache verification, write, fsync and complete manifest check.
async fn download_content_with<F, Fut>(
    store: &LocalStore,
    organization: &str,
    path: &Path,
    manifest: &crate::cloud_backup::Manifest,
    parts: Vec<crate::cloud_backup::Chunk>,
    mut fetch: F,
) -> AppResult<PathBuf>
where
    F: FnMut(crate::cloud_backup::Chunk) -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<u8>>>,
{
    manifest.validate()?;
    crate::company_content::validate(&parts, manifest)?;
    let cache = crate::company_content::directory(&store.data_dir, organization)?;
    // Upgrade an old installation without re-downloading unchanged attachments.
    if fs::read_dir(&cache)?.next().is_none() {
        let reference = store.data_dir.join("company-sync-reference.zentra");
        if reference.is_file() {
            let directory = cache.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::company_content::prepare(&reference, &directory)
            })
            .await
            .map_err(|_| invalid("La préparation du cache a été interrompue."))??;
        }
    }
    let mut file = tempfile::Builder::new()
        .prefix(".receive-content-")
        .tempfile_in(folder(store)?)?;
    for part in &parts {
        let bytes = match crate::company_content::cached(&cache, part)? {
            Some(bytes) => bytes,
            None => {
                let bytes = fetch(part.clone()).await?;
                crate::company_content::put(&cache, part, &bytes)?;
                bytes
            }
        };
        file.write_all(&bytes)?;
    }
    file.as_file().sync_all()?;
    require_archive_content(file.path(), manifest,
        "La copie de l’entreprise est incomplète. Aucune donnée n’a été modifiée.")?;
    file.persist(path).map_err(|e| AppError::Io(e.error))?;
    let _ = crate::company_content::trim(&cache);
    Ok(path.to_owned())
}
const PRIVATE_ROWS: &[&str] = &[
    "company_local_identity",
    // Restore this AFTER identity: its insert/delete triggers rotate the nonce.
    "company_local_member_context",
    "company_local_notes_scope",
    "company_local_action_engine_quote_outbox",
    "company_local_action_engine_quote_publications",
    "company_local_action_engine_quote_confirmations",
    "device_number_ranges",
    "active_timers",
    "project_sync_binding",
    "project_document_sync",
];
fn private_rows(store: &LocalStore) -> AppResult<Vec<(String, Vec<Value>)>> {
    let db = store.connect()?;
    PRIVATE_ROWS
        .iter()
        .map(|name| {
            Ok((
                name.to_string(),
                query_all(&db, &format!("SELECT * FROM {name}"), [])?,
            ))
        })
        .collect()
}
fn restore_private(store: &LocalStore, rows: &[(String, Vec<Value>)]) -> AppResult<()> {
    let mut db = store.connect()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut confirmed_action_outboxes = Vec::new();
    // Children first on delete, parents first on insert. Publication links own
    // an FK to the outbox and cannot survive a parent DELETE/INSERT interleave.
    for (table, _) in rows.iter().rev() {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    for (table, rows) in rows {
        // Identity triggers may have generated a new nonce during the first
        // pass. Restore this installation's saved nonce only after identity.
        if table == "company_local_member_context" { tx.execute(&format!("DELETE FROM {table}"), [])?; }
        for row in rows {
            let mut object = row
                .as_object()
                .ok_or_else(|| invalid("Données privées illisibles."))?.clone();
            // A first confirmation INSERT always requires pending/uncertain.
            // Restore its exact historical marker before the terminal outbox
            // state, without weakening that global SQL guard. Old confirmed
            // rows without a marker remain ambiguous and cannot release pins.
            if table == "company_local_action_engine_quote_outbox" && object.get("state").and_then(Value::as_str) == Some("confirmed") {
                confirmed_action_outboxes.push((
                    object.get("organization_id").and_then(Value::as_str).ok_or_else(|| invalid("Entreprise privée invalide."))?.to_owned(),
                    object.get("proposal_id").and_then(Value::as_str).ok_or_else(|| invalid("Proposition privée invalide."))?.to_owned(),
                ));
                object.insert("state".into(), Value::String("pending".into()));
            }
            // Public inserts must begin unacknowledged. Restore a published
            // private link via its same guarded transition, in this transaction.
            let published = if table == "company_local_action_engine_quote_publications" {
                let revision = object.get("published_revision").cloned().unwrap_or(Value::Null);
                let at = object.get("published_at").cloned().unwrap_or(Value::Null);
                object.insert("published_revision".into(), Value::Null);
                object.insert("published_at".into(), Value::Null);
                Some((revision, at))
            } else { None };
            let columns = object
                .keys()
                .map(|s| format!("\"{s}\""))
                .collect::<Vec<_>>()
                .join(",");
            let values = object
                .values()
                .map(|v| match v {
                    Value::Null => Ok(rusqlite::types::Value::Null),
                    Value::String(s) => Ok(rusqlite::types::Value::Text(s.clone())),
                    Value::Number(n) => n
                        .as_i64()
                        .map(rusqlite::types::Value::Integer)
                        .ok_or_else(|| invalid("Valeur privée invalide.")),
                    _ => Err(invalid("Valeur privée invalide.")),
                })
                .collect::<AppResult<Vec<_>>>()?;
            tx.execute(
                &format!(
                    "INSERT INTO {table} ({columns}) VALUES ({})",
                    vec!["?"; values.len()].join(",")
                ),
                rusqlite::params_from_iter(values),
            )?;
            if let Some((revision, at)) = published {
                if !revision.is_null() {
                    tx.execute("UPDATE company_local_action_engine_quote_publications SET published_revision=?,published_at=?
                        WHERE organization_id=? AND proposal_id=? AND snapshot_id=?",
                        params![revision.as_i64().ok_or_else(|| invalid("Révision privée invalide."))?,
                            at.as_str().ok_or_else(|| invalid("Date privée invalide."))?,
                            object["organization_id"].as_str().ok_or_else(|| invalid("Entreprise privée invalide."))?,
                            object["proposal_id"].as_str().ok_or_else(|| invalid("Proposition privée invalide."))?,
                            object["snapshot_id"].as_str().ok_or_else(|| invalid("Publication privée invalide."))?])?;
                } else if !at.is_null() { return Err(invalid("Publication privée incohérente.")); }
            }
        }
    }
    for (organization, proposal) in confirmed_action_outboxes {
        let changed = tx.execute("UPDATE company_local_action_engine_quote_outbox SET state='confirmed' WHERE organization_id=? AND proposal_id=? AND state='pending'",
            params![organization,proposal])?;
        if changed != 1 { return Err(invalid("Reprise privée incohérente.")); }
    }
    crate::work_notes::ensure_workspace_scope(&tx)?;
    // Ordinary receives restore the saved nonce after identity. Opening another
    // company intentionally restores no nonce row and starts a fresh context.
    crate::member_context::ensure(&tx)?;
    tx.commit()?;
    Ok(())
}
fn action_receipts(store: &LocalStore) -> AppResult<Vec<Value>> {
    query_all(&store.connect()?, "SELECT * FROM action_engine_quote_receipts", [])
}
/// A received branch may not erase a committed creation fact, including when
/// the user chooses the remote branch. Keep its local outbox and recovery copy;
/// do not recreate the document or declare an uncertain commit unpublished.
fn require_action_receipts_preserved(store: &LocalStore, expected: &[Value]) -> AppResult<()> {
    let db = store.connect()?;
    for receipt in expected {
        let key = |field: &str| receipt.get(field).and_then(Value::as_str)
            .ok_or_else(|| invalid("Le reçu Automation local doit être vérifié. Vos données sont conservées."));
        let current = query_all(&db,
            "SELECT * FROM action_engine_quote_receipts WHERE organization_id=? AND source_id=? AND action_kind=?",
            params![key("organization_id")?, key("source_id")?, key("action_kind")?])?;
        if current.as_slice() != std::slice::from_ref(receipt) {
            return Err(invalid("Cette copie ne contient pas le même devis préparé par Automation. Vos données sont conservées. Réunissez les changements avant de remplacer la copie locale."));
        }
    }
    Ok(())
}
fn apply(
    store: &LocalStore,
    path: &Path,
    organization: &str,
    revision: u64,
    expected_clock: i64,
    joining: bool,
    accept_remote: bool,
) -> AppResult<()> {
    let _lock = store.lock()?;
    let _gate = WriteGate::take(store)?;
    let mut prefs = load(store)?;
    if clock(store)? != expected_clock {
        return Err(invalid("Vous avez enregistré une modification pendant le téléchargement. Elle est conservée ; la synchronisation va la vérifier."));
    }
    if joining {
        crate::cloud_backup::require_empty_company(store)?;
    }
    if !joining && !accept_remote && (prefs.pending.is_some() || prefs.base_clock != expected_clock)
    {
        return Err(invalid(
            "Des modifications locales doivent être envoyées avant de recevoir celles de l’équipe.",
        ));
    }
    let mut private = private_rows(store)?;
    let action_receipts = action_receipts(store)?;
    if joining {
        for (table, rows) in &mut private {
            if table == "company_local_notes_scope" || table == "company_local_action_engine_quote_outbox"
                || table == "company_local_action_engine_quote_publications"
                || table == "company_local_action_engine_quote_confirmations" { rows.clear(); }
        }
    }
    // Keep a named recovery copy before an explicit conflict decision. Ordinary
    // receiving uses checked restoration with rollback of the data swap.
    if accept_remote {
        store.create_backup(None, env!("CARGO_PKG_VERSION"))?;
    }
    prefs.organization_id = Some(organization.into());
    prefs.revision = revision;
    prefs.pending = None;
    prefs.received = None;
    prefs.conflict = false;
    prefs.last_synced_at = Some(now_iso());
    store.restore_company_snapshot(&path.to_string_lossy(), || {
        require_action_receipts_preserved(store, &action_receipts)?;
        restore_private(store, &private)?;
        crate::backup::validate_database(&store.database_path)?;
        prefs.base_clock = clock(store)?;
        remember_reference(store, path, organization, revision)?;
        save(store, &prefs)
    })?;
    let _ = clean_transport_copies(store);
    Ok(())
}

pub(crate) async fn join(store: &LocalStore) -> AppResult<bool> {
    let session = project_sync_session(store)
        .await?
        .ok_or_else(|| invalid("Reconnectez-vous avec l’adresse invitée."))?;
    let head = request(&session, Method::GET, &[], None).await?;
    if head["enabled"] != true {
        return Ok(false);
    }
    let revision = checked_head(&session, &head)?;
    let _transfer = crate::cloud_backup::TransferGuard::take()?;
    let _sync = crate::project_sync::pause_for_workspace_change()?;
    crate::cloud_backup::require_empty_company(store)?;
    let expected = clock(store)?;
    let path = download(store, &session, &head).await?;
    let owned = store.clone();
    let organization = session.organization_id;
    tauri::async_runtime::spawn_blocking(move || {
        apply(
            &owned,
            &path,
            &organization,
            revision,
            expected,
            true,
            false,
        )
    })
    .await
    .map_err(|_| invalid("L’ouverture de l’entreprise a été interrompue. Réessayez."))??;
    Ok(true)
}
#[tauri::command]
pub async fn enable_company_sync(
    state: State<'_, LocalStore>,
    confirm_full_access: bool,
) -> Result<Value, String> {
    if !confirm_full_access {
        return Err("Confirmez le partage de toute l’entreprise, y compris les salaires.".into());
    }
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let _transfer = crate::cloud_backup::TransferGuard::take().map_err(command_error)?;
    let _sync = crate::project_sync::pause_for_workspace_change().map_err(command_error)?;
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or("Connectez votre compte pour partager l’entreprise.")?;
    if !["owner", "admin"].contains(&session.role.as_str()) {
        return Err("Seul le titulaire ou un administrateur peut activer le partage.".into());
    }
    let head = request(&session, Method::GET, &[], None)
        .await
        .map_err(command_error)?;
    let revision = checked_head(&session, &head).map_err(command_error)?;
    let prefs = load(&store).map_err(command_error)?;
    if revision > 0 && prefs.organization_id.is_none() {
        return Err("L’entreprise est déjà partagée. Pour la recevoir sur cet appareil, utilisez Rejoindre une entreprise depuis le démarrage.".into());
    }
    if !store
        .app_state(env!("CARGO_PKG_VERSION"))
        .map_err(command_error)?
        .onboarding_completed
    {
        return Err("Terminez la configuration de votre entreprise avant de la partager.".into());
    }
    if !send(&store, &session, true, head["contentTransfer"] == 1)
        .await
        .map_err(command_error)?
    {
        return Err("L’équipe a enregistré des changements. Ouvrez Entreprise partagée pour comparer les versions avant de continuer.".into());
    }
    crate::shared_numbering::replenish_active_series(&store, &session)
        .await
        .map_err(command_error)?;
    status(&store).map_err(command_error)
}
#[tauri::command]
pub async fn sync_company_workspace(
    state: State<'_, LocalStore>,
    receive: bool,
    accept_remote: bool,
    confirmed_duplicate_receipt: Option<crate::company_merge::DuplicateReceipt>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let mut prefs = load(&store).map_err(command_error)?;
    if prefs.organization_id.is_none() {
        return status(&store).map_err(command_error);
    }
    let _transfer = crate::cloud_backup::TransferGuard::take().map_err(command_error)?;
    let _sync = crate::project_sync::pause_for_workspace_change().map_err(command_error)?;
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or("Reconnectez votre compte pour synchroniser l’entreprise.")?;
    if prefs.organization_id.as_deref() != Some(&session.organization_id) {
        return Err("Ces données appartiennent à une autre entreprise. Reconnectez le compte correspondant.".into());
    }
    let known = prefs.revision.to_string();
    let query = if accept_remote {
        vec![]
    } else {
        vec![("after", known.as_str())]
    };
    let mut head = request(&session, Method::GET, &query, None)
        .await
        .map_err(command_error)?;
    let mut revision = checked_head(&session, &head).map_err(command_error)?;
    // The account service has no workspace at all for this organisation (it
    // started empty after a migration) while this device still counts the
    // old revisions. Nothing remote can be lost: share this device's company
    // again as the first version instead of refusing every sync, so the
    // company (and Autopilote's catalogue) is published once more.
    if !accept_remote
        && head["enabled"] == false
        && revision == 0
        && prefs.revision > 0
        && ["owner", "admin"].contains(&session.role.as_str())
    {
        restart_after_empty_server(&store, &session.organization_id).map_err(command_error)?;
        send(&store, &session, true, head["contentTransfer"] == 1)
            .await
            .map_err(command_error)?;
        return status(&store).map_err(command_error);
    }
    // A newer head may include this exact pending snapshot whose ACK was lost.
    // Recover that creation fact before attempting a merge/reference download,
    // especially when the original revision was 0 or transport copies pruned.
    // A denied, unavailable or malformed response never falls through to merge.
    if !accept_remote && session.role != "read_only" && prefs.pending.is_some()
        && recover_pending_publication_with(&store, &session.organization_id, |body| {
            request(&session, Method::POST, &[], Some(body))
        }).await.map_err(command_error)?
    {
        prefs = load(&store).map_err(command_error)?;
        let confirmed = prefs.revision.to_string();
        head = request(&session, Method::GET, &[("after", confirmed.as_str())], None)
            .await.map_err(command_error)?;
        revision = checked_head(&session, &head).map_err(command_error)?;
    }
    let mut changed = false;
    if confirmed_duplicate_receipt.is_some()
        && (session.role == "read_only" || accept_remote || revision <= prefs.revision)
    {
        return Err(
            "Cet encaissement doit être vérifié à nouveau. Aucune saisie n’a été supprimée.".into(),
        );
    }
    if revision < prefs.revision {
        return Err("La version du serveur est antérieure à celle de cet appareil. Contactez le support ; vos données sont conservées.".into());
    }
    // No full archive/digest scan or number-range HTTP requests while idle.
    // Local transaction clocks and the server revision must BOTH be unchanged.
    if !accept_remote
        && head["unchanged"] == true
        && revision == prefs.revision
        && prefs.base_clock >= 0
        && prefs.pending.is_none()
        && prefs.received.is_none()
        && !prefs.conflict
        && clock(&store).map_err(command_error)? == prefs.base_clock
    {
        return status(&store).map_err(command_error);
    }
    if !accept_remote {
        reconcile_idle_device(&store, &session)
            .await
            .map_err(command_error)?;
        prefs = load(&store).map_err(command_error)?;
    }
    if accept_remote && !prefs.conflict {
        return Err("Le conflit a changé. Actualisez avant de choisir une version.".into());
    }
    if prefs.base_clock < 0 && !accept_remote {
        return status(&store).map_err(command_error);
    }
    if revision > prefs.revision
        && !accept_remote
        && (clock(&store).map_err(command_error)? != prefs.base_clock || prefs.pending.is_some())
    {
        let ready = prefs.received.as_ref().is_some_and(|r| {
            r.merge.is_some() && r.revision == revision && clock(&store).ok() == Some(r.clock)
        });
        if !ready {
            let reference = reference_copy(&store, &session, &prefs)
                .await
                .map_err(command_error)?;
            let remote = download(&store, &session, &head)
                .await
                .map_err(command_error)?;
            let owned = store.clone();
            let org = session.organization_id.clone();
            let prepared = tauri::async_runtime::spawn_blocking(move || {
                stage_merge_confirmed(
                    &owned,
                    &reference,
                    &remote,
                    &org,
                    revision,
                    confirmed_duplicate_receipt.as_ref(),
                )
            })
            .await
            .map_err(|_| {
                "La réunion des changements a été interrompue. Elle reprendra automatiquement."
            })?;
            if let Err(reason) = prepared {
                let mut next = load(&store).map_err(command_error)?;
                next.conflict = true;
                next.conflict_reason = Some(match reason {
                    AppError::Validation(message) => message,
                    reason => reason.to_string(),
                });
                save(&store, &next).map_err(command_error)?;
            }
        }
    } else if prefs.pending.is_some() && !accept_remote {
        send(&store, &session, false, head["contentTransfer"] == 1)
            .await
            .map_err(command_error)?;
    } else if revision > prefs.revision || accept_remote {
        if !accept_remote
            && prefs
                .received
                .as_ref()
                .is_some_and(|r| r.revision == revision && r.clock == prefs.base_clock)
            && clock(&store).map_err(command_error)? == prefs.base_clock
        {
            // Already downloaded and verified. Wait for the active form to
            // close, without downloading every attachment again on each wake.
            return status(&store).map_err(command_error);
        }
        if clock(&store).map_err(command_error)? != prefs.base_clock && !accept_remote {
            let mut prefs = prefs;
            prefs.conflict = true;
            save(&store, &prefs).map_err(command_error)?;
        } else {
            let expected = clock(&store).map_err(command_error)?;
            let path = download(&store, &session, &head)
                .await
                .map_err(command_error)?;
            if receive && accept_remote {
                let owned = store.clone();
                let organization = session.organization_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    apply(
                        &owned,
                        &path,
                        &organization,
                        revision,
                        expected,
                        false,
                        true,
                    )
                })
                .await
                .map_err(|_| {
                    "La réception a été interrompue. Vos données locales sont conservées."
                        .to_owned()
                })?
                .map_err(command_error)?;
                changed = true;
            } else {
                let mut next = load(&store).map_err(command_error)?;
                next.received = Some(Received {
                    id: head["snapshotId"].as_str().unwrap().into(),
                    organization: session.organization_id.clone(),
                    revision,
                    clock: expected,
                    manifest: serde_json::from_value(head["manifest"].clone())
                        .map_err(|_| "Manifest reçu illisible.")?,
                    merge: None,
                });
                next.conflict = false;
                next.conflict_reason = None;
                save(&store, &next).map_err(command_error)?;
            }
        }
    } else if clock(&store).map_err(command_error)? != prefs.base_clock
        && session.role != "read_only"
    {
        send(&store, &session, false, head["contentTransfer"] == 1)
            .await
            .map_err(command_error)?;
    }
    crate::shared_numbering::replenish_active_series(&store, &session)
        .await
        .map_err(command_error)?;
    let mut result = status(&store).map_err(command_error)?;
    result["changed"] = json!(changed);
    result["remoteRevision"] = json!(revision);
    Ok(result)
}

fn stage_merge(
    store: &LocalStore,
    reference: &Path,
    remote: &Path,
    organization: &str,
    revision: u64,
) -> AppResult<()> {
    stage_merge_confirmed(store, reference, remote, organization, revision, None)
}
fn stage_merge_confirmed(
    store: &LocalStore,
    reference: &Path,
    remote: &Path,
    organization: &str,
    revision: u64,
    choice: Option<&crate::company_merge::DuplicateReceipt>,
) -> AppResult<()> {
    let work = tempfile::tempdir_in(&store.data_dir)?;
    let local = work.path().join("local.zentra");
    let (expected, digest) = {
        let _lock = store.lock()?;
        let _gate = WriteGate::take(store)?;
        let expected = clock(store)?;
        store.create_backup_at(&local, env!("CARGO_PKG_VERSION"))?;
        (expected, crate::company_sync_digest::archive(&local)?)
    };
    let id = uuid::Uuid::new_v4().to_string();
    let output = file_path(store, &id)?;
    if let Err(reason) =
        crate::company_merge::merge_confirmed(store, reference, &local, remote, &output, choice)
    {
        let candidate = crate::company_merge::duplicate_preview(store, reference, &local, remote)
            .ok()
            .flatten();
        let _lock = store.lock()?;
        let mut prefs = load(store)?;
        if clock(store)? == expected && prefs.organization_id.as_deref() == Some(organization) {
            prefs.duplicate_receipt = candidate;
            save(store, &prefs)?;
        }
        return Err(reason);
    }
    let manifest = crate::cloud_backup::file_manifest(&output)?;
    let _lock = store.lock()?;
    let mut prefs = load(store)?;
    if prefs.organization_id.as_deref() != Some(organization)
        || revision <= prefs.revision
        || clock(store)? != expected
    {
        return Ok(());
    }
    prefs.received = Some(Received {
        id,
        organization: organization.into(),
        revision,
        clock: expected,
        manifest,
        merge: Some(MergeReception {
            local_digest: digest,
            reference_id: remote
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| invalid("Copie reçue inconnue."))?
                .into(),
            reference_manifest: crate::cloud_backup::file_manifest(remote)?,
        }),
    });
    prefs.duplicate_receipt = None;
    prefs.conflict = false;
    prefs.conflict_reason = None;
    save(store, &prefs)
}
fn apply_merged(store: &LocalStore, received: &Received, path: &Path) -> AppResult<()> {
    let _lock = store.lock()?;
    let _gate = WriteGate::take(store)?;
    let m = received
        .merge
        .as_ref()
        .ok_or_else(|| invalid("Réunion des changements absente."))?;
    if clock(store)? != received.clock
        || crate::company_sync_digest::local(store)? != m.local_digest
    {
        return Err(invalid(
            "Votre dernière modification est conservée. Elle sera intégrée au prochain échange.",
        ));
    }
    let reference = file_path(store, &m.reference_id)?;
    require_archive_content(&reference, &m.reference_manifest,
        "La copie de référence reçue a changé. Vos données sont conservées.")?;
    let mut prefs = load(store)?;
    let private = private_rows(store)?;
    let action_receipts = action_receipts(store)?;
    // Recovery copy retains the entire original branch, including its audit chain.
    store.create_backup(None, env!("CARGO_PKG_VERSION"))?;
    store.restore_company_snapshot(&path.to_string_lossy(), || {
        require_action_receipts_preserved(store, &action_receipts)?;
        restore_private(store, &private)?;
        crate::backup::validate_database(&store.database_path)?;
        let id = uuid::Uuid::new_v4().to_string();
        let upload = file_path(store, &id)?;
        store.create_collaboration_backup_at(&upload, env!("CARGO_PKG_VERSION"), &received.organization, &id, received.revision)?;
        let clock = clock(store)?;
        prefs.organization_id = Some(received.organization.clone());
        prefs.revision = received.revision;
        prefs.base_clock = clock;
        prefs.pending = Some(Pending {
            id,
            base_revision: received.revision,
            clock,
            manifest: crate::cloud_backup::file_manifest(&upload)?,
            content_version: 2,
        });
        prefs.received = None;
        prefs.conflict = false;
        prefs.conflict_reason = None;
        remember_reference(store, &reference, &received.organization, received.revision)?;
        save(store, &prefs)?;
        let pending = prefs.pending.as_ref().ok_or_else(|| invalid("Publication réunie absente."))?;
        crate::action_engine_quote_publication::link_prepared(store, &received.organization,
            &pending.id, pending.base_revision, pending.clock, &pending.manifest)
    })?;
    let _ = clean_transport_copies(store);
    Ok(())
}

#[tauri::command]
pub async fn apply_company_update(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let _transfer = crate::cloud_backup::TransferGuard::take().map_err(command_error)?;
    let _sync = crate::project_sync::pause_for_workspace_change().map_err(command_error)?;
    let current = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or("Reconnectez votre compte pour recevoir l’entreprise.")?;
    let p = load(&store).map_err(command_error)?;
    let received = p
        .received
        .ok_or("Aucune modification de l’équipe n’est prête à être reçue.")?;
    if received.organization != current.organization_id
        || p.organization_id.as_deref() != Some(&received.organization)
        || received.revision <= p.revision
    {
        return Err("La version reçue ne correspond plus à votre entreprise.".into());
    }
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = file_path(&owned, &received.id)?;
        require_archive_content(&path, &received.manifest,
            "Les documents reçus ont changé. Relancez la synchronisation.")?;
        if received.merge.is_some() {
            return apply_merged(&owned, &received, &path);
        }
        apply(
            &owned,
            &path,
            &received.organization,
            received.revision,
            received.clock,
            false,
            false,
        )
    })
    .await
    .map_err(|_| "La réception a été interrompue. Réessayez.".to_owned())?
    .map_err(command_error)?;
    let mut result = status(&store).map_err(command_error)?;
    result["changed"] = json!(true);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_draft_scope_survives_same_company_receives_but_not_a_first_join() {
        let dir = tempfile::tempdir().unwrap();
        let sender = LocalStore::initialize(dir.path().join("sender")).unwrap();
        sender.complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION")).unwrap();
        let archive = dir.path().join("shared-company.zentra");
        sender.create_backup_at(&archive, env!("CARGO_PKG_VERSION")).unwrap();
        let receiver = LocalStore::initialize(dir.path().join("receiver")).unwrap();
        let empty_scope = crate::work_notes::workspace_scope(&receiver.connect().unwrap()).unwrap();
        apply(&receiver, &archive, "notes-company", 1, clock(&receiver).unwrap(), true, false).unwrap();
        let company_scope = crate::work_notes::workspace_scope(&receiver.connect().unwrap()).unwrap();
        assert_ne!(company_scope, empty_scope);
        assert_ne!(company_scope, crate::work_notes::workspace_scope(&sender.connect().unwrap()).unwrap());
        apply(&receiver, &archive, "notes-company", 2, clock(&receiver).unwrap(), false, false).unwrap();
        assert_eq!(crate::work_notes::workspace_scope(&receiver.connect().unwrap()).unwrap(), company_scope);
    }
    fn issued(store: &LocalStore, client: &str, title: &str, cents: i64) -> String {
        let invoice=store.create_record("invoices",json!({"client_id":client,"title":title,"service_date_from":"2026-09-15","service_date_to":"2026-09-15"})).unwrap();
        let id = invoice["id"].as_str().unwrap();
        store.create_record("invoice_items",json!({"invoice_id":id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":cents,"vat_bp":0})).unwrap();
        store
            .issue_invoice(id, Some("2026-09-15".into()), None)
            .unwrap();
        id.into()
    }
    fn reserve(store: &LocalStore, prefix: &str, start: i64) {
        let request = crate::shared_numbering::prepare(store, "org-test", prefix, 2026, start)
            .unwrap()
            .unwrap();
        let request_json = serde_json::to_value(&request).unwrap();
        let reply=serde_json::from_value(json!({"request_id":request_json["request_id"],"organization_id":"org-test","installation_id":store.installation_id,"prefix":prefix,"year":2026,"start_value":start,"end_value":start+199})).unwrap();
        crate::shared_numbering::adopt(store, "org-test", &request, &reply).unwrap();
    }
    fn pay(store: &LocalStore, invoice: &str, cents: i64) {
        store
            .record_payment(crate::models::RecordPaymentInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                invoice_id: invoice.into(),
                amount_cents: cents,
                date: Some("2026-09-15".into()),
                method: Some("bank".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
    }
    #[test]
    fn an_invoice_edit_reuses_attachment_blocks_and_rebuilds_an_exact_company_archive() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("sender")).unwrap();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        crate::tests::enable_accounting(&store);
        let client=store.create_record("clients",json!({"name":"Client test","address_line1":"Rue Test 1","postal_code":"1200","city":"Genève","country":"CH"})).unwrap();
        let invoice = issued(
            &store,
            client["id"].as_str().unwrap(),
            "Facture partagée",
            10_000,
        );
        let mut seed = 37u64;
        let attachment: Vec<u8> = (0..12 * 1024 * 1024)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed as u8
            })
            .collect();
        fs::write(store.attachments_dir.join("document-test.bin"), &attachment).unwrap();
        let cache = crate::company_content::directory(&store.data_dir, "org-test").unwrap();
        let initial = prepare(&store, "org-test", true).unwrap();
        let before =
            crate::company_content::prepare(&file_path(&store, &initial.id).unwrap(), &cache)
                .unwrap();
        confirm_sent(&store, &initial.id, 1).unwrap();
        reserve(&store, "J", 201);
        pay(&store, &invoice, 3_000);
        let next = prepare(&store, "org-test", false).unwrap();
        let after =
            crate::company_content::prepare(&file_path(&store, &next.id).unwrap(), &cache).unwrap();
        crate::company_content::validate(&after, &next.manifest).unwrap();
        let previous: std::collections::HashSet<_> = before.iter().map(|p| &p.sha256).collect();
        let changed: u64 = after
            .iter()
            .filter(|p| !previous.contains(&p.sha256))
            .map(|p| p.size_bytes)
            .sum();
        assert!(
            changed < next.manifest.size_bytes / 4,
            "Delta too large: {changed} / {}",
            next.manifest.size_bytes
        );
        let rebuilt = dir.path().join("received.zentra");
        let mut output = File::create(&rebuilt).unwrap();
        for part in &after {
            output
                .write_all(
                    &crate::company_content::cached(&cache, part)
                        .unwrap()
                        .unwrap(),
                )
                .unwrap();
        }
        drop(output);
        assert_eq!(
            crate::cloud_backup::file_manifest(&rebuilt).unwrap(),
            next.manifest
        );
        let receiver = LocalStore::initialize(dir.path().join("receiver")).unwrap();
        apply(
            &receiver,
            &rebuilt,
            "org-test",
            2,
            clock(&receiver).unwrap(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            receiver
                .connect()
                .unwrap()
                .query_row(
                    "SELECT paid_cents FROM invoices WHERE id=?",
                    [invoice],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3000
        );
        assert_eq!(
            fs::read(receiver.attachments_dir.join("document-test.bin")).unwrap(),
            attachment
        );
        println!(
            "ARCHIVE_DELTA {} / {} bytes for an invoice payment",
            changed, next.manifest.size_bytes
        );
    }
    #[test]
    fn simultaneous_new_invoice_and_receipt_merge_then_reach_every_device_with_audit_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let alice = LocalStore::initialize(dir.path().join("alice")).unwrap();
        let bob = LocalStore::initialize(dir.path().join("bob")).unwrap();
        let reader = LocalStore::initialize(dir.path().join("reader")).unwrap();
        alice
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        crate::tests::enable_accounting(&alice);
        person(&alice, "alice");
        person(&bob, "bob");
        person(&reader, "reader");
        let client=alice.create_record("clients",json!({"name":"Client test","address_line1":"Rue Test 1","postal_code":"1200","city":"Genève","country":"CH"})).unwrap();
        let client = client["id"].as_str().unwrap();
        let first = issued(&alice, client, "Facture initiale", 10_000);
        let p = prepare(&alice, "org-test", true).unwrap();
        let base = dir.path().join("base.zentra");
        fs::copy(file_path(&alice, &p.id).unwrap(), &base).unwrap();
        for target in [&bob, &reader] {
            apply(
                target,
                &base,
                "org-test",
                1,
                clock(target).unwrap(),
                true,
                false,
            )
            .unwrap();
        }
        confirm_sent(&alice, &p.id, 1).unwrap();
        reserve(&alice, "J", 201);
        reserve(&alice, "F", 201);
        reserve(&bob, "J", 401);
        let second = issued(&alice, client, "Facture créée simultanément sur PC", 2_000);
        fs::write(alice.attachments_dir.join("plan-pc.txt"), b"plan local").unwrap();
        pay(&bob, &first, 3_000);
        fs::write(
            bob.attachments_dir.join("photo-iphone.txt"),
            b"photo distante",
        )
        .unwrap();
        let remote = prepare(&bob, "org-test", false).unwrap();
        let remote_path = file_path(&bob, &remote.id).unwrap();
        // The downloaded copy belongs to the target's transport directory.
        let received_path = file_path(&alice, &remote.id).unwrap();
        fs::copy(&remote_path, &received_path).unwrap();
        confirm_sent(&bob, &remote.id, 2).unwrap();
        let before = crate::company_sync_digest::local(&alice).unwrap();
        stage_merge(&alice, &base, &received_path, "org-test", 2).unwrap();
        assert_eq!(
            crate::company_sync_digest::local(&alice).unwrap(),
            before,
            "staging must never mutate live data"
        );
        let staged = load(&alice).unwrap().received.unwrap();
        assert_eq!(status(&alice).unwrap()["ready"], true);
        fs::write(
            alice.attachments_dir.join("changed-during-download.txt"),
            b"latest local file",
        )
        .unwrap();
        assert!(apply_merged(&alice, &staged, &file_path(&alice, &staged.id).unwrap()).is_err());
        assert_eq!(load(&alice).unwrap().revision, 1);
        fs::remove_file(alice.attachments_dir.join("changed-during-download.txt")).unwrap();
        apply_merged(&alice, &staged, &file_path(&alice, &staged.id).unwrap()).unwrap();
        let outgoing = load(&alice).unwrap().pending.unwrap();
        assert_eq!(outgoing.base_revision, 2);
        let archive = file_path(&alice, &outgoing.id).unwrap();
        for target in [&bob, &reader] {
            apply(
                target,
                &archive,
                "org-test",
                3,
                clock(target).unwrap(),
                false,
                false,
            )
            .unwrap();
        }
        confirm_sent(&alice, &outgoing.id, 3).unwrap();
        let digest = crate::company_sync_digest::local(&alice).unwrap();
        for target in [&alice, &bob, &reader] {
            assert_eq!(crate::company_sync_digest::local(target).unwrap(), digest);
            let db = target.connect().unwrap();
            assert_eq!(
                db.query_row(
                    "SELECT SUM(total_cents-paid_cents) FROM invoices WHERE number IS NOT NULL",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                9_000
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM payments", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM invoices WHERE id=?", [&second], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            crate::audit::verify_audit_chain(&db).unwrap();
            assert!(
                db.query_row(
                    "SELECT COUNT(*) FROM audit_log WHERE action='company.merge_branch'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap()
                    > 0
            );
            assert!(target.attachments_dir.join("plan-pc.txt").is_file());
            assert!(target.attachments_dir.join("photo-iphone.txt").is_file());
            assert_eq!(status(target).unwrap()["pending"], false);
            assert!(target
                .data_dir
                .join("company-sync-reference.zentra")
                .is_file());
        }
        // A subsequent edit uses the newly accepted reference, not the stale
        // base from the previous conflict. No endless pending/reception loop.
        pay(&bob, &second, 500);
        let next = prepare(&bob, "org-test", false).unwrap();
        assert_eq!(next.base_revision, 3);
        apply(
            &alice,
            &file_path(&bob, &next.id).unwrap(),
            "org-test",
            4,
            clock(&alice).unwrap(),
            false,
            false,
        )
        .unwrap();
        assert_eq!(
            alice
                .connect()
                .unwrap()
                .query_row(
                    "SELECT paid_cents FROM invoices WHERE id=?",
                    [second],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            500
        );
    }
    #[test]
    fn duplicate_receipts_on_two_devices_are_never_summed_or_silently_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let a = LocalStore::initialize(dir.path().join("a")).unwrap();
        let b = LocalStore::initialize(dir.path().join("b")).unwrap();
        a.complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        crate::tests::enable_accounting(&a);
        let client=a.create_record("clients",json!({"name":"Client test","address_line1":"Rue Test 1","postal_code":"1200","city":"Genève","country":"CH"})).unwrap();
        let id = issued(
            &a,
            client["id"].as_str().unwrap(),
            "Facture commune",
            10_000,
        );
        let p = prepare(&a, "org-test", true).unwrap();
        let base = dir.path().join("base.zentra");
        fs::copy(file_path(&a, &p.id).unwrap(), &base).unwrap();
        apply(&b, &base, "org-test", 1, clock(&b).unwrap(), true, false).unwrap();
        confirm_sent(&a, &p.id, 1).unwrap();
        reserve(&a, "J", 201);
        reserve(&b, "J", 401);
        pay(&a, &id, 10_000);
        pay(&b, &id, 10_000);
        reserve(&a, "F", 201);
        let extra = issued(
            &a,
            client["id"].as_str().unwrap(),
            "Nouvelle facture à conserver",
            270_250,
        );
        let remote = prepare(&b, "org-test", false).unwrap();
        let before = crate::company_sync_digest::local(&a).unwrap();
        let error = stage_merge(
            &a,
            &base,
            &file_path(&b, &remote.id).unwrap(),
            "org-test",
            2,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("paiement deux fois"), "{error}");
        assert_eq!(crate::company_sync_digest::local(&a).unwrap(), before);
        assert!(load(&a).unwrap().received.is_none());
        let choice = load(&a)
            .unwrap()
            .duplicate_receipt
            .expect("Only matching payment and journal bundles can be proposed");
        let remote_path = file_path(&a, &remote.id).unwrap();
        fs::copy(file_path(&b, &remote.id).unwrap(), &remote_path).unwrap();
        let mut stale = choice.clone();
        stale.amount_cents += 1;
        assert!(
            stage_merge_confirmed(&a, &base, &remote_path, "org-test", 2, Some(&stale)).is_err()
        );
        assert_eq!(crate::company_sync_digest::local(&a).unwrap(), before);
        stage_merge_confirmed(&a, &base, &remote_path, "org-test", 2, Some(&choice)).unwrap();
        assert_eq!(
            crate::company_sync_digest::local(&a).unwrap(),
            before,
            "Even a confirmed review stages first"
        );
        let received = load(&a).unwrap().received.unwrap();
        apply_merged(&a, &received, &file_path(&a, &received.id).unwrap()).unwrap();
        let db = a.connect().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM payments", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='payment'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT total_cents-paid_cents FROM invoices WHERE id=?",
                [extra],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            270_250
        );
        assert_eq!(db.query_row("SELECT COUNT(*) FROM audit_log WHERE action='company.merge_branch' AND json_extract(payload_json,'$.confirmed_duplicate_receipt.localId')=?",[&choice.local_id],|r|r.get::<_,i64>(0)).unwrap(),1);
        crate::audit::verify_audit_chain(&db).unwrap();
        let replay = a
            .record_payment(crate::models::RecordPaymentInput {
                request_id: choice.local_id.clone(),
                invoice_id: id,
                amount_cents: 10_000,
                date: Some("2026-09-15".into()),
                method: Some("bank".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
        assert_eq!(replay["id"].as_str(), Some(choice.remote_id.as_str()));
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM payments", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn logo_container_changes_are_not_company_edits_but_new_logo_bytes_are() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        let name = format!("logo-{}.png", "a".repeat(64));
        let db = store.connect().unwrap();
        for ch in ["a", "b"] {
            let digest = ch.repeat(64);
            db.execute("INSERT INTO company_brand_assets(sha256,file_name,media_type,byte_size,width,height,created_at,last_verified_at) VALUES(?,?,'image/png',1024,120,60,?,?)",params![digest,format!("logo-{digest}.png"),now_iso(),now_iso()]).unwrap();
        }
        db.execute(
            "UPDATE settings SET logo_path=? WHERE id=1",
            [format!("/private/var/mobile/attachments/branding/{name}")],
        )
        .unwrap();
        let digest = crate::company_sync_digest::local(&store).unwrap();
        let before = clock(&store).unwrap();
        db.execute(
            "UPDATE settings SET logo_path=? WHERE id=1",
            [format!("C:\\Users\\local\\attachments\\branding\\{name}")],
        )
        .unwrap();
        assert_eq!(clock(&store).unwrap(), before);
        assert_eq!(crate::company_sync_digest::local(&store).unwrap(), digest);
        db.execute(
            "UPDATE company_brand_assets SET last_verified_at='2026-09-16T00:00:00Z'",
            [],
        )
        .unwrap();
        assert_eq!(clock(&store).unwrap(), before);
        assert_eq!(crate::company_sync_digest::local(&store).unwrap(), digest);
        db.execute(
            "UPDATE settings SET logo_path=? WHERE id=1",
            [format!(
                "C:\\Users\\local\\attachments\\branding\\logo-{}.png",
                "b".repeat(64)
            )],
        )
        .unwrap();
        assert!(clock(&store).unwrap() > before);
        assert_ne!(crate::company_sync_digest::local(&store).unwrap(), digest);
    }
    #[test]
    fn idle_checks_do_not_dirty_shared_company_and_legacy_false_conflicts_recover() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        seed(&store, "shared-client");
        let pending = prepare(&store, "org-test", true).unwrap();
        let expected =
            crate::company_sync_digest::archive(&file_path(&store, &pending.id).unwrap()).unwrap();
        confirm_sent(&store, &pending.id, 1).unwrap();
        assert_eq!(crate::company_sync_digest::local(&store).unwrap(), expected);
        let before = clock(&store).unwrap();
        let db = store.connect().unwrap();
        db.execute(
            "UPDATE clients SET name=name,updated_at='2026-09-15T04:00:00Z'",
            [],
        )
        .unwrap();
        db.execute("UPDATE reminder_settings SET last_scan_at='2026-09-15T04:00:00Z',updated_at='2026-09-15T04:00:00Z'", []).unwrap();
        db.execute("INSERT INTO reminder_operation_requests(request_id,operation,payload_sha256,payload_json,response_json,created_at) VALUES(?,'scan',?,'{}',?,'2026-09-15T04:00:00Z')",params![uuid::Uuid::new_v4().to_string(),"a".repeat(64),r#"{"created":[],"cancelled":[],"promoted":[]}"#]).unwrap();
        assert_eq!(clock(&store).unwrap(), before);
        assert_eq!(crate::company_sync_digest::local(&store).unwrap(), expected);
        // Reproduce the bookkeeping clock increments left by 1.69.1.
        db.execute("UPDATE company_local_clock SET value=value+20", [])
            .unwrap();
        let mut prefs = load(&store).unwrap();
        prefs.conflict = true;
        save(&store, &prefs).unwrap();
        assert!(reconcile_unchanged_local(&store, &expected).unwrap());
        assert!(!load(&store).unwrap().conflict);
        assert_eq!(load(&store).unwrap().base_clock, clock(&store).unwrap());
        db.execute(
            "UPDATE clients SET name='Modification réelle' WHERE id='shared-client'",
            [],
        )
        .unwrap();
        assert!(clock(&store).unwrap() > before + 20);
        assert!(!reconcile_unchanged_local(&store, &expected).unwrap());
        assert_eq!(
            db.query_row(
                "SELECT name FROM clients WHERE id='shared-client'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "Modification réelle"
        );
    }
    #[test]
    fn baseline_matches_received_copy_but_never_discards_document_or_attachment_changes() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(a.path().into()).unwrap();
        let target = LocalStore::initialize(b.path().into()).unwrap();
        seed(&source, "client-a");
        fs::write(source.attachments_dir.join("logo.png"), b"original logo").unwrap();
        let pending = prepare(&source, "org-test", true).unwrap();
        let path = file_path(&source, &pending.id).unwrap();
        let expected = crate::company_sync_digest::archive(&path).unwrap();
        apply(
            &target,
            &path,
            "org-test",
            1,
            clock(&target).unwrap(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            crate::company_sync_digest::local(&target).unwrap(),
            expected
        );
        assert_eq!(
            baseline(&target, &load(&target).unwrap()).unwrap(),
            expected
        );
        fs::write(target.attachments_dir.join("logo.png"), b"modified logo").unwrap();
        assert!(!reconcile_unchanged_local(&target, &expected).unwrap());
        fs::write(target.attachments_dir.join("logo.png"), b"original logo").unwrap();
        target.connect().unwrap().execute("INSERT INTO invoices(id,title,client_id,created_at,updated_at) VALUES('invoice-a','Facture locale','client-a',?,?)",params![now_iso(),now_iso()]).unwrap();
        assert!(!reconcile_unchanged_local(&target, &expected).unwrap());
        let mut prefs = load(&target).unwrap();
        prefs.base_clock = -1;
        save(&target, &prefs).unwrap();
        assert!(!reconcile_unchanged_local(
            &target,
            &crate::company_sync_digest::local(&target).unwrap()
        )
        .unwrap());
    }
    #[test]
    fn every_committed_shared_write_notifies_once_but_rollbacks_and_imports_do_not() {
        use std::sync::atomic::AtomicUsize;
        let temp = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temp.path().into()).unwrap();
        seed(&store, "notification-client");
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        LISTENERS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
                store.data_dir.clone(),
                Arc::new(move || {
                    observed.fetch_add(1, Ordering::AcqRel);
                }),
            );
        let mut c = store.connect().unwrap();
        {
            let tx = c.transaction().unwrap();
            assert_eq!(
                tx.execute(
                    "UPDATE clients SET name='Partagé' WHERE id='notification-client'",
                    []
                )
                .unwrap(),
                1
            );
            tx.execute(
                "UPDATE clients SET name='Final' WHERE id='notification-client'",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(count.load(Ordering::Acquire), 1);
        {
            let tx = c.transaction().unwrap();
            tx.execute(
                "UPDATE clients SET name='Annulé' WHERE id='notification-client'",
                [],
            )
            .unwrap();
        }
        assert_eq!(count.load(Ordering::Acquire), 1);
        {
            let _gate = WriteGate::take(&store).unwrap();
            c.execute(
                "UPDATE clients SET name='Reçu' WHERE id='notification-client'",
                [],
            )
            .unwrap();
        }
        assert_eq!(count.load(Ordering::Acquire), 1);
        assert_eq!(
            c.query_row(
                "SELECT name FROM clients WHERE id='notification-client'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "Reçu"
        );
        assert_eq!(count.load(Ordering::Acquire), 1);
        LISTENERS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .remove(&store.data_dir);
    }
    fn person(store: &LocalStore, user: &str) {
        set_identity(
            store,
            "org-test",
            user,
            &format!("{user}@example.test"),
            "member",
        )
        .unwrap();
    }
    fn seed(store: &LocalStore, id: &str) {
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                params![id, id, now_iso(), now_iso()],
            )
            .unwrap();
    }
    #[test]
    fn authors_are_original_and_persist_in_company_copy_without_private_identity() {
        let source_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(source_dir.path().into()).unwrap();
        let target = LocalStore::initialize(target_dir.path().into()).unwrap();
        person(&source, "alice");
        set_identity(&source, "org-test", "alice", "Alice Martin", "member").unwrap();
        person(&target, "bob");
        seed(&source, "client-a");
        source.connect().unwrap().execute("INSERT INTO quotes(id,title,client_id,created_at,updated_at) VALUES('quote-a','Devis Alice','client-a',?,?)",params![now_iso(),now_iso()]).unwrap();
        person(&source, "charlie");
        assert_eq!(quote_contact(&source.connect().unwrap(), "quote-a").unwrap(), "Alice Martin");
        source
            .connect()
            .unwrap()
            .execute(
                "UPDATE quotes SET title='Titre corrigé' WHERE id='quote-a'",
                [],
            )
            .unwrap();
        fs::write(
            source.attachments_dir.join("logo-test.png"),
            b"test company logo",
        )
        .unwrap();
        let pending = prepare(&source, "org-test", true).unwrap();
        apply(
            &target,
            &file_path(&source, &pending.id).unwrap(),
            "org-test",
            1,
            clock(&target).unwrap(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            target
                .connect()
                .unwrap()
                .query_row(
                    "SELECT user_id FROM document_creators WHERE document_id='quote-a'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "alice"
        );
        assert_eq!(quote_contact(&target.connect().unwrap(), "quote-a").unwrap(), "Alice Martin");
        assert_eq!(
            target
                .connect()
                .unwrap()
                .query_row("SELECT user_id FROM company_local_identity", [], |r| r
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "bob"
        );
        assert_eq!(
            fs::read(target.attachments_dir.join("logo-test.png")).unwrap(),
            b"test company logo"
        );
        assert_eq!(status(&target).unwrap()["pending"], false);
        assert!(target
            .connect()
            .unwrap()
            .execute("UPDATE document_creators SET user_id='bob'", [])
            .is_err());
    }
    #[test]
    fn issued_invoice_and_member_payment_keep_all_company_balances_identical() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        let alice = LocalStore::initialize(a.path().into()).unwrap();
        let bob = LocalStore::initialize(b.path().into()).unwrap();
        let reader = LocalStore::initialize(c.path().into()).unwrap();
        let mut settings = crate::tests::test_onboarding();
        settings.vat_registered = true;
        settings.vat_number = Some("CHE-123.456.789 TVA".into());
        settings.default_vat_bp = Some(810);
        alice
            .complete_onboarding(settings, env!("CARGO_PKG_VERSION"))
            .unwrap();
        crate::tests::enable_accounting(&alice);
        person(&alice, "alice");
        person(&bob, "bob");
        person(&reader, "reader");
        let client = alice.create_record("clients", json!({"name":"Client partagé", "address_line1":"Rue du Test 1", "postal_code":"1200", "city":"Genève", "country":"CH"})).unwrap();
        let invoice = alice.create_record("invoices", json!({"client_id":client["id"], "title":"Facture Alice", "service_date_from":"2026-09-14", "service_date_to":"2026-09-14"})).unwrap();
        let id = invoice["id"].as_str().unwrap();
        alice.create_record("invoice_items", json!({"invoice_id":id, "description":"Prestation", "quantity":1, "unit":"forfait", "unit_price_cents":100_000, "vat_bp":810})).unwrap();
        alice
            .issue_invoice(id, Some("2026-09-14".into()), None)
            .unwrap();
        let first = prepare(&alice, "org-test", true).unwrap();
        for target in [&bob, &reader] {
            apply(
                target,
                &file_path(&alice, &first.id).unwrap(),
                "org-test",
                1,
                clock(target).unwrap(),
                true,
                false,
            )
            .unwrap();
        }
        confirm_sent(&alice, &first.id, 1).unwrap();

        // In production the join flow obtains a separate, server-reserved
        // journal range for each device. Exercise its real adoption here too.
        let reservation = crate::shared_numbering::prepare(&bob, "org-test", "J", 2026, 2)
            .unwrap()
            .unwrap();
        let reservation_json = serde_json::to_value(&reservation).unwrap();
        let reply = serde_json::from_value(json!({
            "request_id":reservation_json["request_id"], "organization_id":"org-test", "installation_id":bob.installation_id,
            "prefix":"J", "year":2026, "start_value":2, "end_value":201,
        })).unwrap();
        crate::shared_numbering::adopt(&bob, "org-test", &reservation, &reply).unwrap();
        bob.record_payment(crate::models::RecordPaymentInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            invoice_id: id.into(),
            amount_cents: 30_000,
            date: Some("2026-09-14".into()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        })
        .unwrap();
        let second = prepare(&bob, "org-test", false).unwrap();
        for target in [&alice, &reader] {
            apply(
                target,
                &file_path(&bob, &second.id).unwrap(),
                "org-test",
                2,
                clock(target).unwrap(),
                false,
                false,
            )
            .unwrap();
        }
        confirm_sent(&bob, &second.id, 2).unwrap();
        let balances = |store: &LocalStore| {
            let db = store.connect().unwrap();
            let amount = db
                .query_row(
                    "SELECT total_cents,paid_cents,total_cents-paid_cents FROM invoices WHERE id=?",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(amount, (108_100, 30_000, 78_100));
            assert_eq!(
                db.query_row(
                    "SELECT user_id FROM document_creators WHERE document_id=?",
                    [id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "alice"
            );
            assert_eq!(db.query_row("SELECT COUNT(*) FROM journal_entries WHERE source_type IN ('invoice','payment')", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
            assert_eq!(db.query_row("SELECT COUNT(*) FROM (SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id HAVING SUM(debit_cents)!=SUM(credit_cents))", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
            let mut statement = db.prepare("SELECT account_id,SUM(debit_cents),SUM(credit_cents) FROM journal_lines GROUP BY account_id ORDER BY account_id").unwrap();
            statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(balances(&alice), balances(&bob));
        assert_eq!(balances(&alice), balances(&reader));
        for store in [&alice, &bob, &reader] {
            assert_eq!(status(store).unwrap()["pending"], false);
        }
    }
    #[test]
    fn dirty_or_concurrent_local_work_is_never_silently_overwritten() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(a.path().into()).unwrap();
        let target = LocalStore::initialize(b.path().into()).unwrap();
        seed(&source, "shared-client");
        let pending = prepare(&source, "org-test", true).unwrap();
        let path = file_path(&source, &pending.id).unwrap();
        apply(
            &target,
            &path,
            "org-test",
            1,
            clock(&target).unwrap(),
            true,
            false,
        )
        .unwrap();
        let clean = clock(&target).unwrap();
        seed(&target, "offline-client");
        assert!(apply(&target, &path, "org-test", 2, clean, false, false).is_err());
        assert!(apply(
            &target,
            &path,
            "org-test",
            2,
            clock(&target).unwrap(),
            false,
            false
        )
        .is_err());
        assert_eq!(
            target
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM clients", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(load(&target).unwrap().revision, 1);
        apply(
            &target,
            &path,
            "org-test",
            2,
            clock(&target).unwrap(),
            false,
            true,
        )
        .unwrap();
        assert_eq!(load(&target).unwrap().revision, 2);
        assert!(fs::read_dir(&target.backups_dir).unwrap().count() >= 1);
    }
    #[test]
    fn execution_gate_blocks_a_statement_prepared_before_receiving() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        let c = store.connect().unwrap();
        let mut statement=c.prepare("INSERT INTO clients(id,name,created_at,updated_at) VALUES('later','Later','2026-09-14','2026-09-14')").unwrap();
        gate(&store).store(true, Ordering::Release);
        assert!(statement.execute([]).is_err());
        gate(&store).store(false, Ordering::Release);
        statement.execute([]).unwrap();
    }
    #[test]
    fn pending_snapshot_survives_restart_and_cannot_change_company() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        seed(&store, "a");
        let p = prepare(&store, "org-test", true).unwrap();
        let reopened = LocalStore::initialize(dir.path().into()).unwrap();
        assert_eq!(prepare(&reopened, "org-test", false).unwrap().id, p.id);
        assert!(prepare(&reopened, "another-company", false).is_err());
        seed(&reopened, "new-change");
        confirm_sent(&reopened, &p.id, 1).unwrap();
        assert_eq!(status(&reopened).unwrap()["pending"], true);
    }
}

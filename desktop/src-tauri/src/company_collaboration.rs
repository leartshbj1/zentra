//! Complete-company sharing. Revisions are published with a server-side CAS;
//! divergent local work is kept, never silently replaced by the last uploader.
use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};
use reqwest::Method;
use rusqlite::{functions::FunctionFlags, params, Connection};
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
const STATE: &str = "company-collaboration.json";
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
    connection.create_scalar_function(
        "zentra_company_write_allowed",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS,
        move |_| Ok(!gate.load(Ordering::Acquire) || APPLYING.get()),
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
pub(crate) fn upgrade_tracking(connection: &Connection) -> AppResult<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS company_local_tracking_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)")?;
    let ready: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM company_local_tracking_version WHERE id=1 AND version=2)",
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
            .map(|c| format!("OLD.\"{c}\" IS NOT NEW.\"{c}\""))
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
    connection.execute("INSERT INTO company_local_tracking_version VALUES(1,2) ON CONFLICT(id) DO UPDATE SET version=2",[])?;
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
    if digest.is_none() && !dirty {
        let _lock = store.lock()?;
        if clock(store)? == prefs.base_clock {
            save_baseline(
                store,
                &session.organization_id,
                prefs.revision,
                crate::company_sync_digest::local(store)?,
            )?;
        }
        return Ok(());
    }
    if !dirty {
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
    let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_local_identity')",[],|r|r.get(0))?;
    if exists {
        connection.execute("DELETE FROM company_local_identity", [])?;
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
    store.connect()?.execute("INSERT INTO company_local_identity VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,user_id=excluded.user_id,display_name=excluded.display_name,role=excluded.role",params![organization,user_id,name,role])?;
    Ok(())
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
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    id: String,
    base_revision: u64,
    clock: i64,
    manifest: crate::cloud_backup::Manifest,
}
fn folder(store: &LocalStore) -> AppResult<PathBuf> {
    let p = store.data_dir.join("company-sync");
    fs::create_dir_all(&p)?;
    Ok(p)
}
fn load(store: &LocalStore) -> AppResult<Preferences> {
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
    }
    Ok(value)
}
fn save(store: &LocalStore, value: &Preferences) -> AppResult<()> {
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
fn file_path(store: &LocalStore, id: &str) -> AppResult<PathBuf> {
    crate::cloud_backup::validate_id(id)?;
    Ok(folder(store)?.join(format!("{id}.zentra")))
}
fn clean_transport_copies(store: &LocalStore) -> AppResult<()> {
    let prefs = load(store)?;
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
            || prefs.pending.as_ref().is_some_and(|p| p.id == id)
            || prefs.received.as_ref().is_some_and(|r| r.id == id)
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
      "conflict":prefs.conflict,"ready":prefs.received.as_ref().is_some_and(|r|r.clock==prefs.base_clock&&clock(store).ok()==Some(r.clock)),"lastSyncedAt":prefs.last_synced_at,"syncing":gate(store).load(Ordering::Acquire)}),
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

fn prepare(store: &LocalStore, organization: &str, activate: bool) -> AppResult<Pending> {
    let _lock = store.lock()?;
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
    store.create_backup_at(&path, env!("CARGO_PKG_VERSION"))?;
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
    };
    prefs.pending = Some(pending.clone());
    prefs.organization_id = Some(organization.into());
    save(store, &prefs)?;
    Ok(pending)
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
    let digest = crate::company_sync_digest::archive(&file_path(store, id)?)?;
    save_baseline(
        store,
        prefs
            .organization_id
            .as_deref()
            .ok_or_else(|| invalid("Entreprise de référence absente."))?,
        revision,
        digest,
    )?;
    prefs.base_clock = p.clock;
    prefs.revision = revision;
    prefs.pending = None;
    prefs.conflict = false;
    prefs.last_synced_at = Some(now_iso());
    save(store, &prefs)?;
    let _ = clean_transport_copies(store);
    Ok(())
}
async fn send(store: &LocalStore, session: &ProjectSyncSession, activate: bool) -> AppResult<bool> {
    let owned = store.clone();
    let org = session.organization_id.clone();
    let p = tauri::async_runtime::spawn_blocking(move || prepare(&owned, &org, activate))
        .await
        .map_err(|_| invalid("L’envoi a été interrompu. Il reprendra automatiquement."))??;
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
    let response=request(session,Method::POST,&[],Some(json!({"action":"prepare","id":p.id,"baseRevision":p.base_revision,"manifest":p.manifest,"confirmFullAccess":activate,"numbers":numbers}))).await?;
    if response["conflict"] == true {
        let mut prefs = load(store)?;
        prefs.conflict = true;
        save(store, &prefs)?;
        return Ok(false);
    }
    if let Some(revision) = response["revision"].as_u64() {
        confirm_sent(store, &p.id, revision)?;
        return Ok(true);
    }
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
        session
            .request(
                Method::PUT,
                PATH,
                &[("id", &p.id), ("index", &index.to_string())],
                &[],
                Some(bytes),
                false,
            )
            .await?;
    }
    let current = project_sync_session(store)
        .await?
        .ok_or_else(|| invalid("Reconnectez votre compte pour terminer l’envoi."))?;
    if current.organization_id != session.organization_id {
        return Err(invalid("Le compte a changé pendant l’envoi."));
    }
    let result = request(
        &current,
        Method::POST,
        &[],
        Some(json!({"action":"commit","id":p.id})),
    )
    .await?;
    if result["committed"] == true && result["snapshotId"].as_str() == Some(&p.id) {
        confirm_sent(
            store,
            &p.id,
            result["revision"]
                .as_u64()
                .ok_or_else(|| invalid("La confirmation de version est invalide."))?,
        )?;
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
    if path.is_file() && crate::cloud_backup::file_manifest(&path)? == manifest {
        return Ok(path);
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
    Ok(path)
}
const PRIVATE_ROWS: &[&str] = &[
    "company_local_identity",
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
    for (table, rows) in rows {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
        for row in rows {
            let object = row
                .as_object()
                .ok_or_else(|| invalid("Données privées illisibles."))?;
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
        }
    }
    tx.commit()?;
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
    let private = private_rows(store)?;
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
        restore_private(store, &private)?;
        crate::backup::validate_database(&store.database_path)?;
        prefs.base_clock = clock(store)?;
        save_baseline(
            store,
            organization,
            revision,
            crate::company_sync_digest::local(store)?,
        )?;
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
    if !send(&store, &session, true).await.map_err(command_error)? {
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
    let head = request(&session, Method::GET, &[], None)
        .await
        .map_err(command_error)?;
    let revision = checked_head(&session, &head).map_err(command_error)?;
    let mut changed = false;
    if revision < prefs.revision {
        return Err("La version du serveur est antérieure à celle de cet appareil. Contactez le support ; vos données sont conservées.".into());
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
    if prefs.conflict && !accept_remote {
        return status(&store).map_err(command_error);
    }
    if prefs.pending.is_some() && !accept_remote {
        send(&store, &session, false).await.map_err(command_error)?;
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
                });
                save(&store, &next).map_err(command_error)?;
            }
        }
    } else if clock(&store).map_err(command_error)? != prefs.base_clock
        && session.role != "read_only"
    {
        send(&store, &session, false).await.map_err(command_error)?;
    }
    crate::shared_numbering::replenish_active_series(&store, &session)
        .await
        .map_err(command_error)?;
    let mut result = status(&store).map_err(command_error)?;
    result["changed"] = json!(changed);
    result["remoteRevision"] = json!(revision);
    Ok(result)
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
        if crate::cloud_backup::file_manifest(&path)? != received.manifest {
            return Err(invalid(
                "Les documents reçus ont changé. Relancez la synchronisation.",
            ));
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
        person(&target, "bob");
        seed(&source, "client-a");
        source.connect().unwrap().execute("INSERT INTO quotes(id,title,client_id,created_at,updated_at) VALUES('quote-a','Devis Alice','client-a',?,?)",params![now_iso(),now_iso()]).unwrap();
        person(&source, "charlie");
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

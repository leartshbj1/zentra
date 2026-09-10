//! One bounded receive/reconcile/send pass for an explicitly selected history.
//! No account connection implicitly chooses a history or starts this command.
use super::{outgoing::transport as outgoing, replay::delivery::incoming, snapshot, workspace};
use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    database::LocalStore,
    error::{command_error, AppError, AppResult},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tauri::State;
pub(crate) mod installation;
pub(crate) mod resolution;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    pub organization_id: String,
    pub installation_id: String,
    pub capture_generation: String,
    pub generation: String,
    pub bootstrap_transfer_id: String,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

// SQLite provides the cross-process exclusion; the weak map only routes an
// in-process cancellation request. A dropped invoke must not release the lease
// while a detached blocking installer still owns the transport.
pub(crate) struct Run {
    _connection: Mutex<Connection>,
    cancelled: AtomicBool,
    request_id: OnceLock<String>,
}
impl Run {
    pub(crate) fn ensure_running(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(AppError::BusinessSyncPaused)
        } else {
            Ok(())
        }
    }
}
static RUNS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Run>>>> = OnceLock::new();
fn runs() -> &'static Mutex<BTreeMap<PathBuf, Weak<Run>>> {
    RUNS.get_or_init(Mutex::default)
}

pub(crate) fn try_acquire(store: &LocalStore) -> AppResult<Option<Arc<Run>>> {
    if !snapshot::regular_metadata(&store.data_dir)?.is_dir() {
        return Err(invalid("Le profil local est invalide."));
    }
    let profile = fs::canonicalize(&store.data_dir)?;
    let root = profile.join("business-cycle");
    match fs::create_dir(&root) {
        Ok(()) => snapshot::sync_directory(&profile)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let mut runs = runs()
        .lock()
        .map_err(|_| invalid("Le suivi de synchronisation est indisponible."))?;
    let connection = match workspace::gate(&root, Duration::ZERO) {
        Ok(connection) => connection,
        Err(AppError::Database(rusqlite::Error::SqliteFailure(e, _)))
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(e),
    };
    let run = Arc::new(Run {
        _connection: Mutex::new(connection),
        cancelled: AtomicBool::new(false),
        request_id: OnceLock::new(),
    });
    runs.retain(|_, value| value.strong_count() > 0);
    runs.insert(profile, Arc::downgrade(&run));
    Ok(Some(run))
}
pub(crate) fn acquire(store: &LocalStore) -> AppResult<Arc<Run>> {
    try_acquire(store)?
        .ok_or_else(|| invalid("Une synchronisation de ce dossier est déjà en cours."))
}
#[cfg(test)]
pub(super) fn cancel(store: &LocalStore) -> AppResult<bool> {
    cancel_matching(store, None)
}
fn cancel_matching(store: &LocalStore, request_id: Option<&str>) -> AppResult<bool> {
    let profile = fs::canonicalize(&store.data_dir)?;
    let runs = runs()
        .lock()
        .map_err(|_| invalid("Le suivi de synchronisation est indisponible."))?;
    if let Some(run) = runs.get(&profile).and_then(Weak::upgrade) {
        if request_id.is_some_and(|id| run.request_id.get().map(String::as_str) != Some(id)) {
            return Ok(false);
        }
        run.cancelled.store(true, Ordering::Release);
        return Ok(true);
    }
    Ok(false)
}

pub(crate) struct Guarded<T> {
    pub transport: T,
    selection: Selection,
    run: Arc<Run>,
    before_install: Option<Arc<dyn Fn() -> AppResult<()> + Send + Sync>>,
}
impl<T> Guarded<T> {
    pub(crate) fn new(transport: T, selection: Selection, run: Arc<Run>) -> Self {
        Self {
            transport,
            selection,
            run,
            before_install: None,
        }
    }
    pub(crate) fn lease(&self) -> Arc<Run> {
        self.run.clone()
    }
    pub(crate) fn check(&self, store: &LocalStore) -> AppResult<()> {
        self.run.ensure_running()?;
        if incoming::selection(store, &self.selection.organization_id)? != self.selection {
            return Err(invalid("L’historique sélectionné a changé. Choisissez à nouveau le dossier à synchroniser."));
        }
        Ok(())
    }
}

fn status(selection: &Selection, state: &str, detail: Value, changed: bool) -> Value {
    json!({"state":state,"selection":selection,"workspace_changed":changed,"detail":detail,"replication_active":false})
}

pub(crate) async fn pass<T>(
    store: LocalStore,
    transport: Arc<Guarded<T>>,
    install_received: bool,
) -> AppResult<Value>
where
    T: incoming::Transport + outgoing::Transport + Send + Sync + 'static,
{
    // Each transport validates the account and this selected history around
    // every network operation. Revision-specific checks remain in the decoders.
    {
        let _guard = store.lock()?;
        transport.check(&store)?;
        incoming::Transport::ensure_current(transport.as_ref(), &store)?;
        let pending = resolution::pending(
            &store,
            &store.connect()?,
            &transport.selection,
            outgoing::Transport::role(transport.as_ref()),
        )?;
        if !pending.is_null() {
            return Ok(status(
                &transport.selection,
                "conflict",
                json!({"state":"resolution_pending","resolution":pending}),
                false,
            ));
        }
    }
    let received = incoming::receive_pass(&store, transport.as_ref(), 8).await?;
    let selection = &transport.selection;
    match received["state"].as_str() {
        Some("receiving_transactions") => Ok(status(selection, "receiving", received, false)),
        Some("transaction_received") => {
            if !install_received {
                return Ok(status(selection, "awaiting_installation", received, false));
            }
            let transaction = received["transaction_id"]
                .as_str()
                .ok_or_else(|| invalid("La transaction reçue est absente."))?
                .to_owned();
            let role = outgoing::Transport::role(transport.as_ref()).to_owned();
            let reconciled = incoming::reconciliation::process_with_installation(
                store,
                transport.clone(),
                role,
                transaction,
                true,
                transport
                    .before_install
                    .clone()
                    .unwrap_or_else(|| Arc::new(|| Ok(()))),
            )
            .await?;
            // Finish this pass after one install. The next pass discovers again
            // before sending, including when this was our own committed receipt.
            match reconciled["state"].as_str() {
                Some("transaction_reconciled" | "transaction_installed")
                    if reconciled["installed"] == true =>
                {
                    Ok(status(selection, "installed", reconciled, true))
                }
                Some("reconciliation_conflict") => {
                    Ok(status(selection, "conflict", reconciled, false))
                }
                _ => Err(invalid(
                    "La révision n’a pas été installée. Les modifications locales sont conservées.",
                )),
            }
        }
        Some("no_new_revision") => {
            if outgoing::Transport::role(transport.as_ref()) == "read_only" {
                return Ok(status(
                    selection,
                    "idle",
                    json!({"receive_only":true}),
                    false,
                ));
            }
            let sent = outgoing::send_pass(store, transport.clone()).await?;
            let state =
                match sent["state"].as_str() {
                    Some("nothing_to_send") => "idle",
                    Some("committed") => "awaiting_receipt",
                    Some("conflict") => "conflict",
                    Some("invalid") => "invalid",
                    Some("stale") => "retry",
                    Some(
                        "receiving"
                        | "awaiting_files"
                        | "awaiting_validation"
                        | "reviewing"
                        | "validating"
                        | "fingerprinting"
                        | "preparing_delivery"
                        | "committing",
                    ) => "sending",
                    _ => return Err(invalid(
                        "L’étape d’envoi reçue est inconnue. La synchronisation est interrompue.",
                    )),
                };
            Ok(status(selection, state, sent, false))
        }
        _ => Err(invalid(
            "L’étape de réception reçue est inconnue. La synchronisation est interrompue.",
        )),
    }
}

#[tauri::command]
pub async fn get_business_cycle_state(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner();
    let Some(session) = project_sync_session(store).await.map_err(command_error)? else {
        return Ok(json!({"state":"waiting_for_connection"}));
    };
    session.ensure_current_for(store).map_err(command_error)?;
    let _guard = store.lock().map_err(command_error)?;
    let c = store.connect().map_err(command_error)?;
    let installed: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM business_sync_baseline)",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::from)
        .map_err(command_error)?;
    if !installed {
        return Ok(json!({"state":"history_required"}));
    }
    let selection = incoming::selection(store, &session.organization_id).map_err(command_error)?;
    let pending = super::status(&c).map_err(command_error)?;
    let resolution =
        resolution::pending(store, &c, &selection, &session.role).map_err(command_error)?;
    session.ensure_current_for(store).map_err(command_error)?;
    Ok(
        json!({"state":"ready","selection":selection,"pending_transactions":pending["pending_transactions"],"resolution":resolution,"replication_active":false}),
    )
}

#[tauri::command]
pub async fn sync_business_cycle(
    state: State<'_, LocalStore>,
    selection: Selection,
    install_received: bool,
    installation_permission: tauri::ipc::Channel<installation::Request>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let Some(run) = try_acquire(&store).map_err(command_error)? else {
        return Ok(status(&selection, "busy", Value::Null, false));
    };
    if let Some(id) = request_id {
        uuid::Uuid::parse_str(&id)
            .map_err(|_| "La demande de synchronisation est invalide.".to_owned())?;
        let _ = run.request_id.set(id);
    }
    let Some(session): Option<ProjectSyncSession> =
        project_sync_session(&store).await.map_err(command_error)?
    else {
        return Ok(status(
            &selection,
            "waiting_for_connection",
            Value::Null,
            false,
        ));
    };
    if session.organization_id != selection.organization_id {
        return Err("Le compte connecté ne correspond pas au dossier sélectionné.".into());
    }
    let mut guarded = Guarded::new(session, selection.clone(), run.clone());
    let permission_store = store.clone();
    let permission_selection = selection.clone();
    let permission_run = run.clone();
    guarded.before_install = Some(Arc::new(move || {
        installation::request(
            &permission_store,
            &permission_selection,
            || permission_run.ensure_running(),
            |request| {
                installation_permission
                    .send(request)
                    .map_err(|_| AppError::BusinessInstallDeferred)
            },
            Duration::from_secs(5),
        )
    }));
    let transport = Arc::new(guarded);
    match pass(store, transport, install_received).await {
        Ok(result) => Ok(result),
        Err(AppError::BusinessSyncPaused) => Ok(status(&selection, "paused", Value::Null, false)),
        Err(AppError::BusinessInstallDeferred) => Ok(status(
            &selection,
            "awaiting_installation",
            Value::Null,
            false,
        )),
        Err(error) => Err(command_error(error)),
    }
}

#[tauri::command]
pub fn pause_business_cycle(
    state: State<'_, LocalStore>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let pending = cancel_matching(state.inner(), request_id.as_deref()).map_err(command_error)?;
    if request_id.is_some() {
        return Ok(
            json!({"state":if pending {"stopping"}else{"paused"},"in_flight":pending,"request_id":request_id}),
        );
    }
    if !pending && try_acquire(state.inner()).map_err(command_error)?.is_none() {
        return Err("Une autre instance utilise ce dossier. Suspendez la synchronisation depuis cette instance.".into());
    }
    Ok(json!({"state":if pending {"stopping"} else {"paused"},"in_flight":pending}))
}

#[cfg(test)]
mod tests;

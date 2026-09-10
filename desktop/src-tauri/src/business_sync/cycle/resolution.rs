//! Explicit resolution requests share the cycle lease and UI write barrier.
use super::*;
use crate::business_sync::retirement::durable;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Apply,
    Cancel,
}

pub(super) fn pending(
    store: &LocalStore,
    c: &Connection,
    selected: &Selection,
    role: &str,
) -> AppResult<Value> {
    let Some(frozen) = durable::load(c, store)? else {
        return Ok(Value::Null);
    };
    if frozen.intent.organization_id != selected.organization_id
        || frozen.intent.capture_generation != selected.capture_generation
        || frozen.intent.generation != selected.generation
        || frozen.intent.installation_id != selected.installation_id
    {
        return Err(invalid("La résolution appartient à un autre dossier. Reconnectez le compte de cette entreprise."));
    }
    Ok(json!({"resolution_id":frozen.intent.resolution_id,
        "transaction_id":frozen.intent.received_transaction_id,
        "accepted":frozen.stage == durable::Stage::Retired,
        "cancellation_requested":frozen.cancellation_requested,
        "can_apply":matches!(role,"owner"|"admin"|"member"|"accountant")}))
}

#[tauri::command]
pub async fn resolve_business_conflict(
    state: State<'_, LocalStore>,
    selection: Selection,
    transaction_id: String,
    resolution_id: String,
    action: Action,
    request_id: String,
    installation_permission: tauri::ipc::Channel<installation::Request>,
) -> Result<Value, String> {
    execute(
        state.inner().clone(),
        selection,
        transaction_id,
        resolution_id,
        action,
        request_id,
        installation_permission,
    )
    .await
    .map_err(command_error)
}

async fn execute(
    store: LocalStore,
    selection: Selection,
    transaction_id: String,
    resolution_id: String,
    action: Action,
    request_id: String,
    channel: tauri::ipc::Channel<installation::Request>,
) -> AppResult<Value> {
    uuid::Uuid::parse_str(&request_id)
        .map_err(|_| invalid("La demande de résolution est invalide."))?;
    uuid::Uuid::parse_str(&resolution_id)
        .map_err(|_| invalid("Les choix enregistrés sont invalides."))?;
    let run = acquire(&store)?;
    let _ = run.request_id.set(request_id);
    let session = project_sync_session(&store).await?.ok_or_else(|| {
        invalid("Reconnectez le compte de cette entreprise pour reprendre la résolution.")
    })?;
    if session.organization_id != selection.organization_id
        || !matches!(
            session.role.as_str(),
            "owner" | "admin" | "member" | "accountant"
        )
    {
        return Err(invalid(
            "Ce compte ne permet pas de résoudre les modifications de ce dossier.",
        ));
    }
    let binding = session.comparison_binding();
    let guarded = Arc::new(Guarded::new(session, selection.clone(), run.clone()));
    guarded.check(&store)?;
    guarded.transport.ensure_current_for(&store)?;
    let cancel = {
        let _guard = store.lock()?;
        let frozen = durable::load(&store.connect()?, &store)?;
        // A resumed cancellation must never dispatch the earlier apply request.
        matches!(action, Action::Cancel)
            || frozen.is_some_and(|f| {
                f.intent.resolution_id == resolution_id && f.cancellation_requested
            })
    };
    let permission_store = store.clone();
    let permission: Arc<dyn Fn() -> AppResult<()> + Send + Sync> = Arc::new(move || {
        installation::request(
            &permission_store,
            &selection,
            || run.ensure_running(),
            |request| {
                channel
                    .send(request)
                    .map_err(|_| AppError::BusinessInstallDeferred)
            },
            Duration::from_secs(5),
        )
    });
    if cancel {
        incoming::reconciliation::application::cancel_saved(
            store,
            guarded,
            transaction_id,
            resolution_id,
            permission,
        )
        .await
    } else {
        incoming::reconciliation::application::apply_saved(
            store,
            guarded,
            transaction_id,
            resolution_id,
            binding,
            permission,
        )
        .await
    }
}

//! Authenticated conflict comparison and guarded, non-installing previews.
use super::*;
use crate::business_sync::replay::reconciliation::resolution;
use std::sync::Arc;

pub(super) enum Action {
    Inspect {
        after_sequence: Option<String>,
        review_id: Option<String>,
    },
    Preview(resolution::Request),
}

#[tauri::command]
pub async fn inspect_business_conflicts(
    state: State<'_, LocalStore>,
    transaction_id: String,
    after_sequence: Option<String>,
    review_id: Option<String>,
) -> Result<Value, String> {
    process(
        state.inner().clone(),
        transaction_id,
        Action::Inspect {
            after_sequence,
            review_id,
        },
    )
    .await
    .map_err(command_error)
}

#[tauri::command]
pub async fn preview_business_resolution(
    state: State<'_, LocalStore>,
    transaction_id: String,
    request: resolution::Request,
) -> Result<Value, String> {
    process(
        state.inner().clone(),
        transaction_id,
        Action::Preview(request),
    )
    .await
    .map_err(command_error)
}

async fn process(store: LocalStore, transaction_id: String, action: Action) -> AppResult<Value> {
    let lease = crate::business_sync::cycle::acquire(&store)?;
    let session = project_sync_session(&store)
        .await?
        .ok_or_else(|| invalid("Reconnectez votre compte pour comparer les modifications."))?;
    let role = session.role.clone();
    let account_binding = session.comparison_binding();
    let selected = selection(&store, &session.organization_id)?;
    let transport = Arc::new(crate::business_sync::cycle::Guarded::new(
        session, selected, lease,
    ));
    process_with_transport(
        store,
        transport,
        role,
        transaction_id,
        action,
        account_binding,
    )
    .await
}

pub(super) async fn process_with_transport<T: Transport + Send + Sync + 'static>(
    store: LocalStore,
    session: Arc<T>,
    role: String,
    transaction_id: String,
    action: Action,
    account_binding: String,
) -> AppResult<Value> {
    if !matches!(
        role.as_str(),
        "owner" | "admin" | "member" | "accountant" | "read_only"
    ) {
        return Err(invalid(
            "Votre rôle ne permet pas de consulter cette comparaison.",
        ));
    }
    let (folder, header) = next_received(&store, session.as_ref(), &transaction_id).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let revision = verify(&store, &folder, &header, &role, || {
            session.ensure_current(&store)
        })?;
        let scope = resolution::Scope {
            store: &store,
            context: &revision.context,
            capture: &header.binding.capture,
            receipt_sha256: &header.entry.receipt_sha256,
            role: &role,
            account_binding: &account_binding,
            acknowledgement: revision.acknowledgement.as_ref(),
        };
        let mut result = match action {
            Action::Inspect {
                after_sequence,
                review_id,
            } => resolution::inspect(
                &revision.prepared,
                &scope,
                after_sequence.as_deref(),
                review_id.as_deref(),
            )?,
            Action::Preview(request) => resolution::preview(
                &revision.prepared,
                &scope,
                request,
                || session.ensure_current(&store),
                |candidate| {
                    let plan = files::plan(candidate, &store, &folder, &revision.chunks)?;
                    session.ensure_current(&store)?;
                    plan.preview(&store)
                },
            )?,
        };
        // Comparison may be slow. Reject edits, a different account/history or
        // a cancellation that occurred after its snapshot was opened.
        let _guard = store.lock()?;
        session.ensure_current(&store)?;
        revision
            .prepared
            .verify_live(&store.connect()?, &store, &revision.context)?;
        result["transaction_id"] = json!(header.entry.transaction_id);
        Ok(result)
    })
    .await
    .map_err(|_| {
        invalid("La comparaison a été interrompue. Les modifications locales sont conservées.")
    })?
}

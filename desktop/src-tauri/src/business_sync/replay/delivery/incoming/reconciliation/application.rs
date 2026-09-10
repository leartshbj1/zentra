//! Durable choice application with a private-state-preserving installer.
//! The caller owns the cycle lease and the interface permission/reload handshake.
use super::*;
use crate::business_sync::{cycle::Guarded, retirement::durable};
use crate::error::AppError;
use std::sync::Arc;

pub(crate) async fn retire_saved<T>(
    store: LocalStore,
    session: Arc<Guarded<T>>,
    transaction_id: String,
    resolution_id: String,
    account_binding: String,
    before_freeze: Arc<dyn Fn() -> AppResult<()> + Send + Sync>,
) -> AppResult<durable::Frozen>
where
    T: Transport + durable::Transport + Send + Sync + 'static,
{
    let role = durable::Transport::role(&session.transport).to_owned();
    if !matches!(role.as_str(), "owner" | "admin" | "member" | "accountant") {
        return Err(invalid(
            "Votre rôle ne permet pas d’appliquer cette résolution.",
        ));
    }
    session.check(&store)?;
    durable::Transport::ensure_current(&session.transport, &store)?;
    let (s, t, id, transaction) = (
        store.clone(),
        session.clone(),
        resolution_id.clone(),
        transaction_id.clone(),
    );
    let exists = tauri::async_runtime::spawn_blocking(move || {
        let _guard = s.lock()?;
        let c = s.connect()?;
        let tx = c.unchecked_transaction()?;
        let frozen = durable::load(&tx, &s)?;
        let Some(frozen) = frozen else {
            return Ok(false);
        };
        if frozen.intent.resolution_id != id
            || frozen.intent.received_transaction_id != transaction
            || frozen.intent.organization_id != durable::Transport::organization(&t.transport)
        {
            return Err(invalid(
                "Reprenez la résolution déjà protégée de ce dossier.",
            ));
        }
        saved::verify_frozen(&s, &frozen.intent)?;
        t.check(&s)?;
        durable::Transport::ensure_current(&t.transport, &s)?;
        Ok(true)
    })
    .await
    .map_err(|_| invalid("La lecture des choix protégés a été interrompue."))??;
    if !exists {
        let (folder, header) = next_received(&store, session.as_ref(), &transaction_id).await?;
        let (s, t, id) = (store.clone(), session.clone(), resolution_id.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let revision = verify(&s, &folder, &header, &role, || {
                Transport::ensure_current(t.as_ref(), &s)
            })?;
            let scope = merge::resolution::Scope {
                store: &s,
                context: &revision.context,
                capture: &header.binding.capture,
                receipt_sha256: &header.entry.receipt_sha256,
                role: &role,
                account_binding: &account_binding,
                acknowledgement: revision.acknowledgement.as_ref(),
            };
            let review_id = merge::resolution::review_id(&revision.prepared, &scope)?;
            // Permission comes after comparison work, before the durable fence.
            before_freeze()?;
            saved::freeze(&s, &header, &id, &review_id, &revision, || {
                Transport::ensure_current(t.as_ref(), &s)
            })?;
            Ok::<_, AppError>(())
        })
        .await
        .map_err(|_| invalid("La préparation de la résolution a été interrompue."))??;
    }
    durable::run(store, session, resolution_id).await
}

pub(crate) async fn apply_saved<T>(
    store: LocalStore,
    session: Arc<Guarded<T>>,
    transaction_id: String,
    resolution_id: String,
    account_binding: String,
    permission: Arc<dyn Fn() -> AppResult<()> + Send + Sync>,
) -> AppResult<Value>
where
    T: Transport + durable::Transport + Send + Sync + 'static,
{
    if !matches!(
        durable::Transport::role(&session.transport),
        "owner" | "admin" | "member" | "accountant"
    ) {
        return Err(invalid(
            "Votre rôle ne permet pas d’appliquer cette résolution.",
        ));
    }
    let (s, t, id) = (store.clone(), session.clone(), resolution_id.clone());
    let completed = tauri::async_runtime::spawn_blocking(move || {
        let _guard = s.lock()?;
        Transport::ensure_current(t.as_ref(), &s)?;
        super::super::selection(&s, durable::Transport::organization(&t.transport))?;
        saved::installation::installed(&s, &s.connect()?, &id)
    })
    .await
    .map_err(|_| invalid("La vérification de l’installation a été interrompue."))??;
    if let Some(mut result) = completed {
        if result["transaction_id"] != transaction_id {
            return Err(invalid(
                "La résolution terminée appartient à une autre transaction.",
            ));
        }
        result["workspace_changed"] = json!(true); // Also reload after a lost result.
        result["selection"] = serde_json::to_value(super::super::selection(
            &store,
            durable::Transport::organization(&session.transport),
        )?)?;
        return Ok(result);
    }
    retire_saved(
        store.clone(),
        session.clone(),
        transaction_id,
        resolution_id.clone(),
        account_binding,
        permission.clone(),
    )
    .await?;
    install_saved(store, session, resolution_id, permission).await
}

async fn install_saved<T>(
    store: LocalStore,
    session: Arc<Guarded<T>>,
    resolution_id: String,
    permission: Arc<dyn Fn() -> AppResult<()> + Send + Sync>,
) -> AppResult<Value>
where
    T: Transport + durable::Transport + Send + Sync + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = saved::installation::install(
            &store,
            &resolution_id,
            || Transport::ensure_current(session.as_ref(), &store),
            |point| {
                if point == saved::installation::Point::Prepared {
                    permission()?;
                }
                Ok(())
            },
        )?;
        // The selected capture changed at commit. Do not run Guarded::check
        // against its old value afterwards; return the new selection to reload.
        durable::Transport::ensure_current(&session.transport, &store)?;
        result["workspace_changed"] = json!(true);
        result["selection"] = serde_json::to_value(super::super::selection(
            &store,
            durable::Transport::organization(&session.transport),
        )?)?;
        Ok::<_, AppError>(result)
    })
    .await
    .map_err(|_| {
        invalid(
            "L’installation a été interrompue. Rechargez le dossier avant de reprendre la saisie.",
        )
    })?
}

/// Cancellation is a server decision: an already accepted retirement must finish
/// installing the exact sealed choice, even when the user requested cancellation.
pub(crate) async fn cancel_saved<T>(
    store: LocalStore,
    session: Arc<Guarded<T>>,
    transaction_id: String,
    resolution_id: String,
    permission: Arc<dyn Fn() -> AppResult<()> + Send + Sync>,
) -> AppResult<Value>
where
    T: Transport
        + crate::business_sync::retirement::cancellation::durable::Transport
        + Send
        + Sync
        + 'static,
{
    use crate::business_sync::retirement::cancellation::durable as cancellation;
    let (s, t, id, received) = (
        store.clone(),
        session.clone(),
        resolution_id.clone(),
        transaction_id.clone(),
    );
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let _guard = s.lock()?;
        Transport::ensure_current(t.as_ref(), &s)?;
        let c = s.connect()?;
        if let Some(done) = saved::installation::installed(&s, &c, &id)? {
            if done["transaction_id"] != received {
                return Err(invalid("La résolution appartient à une autre transaction."));
            }
            return Ok(true);
        }
        if let Some(frozen) = durable::load(&c, &s)? {
            durable::authorize(&s, &t, &frozen)?;
            if frozen.intent.resolution_id != id
                || frozen.intent.received_transaction_id != received
            {
                return Err(invalid(
                    "Reprenez la résolution déjà protégée de ce dossier.",
                ));
            }
        }
        Ok(false)
    })
    .await
    .map_err(|_| invalid("La lecture de la résolution a été interrompue."))??;
    if installed {
        return apply_saved(
            store,
            session,
            transaction_id,
            resolution_id,
            String::new(),
            permission,
        )
        .await;
    }
    let allowed = permission.clone();
    tauri::async_runtime::spawn_blocking(move || allowed())
        .await
        .map_err(|_| invalid("Le contrôle de l’interface a été interrompu."))??;
    match cancellation::run(store.clone(), session.clone(), resolution_id.clone()).await? {
        cancellation::Outcome::Cancelled(mut result) => {
            if result["transaction_id"] != transaction_id {
                return Err(invalid("L’annulation appartient à une autre transaction."));
            }
            result["selection"] = serde_json::to_value(super::super::selection(
                &store,
                durable::Transport::organization(&session.transport),
            )?)?;
            Ok(result)
        }
        cancellation::Outcome::Retired(frozen) => {
            if frozen.intent.resolution_id != resolution_id {
                return Err(invalid("La résolution acceptée a changé."));
            }
            let mut result = install_saved(store, session, resolution_id, permission).await?;
            result["cancellation_superseded"] = json!(true);
            Ok(result)
        }
    }
}

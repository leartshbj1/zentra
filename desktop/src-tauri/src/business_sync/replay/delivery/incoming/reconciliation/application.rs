//! Application stages shared by the future installer and recovery command.
//! Kept out of Tauri's command surface until replacement installation and the
//! interface reload can complete the operation that freezes shared writes.
use super::*;
use crate::business_sync::{cycle::Guarded, retirement::durable};
use crate::error::AppError;
use std::sync::Arc;

#[allow(dead_code)] // Called by the installer once its atomic replacement path is connected.
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

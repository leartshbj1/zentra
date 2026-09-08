//! Explicit initial publication. A durable write guard survives lost responses
//! and restarts; only a matching server receipt or abandonment releases it.
use super::*;
use rusqlite::Transaction;

pub(in crate::business_sync::snapshot) fn begin_intent(
    tx: &Transaction<'_>,
    p: &Prepared,
) -> AppResult<()> {
    if p.manifest.version != 3 {
        return Err(invalid(
            "Annulez cette ancienne préparation puis préparez à nouveau le partage.",
        ));
    }
    let dirty:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_changes WHERE generation=?) OR EXISTS(SELECT 1 FROM business_sync_baseline)",[&p.transfer_id],|r|r.get(0))?;
    if dirty {
        return Err(invalid("Le dossier a changé depuis sa préparation. Annulez cette préparation puis relancez le partage pour inclure vos dernières modifications."));
    }
    let previous:Option<(String,String,String)>=tx.query_row("SELECT organization_id,installation_id,transfer_id FROM business_sync_publication_intent WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some(old) = previous {
        if old
            != (
                p.organization_id.clone(),
                p.installation_id.clone(),
                p.transfer_id.clone(),
            )
        {
            return Err(invalid("Une autre publication attend sa confirmation."));
        }
    } else {
        tx.execute(
            "INSERT INTO business_sync_publication_intent VALUES(1,?,?,?,'preparing',?)",
            params![
                p.organization_id,
                p.installation_id,
                p.transfer_id,
                now_iso()
            ],
        )?;
    }
    Ok(())
}
pub(super) fn has_intent(store: &LocalStore) -> AppResult<bool> {
    Ok(store.connect()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_publication_intent)",
        [],
        |r| r.get(0),
    )?)
}
pub(super) fn is_committing(store: &LocalStore) -> AppResult<bool> {
    Ok(store.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_publication_intent WHERE state IN ('checking','publishing'))",[],|r|r.get(0))?)
}
fn exclusive() -> AppResult<RunGuard> {
    RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| {
            invalid("Un transfert est déjà en cours. Réessayez dans quelques secondes.")
        })?;
    Ok(RunGuard)
}
fn phase(store: &LocalStore, bound: &BoundSnapshot) -> AppResult<String> {
    let value:Option<String>=store.connect()?.query_row("SELECT state FROM business_sync_publication_intent WHERE organization_id=? AND installation_id=? AND transfer_id=?",params![bound.prepared.organization_id,store.installation_id,bound.prepared.transfer_id],|r|r.get(0)).optional()?;
    value.ok_or_else(|| invalid("Cette publication n’a pas été demandée sur cet appareil."))
}
fn advance(store: &LocalStore, bound: &BoundSnapshot, next: &str) -> AppResult<()> {
    let _guard = store.lock()?;
    ensure_bound(store, bound)?;
    let mut c = store.connect()?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    begin_intent(&tx, &bound.prepared)?;
    tx.execute(
        "UPDATE business_sync_publication_intent SET state=? WHERE transfer_id=?",
        params![next, bound.prepared.transfer_id],
    )?;
    tx.commit()?;
    Ok(())
}
trait PublicationTransport {
    fn organization(&self) -> &str;
    fn role(&self) -> &str;
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()>;
    fn call(
        &self,
        method: Method,
        path: &str,
        id: &str,
    ) -> impl Future<Output = AppResult<(u16, Vec<u8>)>> + Send;
}
impl PublicationTransport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn call(&self, method: Method, path: &str, id: &str) -> AppResult<(u16, Vec<u8>)> {
        let post = method == Method::POST;
        let query = if post || id.is_empty() {
            vec![]
        } else {
            vec![("transfer_id", id)]
        };
        let headers = if post {
            vec![("content-type", "application/json".into())]
        } else {
            vec![]
        };
        let body = if post {
            Some(serde_json::to_vec(&json!({"transfer_id":id}))?)
        } else {
            None
        };
        let readonly = method == Method::GET;
        let (status, bytes) = self
            .request_status(method, path, &query, &headers, body, readonly)
            .await?;
        Ok((status.as_u16(), bytes))
    }
}
fn successful(status: u16, bytes: Vec<u8>) -> AppResult<Vec<u8>> {
    if (200..300).contains(&status) {
        return Ok(bytes);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let message = value["error"]
        .as_str()
        .filter(|s| s.len() < 1500)
        .unwrap_or(
            "La publication n’a pas été confirmée. Vous pouvez reprendre sans perdre vos données.",
        );
    Err(invalid(message))
}
fn confirmed(
    store: &LocalStore,
    bound: &BoundSnapshot,
    generation: &str,
    bytes: &[u8],
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    let receipt = super::super::incoming::validate_source_receipt(
        &bound.prepared,
        &bound.folder,
        files::manifest_json(bound)?,
        generation,
        bytes,
    )?;
    let _guard = store.lock()?;
    ensure_current()?;
    ensure_bound(store, bound)?;
    let mut c = store.connect()?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT receipt_json FROM business_sync_baseline WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if serde_json::from_str::<Value>(&old)? != receipt {
            return Err(invalid(
                "Un autre historique est déjà installé sur cet appareil.",
            ));
        }
        return Ok(
            json!({"state":"history_installed","already_installed":true,"replication_active":false}),
        );
    }
    let intent:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_publication_intent WHERE transfer_id=? AND organization_id=? AND installation_id=? AND state='publishing')",params![bound.prepared.transfer_id,bound.prepared.organization_id,store.installation_id],|r|r.get(0))?;
    if !intent {
        return Err(invalid("La demande locale de publication a changé."));
    }
    let other: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM shared_numbering_binding WHERE organization_id<>?)",
        [&bound.prepared.organization_id],
        |r| r.get(0),
    )?;
    if other {
        return Err(invalid(
            "Les numéros de cet appareil sont liés à une autre entreprise.",
        ));
    }
    tx.execute(
        "INSERT INTO business_sync_baseline VALUES(1,?,?,?,?,'published',?)",
        params![
            bound.prepared.organization_id,
            generation,
            bound.prepared.transfer_id,
            serde_json::to_string(&receipt)?,
            now_iso()
        ],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO shared_numbering_binding VALUES(1,?,?)",
        params![bound.prepared.organization_id, now_iso()],
    )?;
    tx.execute(
        "DELETE FROM business_sync_publication_intent WHERE transfer_id=?",
        [&bound.prepared.transfer_id],
    )?;
    tx.commit()?;
    Ok(
        json!({"state":"history_installed","transfer_id":bound.prepared.transfer_id,"pending_transactions":0,"replication_active":false}),
    )
}
async fn pass(store: &LocalStore, t: &impl PublicationTransport) -> AppResult<Value> {
    if !matches!(t.role(), "owner" | "admin") {
        return Err(invalid(
            "Seuls le titulaire et les administrateurs peuvent publier ce dossier.",
        ));
    }
    t.ensure_current(store)?;
    let bound = load_prepared(store, t.organization())?
        .ok_or_else(|| invalid("Préparez le dossier avant sa publication."))?;
    let id = &bound.prepared.transfer_id;
    let mut state = phase(store, &bound)?;
    let receipts = read_receipts(&bound)?
        .ok_or_else(|| invalid("Terminez l’envoi du dossier avant sa publication."))?;
    if receipts.remote.state != "uploaded" {
        return Err(invalid("L’envoi des données n’est pas terminé."));
    }
    if state == "preparing" {
        let (code, bytes) = t
            .call(Method::POST, "/api/sync/bootstrap/structure", id)
            .await?;
        t.ensure_current(store)?;
        let check: Value = serde_json::from_slice(&successful(code, bytes)?)?;
        if check["state"] == "invalid" {
            return Err(invalid("Le contrôle du dossier a trouvé une incohérence. Annulez la préparation pour la corriger."));
        }
        if check["state"] != "valid" {
            return Ok(
                json!({"state":"history_checking","step":"structure","replication_active":false}),
            );
        }
        advance(store, &bound, "checking")?;
        state = "checking".into();
    }
    if state == "checking" {
        let (code, bytes) = t
            .call(Method::POST, "/api/sync/bootstrap/integrity", id)
            .await?;
        t.ensure_current(store)?;
        let check: Value = serde_json::from_slice(&successful(code, bytes)?)?;
        if check["state"] == "invalid" {
            return Err(invalid("Le contrôle comptable n’est pas terminé : une incohérence doit être corrigée avant le partage."));
        }
        if check["state"] != "valid" {
            return Ok(
                json!({"state":"history_checking","step":"accounting","replication_active":false}),
            );
        }
        advance(store, &bound, "publishing")?;
    }
    // Persisted before POST. A restart goes straight back to this idempotent
    // endpoint, even if ordinary upload endpoints now say `committed`.
    t.ensure_current(store)?;
    let (code, bytes) = t
        .call(Method::POST, "/api/sync/bootstrap/publish", id)
        .await?;
    let bytes = successful(code, bytes)?;
    confirmed(store, &bound, &receipts.remote.generation, &bytes, || {
        t.ensure_current(store)
    })
}
pub(super) async fn publication_pass(
    store: &LocalStore,
    session: &ProjectSyncSession,
) -> AppResult<Value> {
    pass(store, session).await
}

async fn cancel(store: &LocalStore, t: &impl PublicationTransport) -> AppResult<Value> {
    if !matches!(t.role(), "owner" | "admin") {
        return Err(invalid(
            "Seuls le titulaire et les administrateurs peuvent annuler cette préparation.",
        ));
    }
    t.ensure_current(store)?;
    let bound = load_prepared(store, t.organization())?
        .ok_or_else(|| invalid("Aucune préparation à annuler sur cet appareil."))?;
    let (code, bytes) = t
        .call(
            Method::DELETE,
            "/api/sync/bootstrap",
            &bound.prepared.transfer_id,
        )
        .await?;
    t.ensure_current(store)?;
    if code == 409 {
        let (head_code, head_bytes) = t
            .call(
                Method::GET,
                "/api/sync/history",
                &bound.prepared.transfer_id,
            )
            .await?;
        let head: Value = serde_json::from_slice(&successful(head_code, head_bytes)?)?;
        if head["state"] == "published" {
            let receipts = read_receipts(&bound)?
                .ok_or_else(|| invalid("Les reçus de cette préparation sont absents."))?;
            advance(store, &bound, "publishing")?;
            return confirmed(
                store,
                &bound,
                &receipts.remote.generation,
                &serde_json::to_vec(&head["receipt"])?,
                || t.ensure_current(store),
            );
        }
        return successful(code, bytes).map(|_| Value::Null);
    }
    if code == 404 && read_receipts(&bound)?.is_none() && !is_committing(store)? {
        // No remote upload was ever acknowledged. A late abandoned upload can
        // at most leave unpublished staging; it cannot publish without intent.
    } else {
        let result: Value = serde_json::from_slice(&successful(code, bytes)?)?;
        if result["state"] != "abandoned" || result["transfer_id"] != bound.prepared.transfer_id {
            return Err(invalid("L’annulation distante n’a pas été confirmée."));
        }
    }
    let _guard = store.lock()?;
    t.ensure_current(store)?;
    ensure_bound(store, &bound)?;
    let mut c = store.connect()?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let installed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_baseline)",
        [],
        |r| r.get(0),
    )?;
    if installed {
        return Err(invalid("Un historique publié ne peut plus être annulé."));
    }
    tx.execute(
        "DELETE FROM business_sync_publication_intent WHERE transfer_id=?",
        [&bound.prepared.transfer_id],
    )?;
    super::super::super::detach_capture(&tx)?;
    tx.execute(
        "DELETE FROM business_sync_binding WHERE generation=?",
        [&bound.prepared.transfer_id],
    )?;
    // Keep old frozen files and journal evidence. The next snapshot incorporates
    // the actual current business rows; no transaction receipt is invented.
    tx.commit()?;
    Ok(json!({"state":"not_prepared","replication_active":false}))
}

#[tauri::command]
pub async fn start_business_publication(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _run = exclusive().map_err(command_error)?;
    let store = state.inner().clone();
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or_else(|| "Connectez votre compte avant de partager ce dossier.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        session.ensure_current_for(&store)?;
        let p =
            store.prepare_business_snapshot_mode(&session.organization_id, &session.role, true)?;
        session.ensure_current_for(&store)?;
        Ok::<_, crate::error::AppError>(
            json!({"state":"uploading","transfer_id":p.transfer_id,"replication_active":false}),
        )
    })
    .await
    .map_err(|_| "La préparation a été interrompue.".to_owned())?
    .map_err(command_error)
}
#[tauri::command]
pub async fn cancel_business_publication(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _run = exclusive().map_err(command_error)?;
    let session = project_sync_session(state.inner())
        .await
        .map_err(command_error)?
        .ok_or_else(|| {
            "Reconnectez le compte qui a préparé ce dossier pour confirmer son annulation."
                .to_owned()
        })?;
    cancel(state.inner(), &session).await.map_err(command_error)
}

fn local_state(store: &LocalStore, organization: &str, role: &str) -> AppResult<Value> {
    let c = store.connect()?;
    let binding: Option<(String, String, bool)> = c
        .query_row(
            "SELECT organization_id,installation_id,capture_enabled FROM business_sync_binding",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let compatible = binding
        .as_ref()
        .is_none_or(|b| b.0 == organization && b.1 == store.installation_id && b.2);
    let installed: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_baseline)",
        [],
        |r| r.get(0),
    )?;
    let configured: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE onboarding_completed=1)",
        [],
        |r| r.get(0),
    )?;
    let phase: Option<String> = c
        .query_row(
            "SELECT state FROM business_sync_publication_intent",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let fresh = super::super::incoming::import::require_fresh(&c).is_ok();
    let pending = super::super::super::status(&c)?;
    Ok(json!({"connected":true,"organization_id":organization,
        "state":if !compatible {"needs_reconciliation"}else if installed {"installed"}else{phase.as_deref().unwrap_or(if binding.is_some(){"prepared"}else{"not_prepared"})},
        "can_publish":compatible && configured && !installed && matches!(role,"owner"|"admin"),"can_import":fresh,
        "publication_pending":phase.is_some(),"pending_transactions":pending["pending_transactions"]}))
}
#[tauri::command]
pub async fn get_business_history_state(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner();
    let Some(session) = project_sync_session(store).await.map_err(command_error)? else {
        return Ok(json!({"connected":false}));
    };
    let mut result =
        local_state(store, &session.organization_id, &session.role).map_err(command_error)?;
    let (code, bytes) = PublicationTransport::call(&session, Method::GET, "/api/sync/history", "")
        .await
        .map_err(command_error)?;
    let head: Value = serde_json::from_slice(&successful(code, bytes).map_err(command_error)?)
        .map_err(|_| "L'état du partage est illisible.".to_owned())?;
    session.ensure_current_for(store).map_err(command_error)?;
    result["has_remote_history"] = json!(head["state"] == "published");
    result["remote_transfer_id"] = head["receipt"]["transfer_id"].clone();
    Ok(result)
}

#[cfg(test)]
mod tests;

//! The retirement stage of conflict application. Persist dispatch intent before
//! HTTP, then retain the exact authenticated receipt before any installation.
//! No response, including 404/409, can unfreeze a possibly dispatched request.
use super::{Intent, Receipt, MAX_PROOF_BYTES};
use crate::{
    account_cloud::ProjectSyncSession,
    business_sync::cycle::Guarded,
    database::LocalStore,
    error::{AppError, AppResult},
};
use reqwest::{Method, StatusCode};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{future::Future, sync::Arc};

const API: &str = "/api/sync/transactions/retirement";

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    Prepared,
    Retiring,
    Retired,
}
pub(crate) struct Frozen {
    pub intent: Intent,
    pub raw_intent: String,
    pub stage: Stage,
    pub retirement: Option<String>,
    pub cancellation_requested: bool,
}

pub(crate) trait Transport {
    fn organization(&self) -> &str;
    fn role(&self) -> &str;
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()>;
    fn get(&self, id: &str) -> impl Future<Output = AppResult<(StatusCode, Vec<u8>)>> + Send;
    fn post(&self, body: Vec<u8>) -> impl Future<Output = AppResult<(StatusCode, Vec<u8>)>> + Send;
}
impl Transport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn get(&self, id: &str) -> AppResult<(StatusCode, Vec<u8>)> {
        self.request_status(Method::GET, API, &[("resolution_id", id)], &[], None, false)
            .await
    }
    async fn post(&self, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
        self.request_status(
            Method::POST,
            API,
            &[],
            &[("content-type", "application/json".into())],
            Some(body),
            false,
        )
        .await
    }
}

/// Read and validate against the *installed* identity, including after restore.
/// The caller owns the working-store mutex or an equivalent SQLite snapshot.
pub(crate) fn load(c: &Connection, store: &LocalStore) -> AppResult<Option<Frozen>> {
    if crate::cloud_backup::is_restoring() {
        return Err(invalid("Attendez la fin de la restauration."));
    }
    type Row = (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        bool,
    );
    let row: Option<Row> = c.query_row(
        "SELECT resolution_id,proposal_sha256,intent_json,intent_sha256,state,retirement_json,retirement_sha256,cancellation_requested FROM business_sync_resolution_intent WHERE id=1",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
    ).optional()?;
    let Some((id, proposal, raw, seal, state, retirement, retirement_seal, cancellation_requested)) =
        row
    else {
        return Ok(None);
    };
    let intent = Intent::read(raw.as_bytes())?;
    let current: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id LEFT JOIN business_sync_cursor c ON c.id=b.id WHERE b.id=1 AND b.capture_enabled=1 AND b.organization_id=?1 AND b.installation_id=?2 AND b.generation=?3 AND h.organization_id=b.organization_id AND h.server_generation=?4 AND COALESCE(c.revision,1)=?5 AND (c.id IS NULL OR (c.organization_id=b.organization_id AND c.generation=h.server_generation))) AND NOT EXISTS(SELECT 1 FROM business_sync_publication_intent) AND NOT EXISTS(SELECT 1 FROM business_sync_resolutions WHERE resolution_id=?6)",
        params![intent.organization_id,intent.installation_id,intent.capture_generation,intent.generation,intent.source_revision,id],
        |r|r.get(0),
    )?;
    if id != intent.resolution_id
        || proposal != intent.proposal_sha256
        || seal != digest(raw.as_bytes())
        || intent.installation_id != store.installation_id
        || !current
        || (cancellation_requested && state == "prepared")
        || c.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_resolution_cancellations WHERE resolution_id=?1)", [&id], |r|r.get::<_,bool>(0))?
    {
        return Err(invalid(
            "Cette résolution appartient à un autre état ou appareil. Le dossier reste protégé.",
        ));
    }
    let stage = match (state.as_str(), &retirement, &retirement_seal) {
        ("prepared", None, None) => Stage::Prepared,
        ("retiring", None, None) => Stage::Retiring,
        ("retired", Some(proof), Some(hash)) if digest(proof.as_bytes()) == *hash => {
            Receipt::read(proof.as_bytes(), &intent)?;
            Stage::Retired
        }
        _ => {
            return Err(invalid(
                "La preuve locale de résolution est incomplète. Le dossier reste protégé.",
            ))
        }
    };
    Ok(Some(Frozen {
        intent,
        raw_intent: raw,
        stage,
        retirement,
        cancellation_requested,
    }))
}

/// Called only after proposal, source and files were verified under this same
/// IMMEDIATE/FULL transaction. SQL guards enforce the durable identity fence.
pub(crate) fn prepare(c: &Connection, intent: &Intent) -> AppResult<()> {
    if c.is_autocommit() {
        return Err(invalid(
            "La préparation exige un verrou d’écriture transactionnel.",
        ));
    }
    let raw = serde_json::to_string(intent)?;
    Intent::read(raw.as_bytes())?;
    c.execute("INSERT INTO business_sync_resolution_intent(id,resolution_id,proposal_sha256,intent_json,intent_sha256,state) VALUES(1,?1,?2,?3,?4,'prepared')",
        params![intent.resolution_id,intent.proposal_sha256,raw,digest(raw.as_bytes())])?;
    Ok(())
}

pub(crate) fn authorize<T: Transport>(
    store: &LocalStore,
    transport: &Guarded<T>,
    frozen: &Frozen,
) -> AppResult<()> {
    transport.check(store)?;
    transport.transport.ensure_current(store)?;
    if transport.transport.organization() != frozen.intent.organization_id
        || !matches!(
            transport.transport.role(),
            "owner" | "admin" | "member" | "accountant"
        )
    {
        return Err(invalid(
            "Reconnectez un compte autorisé de cette entreprise pour reprendre la résolution.",
        ));
    }
    Ok(())
}

fn current<T: Transport>(
    store: &LocalStore,
    transport: &Guarded<T>,
    id: &str,
) -> AppResult<Frozen> {
    let c = store.connect()?;
    let tx = c.unchecked_transaction()?;
    let frozen = load(&tx, store)?
        .ok_or_else(|| invalid("Aucune résolution préparée ne correspond à cette reprise."))?;
    if frozen.intent.resolution_id != id {
        return Err(invalid(
            "Les choix enregistrés ont changé. La demande est interrompue.",
        ));
    }
    authorize(store, transport, &frozen)?;
    Ok(frozen)
}

pub(in crate::business_sync::retirement) fn status_error(status: StatusCode) -> AppError {
    // Never include server text: a proxy page or account error may contain data
    // unrelated to this operation. In every case retain the dispatch fence.
    invalid(match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "Reconnectez un compte autorisé pour reprendre cette résolution. Les choix restent conservés.",
        StatusCode::CONFLICT => "L’historique partagé a évolué. La résolution reste protégée et doit être reprise avant de modifier le dossier.",
        _ => "Le serveur n’a pas confirmé la résolution. Les choix restent conservés pour la reprise.",
    })
}

pub(in crate::business_sync::retirement) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            invalid(
                "L’application de la résolution a été interrompue. Reprenez les choix enregistrés.",
            )
        })?
}

/// At most one GET and one identical POST. The Arc retains the cross-process
/// lease while blocking work survives a dropped invoke. This is not an install.
pub(crate) async fn run<T: Transport + Send + Sync + 'static>(
    store: LocalStore,
    transport: Arc<Guarded<T>>,
    id: String,
) -> AppResult<Frozen> {
    let (s, t, key) = (store.clone(), transport.clone(), id.clone());
    let frozen = blocking(move || {
        let _guard = s.lock()?;
        current(&s, &t, &key)
    })
    .await?;
    if frozen.stage == Stage::Retired {
        return Ok(frozen);
    }
    if frozen.cancellation_requested {
        return Err(invalid("L’annulation est déjà demandée. Reprenez sa confirmation avant une nouvelle résolution."));
    }
    let expected = frozen.intent;
    if frozen.stage == Stage::Retiring {
        let (status, raw) = transport.transport.get(&id).await?;
        if status == StatusCode::OK {
            return finish(store, transport, expected, raw).await;
        }
        // A GET 404 says only that the previous POST has not become visible
        // yet. It permits retrying the exact body, never deleting the intent.
        if status != StatusCode::NOT_FOUND {
            return Err(status_error(status));
        }
    }
    let (s, t, e) = (store.clone(), transport.clone(), expected.clone());
    let request = blocking(move || {
        let _guard = s.lock()?;
        let mut c = s.connect()?;
        c.pragma_update(None, "synchronous", "FULL")?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let live = load(&tx, &s)?.ok_or_else(|| invalid("La résolution préparée est absente."))?;
        if live.intent != e || live.stage == Stage::Retired || live.cancellation_requested {
            return Err(invalid("L’étape de résolution a changé avant l’envoi."));
        }
        authorize(&s, &t, &live)?;
        let request = serde_json::to_vec(&e.request())?;
        if tx.execute(
            "UPDATE business_sync_resolution_intent SET state='retiring' WHERE id=1 AND intent_json=?1",
            [&live.raw_intent],
        )? != 1 {
            return Err(invalid("L’intention exacte n’a pas été conservée avant l’envoi."));
        }
        tx.commit()?; // FULL must complete before request bytes can be sent.
        Ok(request)
    })
    .await?;
    // A pause or account switch immediately after the durable transition also
    // retains retiring; a later authorized session resumes the original choice.
    transport.check(&store)?;
    transport.transport.ensure_current(&store)?;
    let (status, raw) = transport.transport.post(request).await?;
    if status != StatusCode::OK {
        return Err(status_error(status));
    }
    finish(store, transport, expected, raw).await
}

pub(in crate::business_sync::retirement) async fn finish<T: Transport + Send + Sync + 'static>(
    store: LocalStore,
    transport: Arc<Guarded<T>>,
    expected: Intent,
    raw: Vec<u8>,
) -> AppResult<Frozen> {
    if raw.len() > MAX_PROOF_BYTES {
        return Err(invalid(
            "La réponse de résolution dépasse la taille autorisée.",
        ));
    }
    Receipt::read(&raw, &expected)?;
    let proof =
        String::from_utf8(raw).map_err(|_| invalid("La preuve de résolution est illisible."))?;
    blocking(move || {
        let _guard = store.lock()?;
        let mut c = store.connect()?;
        c.pragma_update(None, "synchronous", "FULL")?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let live = load(&tx, &store)?.ok_or_else(|| invalid("La résolution à confirmer est absente."))?;
        if live.intent != expected || live.stage != Stage::Retiring {
            return Err(invalid("La résolution a changé pendant la réponse du serveur."));
        }
        authorize(&store, &transport, &live)?;
        tx.execute("UPDATE business_sync_resolution_intent SET state='retired',retirement_json=?1,retirement_sha256=?2 WHERE id=1", params![proof,digest(proof.as_bytes())])?;
        let result = load(&tx, &store)?.ok_or_else(|| invalid("La preuve de résolution n’a pas été conservée."))?;
        if result.retirement.as_deref() != Some(proof.as_str()) || result.raw_intent != live.raw_intent {
            return Err(invalid("Les octets de la preuve enregistrée ne correspondent pas à la réponse."));
        }
        tx.commit()?;
        Ok(result)
    }).await
}

/// Cancellation is possible only before a POST could have left this device.
/// The lease and SQLite write lock serialize it with dispatch in every process.
#[allow(dead_code)] // The eventual application command may cancel before dispatch only.
pub(crate) fn cancel_prepared<T: Transport>(
    store: &LocalStore,
    transport: &Guarded<T>,
    id: &str,
) -> AppResult<()> {
    let _guard = store.lock()?;
    let mut c = store.connect()?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let frozen = load(&tx, store)?
        .ok_or_else(|| invalid("Aucune résolution préparée ne correspond à cette annulation."))?;
    authorize(store, transport, &frozen)?;
    if frozen.intent.resolution_id != id || frozen.stage != Stage::Prepared {
        return Err(invalid("La demande a peut-être été reçue. Reprenez la résolution avant de modifier le dossier."));
    }
    tx.execute("DELETE FROM business_sync_resolution_intent WHERE id=1", [])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;

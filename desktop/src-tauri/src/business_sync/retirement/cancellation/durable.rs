//! Retain cancellation intent before HTTP. Only an exact durable proof releases
//! the shared-write fence; a retirement that won instead remains installable.
use super::Receipt;
use crate::{
    account_cloud::ProjectSyncSession,
    business_sync::{
        cycle::Guarded,
        retirement::{durable as retirement, Intent, MAX_PROOF_BYTES},
    },
    database::LocalStore,
    error::{AppError, AppResult},
};
use reqwest::{Method, StatusCode};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{future::Future, sync::Arc};

const API: &str = "/api/sync/transactions/retirement/cancel";
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

pub(crate) trait Transport: retirement::Transport {
    fn cancellation_get(
        &self,
        id: &str,
    ) -> impl Future<Output = AppResult<(StatusCode, Vec<u8>)>> + Send;
    fn cancellation_post(
        &self,
        body: Vec<u8>,
    ) -> impl Future<Output = AppResult<(StatusCode, Vec<u8>)>> + Send;
}
impl Transport for ProjectSyncSession {
    async fn cancellation_get(&self, id: &str) -> AppResult<(StatusCode, Vec<u8>)> {
        self.request_status(Method::GET, API, &[("resolution_id", id)], &[], None, false)
            .await
    }
    async fn cancellation_post(&self, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
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
#[allow(dead_code)] // Consumed by the coordinated application flow in preparation.
pub(crate) enum Outcome {
    Cancelled(Value),
    Retired(Box<retirement::Frozen>),
}

#[cfg(test)]
mod tests;

fn completed<T: Transport>(
    store: &LocalStore,
    c: &Connection,
    t: &Guarded<T>,
    id: &str,
) -> AppResult<Option<Value>> {
    t.check(store)?;
    t.transport.ensure_current(store)?;
    let row: Option<(String, String, String, String)> = c.query_row(
        "SELECT intent_json,intent_sha256,cancellation_json,cancellation_sha256 FROM business_sync_resolution_cancellations WHERE resolution_id=?1",
        [id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).optional()?;
    let Some((intent, seal, proof, proof_seal)) = row else {
        return Ok(None);
    };
    let parsed = Intent::read(intent.as_bytes())?;
    Receipt::read(proof.as_bytes(), &parsed)?;
    if digest(intent.as_bytes()) != seal || digest(proof.as_bytes()) != proof_seal
        || parsed.resolution_id != id || parsed.installation_id != store.installation_id
        || parsed.organization_id != t.transport.organization()
        || !matches!(t.transport.role(), "owner"|"admin"|"member"|"accountant")
        || !c.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id WHERE b.id=1 AND b.capture_enabled=1 AND b.organization_id=?1 AND b.installation_id=?2 AND h.organization_id=b.organization_id AND h.server_generation=?3)",params![parsed.organization_id,parsed.installation_id,parsed.generation],|r|r.get::<_,bool>(0))?
    { return Err(invalid("Cette annulation ne correspond pas au compte et au dossier de cet appareil.")); }
    Ok(Some(
        json!({"state":"resolution_cancelled","resolution_id":id,"cancelled":true,"already_cancelled":true,"workspace_changed":false,"requires_new_comparison":true}),
    ))
}

enum Start {
    Complete(Value),
    Frozen(Box<retirement::Frozen>),
}

/// Internal until the UI coordinates the frozen workspace and refresh lifecycle.
#[allow(dead_code)]
pub(crate) async fn run<T: Transport + Send + Sync + 'static>(
    store: LocalStore,
    transport: Arc<Guarded<T>>,
    id: String,
) -> AppResult<Outcome> {
    let (s, t, key) = (store.clone(), transport.clone(), id.clone());
    let start=retirement::blocking(move || {
        let _guard=s.lock()?;
        let mut c=s.connect()?;
        c.pragma_update(None,"synchronous","FULL")?;
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(done)=completed(&s,&tx,&t,&key)? { return Ok(Start::Complete(done)); }
        let frozen=retirement::load(&tx,&s)?.ok_or_else(||invalid("Aucune résolution ne correspond à cette annulation."))?;
        retirement::authorize(&s,&t,&frozen)?;
        if frozen.intent.resolution_id!=key {return Err(invalid("La résolution à annuler a changé."));}
        if frozen.stage==retirement::Stage::Retired {return Ok(Start::Frozen(Box::new(frozen)));}
        if tx.execute("UPDATE business_sync_resolution_intent SET state='retiring',cancellation_requested=1 WHERE id=1 AND intent_json=?1",[&frozen.raw_intent])?!=1 {return Err(invalid("La demande d’annulation n’a pas été enregistrée."));}
        let current=retirement::load(&tx,&s)?.ok_or_else(||invalid("La demande d’annulation est absente."))?;
        if !current.cancellation_requested {return Err(invalid("L’annulation n’est pas conservée."));}
        tx.commit()?; // Complete FULL durability before either network operation.
        Ok(Start::Frozen(Box::new(current)))
    }).await?;
    let expected = match start {
        Start::Complete(result) => return Ok(Outcome::Cancelled(result)),
        Start::Frozen(frozen) if frozen.stage == retirement::Stage::Retired => {
            return Ok(Outcome::Retired(frozen))
        }
        Start::Frozen(frozen) => frozen.intent,
    };
    transport.check(&store)?;
    transport.transport.ensure_current(&store)?;
    let (status, raw) = transport.transport.cancellation_get(&id).await?;
    let raw = if status == StatusCode::OK {
        raw
    } else {
        if status != StatusCode::NOT_FOUND {
            return Err(retirement::status_error(status));
        }
        transport.check(&store)?;
        transport.transport.ensure_current(&store)?;
        let (status, raw) = transport
            .transport
            .cancellation_post(serde_json::to_vec(&expected.request())?)
            .await?;
        if status != StatusCode::OK {
            return Err(retirement::status_error(status));
        }
        raw
    };
    if raw.len() > MAX_PROOF_BYTES {
        return Err(invalid(
            "La confirmation d’annulation est trop volumineuse.",
        ));
    }
    // The server can truthfully return a retirement that won the race. Retain
    // it through the existing exact-proof path, never label it cancelled.
    if crate::business_sync::retirement::Receipt::read(&raw, &expected).is_ok() {
        return Ok(Outcome::Retired(Box::new(
            retirement::finish(store, transport, expected, raw).await?,
        )));
    }
    Receipt::read(&raw, &expected)?;
    let proof = String::from_utf8(raw)
        .map_err(|_| invalid("La confirmation d’annulation est illisible."))?;
    retirement::blocking(move || {
        let _guard = store.lock()?;
        let mut c = store.connect()?;
        c.pragma_update(None, "synchronous", "FULL")?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let frozen = retirement::load(&tx, &store)?
            .ok_or_else(|| invalid("La demande à confirmer est absente."))?;
        retirement::authorize(&store, &transport, &frozen)?;
        if frozen.intent != expected
            || frozen.stage != retirement::Stage::Retiring
            || !frozen.cancellation_requested
        {
            return Err(invalid(
                "La demande a changé pendant la confirmation d’annulation.",
            ));
        }
        tx.execute(
            "INSERT INTO business_sync_resolution_cancellations VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                expected.resolution_id,
                frozen.raw_intent,
                digest(frozen.raw_intent.as_bytes()),
                proof,
                digest(proof.as_bytes()),
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        if tx.execute(
            "DELETE FROM business_sync_resolution_intent WHERE id=1 AND intent_json=?1",
            [&frozen.raw_intent],
        )? != 1
        {
            return Err(invalid("La demande annulée n’a pas pu être libérée."));
        }
        let mut result = completed(&store, &tx, &transport, &id)?
            .ok_or_else(|| invalid("La preuve d’annulation n’a pas été conservée."))?;
        result["already_cancelled"] = json!(false);
        tx.commit()?;
        Ok(Outcome::Cancelled(result))
    })
    .await
}

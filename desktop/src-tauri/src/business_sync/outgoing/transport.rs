//! Upload receipts confirm bytes; only the separate validated server lifecycle
//! can yield a canonical receipt. Neither consumes local pending transactions,
//! reserves numbers or advances the installed business cursor.
use super::*;
use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    error::command_error,
};
use reqwest::Method;
use serde_json::json;
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::State;
const ENDPOINT: &str = "/api/sync/transactions";
mod file_transfer;
mod lifecycle;
struct FileRequest {
    method: Method,
    id: String,
    sha: String,
    index: Option<usize>,
    hash: Option<String>,
    body: Option<Vec<u8>>,
}
static RUNNING: AtomicBool = AtomicBool::new(false);
struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Part {
    chunk_index: usize,
    sha256: String,
    size_bytes: u64,
    change_count: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    transaction_id: String,
    organization_id: String,
    installation_id: String,
    generation: String,
    capture_generation: String,
    manifest_sha256: String,
    state: String,
    received_chunks: Vec<Part>,
    files_pending: usize,
    pending_files: Vec<Blob>,
    canonical_committed: bool,
    #[serde(default, rename = "receipt", skip_serializing_if = "Option::is_none")]
    committed_receipt: Option<Value>,
    replication_active: bool,
}
trait Transport {
    fn organization(&self) -> &str;
    fn role(&self) -> &str;
    fn current(&self, store: &LocalStore) -> AppResult<()>;
    fn lifecycle_request(
        &self,
        _path: &'static str,
        _id: &str,
        _body: Option<Vec<u8>>,
    ) -> impl Future<Output = AppResult<(u16, Vec<u8>)>> + Send {
        async { Err(invalid("Le contrôle serveur n’est pas disponible.")) }
    }
    fn file_request(
        &self,
        _request: FileRequest,
    ) -> impl Future<Output = AppResult<(u16, Vec<u8>)>> + Send {
        async { Err(invalid("Le transport des documents n’est pas disponible.")) }
    }
    fn request(
        &self,
        method: Method,
        id: &str,
        index: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> impl Future<Output = AppResult<(u16, Vec<u8>)>> + Send;
}
impl Transport for ProjectSyncSession {
    async fn lifecycle_request(
        &self,
        path: &'static str,
        id: &str,
        body: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let headers = if body.is_some() {
            vec![("content-type", "application/json".into())]
        } else {
            vec![]
        };
        let (code, bytes) = self
            .request_status(
                Method::POST,
                path,
                &[("transaction_id", id)],
                &headers,
                body,
                false,
            )
            .await?;
        Ok((code.as_u16(), bytes))
    }
    async fn file_request(&self, r: FileRequest) -> AppResult<(u16, Vec<u8>)> {
        let index = r.index.map(|i| i.to_string());
        let mut query = vec![
            ("transaction_id", r.id.as_str()),
            ("sha256", r.sha.as_str()),
        ];
        if let Some(ref i) = index {
            query.push(("part", i));
        }
        let headers = r
            .hash
            .map(|hash| vec![("x-content-sha256", hash)])
            .unwrap_or_default();
        let (code, bytes) = self
            .request_status(
                r.method,
                "/api/sync/transactions/file",
                &query,
                &headers,
                r.body,
                false,
            )
            .await?;
        Ok((code.as_u16(), bytes))
    }
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn request(
        &self,
        method: Method,
        id: &str,
        index: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let index = index.map(|v| v.to_string());
        let mut query = vec![("transaction_id", id)];
        if let Some(ref index) = index {
            query.push(("chunk", index));
        }
        let headers = if method == Method::POST {
            vec![("content-type", "application/json".into())]
        } else {
            vec![]
        };
        let (code, bytes) = self
            .request_status(method, ENDPOINT, &query, &headers, body, false)
            .await?;
        Ok((code.as_u16(), bytes))
    }
}
fn bound(store: &LocalStore, p: &Prepared) -> AppResult<()> {
    let valid:bool=store.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_binding b JOIN business_sync_baseline a ON a.organization_id=b.organization_id WHERE b.id=1 AND b.organization_id=? AND b.installation_id=? AND b.generation=? AND b.capture_enabled=1 AND a.server_generation=? AND a.source_transfer_id=?)",params![p.manifest.organization_id,store.installation_id,p.manifest.capture_generation,p.manifest.generation,p.manifest.bootstrap_transfer_id],|r|r.get(0))?;
    if !valid {
        return Err(invalid(
            "Le dossier local a changé pendant son envoi. Reprenez depuis le profil d’origine.",
        ));
    }
    Ok(())
}
fn receipt(
    code: u16,
    bytes: &[u8],
    p: &Prepared,
    hash: &str,
    previous: Option<&Receipt>,
) -> AppResult<Receipt> {
    if !(200..300).contains(&code) {
        let v: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
        return Err(invalid(
            v["error"]
                .as_str()
                .filter(|s| s.len() < 1500)
                .unwrap_or("L’envoi est interrompu. Les modifications locales sont conservées."),
        ));
    }
    let r: Receipt = serde_json::from_slice(bytes)?;
    let m = &p.manifest;
    if r.transaction_id != m.transaction_id
        || r.organization_id != m.organization_id
        || r.installation_id != m.installation_id
        || r.generation != m.generation
        || r.capture_generation != m.capture_generation
        || r.manifest_sha256 != hash
        || r.canonical_committed != (r.state == "committed")
        || r.committed_receipt.is_some() != r.canonical_committed
        || r.replication_active
        || !matches!(
            r.state.as_str(),
            "receiving" | "awaiting_files" | "awaiting_validation" | "invalid" | "committed"
        )
        || r.files_pending > m.files.len()
        || r.pending_files.len() != r.files_pending.min(8)
        || (matches!(r.state.as_str(), "awaiting_validation" | "committed") && r.files_pending != 0)
        || (r.state == "awaiting_files" && r.files_pending == 0)
    {
        return Err(invalid(
            "Le reçu de transfert ne correspond pas à l’opération préparée.",
        ));
    }
    let mut previous_file = "";
    for file in &r.pending_files {
        if file.sha256.as_str() <= previous_file || !m.files.contains(file) {
            return Err(invalid(
                "Le serveur demande un document absent de cette transaction.",
            ));
        }
        previous_file = &file.sha256;
    }
    if previous.is_some_and(|p| r.files_pending > p.files_pending) {
        return Err(invalid("Le reçu des documents a régressé."));
    }
    let mut indices = std::collections::BTreeSet::new();
    for part in &r.received_chunks {
        let expected = m
            .chunks
            .get(part.chunk_index)
            .ok_or_else(|| invalid("Le reçu comporte un fragment inconnu."))?;
        if !indices.insert(part.chunk_index)
            || part.sha256 != expected.sha256
            || part.size_bytes != expected.size_bytes
            || part.change_count != expected.change_count
        {
            return Err(invalid(
                "Un fragment du reçu ne correspond pas aux octets préparés.",
            ));
        }
    }
    if r.state != "receiving" && indices.len() != m.chunks.len() {
        return Err(invalid(
            "Le reçu annonce une transaction incomplète comme reçue.",
        ));
    }
    if r.state == "awaiting_files" && m.files.is_empty() {
        return Err(invalid("Le reçu de documents est incohérent."));
    }
    if previous.is_some_and(|old| {
        old.received_chunks
            .iter()
            .any(|c| !indices.contains(&c.chunk_index))
    }) {
        return Err(invalid(
            "Un fragment précédemment reçu a disparu du serveur.",
        ));
    }
    if r.state == "invalid" {
        return Err(invalid("Le serveur a reçu une transaction incohérente. Les modifications locales restent conservées pour leur réconciliation."));
    }
    if let Some(committed) = &r.committed_receipt {
        crate::business_sync::replay::delivery::verify_outgoing_receipt(
            &serde_json::to_vec(committed)?,
            m,
            hash,
        )?;
    }
    Ok(r)
}
async fn transfer(store: &LocalStore, t: &impl Transport, p: &Prepared) -> AppResult<Value> {
    if t.organization() != p.manifest.organization_id
        || !matches!(t.role(), "owner" | "admin" | "member" | "accountant")
    {
        return Err(invalid(
            "Ce compte ne peut pas envoyer les modifications de ce dossier.",
        ));
    }
    t.current(store)?;
    bound(store, p)?;
    let manifest_json = serde_json::to_string(&p.manifest)?;
    let hash = digest(manifest_json.as_bytes());
    let id = &p.manifest.transaction_id;
    let (mut code, mut bytes) = t.request(Method::GET, id, None, None).await?;
    t.current(store)?;
    bound(store, p)?;
    if code == 404 {
        (code, bytes) = t
            .request(
                Method::POST,
                id,
                None,
                Some(serde_json::to_vec(&json!({"manifest_json":manifest_json}))?),
            )
            .await?;
    }
    t.current(store)?;
    bound(store, p)?;
    let mut result = receipt(code, &bytes, p, &hash, None)?;
    if let Some(committed) = &result.committed_receipt {
        return Ok(lifecycle::committed_status(committed.clone(), 0));
    }
    let mut missing = (0..p.manifest.chunks.len())
        .filter(|i| !result.received_chunks.iter().any(|r| r.chunk_index == *i))
        .collect::<Vec<_>>();
    // A crash may occur after the last SQL batch but before row sealing. Retry
    // that same final PUT; GET never pretends to finalize the business changes.
    if missing.is_empty() && result.state == "receiving" {
        missing.push(p.manifest.chunks.len() - 1);
    }
    let mut sent = 0;
    for index in missing.into_iter().take(8) {
        if result.canonical_committed {
            break;
        }
        t.current(store)?;
        bound(store, p)?;
        let body = p.read_chunk(index)?;
        let (code, bytes) = t.request(Method::PUT, id, Some(index), Some(body)).await?;
        t.current(store)?;
        bound(store, p)?;
        result = receipt(code, &bytes, p, &hash, Some(&result))?;
        sent += 1;
    }
    let mut sent_files = 0;
    if result.state == "awaiting_files" && sent < 8 {
        sent_files = file_transfer::send(store, t, p, &result.pending_files, 8 - sent).await?;
        t.current(store)?;
        bound(store, p)?;
        let (code, bytes) = t.request(Method::GET, id, None, None).await?;
        t.current(store)?;
        bound(store, p)?;
        result = receipt(code, &bytes, p, &hash, Some(&result))?;
    }
    if let Some(committed) = &result.committed_receipt {
        return Ok(lifecycle::committed_status(committed.clone(), 0));
    }
    Ok(
        json!({"state":result.state,"transaction_id":id,"received_chunks":result.received_chunks.len(),"total_chunks":p.manifest.chunks.len(),"sent_chunks":sent,"sent_file_parts":sent_files,"files_pending":result.files_pending,"canonical_committed":false,"replication_active":false}),
    )
}

#[tauri::command]
pub async fn sync_business_transactions(state: State<'_, LocalStore>) -> Result<Value, String> {
    RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Un envoi de modifications est déjà en cours.".to_owned())?;
    let _run = RunGuard;
    let store = state.inner().clone();
    let Some(session) = project_sync_session(&store).await.map_err(command_error)? else {
        return Ok(
            json!({"state":"waiting_for_connection","canonical_committed":false,"replication_active":false}),
        );
    };
    let (store, session, prepared) = tauri::async_runtime::spawn_blocking(move || {
        session.ensure_current_for(&store)?;
        let prepared = prepare_next(&store, &session.organization_id, &session.role)?;
        session.ensure_current_for(&store)?;
        Ok::<_, AppError>((store, session, prepared))
    })
    .await
    .map_err(|_| "La préparation des modifications a été interrompue.".to_owned())?
    .map_err(command_error)?;
    let Some(prepared) = prepared else {
        return Ok(
            json!({"state":"nothing_to_send","canonical_committed":false,"replication_active":false}),
        );
    };
    synchronize(&store, &session, &prepared)
        .await
        .map_err(command_error)
}

async fn synchronize(store: &LocalStore, t: &impl Transport, p: &Prepared) -> AppResult<Value> {
    let uploaded = transfer(store, t, p).await?;
    if uploaded["state"] != "awaiting_validation" {
        return Ok(uploaded);
    }
    let used = uploaded["sent_chunks"].as_u64().unwrap_or(0)
        + uploaded["sent_file_parts"].as_u64().unwrap_or(0);
    let remaining = 8u64.saturating_sub(used) as usize;
    if remaining == 0 {
        return Ok(uploaded);
    }
    lifecycle::advance(store, t, p, remaining).await
}

#[cfg(test)]
mod tests;

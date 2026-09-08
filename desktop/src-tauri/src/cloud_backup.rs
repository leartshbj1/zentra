use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};
use chrono::{DateTime, Utc};
use reqwest::Method;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::State;
use uuid::Uuid;

const CHUNK_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHUNKS: usize = 64;
const CONFIG_FILE: &str = "cloud-backup-state.json";
static RUNNING: AtomicBool = AtomicBool::new(false);
static RESTORING: AtomicBool = AtomicBool::new(false);
pub(crate) fn is_restoring() -> bool {
    RESTORING.load(Ordering::Acquire)
}
struct RestoreGuard;
impl Drop for RestoreGuard {
    fn drop(&mut self) {
        RESTORING.store(false, Ordering::Release);
    }
}
struct TransferGuard;
impl TransferGuard {
    fn take() -> AppResult<Self> {
        RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| validation("Une opération de sauvegarde est déjà en cours."))?;
        Ok(Self)
    }
}
impl Drop for TransferGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}
fn validation(message: &str) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Chunk {
    sha256: String,
    size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    app_version: String,
    sha256: String,
    size_bytes: u64,
    chunks: Vec<Chunk>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    backup_id: String,
    manifest: Manifest,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Preferences {
    enabled: bool,
    organization_id: Option<String>,
    last_success_at: Option<String>,
    last_error: Option<String>,
    pending: Option<Pending>,
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn validate_id(id: &str) -> AppResult<()> {
    let parsed =
        Uuid::parse_str(id).map_err(|_| validation("Référence de sauvegarde invalide."))?;
    if parsed.get_version_num() != 4
        || parsed.get_variant() != uuid::Variant::RFC4122
        || parsed.to_string() != id
    {
        return Err(validation("Référence de sauvegarde invalide."));
    }
    Ok(())
}
impl Manifest {
    fn validate(&self) -> AppResult<()> {
        if self.format != "zentra-cloud-backup"
            || self.version != 1
            || self.chunks.is_empty()
            || self.chunks.len() > MAX_CHUNKS
            || self.app_version.is_empty()
            || self.app_version.len() > 60
            || !valid_hash(&self.sha256)
        {
            return Err(validation(
                "Format de sauvegarde distante non pris en charge.",
            ));
        }
        let mut size = 0;
        for (i, part) in self.chunks.iter().enumerate() {
            if !valid_hash(&part.sha256)
                || part.size_bytes == 0
                || part.size_bytes > CHUNK_BYTES as u64
                || (i + 1 < self.chunks.len() && part.size_bytes != CHUNK_BYTES as u64)
            {
                return Err(validation("La liste des fragments est invalide."));
            }
            size += part.size_bytes;
        }
        if size != self.size_bytes {
            return Err(validation("La taille de la sauvegarde est incohérente."));
        }
        Ok(())
    }
}
impl LocalStore {
    fn cloud_backup_folder(&self) -> AppResult<PathBuf> {
        let folder = self.data_dir.join("cloud-backups");
        fs::create_dir_all(&folder)?;
        Ok(folder)
    }
    fn cloud_backup_path(&self, id: &str) -> AppResult<PathBuf> {
        validate_id(id)?;
        Ok(self.cloud_backup_folder()?.join(format!("{id}.zentra")))
    }
    fn cloud_backup_preferences(&self) -> AppResult<Preferences> {
        let path = self.data_dir.join(CONFIG_FILE);
        if !path.exists() {
            return Ok(Preferences::default());
        }
        if fs::metadata(&path)?.len() > 32 * 1024 {
            return Err(validation("Les réglages de sauvegarde sont illisibles."));
        }
        let prefs: Preferences = serde_json::from_reader(File::open(path)?)?;
        if let Some(pending) = &prefs.pending {
            validate_id(&pending.backup_id)?;
            pending.manifest.validate()?;
        }
        Ok(prefs)
    }
    fn save_cloud_backup_preferences(&self, prefs: &Preferences) -> AppResult<()> {
        let mut file = tempfile::Builder::new()
            .prefix(".cloud-backup-")
            .tempfile_in(&self.data_dir)?;
        serde_json::to_writer(file.as_file_mut(), prefs)?;
        file.as_file_mut().sync_all()?;
        file.persist(self.data_dir.join(CONFIG_FILE))
            .map_err(|e| AppError::Io(e.error))?;
        Ok(())
    }
    fn validate_backup_organization(&self, prefs: &Preferences, org: &str) -> AppResult<()> {
        let project_org = self
            .connect()?
            .query_row(
                "SELECT organization_id FROM project_sync_binding WHERE id=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if prefs.organization_id.as_deref().is_some_and(|id| id != org)
            || project_org.as_deref().is_some_and(|id| id != org)
        {
            return Err(validation("Ces données sont rattachées à une autre entreprise. Reconnectez le compte correspondant avant de sauvegarder."));
        }
        Ok(())
    }
    fn prepare_cloud_backup(&self, org: &str) -> AppResult<Pending> {
        let _lock = self.lock()?;
        let mut prefs = self.cloud_backup_preferences()?;
        self.validate_backup_organization(&prefs, org)?;
        if let Some(pending) = prefs.pending {
            if !self.cloud_backup_path(&pending.backup_id)?.is_file() {
                return Err(validation("L’envoi en attente a perdu son fichier local. Abandonnez-le depuis les sauvegardes puis créez une nouvelle copie."));
            }
            return Ok(pending);
        }
        let id = Uuid::new_v4().to_string();
        let path = self.cloud_backup_path(&id)?;
        self.create_backup_at(&path, env!("CARGO_PKG_VERSION"))?;
        let manifest = match file_manifest(&path) {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        let pending = Pending {
            backup_id: id,
            manifest,
        };
        prefs.organization_id = Some(org.into());
        prefs.pending = Some(pending.clone());
        prefs.last_error = None;
        self.save_cloud_backup_preferences(&prefs)?;
        Ok(pending)
    }
    fn finish_cloud_backup(&self, id: &str) -> AppResult<()> {
        let _lock = self.lock()?;
        let mut prefs = self.cloud_backup_preferences()?;
        if prefs.pending.as_ref().is_none_or(|p| p.backup_id != id) {
            return Err(validation("L’envoi en attente a changé."));
        }
        prefs.pending = None;
        prefs.last_success_at = Some(now_iso());
        prefs.last_error = None;
        self.save_cloud_backup_preferences(&prefs)?;
        let _ = fs::remove_file(self.cloud_backup_path(id)?);
        Ok(())
    }
}
fn file_manifest(path: &Path) -> AppResult<Manifest> {
    let mut source = File::open(path)?;
    let size = source.metadata()?.len();
    if size == 0 || size > (CHUNK_BYTES * MAX_CHUNKS) as u64 {
        return Err(validation("La sauvegarde distante accepte jusqu’à 512 Mo par copie. Créez une sauvegarde locale pour cette entreprise plus volumineuse."));
    }
    let mut digest = Sha256::new();
    let mut chunks = Vec::new();
    let mut remaining = size;
    while remaining > 0 {
        let mut bytes = vec![0; remaining.min(CHUNK_BYTES as u64) as usize];
        source.read_exact(&mut bytes)?;
        digest.update(&bytes);
        chunks.push(Chunk {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
        });
        remaining -= bytes.len() as u64;
    }
    let manifest = Manifest {
        format: "zentra-cloud-backup".into(),
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        sha256: format!("{:x}", digest.finalize()),
        size_bytes: size,
        chunks,
    };
    manifest.validate()?;
    Ok(manifest)
}
fn verify_chunk(part: &Chunk, bytes: &[u8]) -> AppResult<()> {
    if bytes.len() as u64 != part.size_bytes
        || format!("{:x}", Sha256::digest(bytes)) != part.sha256
    {
        return Err(validation(
            "Un fragment de sauvegarde est incomplet ou altéré. Aucune donnée n’a été remplacée.",
        ));
    }
    Ok(())
}
async fn backup_session(store: &LocalStore) -> AppResult<ProjectSyncSession> {
    let session = project_sync_session(store).await?.ok_or_else(|| validation("Connectez cet appareil au compte de votre entreprise pour accéder aux sauvegardes distantes."))?;
    if !matches!(session.role.as_str(), "owner" | "admin") {
        return Err(validation(
            "Les sauvegardes complètes sont réservées au titulaire et aux administrateurs.",
        ));
    }
    Ok(session)
}
async fn request(
    session: &ProjectSyncSession,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    value: Option<Value>,
) -> AppResult<Value> {
    let body = value.map(|value| serde_json::to_vec(&value)).transpose()?;
    let (status, bytes) = session
        .request(
            method,
            path,
            query,
            &[("Content-Type", "application/json".into())],
            body,
            false,
        )
        .await?;
    if !status.is_success() {
        return Err(validation(
            "Cette sauvegarde a été supprimée du coffre. Abandonnez son envoi local si nécessaire.",
        ));
    }
    serde_json::from_slice(&bytes).map_err(Into::into)
}
fn received_chunks(response: &Value, pending: &Pending) -> AppResult<BTreeSet<usize>> {
    if response["backup_id"] != pending.backup_id
        || response["sha256"] != pending.manifest.sha256
        || response["size_bytes"] != pending.manifest.size_bytes
        || !matches!(response["state"].as_str(), Some("uploading" | "complete"))
    {
        return Err(validation(
            "Le coffre a répondu pour une autre sauvegarde ou un état invalide.",
        ));
    }
    // An older server has no receipt catalogue: repeat verified parts safely.
    let Some(received) = response.get("received_chunks") else {
        return Ok(BTreeSet::new());
    };
    let received = received
        .as_array()
        .filter(|parts| parts.len() <= pending.manifest.chunks.len())
        .ok_or_else(|| validation("Les confirmations du coffre sont invalides."))?;
    let mut indexes = BTreeSet::new();
    for part in received {
        let index = part["chunk_index"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| validation("Une confirmation de fragment est invalide."))?;
        let expected = pending
            .manifest
            .chunks
            .get(index)
            .ok_or_else(|| validation("Une confirmation concerne un fragment inconnu."))?;
        if part["sha256"] != expected.sha256
            || part["size_bytes"] != expected.size_bytes
            || !indexes.insert(index)
        {
            return Err(validation(
                "Une confirmation de fragment ne correspond pas à cet envoi.",
            ));
        }
    }
    Ok(indexes)
}

#[derive(Debug, PartialEq)]
struct BackupSendReceipt {
    sent_chunks: usize,
    skipped_chunks: usize,
}

async fn send_backup(
    store: &LocalStore,
    session: &ProjectSyncSession,
) -> AppResult<BackupSendReceipt> {
    let owned = store.clone();
    let org = session.organization_id.clone();
    let pending = tauri::async_runtime::spawn_blocking(move || owned.prepare_cloud_backup(&org))
        .await
        .map_err(|_| validation("La préparation de sauvegarde a été interrompue."))??;
    let result = request(
        session,
        Method::POST,
        "/api/backups",
        &[],
        Some(json!({ "backup_id": pending.backup_id, "manifest": pending.manifest })),
    )
    .await?;
    let received = received_chunks(&result, &pending)?;
    let mut receipt = BackupSendReceipt {
        sent_chunks: 0,
        skipped_chunks: 0,
    };
    if result["state"] != "complete" {
        let mut file = File::open(store.cloud_backup_path(&pending.backup_id)?)?;
        for (index, part) in pending.manifest.chunks.iter().enumerate() {
            if received.contains(&index) {
                file.seek(SeekFrom::Current(part.size_bytes as i64))?;
                receipt.skipped_chunks += 1;
                continue;
            }
            let mut bytes = vec![0; part.size_bytes as usize];
            file.read_exact(&mut bytes)?;
            verify_chunk(part, &bytes)?;
            let index = index.to_string();
            let (status, _) = session
                .request(
                    Method::PUT,
                    "/api/backups/chunk",
                    &[("id", &pending.backup_id), ("index", &index)],
                    &[],
                    Some(bytes),
                    false,
                )
                .await?;
            if !status.is_success() {
                return Err(validation(
                    "Cette sauvegarde a été supprimée. Abandonnez cet envoi avant de recommencer.",
                ));
            }
            receipt.sent_chunks += 1;
        }
        let complete = request(
            session,
            Method::POST,
            "/api/backups/item",
            &[("id", &pending.backup_id)],
            None,
        )
        .await?;
        if complete["state"] != "complete"
            || complete["sha256"] != pending.manifest.sha256
            || complete["backup_id"] != pending.backup_id
        {
            return Err(validation(
                "Le coffre n’a pas confirmé la réception complète de la sauvegarde.",
            ));
        }
    } else {
        receipt.skipped_chunks = pending.manifest.chunks.len();
    }
    store.finish_cloud_backup(&pending.backup_id)?;
    Ok(receipt)
}
fn public_preferences(prefs: &Preferences) -> Value {
    json!({ "enabled": prefs.enabled, "organization_id": prefs.organization_id, "last_success_at": prefs.last_success_at,
        "last_error": prefs.last_error, "pending_id": prefs.pending.as_ref().map(|p| &p.backup_id), "running": RUNNING.load(Ordering::Acquire) })
}

#[tauri::command]
pub async fn get_cloud_backup_state(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let mut result = public_preferences(&store.cloud_backup_preferences().map_err(command_error)?);
    match backup_session(&store).await {
        Ok(session) => {
            result["connected"] = json!(true);
            result["account_organization_id"] = json!(session.organization_id);
            match request(&session, Method::GET, "/api/backups", &[], None).await {
                Ok(list) => {
                    result["backups"] = list["backups"].clone();
                }
                Err(error) => {
                    result["error"] = json!(command_error(error));
                }
            }
        }
        Err(error) => {
            result["connected"] = json!(false);
            result["error"] = json!(command_error(error));
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn set_cloud_backup_enabled(
    state: State<'_, LocalStore>,
    enabled: bool,
) -> Result<Value, String> {
    let _operation = TransferGuard::take().map_err(command_error)?;
    let current_session = if enabled {
        Some(backup_session(&state).await.map_err(command_error)?)
    } else {
        None
    };
    let _lock = state.lock().map_err(command_error)?;
    let mut prefs = state.cloud_backup_preferences().map_err(command_error)?;
    if let Some(session) = current_session {
        state
            .validate_backup_organization(&prefs, &session.organization_id)
            .map_err(command_error)?;
        prefs.organization_id = Some(session.organization_id);
    }
    prefs.enabled = enabled;
    prefs.last_error = None;
    state
        .save_cloud_backup_preferences(&prefs)
        .map_err(command_error)?;
    Ok(public_preferences(&prefs))
}
#[tauri::command]
pub async fn run_cloud_backup(state: State<'_, LocalStore>, manual: bool) -> Result<Value, String> {
    let store = state.inner().clone();
    let prefs = store.cloud_backup_preferences().map_err(command_error)?;
    if !manual
        && (!prefs.enabled
            || (prefs.pending.is_none()
                && prefs
                    .last_success_at
                    .as_deref()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|last| {
                        (0..24).contains(&Utc::now().signed_duration_since(last).num_hours())
                    })))
    {
        return Ok(public_preferences(&prefs));
    }
    let _operation = TransferGuard::take().map_err(command_error)?;
    let outcome = async {
        let session = backup_session(&store).await?;
        send_backup(&store, &session).await
    }
    .await;
    if let Err(error) = outcome {
        let message = command_error(error);
        let _lock = store.lock().map_err(command_error)?;
        let mut prefs = store.cloud_backup_preferences().map_err(command_error)?;
        prefs.last_error = Some(message.clone());
        store
            .save_cloud_backup_preferences(&prefs)
            .map_err(command_error)?;
        return Err(message);
    }
    drop(_operation);
    Ok(public_preferences(
        &store.cloud_backup_preferences().map_err(command_error)?,
    ))
}
#[tauri::command]
pub async fn delete_cloud_backup(
    state: State<'_, LocalStore>,
    backup_id: String,
) -> Result<(), String> {
    let _operation = TransferGuard::take().map_err(command_error)?;
    validate_id(&backup_id).map_err(command_error)?;
    let session = backup_session(&state).await.map_err(command_error)?;
    request(
        &session,
        Method::DELETE,
        "/api/backups/item",
        &[("id", &backup_id)],
        None,
    )
    .await
    .map_err(command_error)?;
    let _lock = state.lock().map_err(command_error)?;
    let mut prefs = state.cloud_backup_preferences().map_err(command_error)?;
    if prefs.organization_id.as_deref() == Some(&session.organization_id)
        && prefs
            .pending
            .as_ref()
            .is_some_and(|p| p.backup_id == backup_id)
    {
        prefs.pending = None;
        prefs.last_error = None;
        state
            .save_cloud_backup_preferences(&prefs)
            .map_err(command_error)?;
        let path = state.cloud_backup_path(&backup_id).map_err(command_error)?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| command_error(e.into()))?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn cancel_cloud_backup(state: State<'_, LocalStore>) -> Result<(), String> {
    let _operation = TransferGuard::take().map_err(command_error)?;
    let _lock = state.lock().map_err(command_error)?;
    let mut prefs = state.cloud_backup_preferences().map_err(command_error)?;
    let pending = prefs.pending.take();
    prefs.enabled = false;
    prefs.last_error = None;
    state
        .save_cloud_backup_preferences(&prefs)
        .map_err(command_error)?;
    if let Some(pending) = pending {
        let path = state
            .cloud_backup_path(&pending.backup_id)
            .map_err(command_error)?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| command_error(e.into()))?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn restore_cloud_backup(
    state: State<'_, LocalStore>,
    backup_id: String,
) -> Result<(), String> {
    let _operation = TransferGuard::take().map_err(command_error)?;
    RESTORING.store(true, Ordering::Release);
    let _restore = RestoreGuard;
    let store = state.inner().clone();
    restore(&store, &backup_id).await.map_err(command_error)
}
async fn restore(store: &LocalStore, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let session = backup_session(store).await?;
    // Observe commits on this exact connection throughout the download. Refuse to
    // replace edits made after the user confirmed the recovery operation.
    let watcher = store.connect()?;
    let initial_version: i64 = watcher.pragma_query_value(None, "data_version", |r| r.get(0))?;
    let response = request(
        &session,
        Method::GET,
        "/api/backups/item",
        &[("id", id)],
        None,
    )
    .await?;
    let manifest: Manifest = serde_json::from_value(response["manifest"].clone())?;
    manifest.validate()?;
    let mut file = tempfile::Builder::new()
        .prefix(".recovery-")
        .suffix(".zentra")
        .tempfile_in(store.cloud_backup_folder()?)?;
    let mut digest = Sha256::new();
    for (index, part) in manifest.chunks.iter().enumerate() {
        let index = index.to_string();
        let (status, bytes) = session
            .request(
                Method::GET,
                "/api/backups/chunk",
                &[("id", id), ("index", &index)],
                &[],
                None,
                true,
            )
            .await?;
        if !status.is_success() {
            return Err(validation("La sauvegarde n’est plus disponible."));
        }
        verify_chunk(part, &bytes)?;
        digest.update(&bytes);
        file.write_all(&bytes)?;
    }
    if format!("{:x}", digest.finalize()) != manifest.sha256 {
        return Err(validation(
            "L’archive reçue ne correspond pas à la sauvegarde. Aucune donnée n’a été remplacée.",
        ));
    }
    file.as_file().sync_all()?;
    let current = backup_session(store).await?;
    if current.organization_id != session.organization_id {
        return Err(validation(
            "Le compte connecté a changé. Relancez la restauration.",
        ));
    }
    let owned = store.clone();
    let organization = session.organization_id;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = owned.lock()?;
        let current_version: i64 = watcher.pragma_query_value(None, "data_version", |r| r.get(0))?;
        drop(watcher);
        if current_version != initial_version { return Err(validation("Des données ont changé pendant le téléchargement. Relancez la restauration après avoir terminé les modifications en cours.")); }
        owned.require_backup_restore_access()?;
        let prefs = owned.cloud_backup_preferences()?;
        if prefs.pending.is_some() { return Err(validation("Terminez ou abandonnez l’envoi en attente avant de restaurer une sauvegarde.")); }
        let next = Preferences { enabled: prefs.enabled, organization_id: Some(organization), ..Preferences::default() };
        owned.save_cloud_backup_preferences(&next)?;
        if let Err(error) = owned.restore_backup(&file.path().to_string_lossy(), env!("CARGO_PKG_VERSION")) {
            owned.save_cloud_backup_preferences(&prefs)?;
            return Err(error);
        }
        Ok(())
    }).await.map_err(|_| validation("La restauration a été interrompue."))?
}

#[cfg(test)]
mod qa;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_receipts_are_bound_to_the_exact_pending_archive() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("small.zentra");
        fs::write(&path, b"archive bytes").unwrap();
        let pending = Pending {
            backup_id: Uuid::new_v4().to_string(),
            manifest: file_manifest(&path).unwrap(),
        };
        let response = json!({"backup_id":pending.backup_id,"sha256":pending.manifest.sha256,
            "size_bytes":pending.manifest.size_bytes,"state":"uploading",
            "received_chunks":[{"chunk_index":0,"sha256":pending.manifest.chunks[0].sha256,"size_bytes":pending.manifest.chunks[0].size_bytes}]});
        assert_eq!(
            received_chunks(&response, &pending).unwrap(),
            BTreeSet::from([0])
        );
        let mut older = response.clone();
        older.as_object_mut().unwrap().remove("received_chunks");
        assert!(received_chunks(&older, &pending).unwrap().is_empty());
        for invalid in [
            json!(null),
            json!({}),
            json!([null]),
            json!([
                response["received_chunks"][0],
                response["received_chunks"][0]
            ]),
        ] {
            let mut copy = response.clone();
            copy["received_chunks"] = invalid;
            assert!(received_chunks(&copy, &pending).is_err());
        }
        for (key, value) in [
            ("chunk_index", json!(-1)),
            ("chunk_index", json!(1)),
            ("chunk_index", json!(0.5)),
            ("sha256", json!("0".repeat(64))),
            ("size_bytes", json!(1)),
        ] {
            let mut copy = response.clone();
            copy["received_chunks"][0][key] = value;
            assert!(received_chunks(&copy, &pending).is_err());
        }
        for (key, value) in [
            ("backup_id", json!(Uuid::new_v4().to_string())),
            ("sha256", json!("0".repeat(64))),
            ("size_bytes", json!(1)),
            ("state", json!("deleted")),
        ] {
            let mut copy = response.clone();
            copy[key] = value;
            assert!(received_chunks(&copy, &pending).is_err());
        }
    }

    #[test]
    fn backup_v2_https_fixture_contains_real_registered_documents_and_exports() {
        qa::verify_fixture_locally();
    }

    #[test]
    #[ignore = "recette HTTPS réelle : deux autorisations navigateur dans une entreprise de test, puis suppression de la seule copie créée"]
    fn live_https_backup_restores_two_chunks_on_an_independent_installation() {
        qa::run();
    }

    #[test]
    fn rejects_traversal_and_corrupt_or_oversized_manifests() {
        for id in ["../x", "C:/x", "", "00000000-0000-0000-0000-000000000000"] {
            assert!(validate_id(id).is_err());
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("archive");
        fs::write(&path, b"archive").unwrap();
        let manifest = file_manifest(&path).unwrap();
        manifest.validate().unwrap();
        assert!(verify_chunk(&manifest.chunks[0], b"corrupt").is_err());
        let mut wrong = manifest.clone();
        wrong.size_bytes += 1;
        assert!(wrong.validate().is_err());
        wrong = manifest.clone();
        wrong.chunks = vec![manifest.chunks[0].clone(); MAX_CHUNKS + 1];
        assert!(wrong.validate().is_err());
    }
    #[test]
    fn pending_archive_survives_restart_and_cannot_switch_organizations() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temp.path().into()).unwrap();
        let pending = store.prepare_cloud_backup("org_first").unwrap();
        let reopened = LocalStore::initialize(temp.path().into()).unwrap();
        assert_eq!(
            reopened
                .prepare_cloud_backup("org_first")
                .unwrap()
                .backup_id,
            pending.backup_id
        );
        assert!(reopened.prepare_cloud_backup("org_other").is_err());
        reopened.finish_cloud_backup(&pending.backup_id).unwrap();
        assert!(!reopened
            .cloud_backup_path(&pending.backup_id)
            .unwrap()
            .exists());
        assert!(reopened
            .cloud_backup_preferences()
            .unwrap()
            .last_success_at
            .is_some());
    }
    #[test]
    fn complete_backup_recovers_business_database_and_attachments_on_a_fresh_installation() {
        let source_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(source_dir.path().into()).unwrap();
        let target = LocalStore::initialize(target_dir.path().into()).unwrap();
        source.connect().unwrap().execute("INSERT INTO projects(id,name,created_at,updated_at) VALUES('project-recovery','Projet à récupérer','2026-09-08','2026-09-08')", []).unwrap();
        fs::write(
            source.attachments_dir.join("plan.txt"),
            b"Plan original\nConditions",
        )
        .unwrap();
        let pending = source.prepare_cloud_backup("org_first").unwrap();
        let path = source.cloud_backup_path(&pending.backup_id).unwrap();
        let manifest = file_manifest(&path).unwrap();
        assert_eq!(manifest, pending.manifest);
        target
            .restore_backup(&path.to_string_lossy(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        let name: String = target
            .connect()
            .unwrap()
            .query_row(
                "SELECT name FROM projects WHERE id='project-recovery'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "Projet à récupérer");
        assert_eq!(
            fs::read(target.attachments_dir.join("plan.txt")).unwrap(),
            b"Plan original\nConditions"
        );
        assert_ne!(source.installation_id, target.installation_id);
        assert!(target
            .cloud_backup_preferences()
            .unwrap()
            .organization_id
            .is_none());
    }
}

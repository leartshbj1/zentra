//! Receive an immutable published history into separate, resumable storage.
//! This does not replace the working database or enable transaction replication.
pub(crate) mod import;
use super::*;
use crate::account_cloud::ProjectSyncSession;
use reqwest::Method;
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};

const HEAD_BYTES: u64 = 2 * 1024 * 1024;
const PAGE_BYTES: u64 = 512 * 1024;
const PART_BYTES: u64 = 4 * 1024 * 1024;
const PARTS_PER_PASS: usize = 8;
static RUNNING: AtomicBool = AtomicBool::new(false);
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct PublicationReceipt {
    format: String,
    version: u32,
    transfer_id: String,
    organization_id: String,
    generation: String,
    revision: u64,
    manifest_sha256: String,
    files_manifest_sha256: String,
    validator_sha256: String,
    integrity_validator_sha256: String,
    structural_validator_sha256: String,
    row_count: u64,
    file_count: usize,
    audit_entries: u64,
    last_audit_hash: Option<String>,
    committed_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Head {
    state: String,
    head_revision: u64,
    receipt: PublicationReceipt,
    manifest_json: String,
    files_manifest_json: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    sha256: String,
    size_bytes: u64,
    file_count: usize,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilesManifest {
    format: String,
    version: u32,
    pages: Vec<Page>,
    file_count: usize,
    size_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePage {
    version: u32,
    files: Vec<FrozenFile>,
}

trait HistoryTransport {
    fn organization(&self) -> &str;
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()>;
    fn get(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> impl Future<Output = AppResult<Vec<u8>>> + Send;
}
impl HistoryTransport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> AppResult<Vec<u8>> {
        let (status, bytes) = self
            .request(Method::GET, path, query, &[], None, true)
            .await?;
        if !status.is_success() {
            return Err(invalid(
                "L’historique partagé est temporairement indisponible.",
            ));
        }
        Ok(bytes)
    }
}
fn read(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    if !regular_metadata(path)?.is_file() || regular_metadata(path)?.len() > limit {
        return Err(invalid("Le fichier reçu est invalide ou trop volumineux."));
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("Le fichier reçu dépasse la taille autorisée."));
    }
    Ok(bytes)
}
fn directory(path: &Path) -> AppResult<()> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    if !regular_metadata(path)?.is_dir() {
        return Err(invalid("Le dossier de réception est invalide."));
    }
    Ok(())
}
fn atomic_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Le stockage reçu est invalide."))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(path).map_err(|e| e.error)?;
    sync_directory(parent)
}
impl Head {
    fn validate(&self, organization: &str) -> AppResult<(Manifest, FilesManifest)> {
        let r = &self.receipt;
        if self.state != "published"
            || self.head_revision != 1
            || r.format != "zentra-shared-history"
            || r.version != 1
            || r.revision != 1
            || r.organization_id != organization
            || !valid_id(&r.transfer_id)
            || !valid_id(&r.generation)
            || r.committed_at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&r.committed_at).is_err()
            || [
                &r.manifest_sha256,
                &r.files_manifest_sha256,
                &r.validator_sha256,
                &r.integrity_validator_sha256,
                &r.structural_validator_sha256,
            ]
            .iter()
            .any(|s| !valid_digest(s))
            || digest(self.manifest_json.as_bytes()) != r.manifest_sha256
            || digest(self.files_manifest_json.as_bytes()) != r.files_manifest_sha256
            || r.last_audit_hash
                .as_deref()
                .is_some_and(|s| !valid_digest(s))
            || (r.audit_entries == 0) != r.last_audit_hash.is_none()
        {
            return Err(invalid("Le reçu ne correspond pas à l’historique de cette entreprise ou nécessite une application plus récente."));
        }
        let m: Manifest = serde_json::from_str(&self.manifest_json)?;
        let f: FilesManifest = serde_json::from_str(&self.files_manifest_json)?;
        if m.format != "zentra-business-bootstrap"
            || ![2, 3].contains(&m.version)
            || m.schema_version != crate::business_sync::DATA_SCHEMA_VERSION
            || m.contract_sha256 != contract_hash()?
            || m.tables.keys().ne(policy()?.tables.keys())
            || m.tables.get("settings") != Some(&1)
            || m.tables.get("audit_log") != Some(&r.audit_entries)
            || m.row_count != r.row_count
            || m.row_count == 0
            || m.row_count > MAX_ROWS
            || m.size_bytes > MAX_ROW_BYTES
            || m.chunks.is_empty()
            || m.chunks.len() > MAX_CHUNKS
            || f.format != "zentra-business-files"
            || f.version != 2
            || f.file_count != r.file_count
            || f.file_count > MAX_FILES
            || f.pages.len() > 250
            || f.size_bytes > MAX_FILE_TOTAL
        {
            return Err(invalid(
                "Les manifestes reçus sont incompatibles ou dépassent les limites de réception.",
            ));
        }
        numbering::validate(
            m.numbering_floors
                .as_deref()
                .ok_or_else(|| invalid("Les compteurs historiques sont absents."))?,
        )?;
        let mut rows = 0u64;
        let mut size = 0u64;
        for c in &m.chunks {
            if !valid_digest(&c.sha256)
                || c.row_count == 0
                || c.row_count > ROWS_PER_CHUNK as u64
                || c.size_bytes == 0
                || c.size_bytes > CHUNK_BYTES as u64
            {
                return Err(invalid("Un fragment de données est invalide."));
            }
            rows += c.row_count;
            size += c.size_bytes;
        }
        let table_rows = m.tables.values().try_fold(0u64, |n, v| n.checked_add(*v));
        if rows != m.row_count || size != m.size_bytes || table_rows != Some(rows) {
            return Err(invalid("Les totaux de données reçus sont incohérents."));
        }
        let mut files = 0;
        for p in &f.pages {
            if !valid_digest(&p.sha256)
                || p.file_count == 0
                || p.file_count > 200
                || p.size_bytes == 0
                || p.size_bytes > PAGE_BYTES
            {
                return Err(invalid("Une page du catalogue est invalide."));
            }
            files += p.file_count;
        }
        if files != f.file_count {
            return Err(invalid("Le catalogue de documents est incomplet."));
        }
        Ok((m, f))
    }
}
pub(super) fn validate_source_receipt(prepared:&Prepared,folder:&Path,files_json:String,generation:&str,bytes:&[u8]) -> AppResult<Value> {
    let receipt:PublicationReceipt=serde_json::from_slice(bytes)?;
    if receipt.transfer_id!=prepared.transfer_id || receipt.generation!=generation || prepared.manifest.version!=3 {
        return Err(invalid("Le reçu ne correspond pas à cette préparation."));
    }
    let head=Head{state:"published".into(),head_revision:1,receipt,manifest_json:serde_json::to_string(&prepared.manifest)?,files_manifest_json:files_json};
    head.validate(&prepared.organization_id)?;
    let mut last:Option<(i64,String)>=None;
    for (i,chunk) in prepared.manifest.chunks.iter().enumerate() {
        let bytes=read(&folder.join("rows").join(format!("{i:04}.json")),CHUNK_BYTES as u64)?;
        if digest(&bytes)!=chunk.sha256 {return Err(invalid("L’historique préparé a été altéré."));}
        let part:Value=serde_json::from_slice(&bytes)?;
        for row in part["rows"].as_array().ok_or_else(||invalid("Le fragment préparé est illisible."))? {
            if row["table"]!="audit_log" {continue;}
            let position=row["source_rowid"].as_str().and_then(|s|s.parse::<i64>().ok()).ok_or_else(||invalid("L’ordre préparé est illisible."))?;
            let data:Value=serde_json::from_str(row["row_json"].as_str().ok_or_else(||invalid("L’audit préparé est illisible."))?)?;
            let hash=data["entry_hash"].as_str().ok_or_else(||invalid("L’empreinte d’audit préparée est absente."))?;
            if last.as_ref().is_none_or(|r|position>r.0) {last=Some((position,hash.to_owned()));}
        }
    }
    if last.map(|r|r.1)!=head.receipt.last_audit_hash {return Err(invalid("Le reçu ne confirme pas l’audit préparé."));}
    Ok(serde_json::to_value(&head.receipt)?)
}

async fn fetch_checked(
    t: &impl HistoryTransport,
    store: &LocalStore,
    path: &str,
    query: &[(&str, &str)],
    max: u64,
) -> AppResult<Vec<u8>> {
    t.ensure_current(store)?;
    if crate::cloud_backup::is_restoring() {
        return Err(invalid("Attendez la fin de la restauration."));
    }
    let bytes = t.get(path, query).await?;
    t.ensure_current(store)?;
    if bytes.len() as u64 > max {
        return Err(invalid(
            "La réponse de synchronisation est trop volumineuse.",
        ));
    }
    Ok(bytes)
}
async fn piece(
    t: &impl HistoryTransport,
    store: &LocalStore,
    head: &Head,
    part: (&str, usize),
    expected: (&str, u64),
    path: &Path,
    left: &mut usize,
) -> AppResult<bool> {
    let (kind, i) = part;
    if path.try_exists()? {
        if fingerprint_file(path)? != (expected.0.to_owned(), expected.1) {
            return Err(invalid("Un fragment conservé est altéré. Recommencez la réception dans une nouvelle copie."));
        }
        return Ok(true);
    }
    if *left == 0 {
        return Ok(false);
    }
    let index = i.to_string();
    let bytes = fetch_checked(
        t,
        store,
        "/api/sync/history",
        &[
            ("kind", kind),
            ("transfer_id", &head.receipt.transfer_id),
            ("index", &index),
        ],
        expected.1,
    )
    .await?;
    if bytes.len() as u64 != expected.1 || digest(&bytes) != expected.0 {
        return Err(invalid(
            "Le fragment reçu ne correspond pas à son empreinte.",
        ));
    }
    atomic_new(path, &bytes)?;
    *left -= 1;
    Ok(true)
}
fn catalog(folder: &Path, manifest: &FilesManifest) -> AppResult<Vec<FrozenFile>> {
    let mut files = Vec::new();
    let mut paths = BTreeSet::new();
    let mut sizes = BTreeMap::new();
    let mut total = 0u64;
    for (i, page) in manifest.pages.iter().enumerate() {
        let bytes = read(
            &folder.join("catalogue").join(format!("{i:04}.json")),
            PAGE_BYTES,
        )?;
        if bytes.len() as u64 != page.size_bytes || digest(&bytes) != page.sha256 {
            return Err(invalid("La page du catalogue conservée est altérée."));
        }
        let contents: FilePage = serde_json::from_slice(&bytes)?;
        if contents.version != 2 || contents.files.len() != page.file_count {
            return Err(invalid("La page du catalogue reçue est incohérente."));
        }
        for f in contents.files {
            validate_storage_path(&f.path)?;
            if !valid_digest(&f.sha256)
                || f.size_bytes > MAX_FILE_BYTES
                || !paths.insert(f.path.to_lowercase())
                || sizes
                    .insert(f.sha256.clone(), f.size_bytes)
                    .is_some_and(|size| size != f.size_bytes)
            {
                return Err(invalid(
                    "Le catalogue contient un document invalide ou répété.",
                ));
            }
            total += f.size_bytes;
            files.push(f);
        }
    }
    if files.len() != manifest.file_count || total != manifest.size_bytes {
        return Err(invalid("Les totaux des documents reçus sont incohérents."));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}
async fn receive_pass(
    store: &LocalStore,
    t: &impl HistoryTransport,
    limit: usize,
) -> AppResult<Value> {
    let bytes = fetch_checked(t, store, "/api/sync/history", &[], HEAD_BYTES).await?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if value == json!({"state":"uninitialized","head_revision":0}) {
        return Ok(json!({"state":"not_published","replication_active":false}));
    }
    let head: Head = serde_json::from_value(value)?;
    let (manifest, file_manifest) = head.validate(t.organization())?;
    let root = store.data_dir.join("business-history");
    directory(&root)?;
    let company = root.join(digest(t.organization().as_bytes()));
    directory(&company)?;
    let folder = company.join(&head.receipt.transfer_id);
    directory(&folder)?;
    for name in ["rows", "catalogue", "files", "parts"] {
        directory(&folder.join(name))?;
    }
    let descriptor = folder.join("history.json");
    if descriptor.try_exists()? {
        let previous: Head = serde_json::from_slice(&read(&descriptor, HEAD_BYTES)?)?;
        if previous != head {
            return Err(invalid(
                "La révision d’historique a changé pendant sa réception.",
            ));
        }
    } else {
        atomic_new(&descriptor, &serde_json::to_vec(&head)?)?;
    }
    let mut left = limit.min(PARTS_PER_PASS);
    let status = |ready: bool, left: usize| {
        json!({"state":if ready {"history_received"}else{"receiving"},"transfer_id":head.receipt.transfer_id,"revision":1,
        "rows":manifest.row_count,"files":file_manifest.file_count,"received_parts":limit.min(PARTS_PER_PASS)-left,"replication_active":false})
    };
    for (i, c) in manifest.chunks.iter().enumerate() {
        if !piece(
            t,
            store,
            &head,
            ("rows", i),
            (&c.sha256, c.size_bytes),
            &folder.join("rows").join(format!("{i:04}.json")),
            &mut left,
        )
        .await?
        {
            return Ok(status(false, left));
        }
    }
    for (i, p) in file_manifest.pages.iter().enumerate() {
        if !piece(
            t,
            store,
            &head,
            ("files", i),
            (&p.sha256, p.size_bytes),
            &folder.join("catalogue").join(format!("{i:04}.json")),
            &mut left,
        )
        .await?
        {
            return Ok(status(false, left));
        }
    }
    let files = catalog(&folder, &file_manifest)?;
    for f in &files {
        let destination = folder.join("files").join(&f.sha256);
        if destination.try_exists()? {
            if fingerprint_file(&destination)? != (f.sha256.clone(), f.size_bytes) {
                return Err(invalid("Un document conservé est altéré."));
            }
            continue;
        }
        let parts = folder.join("parts").join(&f.sha256);
        directory(&parts)?;
        for part in 0..f.size_bytes.div_ceil(PART_BYTES) {
            let path = parts.join(format!("{part:04}"));
            let expected = (f.size_bytes - part * PART_BYTES).min(PART_BYTES);
            if path.try_exists()? {
                if read(&path, PART_BYTES)?.len() as u64 != expected {
                    return Err(invalid("Un fragment local de document est incomplet."));
                }
                continue;
            }
            if left == 0 {
                return Ok(status(false, left));
            }
            let index = part.to_string();
            let bytes = fetch_checked(
                t,
                store,
                "/api/sync/history/file",
                &[
                    ("transfer_id", &head.receipt.transfer_id),
                    ("sha256", &f.sha256),
                    ("part", &index),
                ],
                expected,
            )
            .await?;
            if bytes.len() as u64 != expected {
                return Err(invalid("La réception du document a été interrompue."));
            }
            atomic_new(&path, &bytes)?;
            left -= 1;
        }
        let mut assembled = tempfile::NamedTempFile::new_in(folder.join("files"))?;
        for part in 0..f.size_bytes.div_ceil(PART_BYTES) {
            assembled.write_all(&read(&parts.join(format!("{part:04}")), PART_BYTES)?)?;
        }
        assembled.as_file().sync_all()?;
        if fingerprint_file(assembled.path())? != (f.sha256.clone(), f.size_bytes) {
            return Err(invalid(
                "Le document reçu ne correspond pas à son empreinte. La base locale est conservée.",
            ));
        }
        assembled
            .persist_noclobber(destination)
            .map_err(|e| e.error)?;
        sync_directory(&folder.join("files"))?;
    }
    t.ensure_current(store)?;
    // Only a verified staging receipt. No database, binding, pending edit,
    // numbering range, licence or protected account file is replaced here.
    let complete = folder.join("received.json");
    let receipt = serde_json::to_vec(&head.receipt)?;
    if complete.try_exists()? {
        if read(&complete, HEAD_BYTES)? != receipt {
            return Err(invalid(
                "La confirmation locale de réception est incohérente.",
            ));
        }
    } else {
        atomic_new(&complete, &receipt)?;
    }
    Ok(status(true, left))
}
#[tauri::command]
pub async fn receive_business_history(state: State<'_, LocalStore>) -> Result<Value, String> {
    if RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(json!({"state":"receiving","replication_active":false}));
    }
    let _guard = Guard;
    let store = state.inner();
    let session = project_sync_session(store)
        .await
        .map_err(command_error)?
        .ok_or_else(|| {
            "Connectez votre compte pour retrouver l’historique de l’entreprise.".to_owned()
        })?;
    receive_pass(store, &session, PARTS_PER_PASS)
        .await
        .map_err(command_error)
}

#[cfg(test)]
mod tests;

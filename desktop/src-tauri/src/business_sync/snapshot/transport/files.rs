//! Frozen file catalogue and bounded binary transfers. Server verification of
//! every complete file is required; none of these receipts activates replication.
use super::*;
use std::io::{Seek, SeekFrom};

const FILES_PATH: &str = "/api/sync/bootstrap/files";
const FILE_PATH: &str = "/api/sync/bootstrap/file";
const FILES_PER_PAGE: usize = 200;
const PAGE_BYTES: usize = 512 * 1024;
const PART_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Page {
    sha256: String,
    size_bytes: u64,
    file_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct FileManifest {
    format: String,
    version: u32,
    pages: Vec<Page>,
    file_count: usize,
    size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct PageReceipt {
    page_index: usize,
    sha256: String,
    size_bytes: u64,
    file_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct PendingBlob {
    sha256: String,
    size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SetStatus {
    transfer_id: String,
    organization_id: String,
    installation_id: String,
    generation: String,
    manifest_sha256: String,
    state: String,
    uploaded_pages: Vec<PageReceipt>,
    file_count: usize,
    size_bytes: u64,
    total_blobs: usize,
    verified_blobs: usize,
    pending_blobs: Vec<PendingBlob>,
    replication_active: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Part {
    sha256: String,
    size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct BlobPlan {
    descriptor_sha256: String,
    sha256: String,
    size_bytes: u64,
    parts: Vec<Part>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct PartReceipt {
    part_index: usize,
    sha256: String,
    size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct BlobStatus {
    transfer_id: String,
    organization_id: String,
    installation_id: String,
    generation: String,
    sha256: String,
    size_bytes: u64,
    verified: bool,
    uploaded_parts: Vec<PartReceipt>,
    replication_active: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DurableFileStatus<T> {
    version: u32,
    descriptor_sha256: String,
    status: T,
}

struct FileRequest {
    method: Method,
    path: &'static str,
    query: Vec<(&'static str, String)>,
    body: Option<Vec<u8>>,
    headers: Vec<(&'static str, String)>,
}
trait FileTransport {
    fn organization(&self) -> &str;
    fn role(&self) -> &str;
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()>;
    fn files_request(
        &self,
        request: FileRequest,
    ) -> impl Future<Output = AppResult<Vec<u8>>> + Send;
}
impl FileTransport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn files_request(&self, request: FileRequest) -> AppResult<Vec<u8>> {
        let query = request
            .query
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect::<Vec<_>>();
        let (status, bytes) = self
            .request(
                request.method,
                request.path,
                &query,
                &request.headers,
                request.body,
                false,
            )
            .await?;
        if !status.is_success() {
            return Err(invalid("Le transfert des pièces doit être réconcilié."));
        }
        Ok(bytes)
    }
}
fn file_request(
    bound: &BoundSnapshot,
    method: Method,
    file: Option<&str>,
    extra: Option<(&'static str, usize)>,
    body: Option<Value>,
) -> AppResult<FileRequest> {
    let mut query = vec![("transfer_id", bound.prepared.transfer_id.clone())];
    if let Some(sha) = file {
        query.push(("sha256", sha.to_owned()));
    }
    if let Some((name, index)) = extra {
        query.push((name, index.to_string()));
    }
    Ok(FileRequest {
        method,
        path: if file.is_some() {
            FILE_PATH
        } else {
            FILES_PATH
        },
        query,
        headers: if body.is_some() {
            vec![("content-type", "application/json".into())]
        } else {
            vec![]
        },
        body: body.map(|value| serde_json::to_vec(&value)).transpose()?,
    })
}
fn page_bytes(files: &[FrozenFile], version: u32) -> AppResult<Vec<u8>> {
    #[derive(Serialize)]
    struct PageBody<'a> {
        version: u32,
        files: &'a [FrozenFile],
    }
    Ok(serde_json::to_vec(&PageBody { version, files })?)
}
fn pages(bound: &BoundSnapshot) -> AppResult<FileManifest> {
    let mut manifest = FileManifest {
        format: "zentra-business-files".into(),
        version: bound.prepared.version,
        pages: vec![],
        file_count: bound.prepared.files.len(),
        size_bytes: 0,
    };
    for files in bound.prepared.files.chunks(FILES_PER_PAGE) {
        let bytes = page_bytes(files, manifest.version)?;
        if bytes.len() > PAGE_BYTES {
            return Err(invalid(
                "Le catalogue de pièces dépasse la taille autorisée.",
            ));
        }
        manifest.pages.push(Page {
            sha256: digest(&bytes),
            size_bytes: bytes.len() as u64,
            file_count: files.len(),
        });
        manifest.size_bytes += files.iter().map(|file| file.size_bytes).sum::<u64>();
    }
    Ok(manifest)
}
fn cache_folder(bound: &BoundSnapshot) -> AppResult<PathBuf> {
    let folder = bound.folder.join("file-transfer");
    match fs::create_dir(&folder) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    if !regular_metadata(&folder)?.is_dir() {
        return Err(invalid("Le dossier de transfert des pièces est invalide."));
    }
    Ok(folder)
}
fn read_cache<T: serde::de::DeserializeOwned>(folder: &Path, name: &str) -> AppResult<Option<T>> {
    let path = folder.join(name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    Ok(Some(serde_json::from_slice(&read_bounded(
        &path,
        MAX_RESPONSE_BYTES,
    )?)?))
}
fn save_cache<T: Serialize>(
    store: &LocalStore,
    bound: &BoundSnapshot,
    name: &str,
    value: &T,
) -> AppResult<()> {
    let _guard = store.lock()?;
    ensure_bound(store, bound)?;
    let folder = cache_folder(bound)?;
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(invalid(
            "Les confirmations des pièces dépassent la taille autorisée.",
        ));
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".file-transfer-")
        .tempfile_in(&folder)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(folder.join(name))
        .map_err(|error| error.error)?;
    sync_directory(&folder)?;
    Ok(())
}
fn validate_set(
    bound: &BoundSnapshot,
    generation: &str,
    manifest: &FileManifest,
    status: &SetStatus,
    previous: Option<&SetStatus>,
    required_page: Option<usize>,
) -> AppResult<()> {
    if status.transfer_id != bound.prepared.transfer_id
        || status.organization_id != bound.prepared.organization_id
        || status.installation_id != bound.prepared.installation_id
        || status.generation != generation
        || status.replication_active
        || status.manifest_sha256 != digest(&serde_json::to_vec(manifest)?)
        || status.file_count != manifest.file_count
        || status.size_bytes != manifest.size_bytes
        || !matches!(
            status.state.as_str(),
            "cataloguing" | "uploading" | "uploaded"
        )
    {
        return Err(invalid(
            "La confirmation du catalogue ne correspond pas à la copie initiale.",
        ));
    }
    let mut known = BTreeMap::new();
    let mut last = None;
    for received in &status.uploaded_pages {
        let page = manifest
            .pages
            .get(received.page_index)
            .ok_or_else(|| invalid("Le serveur confirme une page inconnue."))?;
        if last.is_some_and(|index| index >= received.page_index)
            || received.sha256 != page.sha256
            || received.size_bytes != page.size_bytes
            || received.file_count != page.file_count
        {
            return Err(invalid("Une page confirmée du catalogue est incohérente."));
        }
        last = Some(received.page_index);
        for file in bound
            .prepared
            .files
            .chunks(FILES_PER_PAGE)
            .nth(received.page_index)
            .ok_or_else(|| invalid("Page locale introuvable."))?
        {
            known.insert(file.sha256.as_str(), file.size_bytes);
        }
    }
    if required_page.is_some_and(|index| {
        !status
            .uploaded_pages
            .iter()
            .any(|page| page.page_index == index)
    }) || status.total_blobs != known.len()
        || status.verified_blobs > known.len()
        || (status.state != "cataloguing" && status.uploaded_pages.len() != manifest.pages.len())
        || (status.state == "uploaded" && status.verified_blobs != status.total_blobs)
        || status.pending_blobs.len() != (status.total_blobs - status.verified_blobs).min(8)
    {
        return Err(invalid("Les totaux reçus du catalogue sont incohérents."));
    }
    let mut prior: Option<&str> = None;
    for pending in &status.pending_blobs {
        if known.get(pending.sha256.as_str()) != Some(&pending.size_bytes)
            || pending.size_bytes == 0
            || prior.is_some_and(|sha| sha >= pending.sha256.as_str())
        {
            return Err(invalid("Le serveur demande une pièce inconnue ou répétée."));
        }
        prior = Some(&pending.sha256);
    }
    if let Some(previous) = previous {
        if previous.total_blobs > status.total_blobs
            || previous.verified_blobs > status.verified_blobs
            || (previous.state == "uploaded" && status.state != "uploaded")
            || (previous.state == "uploading" && status.state == "cataloguing")
            || previous
                .uploaded_pages
                .iter()
                .any(|page| !status.uploaded_pages.contains(page))
        {
            return Err(invalid(
                "Une confirmation de pièce a disparu. Une réconciliation est nécessaire.",
            ));
        }
    }
    Ok(())
}
async fn exchange<T: FileTransport>(
    store: &LocalStore,
    bound: &BoundSnapshot,
    transport: &T,
    request: FileRequest,
) -> AppResult<Vec<u8>> {
    transport.ensure_current(store)?;
    {
        let _guard = store.lock()?;
        ensure_bound(store, bound)?;
    }
    let bytes = transport.files_request(request).await?;
    transport.ensure_current(store)?;
    {
        let _guard = store.lock()?;
        ensure_bound(store, bound)?;
    }
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(invalid("La confirmation des pièces est trop volumineuse."));
    }
    Ok(bytes)
}
async fn set_exchange<T: FileTransport>(
    store: &LocalStore,
    bound: &BoundSnapshot,
    transport: &T,
    generation: &str,
    manifest: &FileManifest,
    request: FileRequest,
    page: Option<usize>,
) -> AppResult<SetStatus> {
    let previous: Option<DurableFileStatus<SetStatus>> =
        read_cache(&cache_folder(bound)?, "catalog.json")?;
    if let Some(previous) = &previous {
        if previous.version != 1 || previous.descriptor_sha256 != bound.descriptor_sha256 {
            return Err(invalid(
                "Le catalogue confirmé appartient à une autre copie.",
            ));
        }
        validate_set(bound, generation, manifest, &previous.status, None, None)?;
    }
    let status: SetStatus =
        serde_json::from_slice(&exchange(store, bound, transport, request).await?)?;
    validate_set(
        bound,
        generation,
        manifest,
        &status,
        previous.as_ref().map(|value| &value.status),
        page,
    )?;
    save_cache(
        store,
        bound,
        "catalog.json",
        &DurableFileStatus {
            version: 1,
            descriptor_sha256: bound.descriptor_sha256.clone(),
            status: &status,
        },
    )?;
    Ok(status)
}
fn validate_plan(bound: &BoundSnapshot, blob: &PendingBlob, plan: &BlobPlan) -> AppResult<()> {
    if plan.descriptor_sha256 != bound.descriptor_sha256
        || plan.sha256 != blob.sha256
        || plan.size_bytes != blob.size_bytes
        || plan.parts.len() != blob.size_bytes.div_ceil(PART_BYTES as u64) as usize
        || plan.parts.iter().enumerate().any(|(index, part)| {
            !valid_digest(&part.sha256)
                || part.size_bytes
                    != (blob.size_bytes - index as u64 * PART_BYTES as u64).min(PART_BYTES as u64)
        })
    {
        return Err(invalid("Le découpage figé d'une pièce est incohérent."));
    }
    Ok(())
}
fn part_plan(store: &LocalStore, bound: &BoundSnapshot, blob: &PendingBlob) -> AppResult<BlobPlan> {
    let name = format!("parts-{}.json", blob.sha256);
    {
        let _guard = store.lock()?;
        ensure_bound(store, bound)?;
    }
    if let Some(plan) = read_cache::<BlobPlan>(&cache_folder(bound)?, &name)? {
        validate_plan(bound, blob, &plan)?;
        return Ok(plan);
    }
    let path = bound.folder.join("files").join(&blob.sha256);
    if !regular_metadata(&bound.folder.join("files"))?.is_dir()
        || !regular_metadata(&path)?.is_file()
        || fs::metadata(&path)?.len() != blob.size_bytes
    {
        return Err(invalid(
            "La copie figée d'une pièce est absente ou altérée.",
        ));
    }
    let mut source = File::open(path)?;
    let mut full = Sha256::new();
    let mut parts = vec![];
    let mut remaining = blob.size_bytes;
    while remaining > 0 {
        let mut bytes = vec![0; remaining.min(PART_BYTES as u64) as usize];
        source.read_exact(&mut bytes)?;
        remaining -= bytes.len() as u64;
        full.update(&bytes);
        parts.push(Part {
            sha256: digest(&bytes),
            size_bytes: bytes.len() as u64,
        });
    }
    if source.read(&mut [0u8; 1])? != 0 || format!("{:x}", full.finalize()) != blob.sha256 {
        return Err(invalid(
            "La copie figée d'une pièce est altérée. Son envoi est suspendu.",
        ));
    }
    let plan = BlobPlan {
        descriptor_sha256: bound.descriptor_sha256.clone(),
        sha256: blob.sha256.clone(),
        size_bytes: blob.size_bytes,
        parts,
    };
    validate_plan(bound, blob, &plan)?;
    save_cache(store, bound, &name, &plan)?;
    Ok(plan)
}
fn part_bytes(
    store: &LocalStore,
    bound: &BoundSnapshot,
    plan: &BlobPlan,
    index: usize,
) -> AppResult<Vec<u8>> {
    let _guard = store.lock()?;
    ensure_bound(store, bound)?;
    let folder = bound.folder.join("files");
    let path = folder.join(&plan.sha256);
    if !regular_metadata(&folder)?.is_dir()
        || !regular_metadata(&path)?.is_file()
        || fs::metadata(&path)?.len() != plan.size_bytes
    {
        return Err(invalid("La pièce figée est absente ou altérée."));
    }
    let part = plan
        .parts
        .get(index)
        .ok_or_else(|| invalid("Fragment de pièce inconnu."))?;
    let mut source = File::open(path)?;
    source.seek(SeekFrom::Start(index as u64 * PART_BYTES as u64))?;
    let mut bytes = vec![0; part.size_bytes as usize];
    source.read_exact(&mut bytes)?;
    if digest(&bytes) != part.sha256 {
        return Err(invalid(
            "Un fragment de pièce est altéré. Aucun contenu différent n'a été envoyé.",
        ));
    }
    Ok(bytes)
}
fn validate_blob(
    bound: &BoundSnapshot,
    generation: &str,
    plan: &BlobPlan,
    status: &BlobStatus,
    previous: Option<&BlobStatus>,
    required_part: Option<usize>,
    require_verified: bool,
) -> AppResult<()> {
    if status.transfer_id != bound.prepared.transfer_id
        || status.organization_id != bound.prepared.organization_id
        || status.installation_id != bound.prepared.installation_id
        || status.generation != generation
        || status.sha256 != plan.sha256
        || status.size_bytes != plan.size_bytes
        || status.replication_active
        || (require_verified && !status.verified)
    {
        return Err(invalid(
            "La confirmation de la pièce ne correspond pas à son original.",
        ));
    }
    let mut last = None;
    for received in &status.uploaded_parts {
        let part = plan
            .parts
            .get(received.part_index)
            .ok_or_else(|| invalid("Le serveur confirme un fragment de pièce inconnu."))?;
        if last.is_some_and(|index| index >= received.part_index)
            || received.sha256 != part.sha256
            || received.size_bytes != part.size_bytes
        {
            return Err(invalid("Un fragment confirmé de pièce est incohérent."));
        }
        last = Some(received.part_index);
    }
    if (status.verified && status.uploaded_parts.len() != plan.parts.len())
        || required_part.is_some_and(|index| {
            !status
                .uploaded_parts
                .iter()
                .any(|part| part.part_index == index)
        })
        || previous.is_some_and(|previous| {
            (previous.verified && !status.verified)
                || previous
                    .uploaded_parts
                    .iter()
                    .any(|part| !status.uploaded_parts.contains(part))
        })
    {
        return Err(invalid(
            "La confirmation d'un fragment de pièce a disparu ou est incomplète.",
        ));
    }
    Ok(())
}
enum Confirmation {
    Status,
    Part(usize),
    Verified,
}
async fn blob_exchange<T: FileTransport>(
    store: &LocalStore,
    bound: &BoundSnapshot,
    transport: &T,
    generation: &str,
    plan: &BlobPlan,
    request: FileRequest,
    expected: Confirmation,
) -> AppResult<BlobStatus> {
    let name = format!("receipt-{}.json", plan.sha256);
    let previous: Option<DurableFileStatus<BlobStatus>> = read_cache(&cache_folder(bound)?, &name)?;
    if let Some(previous) = &previous {
        if previous.version != 1 || previous.descriptor_sha256 != bound.descriptor_sha256 {
            return Err(invalid("La pièce confirmée appartient à une autre copie."));
        }
        validate_blob(bound, generation, plan, &previous.status, None, None, false)?;
    }
    let status: BlobStatus =
        serde_json::from_slice(&exchange(store, bound, transport, request).await?)?;
    let part = match expected {
        Confirmation::Part(index) => Some(index),
        _ => None,
    };
    validate_blob(
        bound,
        generation,
        plan,
        &status,
        previous.as_ref().map(|value| &value.status),
        part,
        matches!(expected, Confirmation::Verified),
    )?;
    save_cache(
        store,
        bound,
        &name,
        &DurableFileStatus {
            version: 1,
            descriptor_sha256: bound.descriptor_sha256.clone(),
            status: &status,
        },
    )?;
    Ok(status)
}
async fn transfer_files_pass<T: FileTransport>(
    store: &LocalStore,
    transport: &T,
    limit: usize,
) -> AppResult<Value> {
    if !matches!(transport.role(), "owner" | "admin") {
        return Err(invalid(
            "Seuls le titulaire et les administrateurs peuvent envoyer les pièces de référence.",
        ));
    }
    transport.ensure_current(store)?;
    let bound = std::sync::Arc::new(
        load_prepared(store, transport.organization())?
            .ok_or_else(|| invalid("L'historique initial n'a pas été préparé."))?,
    );
    let source = read_receipts(&bound)?
        .ok_or_else(|| invalid("L'historique initial n'a pas encore été reçu."))?;
    if source.remote.state != "uploaded" {
        return Err(invalid(
            "L'historique initial doit être reçu avant ses pièces.",
        ));
    }
    let generation = &source.remote.generation;
    let manifest = pages(&bound)?;
    let known = read_cache::<DurableFileStatus<SetStatus>>(&cache_folder(&bound)?, "catalog.json")?
        .is_some();
    let begin = if known {
        file_request(&bound, Method::GET, None, None, None)?
    } else {
        file_request(
            &bound,
            Method::POST,
            None,
            None,
            Some(
                json!({"action":"begin","transfer_id":bound.prepared.transfer_id,"manifest":manifest}),
            ),
        )?
    };
    let mut status =
        set_exchange(store, &bound, transport, generation, &manifest, begin, None).await?;
    let mut sent = 0;
    let limit = limit.min(PARTS_PER_PASS);
    while status.state == "cataloguing" && sent < limit {
        let next = (0..manifest.pages.len())
            .find(|index| {
                !status
                    .uploaded_pages
                    .iter()
                    .any(|page| page.page_index == *index)
            })
            .or_else(|| manifest.pages.len().checked_sub(1))
            .ok_or_else(|| invalid("Le serveur attend un catalogue vide."))?;
        let mut request = file_request(&bound, Method::PUT, None, Some(("page", next)), None)?;
        request.body = Some(page_bytes(
            bound
                .prepared
                .files
                .chunks(FILES_PER_PAGE)
                .nth(next)
                .ok_or_else(|| invalid("Page de pièces inconnue."))?,
            manifest.version,
        )?);
        request
            .headers
            .push(("content-type", "application/json".into()));
        status = set_exchange(
            store,
            &bound,
            transport,
            generation,
            &manifest,
            request,
            Some(next),
        )
        .await?;
        sent += 1;
    }
    if status.state == "uploading" {
        for pending in status.pending_blobs.clone() {
            if sent >= limit {
                break;
            }
            // Build per-part checksums only once, off the async network worker.
            let owned_store = store.clone();
            let owned_bound = std::sync::Arc::clone(&bound);
            let plan = tauri::async_runtime::spawn_blocking(move || {
                part_plan(&owned_store, &owned_bound, &pending)
            })
            .await
            .map_err(|_| invalid("La préparation du fichier a été interrompue."))??;
            let mut remote = blob_exchange(
                store,
                &bound,
                transport,
                generation,
                &plan,
                file_request(&bound, Method::GET, Some(&plan.sha256), None, None)?,
                Confirmation::Status,
            )
            .await?;
            while !remote.verified && sent < limit {
                let Some(index) = (0..plan.parts.len()).find(|index| {
                    !remote
                        .uploaded_parts
                        .iter()
                        .any(|part| part.part_index == *index)
                }) else {
                    break;
                };
                let mut request = file_request(
                    &bound,
                    Method::PUT,
                    Some(&plan.sha256),
                    Some(("part", index)),
                    None,
                )?;
                request.body = Some(part_bytes(store, &bound, &plan, index)?);
                request
                    .headers
                    .push(("x-content-sha256", plan.parts[index].sha256.clone()));
                remote = blob_exchange(
                    store,
                    &bound,
                    transport,
                    generation,
                    &plan,
                    request,
                    Confirmation::Part(index),
                )
                .await?;
                sent += 1;
            }
            if !remote.verified && remote.uploaded_parts.len() == plan.parts.len() {
                blob_exchange(
                    store,
                    &bound,
                    transport,
                    generation,
                    &plan,
                    file_request(
                        &bound,
                        Method::POST,
                        Some(&plan.sha256),
                        None,
                        Some(
                            json!({"transfer_id":bound.prepared.transfer_id,"sha256":plan.sha256}),
                        ),
                    )?,
                    Confirmation::Verified,
                )
                .await?;
            }
        }
        status = set_exchange(
            store,
            &bound,
            transport,
            generation,
            &manifest,
            file_request(&bound, Method::GET, None, None, None)?,
            None,
        )
        .await?;
        if status.pending_blobs.is_empty() {
            status = set_exchange(
                store,
                &bound,
                transport,
                generation,
                &manifest,
                file_request(
                    &bound,
                    Method::POST,
                    None,
                    None,
                    Some(json!({"action":"complete","transfer_id":bound.prepared.transfer_id})),
                )?,
                None,
            )
            .await?;
            if status.state != "uploaded" {
                return Err(invalid("Le serveur n'a pas confirmé toutes les pièces."));
            }
        }
    }
    Ok(
        json!({"state":if status.state=="uploaded" {"files_uploaded"} else {"files_uploading"},"transfer_id":bound.prepared.transfer_id,
        "confirmed_files":status.verified_blobs,"total_files":status.total_blobs,"catalog_pages":status.uploaded_pages.len(),"total_catalog_pages":manifest.pages.len(),"sent_file_parts":sent,"replication_active":false}),
    )
}
pub(super) async fn synchronize_files(
    store: &LocalStore,
    transport: &ProjectSyncSession,
) -> AppResult<Value> {
    transfer_files_pass(store, transport, PARTS_PER_PASS).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(super) fn seed_live_qa_files(store: &LocalStore) -> AppResult<()> {
    use base64::Engine;
    let bytes = vec![b'x'; PART_BYTES + 31];
    for index in 0..2 {
        let id = Uuid::new_v4().to_string();
        store.connect()?.execute("INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(?,'qa-native-bootstrap-0000',?,'2026-09-08','2026-09-08')", params![id, format!("Projet fictif de recette HTTPS {index}")])?;
        store.add_project_document(crate::project_documents::AddProjectDocumentInput {
            project_id: id,
            original_name: format!("Document fictif {index}.txt"),
            content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        })?;
    }
    fs::write(store.attachments_dir.join("qa-empty.txt"), b"")?;
    store.connect()?.execute("UPDATE settings SET uid_number='CHE-123.456.789',vat_number='CHE-123.456.789 TVA' WHERE id=1", [])?;
    let profile = store.create_vat_profile(crate::vat_reporting::VatProfileInput {
        id: Some("qa-bootstrap-vat".into()),
        effective_from: "2026-01-01".into(),
        effective_to: None,
        reporting_method: "effective".into(),
        form_of_reporting: "agreed".into(),
        periodicity: "quarterly".into(),
        gross_or_net: "net".into(),
        tdfn_activity_id: None,
        tdfn_rate_bp: None,
        afc_authorization_confirmed: false,
        notes: Some("Recette fictive de transfert ; aucun dépôt auprès de l'AFC.".into()),
        close_previous_open_profile: false,
    })?;
    store.export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
        date_from: "2026-01-01".into(),
        date_to: "2026-03-31".into(),
        submission_type: "initial".into(),
        profile_id: Some(profile.id),
        business_reference_id: "QA-BOOTSTRAP-ONLY".into(),
        file_name: Some("qa-bootstrap-vat.xml".into()),
    })?;
    store.connect()?.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES(?,'Exercice fictif de recette HTTPS','2026-01-01','2026-12-31','open','2026-09-08','2026-09-08')", [Uuid::new_v4().to_string()])?;
    let review = store.prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-12-31".into()),
    })?;
    store.export_fiduciary_closing_zip(
        review["review_id"]
            .as_str()
            .ok_or_else(|| invalid("QA closing review missing"))?,
        env!("CARGO_PKG_VERSION"),
    )?;
    Ok(())
}

#[cfg(test)]
pub(super) async fn live_qa_files(
    store: &LocalStore,
    session: &ProjectSyncSession,
) -> AppResult<()> {
    let bound = load_prepared(store, &session.organization_id)?
        .ok_or_else(|| invalid("QA files snapshot missing"))?;
    assert_eq!(bound.prepared.version, 2);
    assert_eq!(
        bound.prepared.manifest.tables.get("vat_return_exports"),
        Some(&1)
    );
    assert_eq!(
        bound
            .prepared
            .manifest
            .tables
            .get("closing_package_exports"),
        Some(&1)
    );
    let unique = bound
        .prepared
        .files
        .iter()
        .map(|file| (&file.sha256, file.size_bytes))
        .collect::<BTreeMap<_, _>>();
    let unique_bytes = unique.values().sum::<u64>();
    let logical_bytes = bound
        .prepared
        .files
        .iter()
        .map(|file| file.size_bytes)
        .sum::<u64>();
    let binary_parts = unique
        .values()
        .map(|size| size.div_ceil(PART_BYTES as u64))
        .sum::<u64>();
    let catalogue = transfer_files_pass(store, session, 1).await?;
    assert_eq!(catalogue["catalog_pages"], 1);
    assert_eq!(catalogue["state"], "files_uploading");
    let partial = transfer_files_pass(store, session, 1).await?;
    assert_eq!(partial["sent_file_parts"], 1);
    assert_eq!(partial["state"], "files_uploading");
    println!(
        "QA_FILES_PARTIAL transfer={} catalogue_version=2 catalogue_entries={} unique_blobs={} sent_binary_parts=1",
        partial["transfer_id"], bound.prepared.files.len(), unique.len()
    );
    let reopened = LocalStore::initialize(store.data_dir.clone())?;
    let reconnected = project_sync_session(&reopened)
        .await?
        .ok_or_else(|| invalid("QA session missing after file restart"))?;
    let complete = transfer_files_pass(&reopened, &reconnected, 8).await?;
    assert_eq!(complete["state"], "files_uploaded");
    assert_eq!(
        complete["confirmed_files"].as_u64(),
        Some(unique.len() as u64)
    );
    assert_eq!(complete["sent_file_parts"].as_u64(), Some(binary_parts - 1));
    let repeated = transfer_files_pass(&reopened, &reconnected, 8).await?;
    assert_eq!(repeated["sent_file_parts"], 0);
    assert_eq!(repeated["replication_active"], false);
    println!("QA_FILES_COMPLETE transfer={} logical_bytes={} unique_bytes={} resumed_binary_parts={} exports=2 repeated_sent=0 replication_active=false", complete["transfer_id"], logical_bytes, unique_bytes, binary_parts - 1);
    Ok(())
}

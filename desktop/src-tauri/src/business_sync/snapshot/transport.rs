//! Authenticated, resumable transport of a frozen local bootstrap.
//! An upload receipt never grants shared-history or numbering activation.

mod files;
#[cfg(test)]
mod structure_qa;
#[cfg(test)]
mod integrity_qa;
#[cfg(test)]
mod recovery_qa;
#[cfg(test)]
mod supplier_qa;

use super::*;
use crate::account_cloud::ProjectSyncSession;
use reqwest::Method;
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const PARTS_PER_PASS: usize = 8;
const RECEIPTS_FILE: &str = "server-receipts.json";
static RUNNING: AtomicBool = AtomicBool::new(false);
struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Receipt {
    chunk_index: usize,
    sha256: String,
    size_bytes: u64,
    row_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct RemoteStatus {
    transfer_id: String,
    organization_id: String,
    installation_id: String,
    generation: String,
    state: String,
    manifest_sha256: String,
    uploaded_chunks: Vec<Receipt>,
    replication_active: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DurableReceipts {
    version: u32,
    local_generation: String,
    descriptor_sha256: String,
    confirmed_at: String,
    remote: RemoteStatus,
}
struct BoundSnapshot {
    prepared: Prepared,
    folder: PathBuf,
    descriptor_sha256: String,
}

trait BootstrapTransport {
    fn organization(&self) -> &str;
    fn role(&self) -> &str;
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()>;
    fn request(
        &self,
        method: Method,
        id: &str,
        chunk: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> impl Future<Output = AppResult<Vec<u8>>> + Send;
}
impl BootstrapTransport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn request(
        &self,
        method: Method,
        id: &str,
        chunk: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> AppResult<Vec<u8>> {
        let index = chunk.map(|index| index.to_string());
        let mut query = vec![("transfer_id", id)];
        if let Some(index) = index.as_deref() {
            query.push(("chunk", index));
        }
        let headers = if method == Method::POST {
            vec![("content-type", "application/json".to_owned())]
        } else {
            vec![]
        };
        let (status, bytes) = ProjectSyncSession::request(
            self,
            method,
            "/api/sync/bootstrap",
            &query,
            &headers,
            body,
            false,
        )
        .await?;
        if !status.is_success() {
            return Err(invalid(
                "La préparation distante n'est plus disponible. Une réconciliation est nécessaire.",
            ));
        }
        Ok(bytes)
    }
}

fn read_bounded(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    let metadata = regular_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(invalid(
            "Un fichier de préparation est invalide ou trop volumineux.",
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid(
            "Un fichier de préparation a dépassé la taille autorisée.",
        ));
    }
    Ok(bytes)
}
fn load_prepared(store: &LocalStore, organization: &str) -> AppResult<Option<BoundSnapshot>> {
    let _guard = store.lock()?;
    if crate::cloud_backup::is_restoring() {
        return Err(invalid(
            "Une restauration est en cours. L'envoi de l'historique est suspendu.",
        ));
    }
    let connection = store.connect()?;
    let binding:Option<(String,String,String,bool)>=connection.query_row(
        "SELECT organization_id,installation_id,generation,capture_enabled FROM business_sync_binding WHERE id=1",[],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
    let Some((org, installation, id, enabled)) = binding else {
        return Ok(None);
    };
    if org != organization || installation != store.installation_id || !enabled {
        return Err(invalid(
            "Cette copie nécessite une réconciliation avant l'envoi de l'historique.",
        ));
    }
    let folder = store.snapshot_folder(&id)?;
    if !regular_metadata(&folder)?.is_dir() {
        return Err(invalid("La préparation locale est introuvable."));
    }
    let bytes = read_bounded(&folder.join("prepared.json"), MAX_DESCRIPTOR_BYTES)?;
    let prepared: Prepared = serde_json::from_slice(&bytes)?;
    // Large file payloads are checked when they are transferred. The periodic
    // sender must not re-hash gigabytes of attachments for each four-MiB row part.
    prepared.verify_contents(&folder, organization, &store.installation_id, &id, false)?;
    Ok(Some(BoundSnapshot {
        prepared,
        folder,
        descriptor_sha256: digest(&bytes),
    }))
}
fn ensure_bound(store: &LocalStore, bound: &BoundSnapshot) -> AppResult<()> {
    if crate::cloud_backup::is_restoring() {
        return Err(invalid(
            "Une restauration a interrompu l'envoi de l'historique.",
        ));
    }
    let connection = store.connect()?;
    let valid:bool=connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE id=1 AND organization_id=? AND installation_id=? AND generation=? AND capture_enabled=1)",
        params![bound.prepared.organization_id,store.installation_id,bound.prepared.transfer_id],|row|row.get(0))?;
    if !valid || bound.prepared.installation_id != store.installation_id {
        return Err(invalid(
            "La liaison locale a changé. La confirmation distante n'a pas été appliquée.",
        ));
    }
    if !regular_metadata(&bound.folder)?.is_dir()
        || digest(&read_bounded(
            &bound.folder.join("prepared.json"),
            MAX_DESCRIPTOR_BYTES,
        )?) != bound.descriptor_sha256
    {
        return Err(invalid(
            "La copie initiale a changé depuis le début du transfert.",
        ));
    }
    Ok(())
}
fn validate_status(
    prepared: &Prepared,
    status: &RemoteStatus,
    previous: Option<&RemoteStatus>,
    required_chunk: Option<usize>,
) -> AppResult<()> {
    if status.transfer_id != prepared.transfer_id
        || status.organization_id != prepared.organization_id
        || status.installation_id != prepared.installation_id
        || !valid_id(&status.generation)
        || status.replication_active
        || !matches!(status.state.as_str(), "uploading" | "uploaded")
        || status.manifest_sha256 != digest(&serde_json::to_vec(&prepared.manifest)?)
    {
        return Err(invalid(
            "La confirmation distante ne correspond pas à l'historique envoyé.",
        ));
    }
    let mut last = None;
    for receipt in &status.uploaded_chunks {
        let part = prepared
            .manifest
            .chunks
            .get(receipt.chunk_index)
            .ok_or_else(|| invalid("Le serveur confirme un fragment inconnu."))?;
        if last.is_some_and(|index| index >= receipt.chunk_index)
            || receipt.sha256 != part.sha256
            || receipt.size_bytes != part.size_bytes
            || receipt.row_count != part.row_count
        {
            return Err(invalid(
                "L'empreinte, la taille ou le contenu confirmé d'un fragment est incohérent.",
            ));
        }
        last = Some(receipt.chunk_index);
    }
    if status.state == "uploaded" && status.uploaded_chunks.len() != prepared.manifest.chunks.len()
    {
        return Err(invalid(
            "Le serveur annonce un historique reçu alors que des fragments manquent.",
        ));
    }
    if required_chunk.is_some_and(|index| {
        !status
            .uploaded_chunks
            .iter()
            .any(|receipt| receipt.chunk_index == index)
    }) {
        return Err(invalid(
            "Le serveur n'a pas confirmé le fragment qui vient d'être envoyé.",
        ));
    }
    if let Some(previous) = previous {
        if previous.generation != status.generation
            || (previous.state == "uploaded" && status.state != "uploaded")
            || previous
                .uploaded_chunks
                .iter()
                .any(|known| !status.uploaded_chunks.contains(known))
        {
            return Err(invalid("L'historique distant a changé ou un accusé de réception a disparu. Une réconciliation est nécessaire."));
        }
    }
    Ok(())
}
fn read_receipts(bound: &BoundSnapshot) -> AppResult<Option<DurableReceipts>> {
    let path = bound.folder.join(RECEIPTS_FILE);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let receipts: DurableReceipts =
        serde_json::from_slice(&read_bounded(&path, MAX_RESPONSE_BYTES)?)?;
    if receipts.version != 1
        || receipts.local_generation != bound.prepared.transfer_id
        || receipts.descriptor_sha256 != bound.descriptor_sha256
    {
        return Err(invalid(
            "Les accusés de réception locaux appartiennent à une autre préparation.",
        ));
    }
    validate_status(&bound.prepared, &receipts.remote, None, None)?;
    Ok(Some(receipts))
}
fn save_receipts(
    store: &LocalStore,
    bound: &BoundSnapshot,
    status: RemoteStatus,
    required_chunk: Option<usize>,
) -> AppResult<DurableReceipts> {
    let _guard = store.lock()?;
    ensure_bound(store, bound)?;
    let previous = read_receipts(bound)?;
    validate_status(
        &bound.prepared,
        &status,
        previous.as_ref().map(|value| &value.remote),
        required_chunk,
    )?;
    let receipts = DurableReceipts {
        version: 1,
        local_generation: bound.prepared.transfer_id.clone(),
        descriptor_sha256: bound.descriptor_sha256.clone(),
        confirmed_at: now_iso(),
        remote: status,
    };
    let bytes = serde_json::to_vec(&receipts)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(invalid(
            "Les accusés de réception dépassent la taille autorisée.",
        ));
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".receipts-")
        .tempfile_in(&bound.folder)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(bound.folder.join(RECEIPTS_FILE))
        .map_err(|error| error.error)?;
    sync_directory(&bound.folder)?;
    Ok(receipts)
}
fn row_chunk(store: &LocalStore, bound: &BoundSnapshot, index: usize) -> AppResult<Vec<u8>> {
    let _guard = store.lock()?;
    ensure_bound(store, bound)?;
    let folder = bound.folder.join("rows");
    if !regular_metadata(&folder)?.is_dir() {
        return Err(invalid("Les fragments locaux sont indisponibles."));
    }
    let part = bound
        .prepared
        .manifest
        .chunks
        .get(index)
        .ok_or_else(|| invalid("Référence de fragment inconnue."))?;
    let bytes = read_bounded(&folder.join(format!("{index:04}.json")), CHUNK_BYTES as u64)?;
    if bytes.len() as u64 != part.size_bytes || digest(&bytes) != part.sha256 {
        return Err(invalid(
            "Le fragment local est altéré. Aucun contenu différent n'a été envoyé.",
        ));
    }
    Ok(bytes)
}
async fn exchange<T: BootstrapTransport>(
    store: &LocalStore,
    bound: &BoundSnapshot,
    transport: &T,
    method: Method,
    index: Option<usize>,
    body: Option<Vec<u8>>,
) -> AppResult<DurableReceipts> {
    transport.ensure_current(store)?;
    {
        let _guard = store.lock()?;
        ensure_bound(store, bound)?;
    }
    let bytes = transport
        .request(method, &bound.prepared.transfer_id, index, body)
        .await?;
    transport.ensure_current(store)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(invalid("La confirmation distante est trop volumineuse."));
    }
    let status: RemoteStatus = serde_json::from_slice(&bytes)?;
    save_receipts(store, bound, status, index)
}
async fn transfer_pass<T: BootstrapTransport>(
    store: &LocalStore,
    transport: &T,
    limit: usize,
) -> AppResult<Value> {
    if !matches!(transport.role(), "owner" | "admin") {
        return Err(invalid(
            "Seuls le titulaire et les administrateurs peuvent envoyer l'historique initial.",
        ));
    }
    transport.ensure_current(store)?;
    let Some(bound) = load_prepared(store, transport.organization())? else {
        return Ok(json!({"state":"not_prepared","sent_chunks":0,"replication_active":false}));
    };
    let known = read_receipts(&bound)?;
    let mut receipts = if known.is_some() {
        exchange(store, &bound, transport, Method::GET, None, None).await?
    } else {
        let body = serde_json::to_vec(
            &json!({"transfer_id":bound.prepared.transfer_id,"manifest":bound.prepared.manifest}),
        )?;
        if body.len() > 256 * 1024 {
            return Err(invalid(
                "Le manifeste dépasse la taille autorisée par le serveur.",
            ));
        }
        exchange(store, &bound, transport, Method::POST, None, Some(body)).await?
    };
    let mut sent = 0usize;
    while receipts.remote.state != "uploaded" && sent < limit.min(PARTS_PER_PASS) {
        let next = (0..bound.prepared.manifest.chunks.len())
            .find(|index| {
                !receipts
                    .remote
                    .uploaded_chunks
                    .iter()
                    .any(|receipt| receipt.chunk_index == *index)
            })
            // A server interruption after the final durable receipt but before
            // sealing is repaired by an idempotent resend of that last part.
            .unwrap_or(bound.prepared.manifest.chunks.len() - 1);
        let bytes = row_chunk(store, &bound, next)?;
        receipts = exchange(
            store,
            &bound,
            transport,
            Method::PUT,
            Some(next),
            Some(bytes),
        )
        .await?;
        sent += 1;
    }
    Ok(
        json!({"state":if receipts.remote.state=="uploaded" {"history_uploaded"}else{"uploading"},"transfer_id":bound.prepared.transfer_id,
        "confirmed_chunks":receipts.remote.uploaded_chunks.len(),"total_chunks":bound.prepared.manifest.chunks.len(),"sent_chunks":sent,
        "files_pending":bound.prepared.files.len(),"replication_active":false}),
    )
}

/// Runs only after an explicit local preparation. Ordinary account connections
/// never choose an authoritative source, create a binding, or start this upload.
pub(crate) async fn synchronize_if_prepared(store: &LocalStore) -> AppResult<Option<Value>> {
    let enabled: bool = store.connect()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1)",
        [],
        |row| row.get(0),
    )?;
    if !enabled || crate::cloud_backup::is_restoring() {
        return Ok(None);
    }
    if RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(Some(json!({"state":"sending","replication_active":false})));
    }
    let _guard = RunGuard;
    let Some(session) = project_sync_session(store).await? else {
        return Ok(Some(
            json!({"state":"waiting_for_connection","replication_active":false}),
        ));
    };
    let rows = transfer_pass(store, &session, PARTS_PER_PASS).await?;
    if rows["state"] == "history_uploaded" {
        files::synchronize_files(store, &session).await.map(Some)
    } else {
        Ok(Some(rows))
    }
}

#[tauri::command]
pub async fn sync_business_bootstrap(state: State<'_, LocalStore>) -> Result<Value, String> {
    synchronize_if_prepared(state.inner())
        .await
        .map(|status| {
            status.unwrap_or_else(|| json!({"state":"not_prepared","replication_active":false}))
        })
        .map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        prepared: Prepared,
        remote: Mutex<RemoteStatus>,
        requests: Mutex<Vec<(Method, Option<usize>)>>,
        payloads: Mutex<BTreeMap<usize, Vec<u8>>>,
        created: AtomicBool,
        current: AtomicBool,
        lose_begin: AtomicBool,
        lose_part: AtomicBool,
        disconnect_on_part: AtomicBool,
        defer_seal: AtomicBool,
        restore_on_part: Mutex<Option<LocalStore>>,
        role: String,
    }
    impl Fake {
        fn new(store: &LocalStore) -> Self {
            let bound = load_prepared(store, "org-test").unwrap().unwrap();
            let status = RemoteStatus {
                transfer_id: bound.prepared.transfer_id.clone(),
                organization_id: "org-test".into(),
                installation_id: store.installation_id.clone(),
                generation: Uuid::new_v4().to_string(),
                state: "uploading".into(),
                manifest_sha256: digest(&serde_json::to_vec(&bound.prepared.manifest).unwrap()),
                uploaded_chunks: vec![],
                replication_active: false,
            };
            Self {
                prepared: bound.prepared,
                remote: Mutex::new(status),
                requests: Mutex::new(vec![]),
                payloads: Mutex::new(BTreeMap::new()),
                created: AtomicBool::new(false),
                current: AtomicBool::new(true),
                lose_begin: AtomicBool::new(false),
                lose_part: AtomicBool::new(false),
                disconnect_on_part: AtomicBool::new(false),
                defer_seal: AtomicBool::new(false),
                restore_on_part: Mutex::new(None),
                role: "owner".into(),
            }
        }
        fn puts(&self) -> Vec<usize> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter_map(|(method, index)| if *method == Method::PUT { *index } else { None })
                .collect()
        }
    }
    impl BootstrapTransport for Fake {
        fn organization(&self) -> &str {
            "org-test"
        }
        fn role(&self) -> &str {
            &self.role
        }
        fn ensure_current(&self, _store: &LocalStore) -> AppResult<()> {
            if self.current.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(invalid("Account changed"))
            }
        }
        async fn request(
            &self,
            method: Method,
            id: &str,
            index: Option<usize>,
            body: Option<Vec<u8>>,
        ) -> AppResult<Vec<u8>> {
            self.requests.lock().unwrap().push((method.clone(), index));
            assert_eq!(id, self.prepared.transfer_id);
            if method == Method::POST {
                let body: Value = serde_json::from_slice(&body.unwrap()).unwrap();
                assert_eq!(
                    body["manifest"],
                    serde_json::to_value(&self.prepared.manifest).unwrap()
                );
                assert_eq!(body["transfer_id"], id);
                self.created.store(true, Ordering::Release);
                if self.lose_begin.swap(false, Ordering::AcqRel) {
                    return Err(invalid("Lost begin response"));
                }
            } else if method == Method::GET {
                assert!(self.created.load(Ordering::Acquire));
            } else if method == Method::PUT {
                assert!(self.created.load(Ordering::Acquire));
                let index = index.unwrap();
                let bytes = body.unwrap();
                let expected = &self.prepared.manifest.chunks[index];
                assert_eq!(digest(&bytes), expected.sha256);
                assert_eq!(bytes.len() as u64, expected.size_bytes);
                if let Some(previous) = self.payloads.lock().unwrap().insert(index, bytes.clone()) {
                    assert_eq!(previous, bytes);
                }
                let mut remote = self.remote.lock().unwrap();
                if !remote
                    .uploaded_chunks
                    .iter()
                    .any(|receipt| receipt.chunk_index == index)
                {
                    remote.uploaded_chunks.push(Receipt {
                        chunk_index: index,
                        sha256: expected.sha256.clone(),
                        size_bytes: expected.size_bytes,
                        row_count: expected.row_count,
                    });
                    remote
                        .uploaded_chunks
                        .sort_by_key(|receipt| receipt.chunk_index);
                }
                if remote.uploaded_chunks.len() == self.prepared.manifest.chunks.len()
                    && !self.defer_seal.swap(false, Ordering::AcqRel)
                {
                    remote.state = "uploaded".into();
                }
                drop(remote);
                if let Some(store) = self.restore_on_part.lock().unwrap().take() {
                    crate::business_sync::detach_restored_copy(&store.connect()?)?;
                }
                if self.disconnect_on_part.swap(false, Ordering::AcqRel) {
                    self.current.store(false, Ordering::Release);
                }
                if self.lose_part.swap(false, Ordering::AcqRel) {
                    return Err(invalid("Lost part response"));
                }
            } else {
                panic!("Unexpected method")
            }
            Ok(serde_json::to_vec(&*self.remote.lock().unwrap()).unwrap())
        }
    }
    fn fixture(clients: usize) -> (tempfile::TempDir, LocalStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        let mut connection = store.connect().unwrap();
        let transaction = connection.transaction().unwrap();
        for index in 0..clients {
            transaction.execute("INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,'Client fictif','Notes\nDeuxième ligne','2026-09-08','2026-09-08')",[format!("client-{index:05}")]).unwrap();
        }
        transaction.commit().unwrap();
        store
            .prepare_business_snapshot("org-test", "owner")
            .unwrap();
        (directory, store)
    }
    fn receipts(store: &LocalStore) -> Option<DurableReceipts> {
        read_receipts(&load_prepared(store, "org-test").unwrap().unwrap()).unwrap()
    }

    #[test]
    fn lost_manifest_response_reuses_the_original_request_and_server_generation() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = fixture(401);
            let fake = Fake::new(&store);
            fake.lose_begin.store(true, Ordering::Release);
            assert!(transfer_pass(&store, &fake, 1).await.is_err());
            assert!(receipts(&store).is_none());
            let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
            let progress = transfer_pass(&restarted, &fake, 1).await.unwrap();
            assert_eq!(progress["confirmed_chunks"], 1);
            let saved = receipts(&restarted).unwrap();
            assert_eq!(
                saved.remote.generation,
                fake.remote.lock().unwrap().generation
            );
            assert_ne!(saved.local_generation, saved.remote.generation);
            assert_eq!(
                fake.requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(method, _)| *method == Method::POST)
                    .count(),
                2
            );
            assert_eq!(fake.puts(), vec![0]);
        });
    }
    #[test]
    fn lost_part_response_reopens_and_skips_confirmed_bytes_without_losing_later_edits() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = fixture(401);
            let fake = Fake::new(&store);
            fake.lose_part.store(true, Ordering::Release);
            assert!(transfer_pass(&store, &fake, 1).await.is_err());
            assert!(receipts(&store).unwrap().remote.uploaded_chunks.is_empty());
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE clients SET notes='Later offline edit' WHERE id='client-00000'",
                    [],
                )
                .unwrap();
            let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
            let progress = transfer_pass(&restarted, &fake, 8).await.unwrap();
            assert_eq!(progress["state"], "history_uploaded");
            assert_eq!(fake.puts(), vec![0, 1, 2]);
            let final_receipts = receipts(&restarted).unwrap();
            assert_eq!(final_receipts.remote.uploaded_chunks.len(), 3);
            assert_eq!(
                restarted
                    .connect()
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM business_sync_changes WHERE table_name='clients'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
            assert_eq!(
                restarted
                    .connect()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM shared_numbering_binding", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
            let again = transfer_pass(&restarted, &fake, 8).await.unwrap();
            assert_eq!(again["sent_chunks"], 0);
            assert_eq!(fake.puts(), vec![0, 1, 2]);
        });
    }
    #[test]
    fn generation_changes_and_disappearing_receipts_never_overwrite_durable_progress() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = fixture(401);
            let fake = Fake::new(&store);
            transfer_pass(&store, &fake, 1).await.unwrap();
            let saved = receipts(&store).unwrap();
            let baseline = fake.remote.lock().unwrap().clone();
            for kind in [
                "generation",
                "missing",
                "hash",
                "size",
                "count",
                "organization",
                "installation",
                "manifest",
                "activation",
                "duplicate",
                "premature",
            ] {
                let mut changed = baseline.clone();
                match kind {
                    "generation" => changed.generation = Uuid::new_v4().to_string(),
                    "missing" => changed.uploaded_chunks.clear(),
                    "hash" => changed.uploaded_chunks[0].sha256 = "a".repeat(64),
                    "size" => changed.uploaded_chunks[0].size_bytes += 1,
                    "count" => changed.uploaded_chunks[0].row_count += 1,
                    "organization" => changed.organization_id = "org-other".into(),
                    "installation" => changed.installation_id = Uuid::new_v4().to_string(),
                    "manifest" => changed.manifest_sha256 = "b".repeat(64),
                    "activation" => changed.replication_active = true,
                    "duplicate" => changed
                        .uploaded_chunks
                        .push(changed.uploaded_chunks[0].clone()),
                    "premature" => changed.state = "uploaded".into(),
                    _ => unreachable!(),
                }
                *fake.remote.lock().unwrap() = changed;
                assert!(transfer_pass(&store, &fake, 1).await.is_err(), "{kind}");
                assert_eq!(receipts(&store).unwrap().remote, saved.remote, "{kind}");
                assert_eq!(fake.puts(), vec![0]);
            }
        });
    }
    #[test]
    fn per_pass_limit_and_final_sealing_retry_are_bounded_and_idempotent() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = fixture(1801);
            let fake = Fake::new(&store);
            let first = transfer_pass(&store, &fake, 100).await.unwrap();
            assert_eq!(first["sent_chunks"], 8);
            assert_eq!(first["state"], "uploading");
            let last = transfer_pass(&store, &fake, 8).await.unwrap();
            assert_eq!(last["sent_chunks"], 2);
            assert_eq!(last["state"], "history_uploaded");
            let (_other, small) = fixture(0);
            let small_fake = Fake::new(&small);
            small_fake.defer_seal.store(true, Ordering::Release);
            let waiting = transfer_pass(&small, &small_fake, 1).await.unwrap();
            assert_eq!(waiting["state"], "uploading");
            assert_eq!(waiting["confirmed_chunks"], 1);
            let repaired = transfer_pass(&small, &small_fake, 1).await.unwrap();
            assert_eq!(repaired["state"], "history_uploaded");
            assert_eq!(small_fake.puts(), vec![0, 0]);
        });
    }
    #[test]
    fn changed_account_or_restored_profile_during_upload_cannot_accept_the_response() {
        tauri::async_runtime::block_on(async {
            for restore in [false, true] {
                let (_directory, store) = fixture(1);
                let fake = Fake::new(&store);
                if restore {
                    *fake.restore_on_part.lock().unwrap() = Some(store.clone());
                } else {
                    fake.disconnect_on_part.store(true, Ordering::Release);
                }
                assert!(transfer_pass(&store, &fake, 1).await.is_err());
                let id = fake.prepared.transfer_id.clone();
                let saved: DurableReceipts = serde_json::from_slice(
                    &fs::read(store.snapshot_folder(&id).unwrap().join(RECEIPTS_FILE)).unwrap(),
                )
                .unwrap();
                assert!(saved.remote.uploaded_chunks.is_empty());
                assert_eq!(fake.puts(), vec![0]);
            }
        });
    }
    #[test]
    fn corrupt_payload_and_wrong_role_cannot_send_business_rows() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = fixture(1);
            let mut fake = Fake::new(&store);
            for role in ["member", "accountant", "viewer"] {
                fake.role = role.into();
                assert!(transfer_pass(&store, &fake, 8).await.is_err());
                assert!(fake.requests.lock().unwrap().is_empty());
            }
            fake.role = "owner".into();
            let folder = store.snapshot_folder(&fake.prepared.transfer_id).unwrap();
            fs::write(folder.join("rows/0000.json"), b"corrupt").unwrap();
            assert!(transfer_pass(&store, &fake, 1).await.is_err());
            assert!(fake.puts().is_empty());
            assert!(receipts(&store).unwrap().remote.uploaded_chunks.is_empty());
        });
    }

    #[test]
    #[ignore = "Explicit HTTPS acceptance in the named fictitious QA company; the bootstrap and session are cleaned up"]
    fn live_https_bootstrap_resumes_after_the_first_chunk() {
        use futures_util::FutureExt;
        tauri::async_runtime::block_on(async {
            let expected_organization = std::env::var("ZENTRA_BOOTSTRAP_QA_ORGANIZATION")
                .expect("Supply the verified fictitious QA organization before running this test");
            let directory = tempfile::tempdir().unwrap();
            let source = LocalStore::initialize(directory.path().join("bootstrap-source")).unwrap();
            source
                .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
                .unwrap();
            let mut cleanup: Option<(ProjectSyncSession, String)> = None;
            let outcome=std::panic::AssertUnwindSafe(async {
                crate::account_cloud::connect_live_qa_profile(&source,"business-bootstrap").await?;
                let session=project_sync_session(&source).await?.ok_or_else(||invalid("QA session missing"))?;
                if session.organization_id!=expected_organization {return Err(invalid("The QA authorization selected another company. No bootstrap was sent."));}
                let mut connection=source.connect()?;let transaction=connection.transaction()?;
                for index in 0..401 {transaction.execute("INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,'Recette fictive HTTPS','Aucune donnée client réelle\nContrôle de reprise','2026-09-08','2026-09-08')",[format!("qa-native-bootstrap-{index:04}")])?;}
                transaction.commit()?;drop(connection);
                integrity_qa::seed(&source)?;
                files::seed_live_qa_files(&source)?;
                let native_audit=crate::audit::verify_audit_chain(&source.connect()?)?;
                let prepared=source.prepare_business_snapshot(&session.organization_id,&session.role)?;
                let total_chunks=prepared.manifest.chunks.len();
                assert!(total_chunks>1 && total_chunks<=9);
                cleanup=Some((session,prepared.transfer_id.clone()));
                let session=&cleanup.as_ref().unwrap().0;
                let partial=transfer_pass(&source,session,1).await?;
                assert_eq!(partial["confirmed_chunks"],1);assert_eq!(partial["state"],"uploading");
                println!("QA_BOOTSTRAP_PARTIAL transfer={} organization={} confirmed=1 total={}",prepared.transfer_id,session.organization_id,total_chunks);
                assert_eq!(source.connect()?.execute("UPDATE clients SET notes='Modification locale après la copie' WHERE id='qa-native-bootstrap-0000'",[])?,1);
                let reopened=LocalStore::initialize(source.data_dir.clone())?;
                let reconnected=project_sync_session(&reopened).await?.ok_or_else(||invalid("QA session missing after restart"))?;
                let complete=transfer_pass(&reopened,&reconnected,8).await?;
                assert_eq!(complete["state"],"history_uploaded");assert_eq!(complete["sent_chunks"],total_chunks-1);
                assert_eq!(complete["replication_active"],false);
                let duplicate=transfer_pass(&reopened,&reconnected,8).await?;
                assert_eq!(duplicate["sent_chunks"],0);
                let bound=load_prepared(&reopened,&expected_organization)?.ok_or_else(||invalid("QA snapshot missing after restart"))?;
                let stored=read_receipts(&bound)?.ok_or_else(||invalid("QA receipts missing after restart"))?;
                assert_eq!(stored.remote.uploaded_chunks.len(),total_chunks);
                assert_eq!(reopened.connect()?.query_row("SELECT COUNT(*) FROM shared_numbering_binding",[],|row|row.get::<_,i64>(0))?,0);
                assert_eq!(reopened.connect()?.query_row("SELECT COUNT(*) FROM business_sync_changes WHERE table_name='clients'",[],|row|row.get::<_,i64>(0))?,1);
                println!("QA_BOOTSTRAP_COMPLETE transfer={} rows={} resumed_chunks={} repeated_sent=0 pending_local_changes=1 replication_active=false",prepared.transfer_id,prepared.manifest.row_count,total_chunks-1);
                files::live_qa_files(&reopened,&reconnected).await?;
                structure_qa::run(&reconnected,&stored.remote).await?;
                integrity_qa::run(&reconnected,&stored.remote,&native_audit).await?;
                Ok::<(),AppError>(())
            }).catch_unwind().await;
            let removal = if let Some((session, id)) = &cleanup {
                BootstrapTransport::request(session, Method::DELETE, id, None, None)
                    .await
                    .and_then(|bytes| {
                        let response: Value = serde_json::from_slice(&bytes)?;
                        if response["transfer_id"] != id.as_str()
                            || response["state"] != "abandoned"
                            || response["replication_active"] != false
                        {
                            return Err(invalid("The QA bootstrap cleanup was not confirmed."));
                        }
                        Ok(())
                    })
            } else {
                Ok(())
            };
            let disconnected = crate::account_cloud::disconnect_live_qa_profile(&source).await;
            removal.unwrap();
            disconnected.unwrap();
            println!("QA_BOOTSTRAP_CLEANUP_COMPLETE staged_rows_removed=true session_revoked=true");
            outcome.unwrap().unwrap();
        });
    }
}

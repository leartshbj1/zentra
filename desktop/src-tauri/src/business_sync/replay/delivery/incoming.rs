//! Download subsequent committed revisions to private resumable staging. This
//! command never swaps a working database, clears local changes or acknowledges.
use super::*;
use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    error::command_error,
};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    future::Future,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::State;
mod storage;
use storage::{assemble, cached, directory, read, write};

const API: &str = "/api/sync/transactions/commit";
const FILE_PART_BYTES: u64 = 4 * 1024 * 1024;
const SAFE_REVISION: i64 = 9_007_199_254_740_991;
static RUNNING: AtomicBool = AtomicBool::new(false);
struct Running;
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Binding {
    organization: String,
    installation: String,
    capture: String,
    generation: String,
    bootstrap: String,
    revision: i64,
}
impl Binding {
    fn read(store: &LocalStore, organization: &str) -> AppResult<Self> {
        if crate::cloud_backup::is_restoring() {
            return Err(invalid("Attendez la fin de la restauration."));
        }
        let _lock = store.lock()?;
        let c = store.connect()?;
        let result: Option<Self> = c.query_row(
            "SELECT b.organization_id,b.installation_id,b.generation,h.server_generation,h.source_transfer_id,COALESCE(c.revision,1) FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id AND h.organization_id=b.organization_id LEFT JOIN business_sync_cursor c ON c.id=b.id WHERE b.id=1 AND b.capture_enabled=1 AND (c.id IS NULL OR (c.organization_id=b.organization_id AND c.generation=h.server_generation)) AND NOT EXISTS(SELECT 1 FROM business_sync_publication_intent)",
            [], |r| Ok(Self { organization:r.get(0)?, installation:r.get(1)?, capture:r.get(2)?, generation:r.get(3)?, bootstrap:r.get(4)?, revision:r.get(5)? })).optional()?;
        let b = result.ok_or_else(|| {
            invalid("Installez d’abord l’historique partagé de cette entreprise.")
        })?;
        if b.organization != organization
            || b.installation != store.installation_id
            || b.revision < 1
            || b.revision > SAFE_REVISION
            || [&b.capture, &b.generation, &b.bootstrap]
                .iter()
                .any(|s| !uuid(s))
        {
            return Err(invalid(
                "La réception ne correspond pas au dossier installé.",
            ));
        }
        Ok(b)
    }
}
trait Transport {
    fn organization(&self) -> &str;
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()>;
    fn get(
        &self,
        query: &[(&str, &str)],
        limit: u64,
    ) -> impl Future<Output = AppResult<Vec<u8>>> + Send;
}
impl Transport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn get(&self, query: &[(&str, &str)], limit: u64) -> AppResult<Vec<u8>> {
        self.get_bounded(API, query, limit).await
    }
}
fn check(t: &impl Transport, store: &LocalStore, binding: &Binding) -> AppResult<()> {
    t.ensure_current(store)?;
    if Binding::read(store, t.organization())? != *binding {
        return Err(invalid(
            "Le dossier ou sa révision a changé pendant la réception.",
        ));
    }
    Ok(())
}
async fn fetch(
    t: &impl Transport,
    store: &LocalStore,
    binding: &Binding,
    query: &[(&str, &str)],
    limit: u64,
) -> AppResult<Vec<u8>> {
    check(t, store, binding)?;
    let bytes = t.get(query, limit).await?;
    check(t, store, binding)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("La réponse reçue dépasse la taille autorisée."));
    }
    Ok(bytes)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Entry {
    transaction_id: String,
    source_revision: i64,
    revision: i64,
    bundle_sha256: String,
    receipt_sha256: String,
    origin_installation_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Discovery {
    organization_id: String,
    generation: String,
    head_revision: i64,
    commits: Vec<Entry>,
    next_revision: i64,
    has_more: bool,
}
impl Discovery {
    fn validate(&self, b: &Binding) -> AppResult<()> {
        if self.organization_id != b.organization
            || self.generation != b.generation
            || self.head_revision < b.revision
            || self.head_revision > SAFE_REVISION
            || self.commits.len() != (self.head_revision - b.revision).min(20) as usize
            || self.next_revision != b.revision + self.commits.len() as i64
            || self.has_more != (self.next_revision < self.head_revision)
        {
            return Err(invalid("La liste des révisions partagées est incohérente."));
        }
        let mut ids = std::collections::BTreeSet::new();
        for (i, e) in self.commits.iter().enumerate() {
            if e.source_revision != b.revision + i as i64
                || e.revision != e.source_revision + 1
                || !uuid(&e.transaction_id)
                || !uuid(&e.origin_installation_id)
                || !hash(&e.bundle_sha256)
                || !hash(&e.receipt_sha256)
                || !ids.insert(&e.transaction_id)
            {
                return Err(invalid(
                    "Une révision annoncée est absente, répétée ou invalide.",
                ));
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    binding: Binding,
    entry: Entry,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    pieces: usize,
    file: usize,
    part: usize,
}

struct Reception<'a, T> {
    store: &'a LocalStore,
    transport: &'a T,
    binding: Binding,
    entry: Entry,
    folder: PathBuf,
}
impl<T: Transport> Reception<'_, T> {
    async fn resource(
        &self,
        resource: &str,
        sha: &str,
        expected: Option<u64>,
        limit: u64,
        part: Option<usize>,
        path: &Path,
    ) -> AppResult<Vec<u8>> {
        if let Some(bytes) = cached(path, sha, expected, limit)? {
            return Ok(bytes);
        }
        let mut query = vec![
            ("transaction_id", self.entry.transaction_id.as_str()),
            ("resource", resource),
        ];
        let index = part.map(|i| i.to_string());
        if let Some(index) = &index {
            query.push(("part", index));
        }
        let bytes = fetch(self.transport, self.store, &self.binding, &query, limit).await?;
        if digest(&bytes) != sha || expected.is_some_and(|size| size != bytes.len() as u64) {
            return Err(invalid(
                "Le fragment reçu ne correspond pas à la révision confirmée.",
            ));
        }
        write(path, &bytes)?;
        Ok(bytes)
    }
    fn save(&self, p: &Progress) -> AppResult<()> {
        check(self.transport, self.store, &self.binding)?;
        write(&self.folder.join("progress.json"), &serde_json::to_vec(p)?)
    }
    fn status(&self, p: &Progress, complete: bool, head: i64, decoder: &Decoder) -> Value {
        json!({"state":if complete {"transaction_received"} else {"receiving_transactions"},"transaction_id":self.entry.transaction_id,"organization_id":self.binding.organization,
            "generation":self.binding.generation,"revision":self.entry.revision,"installed_revision":self.binding.revision,"head_revision":head,
            "received_pieces":p.pieces,"received_files":p.file,"total_pieces":decoder.bundle.parts.len()*2,"total_files":decoder.manifest.files.len(),
            "replication_active":false,"installed":false,"acknowledged":false})
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePart {
    part_index: usize,
    sha256: String,
    size_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileCatalogue {
    format: String,
    version: u32,
    transaction_id: String,
    organization_id: String,
    generation: String,
    sha256: String,
    size_bytes: u64,
    part_bytes: u64,
    parts: Vec<FilePart>,
}
impl FileCatalogue {
    fn validate(
        &self,
        r: &Reception<'_, impl Transport>,
        file: &crate::business_sync::outgoing::Blob,
    ) -> AppResult<()> {
        if self.format != "zentra-canonical-file"
            || self.version != 1
            || self.transaction_id != r.entry.transaction_id
            || self.organization_id != r.binding.organization
            || self.generation != r.binding.generation
            || self.sha256 != file.sha256
            || self.size_bytes != file.size_bytes
            || self.part_bytes != FILE_PART_BYTES
            || self.parts.len() != file.size_bytes.div_ceil(FILE_PART_BYTES) as usize
        {
            return Err(invalid(
                "Le catalogue ne correspond pas au document attendu.",
            ));
        }
        for (i, p) in self.parts.iter().enumerate() {
            if p.part_index != i
                || !hash(&p.sha256)
                || p.size_bytes
                    != (file.size_bytes - i as u64 * FILE_PART_BYTES).min(FILE_PART_BYTES)
            {
                return Err(invalid("Le catalogue comporte un fragment incohérent."));
            }
        }
        Ok(())
    }
}

async fn receive_pass(store: &LocalStore, t: &impl Transport, limit: usize) -> AppResult<Value> {
    t.ensure_current(store)?;
    let binding = Binding::read(store, t.organization())?;
    let after = binding.revision.to_string();
    let bytes = fetch(
        t,
        store,
        &binding,
        &[
            ("generation", &binding.generation),
            ("after_revision", &after),
        ],
        64 * 1024,
    )
    .await?;
    let discovery: Discovery = serde_json::from_slice(&bytes)?;
    discovery.validate(&binding)?;
    let Some(entry) = discovery.commits.first().cloned() else {
        return Ok(
            json!({"state":"no_new_revision","installed_revision":binding.revision,"head_revision":discovery.head_revision,"replication_active":false}),
        );
    };
    let root = store.data_dir.join("business-reception");
    directory(&root)?;
    let namespace = root.join(digest(&serde_json::to_vec(&binding)?));
    directory(&namespace)?;
    let folder = namespace.join(&entry.transaction_id);
    directory(&folder)?;
    for name in ["changes", "positions", "catalogues", "parts", "files"] {
        directory(&folder.join(name))?;
    }
    let header = Header {
        version: 1,
        binding: binding.clone(),
        entry: entry.clone(),
    };
    let header_path = folder.join("header.json");
    if header_path.try_exists()? {
        if serde_json::from_slice::<Header>(&read(&header_path, 16 * 1024)?)? != header {
            return Err(invalid("La confirmation de cette révision a changé."));
        }
    } else {
        write(&header_path, &serde_json::to_vec(&header)?)?;
    }
    let r = Reception {
        store,
        transport: t,
        binding,
        entry,
        folder,
    };
    let raw = r
        .resource(
            "receipt",
            &r.entry.receipt_sha256,
            None,
            16 * 1024,
            None,
            &r.folder.join("receipt.json"),
        )
        .await?;
    let expected = Expected::from_authenticated_receipt(
        &raw,
        ReceiptRequest {
            organization: &r.binding.organization,
            generation: &r.binding.generation,
            transaction_id: &r.entry.transaction_id,
            source_revision: r.binding.revision,
            receipt_sha256: &r.entry.receipt_sha256,
        },
    )?;
    if expected.receipt.bundle_sha256 != r.entry.bundle_sha256
        || expected.receipt.origin_installation_id != r.entry.origin_installation_id
    {
        return Err(invalid("Le reçu diffère de la révision annoncée."));
    }
    let bundle = r
        .resource(
            "bundle",
            &expected.receipt.bundle_sha256,
            None,
            BUNDLE_BYTES as u64,
            None,
            &r.folder.join("bundle.json"),
        )
        .await?;
    let manifest = r
        .resource(
            "manifest",
            &expected.receipt.manifest_sha256,
            None,
            8 * 1024 * 1024,
            None,
            &r.folder.join("manifest.json"),
        )
        .await?;
    let decoder = Decoder::new(&bundle, &manifest, &expected)?;
    let progress_path = r.folder.join("progress.json");
    let mut p: Progress = if progress_path.try_exists()? {
        serde_json::from_slice(&read(&progress_path, 1024)?)?
    } else {
        Progress::default()
    };
    if p.pieces > decoder.bundle.parts.len() * 2
        || p.file > decoder.manifest.files.len()
        || (p.file > 0 && p.pieces != decoder.bundle.parts.len() * 2)
        || (p.file == decoder.manifest.files.len() && p.part != 0)
    {
        return Err(invalid("L’avancement de réception est incohérent."));
    }
    let mut left = limit.min(8);
    while p.pieces < decoder.bundle.parts.len() * 2 && left > 0 {
        let i = p.pieces / 2;
        let part = &decoder.bundle.parts[i];
        let (kind, sha, size) = if p.pieces.is_multiple_of(2) {
            ("changes", part.source_sha256.as_str(), part.source_bytes)
        } else {
            (
                "positions",
                part.positions_sha256.as_str(),
                part.positions_bytes,
            )
        };
        r.resource(
            kind,
            sha,
            Some(size as u64),
            size as u64,
            Some(i),
            &r.folder.join(kind).join(format!("{i:04}.json")),
        )
        .await?;
        p.pieces += 1;
        left -= 1;
        r.save(&p)?;
    }
    if p.pieces < decoder.bundle.parts.len() * 2 {
        return Ok(r.status(&p, false, discovery.head_revision, &decoder));
    }
    if p.file < decoder.manifest.files.len() && left > 0 {
        let file = &decoder.manifest.files[p.file];
        let catalog_path = r.folder.join("catalogues").join(&file.sha256);
        let query = [
            ("transaction_id", r.entry.transaction_id.as_str()),
            ("resource", "file"),
            ("sha256", file.sha256.as_str()),
        ];
        let raw = if catalog_path.try_exists()? {
            read(&catalog_path, 32 * 1024)?
        } else {
            let raw = fetch(t, store, &r.binding, &query, 32 * 1024).await?;
            let c: FileCatalogue = serde_json::from_slice(&raw)?;
            c.validate(&r, file)?;
            write(&catalog_path, &raw)?;
            raw
        };
        let catalog: FileCatalogue = serde_json::from_slice(&raw)?;
        catalog.validate(&r, file)?;
        if p.part > catalog.parts.len() {
            return Err(invalid("L’avancement du document est incohérent."));
        }
        let parts = r.folder.join("parts").join(&file.sha256);
        directory(&parts)?;
        let destination = r.folder.join("files").join(&file.sha256);
        while p.part < catalog.parts.len() && left > 0 {
            let part = &catalog.parts[p.part];
            let path = parts.join(format!("{:04}", p.part));
            if cached(&path, &part.sha256, Some(part.size_bytes), FILE_PART_BYTES)?.is_none() {
                let index = p.part.to_string();
                let mut query = query.to_vec();
                query.push(("part", &index));
                let bytes = fetch(t, store, &r.binding, &query, part.size_bytes).await?;
                if bytes.len() as u64 != part.size_bytes || digest(&bytes) != part.sha256 {
                    return Err(invalid("Le document reçu est incomplet ou altéré."));
                }
                write(&path, &bytes)?;
            }
            p.part += 1;
            left -= 1;
            r.save(&p)?;
        }
        if p.part < catalog.parts.len() {
            return Ok(r.status(&p, false, discovery.head_revision, &decoder));
        }
        // At most one whole file is assembled per pass, on a blocking worker.
        // The whole-file hash comes from the immutable original manifest, not
        // merely from the independently downloaded catalogue of part hashes.
        let file = file.clone();
        let assembly =
            tauri::async_runtime::spawn_blocking(move || assemble(&parts, &destination, &file));
        assembly
            .await
            .map_err(|_| invalid("La préparation du document a été interrompue."))??;
        check(t, store, &r.binding)?;
        p.file += 1;
        p.part = 0;
        r.save(&p)?;
    }
    let complete = p.file == decoder.manifest.files.len();
    check(t, store, &r.binding)?;
    if complete {
        let folder = r.folder.clone();
        tauri::async_runtime::spawn_blocking(move || verify_downloaded(&folder, &header))
            .await
            .map_err(|_| invalid("La vérification de réception a été interrompue."))??;
        check(t, store, &r.binding)?;
        write(&r.folder.join("received.json"), &raw)?;
    }
    Ok(r.status(&p, complete, discovery.head_revision, &decoder))
}

// The progress file is only an optimization. Never treat its counters, a file
// name, or a previous received marker as proof that all bytes are still intact.
fn verify_downloaded(folder: &Path, expected_header: &Header) -> AppResult<()> {
    let h: Header = serde_json::from_slice(&read(&folder.join("header.json"), 16 * 1024)?)?;
    if h != *expected_header {
        return Err(invalid("Le contexte de réception conservé a changé."));
    }
    let receipt = read(&folder.join("receipt.json"), 16 * 1024)?;
    let expected = Expected::from_authenticated_receipt(
        &receipt,
        ReceiptRequest {
            organization: &h.binding.organization,
            generation: &h.binding.generation,
            transaction_id: &h.entry.transaction_id,
            source_revision: h.binding.revision,
            receipt_sha256: &h.entry.receipt_sha256,
        },
    )?;
    let bundle = read(&folder.join("bundle.json"), BUNDLE_BYTES as u64)?;
    let manifest = read(&folder.join("manifest.json"), 8 * 1024 * 1024)?;
    let mut decoder = Decoder::new(&bundle, &manifest, &expected)?;
    for i in 0..decoder.bundle.parts.len() {
        decoder.part(
            &read(
                &folder.join("changes").join(format!("{i:04}.json")),
                CHUNK_BYTES as u64,
            )?,
            &read(
                &folder.join("positions").join(format!("{i:04}.json")),
                POSITION_BYTES as u64,
            )?,
        )?;
    }
    decoder.finish()?;
    for file in &decoder.manifest.files {
        if snapshot::fingerprint_file(&folder.join("files").join(&file.sha256))?
            != (file.sha256.clone(), file.size_bytes)
        {
            return Err(invalid(
                "Un document reçu est absent ou altéré. La base locale est conservée.",
            ));
        }
    }
    Ok(())
}

/// Installation must freshly pin this header to server discovery and hold the
/// working-profile gate when replacing data. This prepares only a disposable
/// candidate and rejects pending local changes through the existing replay gate.
fn staged_candidate(store: &LocalStore, folder: &Path, header: &Header) -> AppResult<Candidate> {
    if Binding::read(store, &header.binding.organization)? != header.binding {
        return Err(invalid("La révision installée a changé."));
    }
    verify_downloaded(folder, header)?;
    let receipt = read(&folder.join("receipt.json"), 16 * 1024)?;
    let expected = Expected::from_authenticated_receipt(
        &receipt,
        ReceiptRequest {
            organization: &header.binding.organization,
            generation: &header.binding.generation,
            transaction_id: &header.entry.transaction_id,
            source_revision: header.binding.revision,
            receipt_sha256: &header.entry.receipt_sha256,
        },
    )?;
    let bundle = read(&folder.join("bundle.json"), BUNDLE_BYTES as u64)?;
    let manifest = read(&folder.join("manifest.json"), 8 * 1024 * 1024)?;
    let parts = Decoder::new(&bundle, &manifest, &expected)?
        .bundle
        .parts
        .len();
    prepare_candidate(
        store,
        &expected,
        &bundle,
        &manifest,
        (0..parts).map(|i| {
            Ok((
                read(
                    &folder.join("changes").join(format!("{i:04}.json")),
                    CHUNK_BYTES as u64,
                )?,
                read(
                    &folder.join("positions").join(format!("{i:04}.json")),
                    POSITION_BYTES as u64,
                )?,
            ))
        }),
    )
}

#[tauri::command]
pub async fn receive_business_transactions(state: State<'_, LocalStore>) -> Result<Value, String> {
    if RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(json!({"state":"receiving_transactions","replication_active":false}));
    }
    let _running = Running;
    let session = project_sync_session(state.inner())
        .await
        .map_err(command_error)?
        .ok_or_else(|| "Reconnectez votre compte pour recevoir les modifications.".to_owned())?;
    receive_pass(state.inner(), &session, 8)
        .await
        .map_err(command_error)
}

#[cfg(test)]
mod tests;

//! Bounded, exact envelopes for committed local transactions. Preparing an
//! envelope never acknowledges it or changes the installed shared revision.
use super::{files, policy, snapshot};
use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
pub(crate) mod transport;

pub(crate) const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MANIFEST_BYTES: usize = 8 * 1024 * 1024;
const CHANGES_PER_CHUNK: usize = 200;
const MAX_CHANGES: usize = 200_000;
const MAX_TRANSACTION_BYTES: u64 = 512 * 1024 * 1024;
const PREFIX: &[u8] = b"{\"version\":1,\"changes\":[";
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| {
        id.to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Chunk {
    pub sha256: String,
    pub size_bytes: u64,
    pub change_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Blob {
    pub sha256: String,
    pub size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub format: String,
    pub version: u32,
    pub schema_version: u32,
    pub contract_sha256: String,
    pub organization_id: String,
    pub installation_id: String,
    pub generation: String,
    pub capture_generation: String,
    pub bootstrap_transfer_id: String,
    pub transaction_id: String,
    pub base_revision: i64,
    pub first_sequence: String,
    pub last_sequence: String,
    pub change_count: usize,
    pub size_bytes: u64,
    pub chunks: Vec<Chunk>,
    pub files: Vec<Blob>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    sequence: String,
    table: String,
    key_json: String,
    operation: String,
    before_json: Option<String>,
    after_json: Option<String>,
    source_rowid: String,
    files_before: Vec<files::RetainedFile>,
    files_after: Vec<files::RetainedFile>,
}
pub(crate) struct Prepared {
    pub manifest: Manifest,
    pub folder: PathBuf,
}

impl Prepared {
    fn read_chunk(&self, index: usize) -> AppResult<Vec<u8>> {
        let expected = self
            .manifest
            .chunks
            .get(index)
            .ok_or_else(|| invalid("Le fragment demandé n’existe pas."))?;
        let path = self.folder.join(format!("{index:04}.json"));
        let metadata = snapshot::regular_metadata(&path)?;
        if !metadata.is_file()
            || metadata.len() != expected.size_bytes
            || expected.size_bytes > CHUNK_BYTES as u64
        {
            return Err(invalid("Le fragment préparé est absent ou altéré."));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(expected.size_bytes + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != expected.size_bytes || digest(&bytes) != expected.sha256 {
            return Err(invalid("Les octets du fragment préparé sont altérés."));
        }
        Ok(bytes)
    }
}

fn folder(parent: &Path) -> AppResult<()> {
    fs::create_dir_all(parent)?;
    if !snapshot::regular_metadata(parent)?.is_dir() {
        return Err(invalid("Le dossier d’envoi est inaccessible."));
    }
    Ok(())
}
fn flush(
    root: &Path,
    bytes: &mut Vec<u8>,
    count: &mut usize,
    manifest: &mut Manifest,
) -> AppResult<()> {
    if *count == 0 {
        return Ok(());
    }
    bytes.extend_from_slice(b"]}");
    if manifest.chunks.len() >= 1024
        || manifest.size_bytes + bytes.len() as u64 > MAX_TRANSACTION_BYTES
    {
        return Err(invalid(
            "Cette opération dépasse la taille maximale d’un transfert.",
        ));
    }
    let path = root.join(format!("{:04}.json", manifest.chunks.len()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    manifest.chunks.push(Chunk {
        sha256: digest(bytes),
        size_bytes: bytes.len() as u64,
        change_count: *count,
    });
    manifest.size_bytes += bytes.len() as u64;
    bytes.clear();
    bytes.extend_from_slice(PREFIX);
    *count = 0;
    Ok(())
}
fn image_files(
    store: &LocalStore,
    table: &str,
    image: Option<&str>,
    cache: &mut BTreeMap<(String, String), Vec<files::RetainedFile>>,
) -> AppResult<Vec<files::RetainedFile>> {
    let Some(image) = image else {
        return Ok(vec![]);
    };
    if !files::has_files(table) {
        return Ok(vec![]);
    }
    let key = (table.to_owned(), digest(image.as_bytes()));
    if let Some(found) = cache.get(&key) {
        return Ok(found.clone());
    }
    let found = files::retained_image_files(&store.data_dir, table, image)?;
    cache.insert(key, found.clone());
    Ok(found)
}

pub(crate) fn prepare_next(
    store: &LocalStore,
    organization: &str,
    role: &str,
) -> AppResult<Option<Prepared>> {
    if !matches!(role, "owner" | "admin" | "member" | "accountant") {
        return Err(invalid(
            "Ce compte ne peut pas envoyer de modifications métier.",
        ));
    }
    let _guard = store.lock()?;
    if crate::cloud_backup::is_restoring() {
        return Err(invalid("Attendez la fin de la restauration avant l’envoi."));
    }
    let mut connection = store.connect()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let binding:Option<(String,String,String,bool)>=tx.query_row("SELECT organization_id,installation_id,generation,capture_enabled FROM business_sync_binding WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((org, installation, capture, enabled)) = binding else {
        return Ok(None);
    };
    if org != organization || installation != store.installation_id || !enabled || !uuid(&capture) {
        return Err(invalid(
            "Cette copie nécessite une réconciliation avant l’envoi de ses modifications.",
        ));
    }
    let baseline:Option<(String,String,String,String)>=tx.query_row("SELECT organization_id,server_generation,source_transfer_id,receipt_json FROM business_sync_baseline WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((base_org, generation, bootstrap, receipt_json)) = baseline else {
        return Ok(None);
    };
    let receipt: Value = serde_json::from_str(&receipt_json)?;
    if base_org != org
        || !uuid(&generation)
        || !uuid(&bootstrap)
        || receipt["organization_id"] != org
        || receipt["generation"] != generation
        || receipt["transfer_id"] != bootstrap
        || receipt["revision"] != 1
    {
        return Err(invalid("La référence du dossier partagé est incohérente."));
    }
    let current_revision: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT organization_id,generation,revision FROM business_sync_cursor WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if current_revision
        .as_ref()
        .is_some_and(|v| v.0 != org || v.1 != generation || v.2 < 1)
    {
        return Err(invalid(
            "La position de synchronisation appartient à un autre dossier.",
        ));
    }
    let revision = current_revision.map_or(1, |v| v.2);
    let next:Option<String>=tx.query_row("SELECT c.transaction_id FROM business_sync_changes c LEFT JOIN business_sync_receipts r ON r.generation=c.generation AND r.transaction_id=c.transaction_id WHERE c.generation=? GROUP BY c.transaction_id HAVING MAX(c.sequence)>COALESCE(MAX(r.acknowledged_through),0) ORDER BY MIN(c.sequence) LIMIT 1",[&capture],|r|r.get(0)).optional()?;
    let Some(id) = next else {
        return Ok(None);
    };
    if !uuid(&id) {
        return Err(invalid("La référence de l’opération locale est invalide."));
    }
    let partial:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_receipts WHERE generation=? AND transaction_id=?)",params![capture,id],|r|r.get(0))?;
    if partial {
        return Err(invalid("Une opération ne peut pas être confirmée partiellement. Une réconciliation est nécessaire."));
    }
    let base = store.data_dir.join("business-sync");
    folder(&base)?;
    let parent = base.join("outgoing");
    folder(&parent)?;
    let temp = tempfile::Builder::new()
        .prefix(".preparing-")
        .tempdir_in(&parent)?;
    let root = temp.path();
    let contract = policy()?;
    let mut manifest = Manifest {
        format: "zentra-business-transaction".into(),
        version: 1,
        schema_version: super::DATA_SCHEMA_VERSION,
        contract_sha256: snapshot::contract_hash()?,
        organization_id: org.clone(),
        installation_id: installation.clone(),
        generation,
        capture_generation: capture.clone(),
        bootstrap_transfer_id: bootstrap,
        transaction_id: id.clone(),
        base_revision: 0,
        first_sequence: String::new(),
        last_sequence: String::new(),
        change_count: 0,
        size_bytes: 0,
        chunks: vec![],
        files: vec![],
    };
    let mut query=tx.prepare("SELECT sequence,organization_id,installation_id,table_name,row_key_json,operation,before_json,after_json,source_rowid,base_revision FROM business_sync_changes WHERE generation=? AND transaction_id=? ORDER BY sequence")?;
    let mut rows = query.query(params![capture, id])?;
    let mut bytes = PREFIX.to_vec();
    let mut count = 0;
    let mut image_cache = BTreeMap::new();
    let mut blobs = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let seq: i64 = row.get(0)?;
        let row_org: String = row.get(1)?;
        let row_installation: String = row.get(2)?;
        let table: String = row.get(3)?;
        let key_json: String = row.get(4)?;
        let operation: String = row.get(5)?;
        let before_json: Option<String> = row.get(6)?;
        let after_json: Option<String> = row.get(7)?;
        let order: Option<String> = row.get(8)?;
        let base_revision: Option<i64> = row.get(9)?;
        let rule = contract
            .tables
            .get(&table)
            .ok_or_else(|| invalid("Une modification contient une table inconnue."))?;
        let order=order.filter(|s|s.parse::<i64>().is_ok_and(|n|n.to_string()==*s)).ok_or_else(||invalid("Une ancienne modification ne conserve pas son ordre d’origine. Réconciliez le dossier avant son envoi."))?;
        let base_revision=base_revision.filter(|n|*n>=1 && *n<=revision).ok_or_else(||invalid("Une modification précède la copie partagée ou ne conserve pas sa révision d’origine."))?;
        if manifest.change_count == 0 {
            manifest.first_sequence = seq.to_string();
            manifest.base_revision = base_revision;
        }
        if seq < 1
            || row_org != org
            || row_installation != installation
            || base_revision != manifest.base_revision
        {
            return Err(invalid(
                "Les lignes d’une opération appartiennent à des contextes différents.",
            ));
        }
        if !matches!(
            (
                operation.as_str(),
                before_json.is_some(),
                after_json.is_some()
            ),
            ("insert", false, true) | ("update", true, true) | ("delete", true, false)
        ) {
            return Err(invalid("Une modification locale est incomplète."));
        }
        let key: Value = serde_json::from_str(&key_json)?;
        for image in [before_json.as_deref(), after_json.as_deref()]
            .into_iter()
            .flatten()
        {
            snapshot::validate_row(&table, image)?;
            let value: Value = serde_json::from_str(image)?;
            if value.as_object().is_none_or(|v| {
                v.len() != rule.columns.len() || v.keys().any(|k| !rule.columns.contains(k))
            }) || key != Value::Array(rule.key.iter().map(|k| value[k].clone()).collect())
            {
                return Err(invalid(
                    "Une image du journal ne correspond pas au contrat métier.",
                ));
            }
        }
        let files_before = image_files(store, &table, before_json.as_deref(), &mut image_cache)?;
        let files_after = image_files(store, &table, after_json.as_deref(), &mut image_cache)?;
        for file in files_before.iter().chain(&files_after) {
            if blobs
                .insert(file.sha256.clone(), file.size_bytes)
                .is_some_and(|size| size != file.size_bytes)
            {
                return Err(invalid("Deux preuves de document se contredisent."));
            }
        }
        let change = Change {
            sequence: seq.to_string(),
            table,
            key_json,
            operation,
            before_json,
            after_json,
            source_rowid: order,
            files_before,
            files_after,
        };
        let encoded = serde_json::to_vec(&change)?;
        if encoded.len() + PREFIX.len() + 2 > CHUNK_BYTES {
            return Err(invalid(
                "Une modification dépasse la taille maximale d’un fragment.",
            ));
        }
        if count >= CHANGES_PER_CHUNK || bytes.len() + encoded.len() + 3 > CHUNK_BYTES {
            flush(root, &mut bytes, &mut count, &mut manifest)?;
        }
        if count > 0 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(&encoded);
        count += 1;
        manifest.change_count += 1;
        manifest.last_sequence = seq.to_string();
        if manifest.change_count > MAX_CHANGES {
            return Err(invalid(
                "Cette opération contient trop de modifications pour être partagée.",
            ));
        }
    }
    flush(root, &mut bytes, &mut count, &mut manifest)?;
    manifest.files = blobs
        .into_iter()
        .map(|(sha256, size_bytes)| Blob { sha256, size_bytes })
        .collect();
    if manifest.files.len() > 50_000
        || manifest.files.iter().map(|b| b.size_bytes).sum::<u64>() > 10 * 1024 * 1024 * 1024
    {
        return Err(invalid(
            "Les documents de cette opération dépassent la limite de transfert.",
        ));
    }
    let descriptor = serde_json::to_vec(&manifest)?;
    if descriptor.len() > MANIFEST_BYTES {
        return Err(invalid(
            "Le manifeste dépasse la taille maximale d’un transfert.",
        ));
    }
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(root.join("manifest.json"))?;
    file.write_all(&descriptor)?;
    file.sync_all()?;
    drop(file);
    snapshot::sync_directory(root)?;
    let target = parent.join(&id);
    if target.try_exists()? {
        let descriptor_path = target.join("manifest.json");
        let metadata = snapshot::regular_metadata(&descriptor_path)?;
        if !snapshot::regular_metadata(&target)?.is_dir()
            || !metadata.is_file()
            || metadata.len() != descriptor.len() as u64
        {
            return Err(invalid(
                "L’envoi préparé ne correspond plus au journal d’origine.",
            ));
        }
        let mut existing = Vec::new();
        fs::File::open(descriptor_path)?
            .take(descriptor.len() as u64 + 1)
            .read_to_end(&mut existing)?;
        if existing != descriptor {
            return Err(invalid("Le manifeste préparé est altéré."));
        }
        for (index, part) in manifest.chunks.iter().enumerate() {
            if snapshot::fingerprint_file(&target.join(format!("{index:04}.json")))?
                != (part.sha256.clone(), part.size_bytes)
            {
                return Err(invalid("Un fragment préparé est absent ou altéré."));
            }
        }
    } else {
        fs::rename(root, &target)?;
        snapshot::sync_directory(&parent)?;
    }
    Ok(Some(Prepared {
        manifest,
        folder: target,
    }))
}

#[cfg(test)]
mod tests;

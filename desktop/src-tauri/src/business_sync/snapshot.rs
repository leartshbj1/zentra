//! Frozen bootstrap files plus a transactional boundary for subsequent edits.
//! Preparing this bundle does not activate remote replication or numbering.

mod exports;
pub(crate) mod transport;

use super::{identifier, install_capture_triggers, json_image, json_key, policy};
use crate::{
    account_cloud::project_sync_session,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::State;
use uuid::Uuid;
use walkdir::WalkDir;

const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const ROW_BYTES: usize = 1024 * 1024;
const ROWS_PER_CHUNK: usize = 200;
const MAX_CHUNKS: usize = 1024;
const MAX_ROWS: u64 = 200_000;
const MAX_ROW_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FILE_TOTAL: u64 = 10 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
const MAX_DESCRIPTOR_BYTES: u64 = 32 * 1024 * 1024;
const CHUNK_PREFIX: &[u8] = b"{\"version\":1,\"rows\":[";

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| {
        id.to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
pub(super) fn contract_hash() -> AppResult<String> {
    let tables = policy()?
        .tables
        .into_iter()
        .map(|(name, rule)| json!([name, rule.key, rule.columns, rule.local_columns]))
        .collect::<Vec<_>>();
    Ok(digest(&serde_json::to_vec(&json!([
        "zentra-business-contract",
        1,
        60,
        tables
    ]))?))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Chunk {
    sha256: String,
    size_bytes: u64,
    row_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    schema_version: u32,
    contract_sha256: String,
    tables: BTreeMap<String, u64>,
    chunks: Vec<Chunk>,
    row_count: u64,
    size_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct FrozenFile {
    path: String,
    sha256: String,
    size_bytes: u64,
}

/// Verify and freeze registered accounting exports against a database snapshot.
/// Backups use the same checks as initial history without enabling replication.
pub(crate) fn freeze_registered_exports(
    connection: &Connection,
    exports_root: &Path,
    staging: &Path,
) -> AppResult<Vec<(String, PathBuf)>> {
    fs::create_dir_all(staging.join("files"))?;
    let mut files = Vec::new();
    exports::freeze(connection, exports_root, staging, &mut files)?;
    Ok(files
        .into_iter()
        .map(|file| (file.path, staging.join("files").join(file.sha256)))
        .collect())
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Prepared {
    format: String,
    version: u32,
    transfer_id: String,
    organization_id: String,
    installation_id: String,
    created_at: String,
    manifest: Manifest,
    files: Vec<FrozenFile>,
}
#[derive(Serialize)]
struct PortableRow {
    table: String,
    key_json: String,
    row_json: String,
}

pub(super) fn regular_metadata(path: &Path) -> AppResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if linked {
        return Err(invalid(
            "Un lien de fichiers doit être remplacé par une copie locale avant la synchronisation.",
        ));
    }
    Ok(metadata)
}
pub(super) fn safe_relative(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
        || value.chars().any(char::is_control)
        || value.split('/').any(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            let reserved = matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            ) || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|suffix| {
                    suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
                })
            });
            reserved || part.is_empty() || part == "." || part == ".." || part.ends_with([' ', '.'])
        })
    {
        return Err(invalid(
            "La référence d'une pièce jointe n'est pas portable.",
        ));
    }
    Ok(())
}
fn validate_storage_path(path: &str) -> AppResult<()> {
    safe_relative(path)?;
    let (root, relative) = path
        .split_once('/')
        .ok_or_else(|| invalid("Le stockage du document n'est pas précisé."))?;
    if !matches!(root, "attachments" | "exports")
        || (root == "exports" && relative.contains('/'))
        || (root == "attachments"
            && relative
                .split('/')
                .next()
                .is_some_and(|part| part.eq_ignore_ascii_case(super::files::DIRECTORY)))
    {
        return Err(invalid(
            "Le document ne fait pas partie du stockage métier partagé.",
        ));
    }
    Ok(())
}
fn create_file(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn write_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = create_file(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
pub(super) fn sync_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
pub(super) fn fingerprint_file(path: &Path) -> AppResult<(String, u64)> {
    if !regular_metadata(path)?.is_file() {
        return Err(invalid("Une pièce jointe locale n'est pas un fichier."));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_FILE_BYTES {
            return Err(invalid("Une pièce jointe dépasse 512 Mio."));
        }
        hasher.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}
fn freeze_files(root: &Path, folder: &Path) -> AppResult<Vec<FrozenFile>> {
    if !regular_metadata(root)?.is_dir() {
        return Err(invalid("Le stockage des pièces jointes est indisponible."));
    }
    let canonical_root = fs::canonicalize(root)?;
    let blob_folder = folder.join("files");
    fs::create_dir(&blob_folder)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut portable_names = BTreeSet::new();
    let private_cache = root.join(super::files::DIRECTORY);
    if private_cache.try_exists()? && !regular_metadata(&private_cache)?.is_dir() {
        return Err(invalid(
            "Le cache de synchronisation des documents est invalide.",
        ));
    }
    for entry in WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            !(entry.depth() == 1
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(super::files::DIRECTORY)))
        })
    {
        let entry = entry.map_err(|_| {
            invalid("Une pièce jointe est inaccessible. La préparation est annulée.")
        })?;
        let metadata = regular_metadata(entry.path())?;
        if metadata.is_dir() {
            continue;
        }
        if !metadata.is_file() || !fs::canonicalize(entry.path())?.starts_with(&canonical_root) {
            return Err(invalid("Une pièce jointe sort du stockage local autorisé."));
        }
        let path = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| invalid("Référence de pièce jointe invalide."))?
            .to_str()
            .ok_or_else(|| invalid("Le nom d'une pièce jointe n'est pas un texte valide."))?
            .replace('\\', "/");
        safe_relative(&path)?;
        if !portable_names.insert(path.to_lowercase()) {
            return Err(invalid("Deux pièces jointes portent des noms incompatibles sur un autre système. Renommez-les avant le transfert."));
        }
        if files.len() >= MAX_FILES
            || metadata.len() > MAX_FILE_BYTES
            || total.saturating_add(metadata.len()) > MAX_FILE_TOTAL
        {
            return Err(invalid("La préparation dépasse 50 000 fichiers, 512 Mio par fichier ou 10 Gio de pièces jointes."));
        }
        let (sha256, size) = freeze_file_blob(entry.path(), &blob_folder, total)?;
        total += size;
        files.push(FrozenFile {
            path,
            sha256,
            size_bytes: size,
        });
    }
    sync_directory(&blob_folder)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn freeze_file_blob(
    source_path: &Path,
    blob_folder: &Path,
    total: u64,
) -> AppResult<(String, u64)> {
    let metadata = regular_metadata(source_path)?;
    if !metadata.is_file()
        || metadata.len() > MAX_FILE_BYTES
        || total.saturating_add(metadata.len()) > MAX_FILE_TOTAL
    {
        return Err(invalid(
            "Le document dépasse les limites de conservation de l'historique.",
        ));
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".file-")
        .tempfile_in(blob_folder)?;
    let mut source = File::open(source_path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_FILE_BYTES || total.saturating_add(size) > MAX_FILE_TOTAL {
            return Err(invalid("Les pièces jointes dépassent la taille autorisée."));
        }
        hasher.update(&buffer[..count]);
        temporary.write_all(&buffer[..count])?;
    }
    let sha256 = format!("{:x}", hasher.finalize());
    if size != metadata.len() || fingerprint_file(source_path)? != (sha256.clone(), size) {
        return Err(invalid(
            "Un document a changé pendant sa copie. Relancez la préparation.",
        ));
    }
    temporary.as_file().sync_all()?;
    let destination = blob_folder.join(&sha256);
    if destination.try_exists()? {
        if fingerprint_file(&destination)? != (sha256.clone(), size) {
            return Err(invalid("La copie figée d'un document est incohérente."));
        }
    } else {
        temporary
            .persist_noclobber(&destination)
            .map_err(|error| error.error)?;
    }
    Ok((sha256, size))
}
fn validate_file_references(connection: &Connection, files: &[FrozenFile]) -> AppResult<()> {
    let catalog = files
        .iter()
        .filter_map(|file| {
            file.path
                .strip_prefix("attachments/")
                .map(|path| (path, file))
        })
        .collect::<BTreeMap<_, _>>();
    for (sql, kind) in [
        (
            "SELECT stored_name,sha256,size_bytes FROM attachments",
            "attachment",
        ),
        (
            "SELECT stored_path,file_sha256,file_size FROM payroll_document_imports",
            "payroll",
        ),
        (
            "SELECT file_name,sha256,byte_size FROM company_brand_assets",
            "branding",
        ),
    ] {
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let reference: String = row.get(0)?;
            let expected: Option<String> = row.get(1)?;
            let size: i64 = row.get(2)?;
            let path = match kind {
                "payroll" => {
                    let normalized = reference.replace('\\', "/");
                    if normalized.split('/').any(|part| part == "..") {
                        return Err(invalid("Référence de fiche de salaire non portable."));
                    }
                    let mut parts = normalized.rsplit('/');
                    let name = parts.next().unwrap_or_default();
                    if parts.next() != Some("payroll-imports") {
                        return Err(invalid(
                            "Réimportez la fiche de salaire pour conserver sa copie locale.",
                        ));
                    }
                    format!("payroll-imports/{name}")
                }
                "branding" => format!("branding/{reference}"),
                _ => reference,
            };
            safe_relative(&path)?;
            let actual=catalog.get(path.as_str()).ok_or_else(|| invalid("Une pièce référencée est absente du stockage local. Restaurez-la avant la synchronisation."))?;
            if size < 0
                || actual.size_bytes != size as u64
                || expected
                    .as_deref()
                    .is_some_and(|hash| !hash.is_empty() && hash != actual.sha256)
            {
                return Err(invalid("Une pièce jointe ne correspond plus à son empreinte ou à sa taille enregistrée."));
            }
        }
    }
    let logo: Option<String> =
        connection.query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
            row.get(0)
        })?;
    if let Some(logo) = logo.filter(|value| !value.trim().is_empty()) {
        let normalized = logo.replace('\\', "/");
        if normalized.split('/').any(|part| part == "..") {
            return Err(invalid(
                "Réimportez le logo de l'entreprise avant la synchronisation.",
            ));
        }
        let name = normalized.rsplit('/').next().unwrap_or_default();
        if !catalog.contains_key(format!("branding/{name}").as_str()) {
            return Err(invalid(
                "Réimportez le logo de l'entreprise pour conserver sa copie locale.",
            ));
        }
    }
    Ok(())
}
fn validate_row(table: &str, text: &str) -> AppResult<()> {
    if text.len() > ROW_BYTES {
        return Err(invalid(
            "Une ligne métier dépasse la taille autorisée de 1 Mio.",
        ));
    }
    let value: Value = serde_json::from_str(text).map_err(|_| {
        invalid(&format!(
            "La table {table} contient une valeur JSON non représentable."
        ))
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("La ligne métier est invalide."))?;
    for value in object.values() {
        match value {
            Value::Null | Value::String(_) => {}
            Value::Number(number)
                if number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 9_007_199_254_740_991.0) => {}
            _ => {
                return Err(invalid(&format!(
                "La table {table} contient une valeur qui ne peut pas être transférée sans perte."
            )))
            }
        }
    }
    Ok(())
}
fn flush_chunk(
    folder: &Path,
    bytes: &mut Vec<u8>,
    row_count: &mut u64,
    manifest: &mut Manifest,
) -> AppResult<()> {
    if *row_count == 0 {
        return Ok(());
    }
    bytes.extend_from_slice(b"]}");
    if manifest.chunks.len() >= MAX_CHUNKS
        || manifest.size_bytes + bytes.len() as u64 > MAX_ROW_BYTES
    {
        return Err(invalid(
            "L'historique dépasse les limites de transfert initial.",
        ));
    }
    let chunk = Chunk {
        sha256: digest(bytes),
        size_bytes: bytes.len() as u64,
        row_count: *row_count,
    };
    write_new(
        &folder.join(format!("{:04}.json", manifest.chunks.len())),
        bytes,
    )?;
    manifest.size_bytes += chunk.size_bytes;
    manifest.row_count += chunk.row_count;
    manifest.chunks.push(chunk);
    *bytes = CHUNK_PREFIX.to_vec();
    *row_count = 0;
    Ok(())
}
fn freeze_rows(connection: &Connection, folder: &Path) -> AppResult<Manifest> {
    fs::create_dir(folder)?;
    let mut manifest = Manifest {
        format: "zentra-business-bootstrap".into(),
        version: 1,
        schema_version: 60,
        contract_sha256: contract_hash()?,
        tables: BTreeMap::new(),
        chunks: Vec::new(),
        row_count: 0,
        size_bytes: 0,
    };
    let mut bytes = CHUNK_PREFIX.to_vec();
    let mut count = 0;
    let mut total = 0u64;
    for (table, rule) in policy()?.tables {
        let sql = format!(
            "SELECT {},{} FROM {} r ORDER BY {}",
            json_key("r", &rule.key)?,
            json_image("r", &rule.columns)?,
            identifier(&table)?,
            rule.key
                .iter()
                .map(|key| identifier(key))
                .collect::<AppResult<Vec<_>>>()?
                .join(",")
        );
        let mut statement = connection.prepare(&sql)?;
        let mut rows = statement.query([])?;
        let mut table_count = 0u64;
        while let Some(row) = rows.next().map_err(|_| {
            invalid(&format!(
                "Une valeur de la table {table} est incompatible avec le transfert."
            ))
        })? {
            let key_json: String = row.get(0)?;
            let row_json: String = row.get(1)?;
            validate_row(&table, &row_json)?;
            let encoded = serde_json::to_vec(&PortableRow {
                table: table.clone(),
                key_json,
                row_json,
            })?;
            if bytes.len() + usize::from(count > 0) + encoded.len() + 2 > CHUNK_BYTES
                || count >= ROWS_PER_CHUNK as u64
            {
                flush_chunk(folder, &mut bytes, &mut count, &mut manifest)?;
            }
            if bytes.len() + encoded.len() + 2 > CHUNK_BYTES {
                return Err(invalid(
                    "Une ligne métier encodée dépasse la taille d'un fragment.",
                ));
            }
            if count > 0 {
                bytes.push(b',')
            };
            bytes.extend_from_slice(&encoded);
            count += 1;
            table_count += 1;
            total += 1;
            if total > MAX_ROWS {
                return Err(invalid("L'historique initial dépasse 200 000 lignes."));
            }
        }
        manifest.tables.insert(table, table_count);
    }
    flush_chunk(folder, &mut bytes, &mut count, &mut manifest)?;
    if manifest.tables.get("settings") != Some(&1) {
        return Err(invalid(
            "La configuration complète de l'entreprise est nécessaire.",
        ));
    }
    sync_directory(folder)?;
    Ok(manifest)
}

impl Prepared {
    fn summary(&self) -> Value {
        json!({"state":"prepared","transfer_id":self.transfer_id,"rows":self.manifest.row_count,"files":self.files.len(),"file_bytes":self.files.iter().map(|file|file.size_bytes).sum::<u64>(),"replication_active":false})
    }
    fn verify(
        &self,
        folder: &Path,
        organization: &str,
        installation: &str,
        id: &str,
    ) -> AppResult<()> {
        self.verify_contents(folder, organization, installation, id, true)
    }

    fn verify_contents(
        &self,
        folder: &Path,
        organization: &str,
        installation: &str,
        id: &str,
        check_files: bool,
    ) -> AppResult<()> {
        for path in [
            folder.to_path_buf(),
            folder.join("rows"),
            folder.join("files"),
        ] {
            if !regular_metadata(&path)?.is_dir() {
                return Err(invalid("Le dossier de préparation locale est altéré."));
            }
        }
        if self.format != "zentra-local-business-bootstrap"
            || ![1, 2].contains(&self.version)
            || !valid_id(id)
            || self.transfer_id != id
            || self.organization_id != organization
            || self.installation_id != installation
            || self.manifest.format != "zentra-business-bootstrap"
            || self.manifest.version != 1
            || self.manifest.schema_version != 60
            || self.manifest.contract_sha256 != contract_hash()?
            || self.manifest.tables.keys().ne(policy()?.tables.keys())
            || self.manifest.tables.get("settings") != Some(&1)
            || self.manifest.chunks.is_empty()
            || self.manifest.chunks.len() > MAX_CHUNKS
            || self.files.len() > MAX_FILES
        {
            return Err(invalid("La préparation locale ne correspond plus à cette entreprise, cet appareil ou cette version."));
        }
        if self.version == 1
            && ["vat_return_exports", "closing_package_exports"]
                .iter()
                .any(|table| {
                    self.manifest
                        .tables
                        .get(*table)
                        .is_some_and(|count| *count > 0)
                })
        {
            return Err(invalid("Cette ancienne préparation ne conserve pas ses exports historiques. Annulez-la avant de préparer à nouveau l'historique complet."));
        }
        let mut rows = 0u64;
        let mut bytes = 0u64;
        for (index, chunk) in self.manifest.chunks.iter().enumerate() {
            if !valid_digest(&chunk.sha256)
                || chunk.row_count == 0
                || chunk.row_count > ROWS_PER_CHUNK as u64
                || chunk.size_bytes == 0
                || chunk.size_bytes > CHUNK_BYTES as u64
                || (check_files
                    && fingerprint_file(&folder.join("rows").join(format!("{index:04}.json")))?
                        != (chunk.sha256.clone(), chunk.size_bytes))
            {
                return Err(invalid(
                    "Un fragment figé de l'historique est absent ou altéré.",
                ));
            }
            rows = rows
                .checked_add(chunk.row_count)
                .ok_or_else(|| invalid("Le manifeste est trop volumineux."))?;
            bytes = bytes
                .checked_add(chunk.size_bytes)
                .ok_or_else(|| invalid("Le manifeste est trop volumineux."))?;
        }
        let table_rows = self
            .manifest
            .tables
            .values()
            .try_fold(0u64, |sum, count| sum.checked_add(*count))
            .ok_or_else(|| invalid("Les compteurs du manifeste sont invalides."))?;
        if rows != self.manifest.row_count
            || rows != table_rows
            || rows > MAX_ROWS
            || bytes != self.manifest.size_bytes
            || bytes > MAX_ROW_BYTES
        {
            return Err(invalid(
                "Les compteurs du manifeste local sont incohérents.",
            ));
        }
        let mut total = 0u64;
        let mut previous: Option<&str> = None;
        let mut portable_names = BTreeSet::new();
        for file in &self.files {
            safe_relative(&file.path)?;
            if self.version == 2 {
                validate_storage_path(&file.path)?;
            }
            if !portable_names.insert(file.path.to_lowercase())
                || previous.is_some_and(|path| path >= file.path.as_str())
                || !valid_digest(&file.sha256)
                || file.size_bytes > MAX_FILE_BYTES
                || (check_files
                    && fingerprint_file(&folder.join("files").join(&file.sha256))?
                        != (file.sha256.clone(), file.size_bytes))
            {
                return Err(invalid(
                    "Une pièce figée de l'historique est absente ou altérée.",
                ));
            }
            total = total
                .checked_add(file.size_bytes)
                .ok_or_else(|| invalid("Les pièces jointes sont trop volumineuses."))?;
            if total > MAX_FILE_TOTAL {
                return Err(invalid("Les pièces jointes sont trop volumineuses."));
            }
            previous = Some(&file.path);
        }
        Ok(())
    }
}

impl LocalStore {
    fn snapshot_folder(&self, id: &str) -> AppResult<PathBuf> {
        if !valid_id(id) {
            return Err(invalid("La référence de préparation locale est invalide."));
        }
        let parent = self.data_dir.join("business-sync");
        fs::create_dir_all(&parent)?;
        if !regular_metadata(&parent)?.is_dir() {
            return Err(invalid("Le dossier de synchronisation est indisponible."));
        }
        Ok(parent.join(id))
    }
    fn prepare_business_snapshot(&self, organization: &str, role: &str) -> AppResult<Prepared> {
        if !matches!(role, "owner" | "admin") {
            return Err(invalid("Seuls le titulaire et les administrateurs peuvent préparer l'historique de l'entreprise."));
        }
        if organization.is_empty() || organization.len() > 200 {
            return Err(invalid("L'entreprise connectée est invalide."));
        }
        let _guard = self.lock()?;
        if crate::cloud_backup::is_restoring() {
            return Err(invalid(
                "Attendez la fin de la restauration avant de préparer la synchronisation.",
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let binding:Option<(String,String,String,bool)>=transaction.query_row("SELECT organization_id,installation_id,generation,capture_enabled FROM business_sync_binding WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        if let Some((org, installation, id, enabled)) = binding {
            if org != organization || installation != self.installation_id || !enabled {
                return Err(invalid(
                    "Cette copie nécessite une réconciliation avec son entreprise d'origine.",
                ));
            }
            let folder = self.snapshot_folder(&id)?;
            regular_metadata(&folder)?;
            let path = folder.join("prepared.json");
            if regular_metadata(&path)?.len() > MAX_DESCRIPTOR_BYTES {
                return Err(invalid("La préparation locale est illisible."));
            }
            let prepared: Prepared = serde_json::from_slice(&fs::read(path)?)?;
            prepared.verify(&folder, organization, &self.installation_id, &id)?;
            return Ok(prepared);
        }
        for table in ["project_sync_binding", "shared_numbering_binding"] {
            let bound: Option<String> = transaction
                .query_row(
                    &format!("SELECT organization_id FROM {table} WHERE id=1"),
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if bound.is_some_and(|bound| bound != organization) {
                return Err(invalid(
                    "Les données locales sont liées à une autre entreprise.",
                ));
            }
        }
        let schema: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if schema != 60 {
            return Err(invalid(
                "Mettez à jour l'application avant de préparer cet historique.",
            ));
        }
        let integrity: String =
            transaction.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        let broken: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
            [],
            |row| row.get(0),
        )?;
        if integrity != "ok" || broken {
            return Err(invalid(
                "La base locale contient des relations ou des données incohérentes.",
            ));
        }
        crate::audit::verify_audit_chain(&transaction)?;
        let id = Uuid::new_v4().to_string();
        let created_at = now_iso();
        let folder = self.snapshot_folder(&id)?;
        let parent = folder
            .parent()
            .ok_or_else(|| invalid("Dossier de préparation invalide."))?;
        let temporary = tempfile::Builder::new()
            .prefix(".preparing-")
            .tempdir_in(parent)?;
        transaction.execute(
            "INSERT INTO business_sync_binding VALUES(1,?,?,?,1,?)",
            params![organization, self.installation_id, id, created_at],
        )?;
        install_capture_triggers(&transaction)?;
        let manifest = freeze_rows(&transaction, &temporary.path().join("rows"))?;
        let mut files = freeze_files(&self.attachments_dir, temporary.path())?;
        for file in &mut files {
            file.path = format!("attachments/{}", file.path);
            validate_storage_path(&file.path)?;
        }
        exports::freeze(
            &transaction,
            &self.exports_dir,
            temporary.path(),
            &mut files,
        )?;
        validate_file_references(&transaction, &files)?;
        let prepared = Prepared {
            format: "zentra-local-business-bootstrap".into(),
            version: 2,
            transfer_id: id,
            organization_id: organization.into(),
            installation_id: self.installation_id.clone(),
            created_at,
            manifest,
            files,
        };
        let descriptor = serde_json::to_vec(&prepared)?;
        if descriptor.len() as u64 > MAX_DESCRIPTOR_BYTES {
            return Err(invalid(
                "Le catalogue des pièces jointes est trop volumineux.",
            ));
        }
        write_new(&temporary.path().join("prepared.json"), &descriptor)?;
        sync_directory(temporary.path())?;
        fs::rename(temporary.path(), &folder)?;
        sync_directory(parent)?;
        // Files are durable before the binding becomes visible. A crash before
        // commit leaves an unreferenced folder, never a resumable half-snapshot.
        transaction.commit()?;
        Ok(prepared)
    }
}

#[tauri::command]
pub async fn prepare_business_sync_snapshot(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or_else(|| {
            "Connectez votre compte Zentra pour préparer la synchronisation.".to_owned()
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        store
            .prepare_business_snapshot(&session.organization_id, &session.role)
            .map(|prepared| prepared.summary())
    })
    .await
    .map_err(|_| "La préparation locale a été interrompue.".to_owned())?
    .map_err(command_error)
}

#[cfg(test)]
pub(crate) fn assert_export_in_qa_snapshot(store: &LocalStore, file_name: &str, expected: &[u8]) {
    let table = if file_name.ends_with(".xml") {
        "vat_return_exports"
    } else {
        "closing_package_exports"
    };
    let before = crate::database::query_all(
        &store.connect().unwrap(),
        &format!("SELECT * FROM {table}"),
        [],
    )
    .unwrap();
    let prepared = store
        .prepare_business_snapshot("org-exports-qa", "owner")
        .unwrap();
    assert_eq!(prepared.version, 2);
    let file = prepared
        .files
        .iter()
        .find(|file| file.path == format!("exports/{file_name}"))
        .unwrap();
    assert_eq!(file.sha256, digest(expected));
    assert_eq!(
        fs::read(
            store
                .snapshot_folder(&prepared.transfer_id)
                .unwrap()
                .join("files")
                .join(&file.sha256)
        )
        .unwrap(),
        expected
    );
    assert_eq!(
        crate::database::query_all(
            &store.connect().unwrap(),
            &format!("SELECT * FROM {table}"),
            []
        )
        .unwrap(),
        before
    );
    assert_eq!(
        store
            .prepare_business_snapshot("org-exports-qa", "owner")
            .unwrap(),
        prepared
    );
    let mut legacy = prepared.clone();
    legacy.version = 1;
    legacy
        .files
        .retain(|file| !file.path.starts_with("exports/"));
    for file in &mut legacy.files {
        file.path = file.path.strip_prefix("attachments/").unwrap().to_owned();
    }
    assert!(legacy
        .verify(
            &store.snapshot_folder(&legacy.transfer_id).unwrap(),
            "org-exports-qa",
            &store.installation_id,
            &legacy.transfer_id
        )
        .unwrap_err()
        .to_string()
        .contains("ancienne préparation"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, LocalStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        (directory, store)
    }
    fn client(connection: &Connection, id: &str, notes: &str) {
        connection.execute("INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,'Client fictif',?,'2026-09-08','2026-09-08')",params![id,notes]).unwrap();
    }
    fn rows(store: &LocalStore, prepared: &Prepared) -> Vec<Value> {
        (0..prepared.manifest.chunks.len())
            .flat_map(|index| {
                let bytes = fs::read(
                    store
                        .snapshot_folder(&prepared.transfer_id)
                        .unwrap()
                        .join("rows")
                        .join(format!("{index:04}.json")),
                )
                .unwrap();
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                value["rows"].as_array().unwrap().clone()
            })
            .collect()
    }
    fn attachment(store: &LocalStore, name: &str, bytes: &[u8]) {
        fs::write(store.attachments_dir.join(name), bytes).unwrap();
        store.connect().unwrap().execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES(?,'Pièce fictive',?,?,?,'2026-09-08','2026-09-08')",params![Uuid::new_v4().to_string(),name,bytes.len() as i64,digest(bytes)]).unwrap();
    }
    fn assert_unbound(store: &LocalStore) {
        let connection = store.connect().unwrap();
        assert_eq!(
            super::super::status(&connection).unwrap()["state"],
            "not_initialized"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'zentra_sync_*'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn contract_fingerprint_matches_the_deployed_typescript_protocol() {
        assert_eq!(
            contract_hash().unwrap(),
            "4cfe89a2b0bde95c3173481e8e236d26e5bf5df2b20aa1f465fe6d515f6765d8"
        );
    }

    #[test]
    fn restart_resumes_identical_rows_and_files_while_new_changes_stay_in_the_journal() {
        let (_directory, store) = setup();
        client(
            &store.connect().unwrap(),
            "before",
            "Conditions\nDeuxième ligne : œ 2026",
        );
        attachment(&store, "piece-a.pdf", b"fictitious evidence");
        attachment(&store, "piece-b.pdf", b"fictitious evidence");
        let prepared = store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap();
        assert_eq!(prepared.manifest.tables.len(), 106);
        assert_eq!(prepared.manifest.tables["clients"], 1);
        assert!(!prepared.manifest.tables.contains_key("license_state"));
        assert!(!prepared
            .manifest
            .tables
            .contains_key("business_sync_changes"));
        assert!(!prepared
            .manifest
            .tables
            .contains_key("device_number_ranges"));
        assert_eq!(prepared.files.len(), 2);
        assert_eq!(
            fs::read_dir(
                store
                    .snapshot_folder(&prepared.transfer_id)
                    .unwrap()
                    .join("files")
            )
            .unwrap()
            .count(),
            1
        );
        let before = rows(&store, &prepared);
        client(&store.connect().unwrap(), "after", "Ajout après copie");
        fs::write(
            store.attachments_dir.join("piece-a.pdf"),
            b"changed after snapshot",
        )
        .unwrap();
        let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let resumed = restarted
            .prepare_business_snapshot("company-a", "admin")
            .unwrap();
        assert_eq!(prepared, resumed);
        assert_eq!(rows(&restarted, &resumed), before);
        assert!(!before.iter().any(|row| row["key_json"] == "[\"after\"]"));
        let connection = restarted.connect().unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM business_sync_changes WHERE table_name='clients' AND row_key_json='[\"after\"]'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM shared_numbering_binding", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn corrupt_or_missing_managed_files_roll_back_the_entire_preparation() {
        let (_directory, store) = setup();
        attachment(&store, "missing.pdf", b"expected original");
        fs::remove_file(store.attachments_dir.join("missing.pdf")).unwrap();
        assert!(store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap_err()
            .to_string()
            .contains("absente"));
        assert_unbound(&store);
        fs::write(
            store.attachments_dir.join("missing.pdf"),
            b"tampered original",
        )
        .unwrap();
        assert!(store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap_err()
            .to_string()
            .contains("empreinte"));
        assert_unbound(&store);
        assert_eq!(
            fs::read_dir(store.data_dir.join("business-sync"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM attachments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn altered_frozen_chunks_cannot_be_replaced_by_new_live_rows_on_resume() {
        let (_directory, store) = setup();
        let prepared = store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap();
        let path = store
            .snapshot_folder(&prepared.transfer_id)
            .unwrap()
            .join("rows/0000.json");
        fs::write(&path, b"corrupt").unwrap();
        client(&store.connect().unwrap(), "new-client", "Kept pending");
        assert!(store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap_err()
            .to_string()
            .contains("fragment"));
        assert_eq!(fs::read(&path).unwrap(), b"corrupt");
        assert_eq!(
            store
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
    }

    #[test]
    fn roles_company_binding_and_restored_copies_do_not_start_a_new_history() {
        let (_directory, store) = setup();
        for role in ["member", "accountant", "viewer"] {
            assert!(store
                .prepare_business_snapshot("company-a", role)
                .unwrap_err()
                .to_string()
                .contains("administrateurs"));
            assert_unbound(&store);
        }
        let prepared = store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap();
        assert!(store
            .prepare_business_snapshot("company-b", "owner")
            .is_err());
        super::super::detach_restored_copy(&store.connect().unwrap()).unwrap();
        assert!(store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap_err()
            .to_string()
            .contains("réconciliation"));
        assert!(store
            .snapshot_folder(&prepared.transfer_id)
            .unwrap()
            .join("prepared.json")
            .exists());
    }

    #[test]
    fn too_large_or_unrepresentable_business_values_never_enable_capture() {
        let (_directory, store) = setup();
        client(&store.connect().unwrap(), "large", &"x".repeat(ROW_BYTES));
        assert!(store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap_err()
            .to_string()
            .contains("1 Mio"));
        assert_unbound(&store);
        store
            .connect()
            .unwrap()
            .execute("DELETE FROM clients", [])
            .unwrap();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE settings SET invoice_start_number=9007199254740992 WHERE id=1",
                [],
            )
            .unwrap();
        assert!(store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap_err()
            .to_string()
            .contains("sans perte"));
        assert_unbound(&store);
    }

    #[test]
    fn byte_and_row_boundaries_preserve_every_original_json_string() {
        let (_directory, store) = setup();
        let mut connection = store.connect().unwrap();
        let transaction = connection.transaction().unwrap();
        for index in 0..205 {
            client(
                &transaction,
                &format!("client-{index:04}"),
                "Deux lignes\n\"Texte\" en français",
            );
        }
        for index in 0..5 {
            client(
                &transaction,
                &format!("large-{index}"),
                &"\\\"".repeat(220_000),
            );
        }
        transaction.commit().unwrap();
        let prepared = store
            .prepare_business_snapshot("company-a", "owner")
            .unwrap();
        assert!(prepared.manifest.chunks.len() >= 4);
        let mut seen = BTreeMap::new();
        for row in rows(&store, &prepared) {
            let entry = seen
                .entry(row["table"].as_str().unwrap().to_owned())
                .or_insert(0u64);
            *entry += 1;
            validate_row(
                row["table"].as_str().unwrap(),
                row["row_json"].as_str().unwrap(),
            )
            .unwrap();
        }
        for (table, count) in &prepared.manifest.tables {
            assert_eq!(*count, seen.get(table).copied().unwrap_or(0), "{table}");
        }
        prepared
            .verify(
                &store.snapshot_folder(&prepared.transfer_id).unwrap(),
                "company-a",
                &store.installation_id,
                &prepared.transfer_id,
            )
            .unwrap();
    }

    #[test]
    fn unsafe_file_references_are_rejected_without_resolving_other_machine_paths() {
        for path in [
            "../secret",
            "/absolute",
            "C:/Users/private",
            "a\\b",
            "a//b",
            "a/./b",
            "name.",
            "a\0b",
            "a/CON.pdf",
            "a/lpt1.txt",
            "a|b",
            "a?b",
            "a\nb",
        ] {
            assert!(safe_relative(path).is_err(), "{path:?}");
        }
        assert!(safe_relative("payroll-imports/fiche-é.pdf").is_ok());
        let (_directory, store) = setup();
        assert!(store
            .connect()
            .unwrap()
            .execute(
                "UPDATE settings SET logo_path='C:/other-machine/private.png' WHERE id=1",
                [],
            )
            .is_err());
        assert_unbound(&store);
    }

    #[test]
    #[ignore = "Explicit export of a fictitious native snapshot for the TypeScript protocol acceptance test"]
    fn export_fictitious_native_protocol_bundle() {
        use crate::models::{RecordPaymentInput, SaveDocumentWithItemsInput};
        let output = PathBuf::from(
            std::env::var("ZENTRA_NATIVE_BOOTSTRAP_QA")
                .expect("Provide an empty absolute QA output directory"),
        );
        assert!(output.is_absolute());
        let (_directory, store) = setup();
        for index in 0..203 {
            client(
                &store.connect().unwrap(),
                &format!("native-{index:04}"),
                "Conditions\nDeuxième ligne : œ et \"français\"",
            );
        }
        store.install_swiss_accounting_starter().unwrap();
        let customer=store.create_record("clients",json!({
            "name":"Client de recette", "address_line1":"Rue du Client", "address_line2":"7",
            "postal_code":"1000", "city":"Lausanne", "country":"CH"
        })).unwrap();
        let saved=store.save_document_with_items(SaveDocumentWithItemsInput {
            entity:"invoices".into(),id:None,
            data:json!({"client_id":customer["id"],"title":"Recette native vers serveur","service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),
            items:vec![json!({"description":"Prestation fictive\nAvec une deuxième ligne","quantity":1.25,"unit":"heure","unit_price_cents":80_000,"discount_bp":0,"vat_bp":0})],
        }).unwrap();
        let invoice_id = saved["document"]["id"].as_str().unwrap();
        store
            .issue_invoice(invoice_id, Some("2026-09-08".into()), None)
            .unwrap();
        store
            .record_payment(RecordPaymentInput {
                request_id: Uuid::new_v4().to_string(),
                invoice_id: invoice_id.into(),
                amount_cents: 30_000,
                date: Some("2026-09-08".into()),
                method: Some("Banque".into()),
                reference: None,
                notes: Some("Versement fictif".into()),
            })
            .unwrap();
        attachment(&store, "piece.pdf", b"Fictitious protocol evidence");
        let prepared = store
            .prepare_business_snapshot("org_first", "owner")
            .unwrap();
        let source = store.snapshot_folder(&prepared.transfer_id).unwrap();
        fs::create_dir(&output).unwrap();
        fs::create_dir(output.join("rows")).unwrap();
        write_new(
            &output.join("prepared.json"),
            &serde_json::to_vec(&prepared).unwrap(),
        )
        .unwrap();
        for index in 0..prepared.manifest.chunks.len() {
            let name = format!("{index:04}.json");
            write_new(
                &output.join("rows").join(&name),
                &fs::read(source.join("rows").join(name)).unwrap(),
            )
            .unwrap();
        }
    }
}
#[test]
fn private_pending_file_versions_are_not_bootstrap_business_documents() {
    let root = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    fs::write(root.path().join("current.txt"), b"current").unwrap();
    // Case-insensitive reservation also protects a cache restored on Windows.
    let private = root.path().join(".BUSINESS-SYNC-PENDING");
    fs::create_dir(&private).unwrap();
    fs::write(private.join("old-content"), b"abandoned").unwrap();
    let files = freeze_files(root.path(), output.path()).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "current.txt");
}

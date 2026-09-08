//! Immutable bytes for captured row images. Files are sealed before SQLite can
//! commit their journal entry. A rolled-back transaction may leave an unused
//! object; it never leaves a committed reference to unretained bytes.
//!
//! This private subtree lives under attachments so complete backups retain the
//! pending evidence. It is excluded from the authoritative bootstrap catalogue.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use rusqlite::{functions::FunctionFlags, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::snapshot::{fingerprint_file, regular_metadata, safe_relative, sync_directory};
use crate::error::{AppError, AppResult};

pub(super) const DIRECTORY: &str = ".business-sync-pending";
const MAX_BYTES: u64 = 512 * 1024 * 1024;

pub(super) fn has_files(table: &str) -> bool {
    matches!(
        table,
        "attachments"
            | "company_brand_assets"
            | "payroll_document_imports"
            | "settings"
            | "vat_return_exports"
            | "closing_package_exports"
    )
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct RetainedFile {
    root: String,
    path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    table_name: String,
    image_sha256: String,
    files: Vec<RetainedFile>,
}

struct Reference {
    root: &'static str,
    path: String,
    sha256: Option<String>,
    size: Option<u64>,
}

fn text<'a>(row: &'a Value, name: &str) -> AppResult<&'a str> {
    row[name]
        .as_str()
        .ok_or_else(|| invalid("La référence du document est incomplète."))
}

fn managed_name(reference: &str, folder: &str) -> AppResult<String> {
    let normalized = reference.replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") {
        return Err(invalid("La référence du document sort du stockage local."));
    }
    let mut parts = normalized.rsplit('/');
    let name = parts.next().unwrap_or_default();
    // Bootstrap also resolves legacy logos by basename inside the managed
    // branding directory. Never follow their former absolute path.
    if folder != "branding" && parts.next() != Some(folder) {
        return Err(invalid(
            "Réimportez ce document pour conserver une copie locale.",
        ));
    }
    let path = format!("{folder}/{name}");
    safe_relative(&path)?;
    Ok(path)
}

fn reference(table: &str, row: &Value) -> AppResult<Option<Reference>> {
    let (root, path, hash_field, size_field) = match table {
        "attachments" => (
            "attachments",
            text(row, "stored_name")?.to_owned(),
            Some("sha256"),
            Some("size_bytes"),
        ),
        "company_brand_assets" => (
            "attachments",
            format!("branding/{}", text(row, "file_name")?),
            Some("sha256"),
            Some("byte_size"),
        ),
        "payroll_document_imports" => (
            "attachments",
            managed_name(text(row, "stored_path")?, "payroll-imports")?,
            Some("file_sha256"),
            Some("file_size"),
        ),
        "settings" => {
            let Some(logo) = row["logo_path"]
                .as_str()
                .filter(|path| !path.trim().is_empty())
            else {
                return Ok(None);
            };
            ("attachments", managed_name(logo, "branding")?, None, None)
        }
        "vat_return_exports" => (
            "exports",
            text(row, "file_name")?.to_owned(),
            Some("xml_sha256"),
            None,
        ),
        // manifest_sha256 hashes the manifest inside the ZIP, not the ZIP bytes.
        "closing_package_exports" => ("exports", text(row, "file_name")?.to_owned(), None, None),
        _ => return Ok(None),
    };
    safe_relative(&path)?;
    if path
        .split('/')
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case(DIRECTORY))
    {
        return Err(invalid(
            "Le cache de synchronisation ne peut pas devenir une pièce métier.",
        ));
    }
    let mut sha256 = hash_field
        .and_then(|field| row[field].as_str())
        .filter(|hash| !hash.is_empty())
        .map(str::to_owned);
    if table == "settings" {
        sha256 = path
            .strip_prefix("branding/logo-")
            .and_then(|name| name.rsplit_once('.'))
            .map(|(hash, _)| hash)
            .filter(|hash| valid_hash(hash))
            .map(str::to_owned);
    }
    if sha256.as_deref().is_some_and(|hash| !valid_hash(hash)) {
        return Err(invalid("L'empreinte du document est invalide."));
    }
    let size = size_field
        .map(|field| {
            row[field]
                .as_u64()
                .filter(|size| *size <= MAX_BYTES)
                .ok_or_else(|| invalid("La taille du document est invalide."))
        })
        .transpose()?;
    Ok(Some(Reference {
        root,
        path,
        sha256,
        size,
    }))
}

fn directory(path: &Path) -> AppResult<()> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    if !regular_metadata(path)?.is_dir() {
        return Err(invalid("Le cache des documents est inaccessible."));
    }
    Ok(())
}

fn cache_root(data_dir: &Path) -> AppResult<PathBuf> {
    if !regular_metadata(data_dir)?.is_dir()
        || !regular_metadata(&data_dir.join("attachments"))?.is_dir()
    {
        return Err(invalid("Le stockage local des documents est inaccessible."));
    }
    let root = data_dir.join("attachments").join(DIRECTORY);
    directory(&root)?;
    directory(&root.join("blobs"))?;
    directory(&root.join("references"))?;
    sync_directory(&root)?;
    sync_directory(&data_dir.join("attachments"))?;
    Ok(root)
}

fn checked_source(data_dir: &Path, reference: &Reference) -> AppResult<PathBuf> {
    let root = data_dir.join(reference.root);
    if !regular_metadata(&root)?.is_dir() {
        return Err(invalid("Le stockage du document est inaccessible."));
    }
    let mut path = root.clone();
    let parts = reference.path.split('/').collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        let metadata = regular_metadata(&path)?;
        if index + 1 < parts.len() && !metadata.is_dir() {
            return Err(invalid("La référence du document est invalide."));
        }
    }
    if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?) {
        return Err(invalid("Le document sort du stockage local."));
    }
    Ok(path)
}

fn verify_blob(root: &Path, hash: &str, size: Option<u64>) -> AppResult<u64> {
    if !valid_hash(hash) {
        return Err(invalid("L'empreinte conservée est invalide."));
    }
    let actual = fingerprint_file(&root.join("blobs").join(hash))?;
    if actual.0 != hash || size.is_some_and(|size| size != actual.1) {
        return Err(invalid(
            "La copie conservée du document est altérée. L'enregistrement est annulé.",
        ));
    }
    Ok(actual.1)
}

fn seal(
    root: &Path,
    source: &Path,
    expected: Option<&str>,
    size: Option<u64>,
) -> AppResult<(String, u64)> {
    let metadata = regular_metadata(source)?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(invalid(
            "Le document à conserver est invalide ou dépasse 512 Mio.",
        ));
    }
    let mut input = File::open(source)?;
    let mut output = tempfile::NamedTempFile::new_in(root.join("blobs"))?;
    let mut hasher = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        length += read as u64;
        if length > MAX_BYTES {
            return Err(invalid("Le document dépasse 512 Mio."));
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    let hash = format!("{:x}", hasher.finalize());
    if expected.is_some_and(|expected| expected != hash)
        || size.is_some_and(|size| size != length)
        || metadata.len() != length
        || fingerprint_file(source)? != (hash.clone(), length)
    {
        return Err(invalid(
            "Le document a changé pendant sa conservation. L'enregistrement est annulé.",
        ));
    }
    output.as_file().sync_all()?;
    let destination = root.join("blobs").join(&hash);
    match output.persist_noclobber(&destination) {
        Ok(_) => (),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            verify_blob(root, &hash, Some(length))?;
        }
        Err(error) => return Err(error.error.into()),
    }
    sync_directory(&root.join("blobs"))?;
    Ok((hash, length))
}

fn receipt_key(table: &str, image: &str) -> String {
    digest(format!("{table}\0{image}").as_bytes())
}

fn retain_image(data_dir: &Path, table: &str, image: &str) -> AppResult<()> {
    let row: Value = serde_json::from_str(image)?;
    let Some(reference) = reference(table, &row)? else {
        return Ok(());
    };
    let root = cache_root(data_dir)?;
    let image_sha256 = digest(image.as_bytes());
    let destination = root
        .join("references")
        .join(format!("{}.json", receipt_key(table, image)));
    if destination.try_exists()? {
        if regular_metadata(&destination)?.len() > 4096 {
            return Err(invalid("La preuve du document est illisible."));
        }
        let receipt: Receipt = serde_json::from_slice(&fs::read(&destination)?)?;
        if receipt.version != 1
            || receipt.table_name != table
            || receipt.image_sha256 != image_sha256
            || receipt.files.len() != 1
        {
            return Err(invalid(
                "La preuve conservée ne correspond pas au document.",
            ));
        }
        let file = &receipt.files[0];
        if file.root != reference.root
            || file.path != reference.path
            || reference
                .sha256
                .as_deref()
                .is_some_and(|hash| hash != file.sha256)
            || reference.size.is_some_and(|size| size != file.size_bytes)
        {
            return Err(invalid(
                "La preuve conservée ne correspond pas au document.",
            ));
        }
        verify_blob(&root, &file.sha256, Some(file.size_bytes))?;
        return Ok(());
    }
    // A prepared attachment can still have its temporary name at SQL INSERT.
    // Its import helper seals these exact bytes before writing the row. The
    // existing RAII installer must still succeed before committing that row.
    let (sha256, size_bytes) = match reference.sha256.as_deref() {
        Some(hash) if root.join("blobs").join(hash).try_exists()? => {
            (hash.to_owned(), verify_blob(&root, hash, reference.size)?)
        }
        _ => seal(
            &root,
            &checked_source(data_dir, &reference)?,
            reference.sha256.as_deref(),
            reference.size,
        )?,
    };
    let receipt = Receipt {
        version: 1,
        table_name: table.into(),
        image_sha256,
        files: vec![RetainedFile {
            root: reference.root.into(),
            path: reference.path,
            sha256,
            size_bytes,
        }],
    };
    let bytes = serde_json::to_vec(&receipt)?;
    let mut output = tempfile::NamedTempFile::new_in(root.join("references"))?;
    output.write_all(&bytes)?;
    output.as_file().sync_all()?;
    match output.persist_noclobber(&destination) {
        Ok(_) => (),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if regular_metadata(&destination)?.len() > 4096 || fs::read(destination)? != bytes {
                return Err(invalid(
                    "Deux copies contradictoires du document ont été détectées.",
                ));
            }
        }
        Err(error) => return Err(error.error.into()),
    }
    sync_directory(&root.join("references"))?;
    Ok(())
}

pub(super) fn register(connection: &Connection, data_dir: &Path) -> AppResult<()> {
    let data_dir = data_dir.to_path_buf();
    // Not deterministic or innocuous: this function deliberately performs I/O.
    connection.create_scalar_function(
        "zentra_sync_retain_files",
        2,
        FunctionFlags::SQLITE_UTF8,
        move |context| {
            let table = context.get::<String>(0)?;
            let image = context.get::<Option<String>>(1)?;
            if let Some(image) = image.filter(|_| has_files(&table)) {
                retain_image(&data_dir, &table, &image).map_err(|error| {
                    rusqlite::Error::UserFunctionError(Box::new(std::io::Error::other(
                        error.to_string(),
                    )))
                })?;
            }
            Ok(1)
        },
    )?;
    Ok(())
}

/// Use only for an attachment staged inside this profile, before its row is
/// inserted. Ordinary profiles do not create a cache or read the staged bytes.
pub(crate) fn retain_prepared(
    connection: &Connection,
    data_dir: &Path,
    source: &Path,
    hash: &str,
    size: u64,
) -> AppResult<()> {
    let enabled: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1)",
        [],
        |row| row.get(0),
    )?;
    if !enabled {
        return Ok(());
    }
    if !valid_hash(hash) || source.parent() != Some(data_dir.join("attachments").as_path()) {
        return Err(invalid("La pièce préparée n'appartient pas à ce profil."));
    }
    let root = cache_root(data_dir)?;
    seal(&root, source, Some(hash), Some(size))?;
    Ok(())
}

#[cfg(test)]
mod tests;

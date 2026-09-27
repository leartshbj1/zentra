use std::{fs, io::Read, path::{Component, Path}};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use crate::error::{AppError, AppResult};

/// Validate the files referenced by this exact database, without consulting
/// paths on the original computer or loading entire documents into memory.
pub(super) fn validate_files(database: &Path, root: &Path) -> AppResult<()> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    for (table, sql) in [
        ("attachments", "SELECT stored_name,size_bytes,sha256 FROM attachments"),
        ("company_brand_assets", "SELECT 'branding/' || file_name,byte_size,sha256 FROM company_brand_assets"),
    ] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            [table], |row| row.get(0),
        )?;
        if !exists { continue; }
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(0)?;
            let size: i64 = row.get(1)?;
            let digest: Option<String> = row.get(2)?;
            validate_file(root, &name, size, digest.as_deref())?;
        }
    }
    Ok(())
}

fn invalid_file() -> AppError {
    AppError::Validation(
        "Un document ou un logo est absent ou abîmé. Cette sauvegarde ne peut pas être utilisée. Vos données actuelles sont conservées. Récupérez une copie complète depuis l’appareil d’origine, puis réessayez.".into(),
    )
}

fn validate_file(root: &Path, name: &str, size: i64, expected_digest: Option<&str>) -> AppResult<()> {
    // Treat separators consistently across Windows, macOS and mobile.
    let normalized = name.replace('\\', "/");
    let relative = Path::new(&normalized);
    super::ensure_safe_relative(relative)?;
    if size < 0 { return Err(invalid_file()); }
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else { return Err(invalid_file()); };
        path.push(part);
        if fs::symlink_metadata(&path).map_err(|_| invalid_file())?.file_type().is_symlink() {
            return Err(invalid_file());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| invalid_file())?;
    let canonical_path = fs::canonicalize(&path).map_err(|_| invalid_file())?;
    if !canonical_path.starts_with(canonical_root) { return Err(invalid_file()); }
    let mut file = fs::File::open(path).map_err(|_| invalid_file())?;
    let metadata = file.metadata().map_err(|_| invalid_file())?;
    if !metadata.is_file() || metadata.len() != size as u64 { return Err(invalid_file()); }
    // Old generic attachments can lack a digest; preserve that compatibility,
    // while all current document imports and branding have a SHA-256 value.
    if let Some(expected) = expected_digest {
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid_file());
        }
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut read_size = 0u64;
        loop {
            let count = file.read(&mut buffer).map_err(|_| invalid_file())?;
            if count == 0 { break; }
            read_size += count as u64;
            if read_size > size as u64 { return Err(invalid_file()); }
            digest.update(&buffer[..count]);
        }
        if read_size != size as u64 || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected) {
            return Err(invalid_file());
        }
    }
    Ok(())
}

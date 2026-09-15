//! Compare shared content, not the bookkeeping performed by an idle device.
use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};
use rusqlite::{types::ValueRef, Connection};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

pub(crate) fn ignored_column(table: &str, column: &str) -> bool {
    column == "updated_at" || table == "reminder_settings" && column == "last_scan_at"
}

pub(crate) fn noop_scan_sql(prefix: &str) -> String {
    format!("{prefix}operation='scan' AND json_valid({prefix}response_json)=1 AND CASE WHEN json_valid({prefix}response_json)=1 THEN \
      json_type({prefix}response_json,'$.created')='array' AND json_array_length({prefix}response_json,'$.created')=0 AND \
      json_type({prefix}response_json,'$.cancelled')='array' AND json_array_length({prefix}response_json,'$.cancelled')=0 AND \
      json_type({prefix}response_json,'$.promoted')='array' AND json_array_length({prefix}response_json,'$.promoted')=0 ELSE 0 END")
}

fn add(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value);
}

fn database_digest(db: &Connection) -> AppResult<Sha256> {
    let mut hash = Sha256::new();
    add(&mut hash, b"Zentra shared content v1");
    let mut query =
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
    let tables = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for table in tables {
        if super::company_collaboration::local_table(&table) {
            continue;
        }
        if !table
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err(AppError::Validation("Table de partage inconnue.".into()));
        }
        let mut info = db.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
        let mut columns = info
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        columns.retain(|c| !ignored_column(&table, c));
        columns.sort();
        let selected = columns
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        let filter = if table == "reminder_operation_requests" {
            format!(" WHERE NOT COALESCE(({}),0)", noop_scan_sql(""))
        } else {
            String::new()
        };
        let mut statement = db.prepare(&format!("SELECT {selected} FROM \"{table}\"{filter}"))?;
        let mut rows = statement.query([])?;
        let mut digests = Vec::new();
        while let Some(row) = rows.next()? {
            let mut row_hash = Sha256::new();
            for (i, column) in columns.iter().enumerate() {
                add(&mut row_hash, column.as_bytes());
                match row.get_ref(i)? {
                    ValueRef::Null => add(&mut row_hash, b"null"),
                    ValueRef::Integer(v) => {
                        add(&mut row_hash, b"integer");
                        add(&mut row_hash, &v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        add(&mut row_hash, b"real");
                        add(&mut row_hash, &v.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(v) => {
                        add(&mut row_hash, b"text");
                        add(&mut row_hash, v);
                    }
                    ValueRef::Blob(v) => {
                        add(&mut row_hash, b"blob");
                        add(&mut row_hash, v);
                    }
                }
            }
            digests.push(row_hash.finalize().to_vec());
        }
        digests.sort();
        add(&mut hash, table.as_bytes());
        for c in columns {
            add(&mut hash, c.as_bytes());
        }
        add(&mut hash, &(digests.len() as u64).to_le_bytes());
        for row in digests {
            add(&mut hash, &row);
        }
    }
    Ok(hash)
}

fn finish(mut hash: Sha256, mut files: Vec<(String, Vec<u8>)>) -> String {
    files.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, digest) in files {
        add(&mut hash, name.as_bytes());
        add(&mut hash, &digest);
    }
    format!("{:x}", hash.finalize())
}

fn file_digest(reader: &mut impl Read) -> AppResult<Vec<u8>> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().to_vec())
}

/// Caller holds the local operation lock; no business write can race this read.
pub(crate) fn local(store: &LocalStore) -> AppResult<String> {
    let hash = database_digest(&store.connect()?)?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(&store.attachments_dir).follow_links(false) {
        let entry = entry
            .map_err(|_| AppError::Validation("Un document local est inaccessible.".into()))?;
        if entry.file_type().is_symlink() {
            return Err(AppError::Validation(
                "Un lien de document doit être vérifié.".into(),
            ));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&store.attachments_dir)
            .map_err(|_| AppError::UnsafePath(entry.path().into()))?;
        files.push((
            format!(
                "attachments/{}",
                relative.to_string_lossy().replace('\\', "/")
            ),
            file_digest(&mut File::open(entry.path())?)?,
        ));
    }
    Ok(finish(hash, files))
}

/// Only a downloaded, hash-verified transport archive is accepted by callers.
pub(crate) fn archive(path: &Path) -> AppResult<String> {
    let mut zip = zip::ZipArchive::new(File::open(path)?)?;
    let temporary = tempfile::tempdir()?;
    let db_path = temporary.path().join("database.sqlite3");
    {
        let mut source = zip.by_name("database.sqlite3")?;
        if source.size() > 512 * 1024 * 1024 {
            return Err(AppError::Validation(
                "Copie de référence trop volumineuse.".into(),
            ));
        }
        let mut target = File::create(&db_path)?;
        std::io::copy(&mut source, &mut target)?;
        target.flush()?;
    }
    let db = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let hash = database_digest(&db)?;
    drop(db);
    let mut files = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        if entry.is_dir() || !entry.name().starts_with("attachments/") {
            continue;
        }
        if entry.size() > 512 * 1024 * 1024 {
            return Err(AppError::Validation(
                "Document de référence trop volumineux.".into(),
            ));
        }
        files.push((entry.name().to_string(), file_digest(&mut entry)?));
    }
    Ok(finish(hash, files))
}

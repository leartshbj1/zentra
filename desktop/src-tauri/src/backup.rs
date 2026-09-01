use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use rusqlite::{backup::Backup, params, Connection, OptionalExtension};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    database::{now_iso, LocalStore},
    error::{AppError, AppResult},
    models::{BackupManifest, ExportEnvelope},
    schema::SCHEMA_VERSION,
};

const BACKUP_FORMAT: &str = "helvichantier-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const DATABASE_ENTRY: &str = "database.sqlite3";
const ATTACHMENTS_PREFIX: &str = "attachments/";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_DATABASE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES: u64 = 50 * 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ArchiveExtractionLimits {
    manifest_bytes: u64,
    database_bytes: u64,
    attachments_bytes: u64,
}

const ARCHIVE_EXTRACTION_LIMITS: ArchiveExtractionLimits = ArchiveExtractionLimits {
    manifest_bytes: MAX_MANIFEST_BYTES,
    database_bytes: MAX_DATABASE_BYTES,
    attachments_bytes: MAX_ATTACHMENTS_BYTES,
};

struct PreservedLicense {
    token: String,
    license_id: String,
    customer_name: Option<String>,
    plan: String,
    price_chf_cents: i64,
    issued_at: String,
    valid_from: String,
    valid_until: String,
    verified_at: String,
    last_seen_date: String,
    clock_anchor_version: i64,
}

struct RestoredDataSwap {
    database_path: PathBuf,
    attachments_dir: PathBuf,
    staged_database: PathBuf,
    staged_attachments: PathBuf,
    old_database: PathBuf,
    old_attachments: PathBuf,
    old_database_staged: bool,
    old_attachments_staged: bool,
    new_database_installed: bool,
    new_attachments_installed: bool,
}

impl RestoredDataSwap {
    fn rollback(self) -> AppResult<()> {
        let mut failures = Vec::new();

        if self.new_database_installed {
            if let Err(error) = remove_sqlite_sidecars(&self.database_path) {
                failures.push(format!("fichiers temporaires SQLite : {error}"));
            }
            if self.database_path.exists() {
                if let Err(error) = fs::remove_file(&self.database_path) {
                    failures.push(format!("base restaurée : {error}"));
                }
            }
        }
        if self.new_attachments_installed && self.attachments_dir.exists() {
            if let Err(error) = fs::remove_dir_all(&self.attachments_dir) {
                failures.push(format!("pièces jointes restaurées : {error}"));
            }
        }
        if self.old_database_staged && self.old_database.exists() {
            if let Err(error) = fs::rename(&self.old_database, &self.database_path) {
                failures.push(format!("ancienne base : {error}"));
            }
        }
        if self.old_attachments_staged && self.old_attachments.exists() {
            if let Err(error) = fs::rename(&self.old_attachments, &self.attachments_dir) {
                failures.push(format!("anciennes pièces jointes : {error}"));
            }
        }
        if self.staged_database.exists() {
            let _ = fs::remove_file(&self.staged_database);
        }
        if self.staged_attachments.exists() {
            let _ = fs::remove_dir_all(&self.staged_attachments);
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Validation(format!(
                "Le retour aux données précédentes est incomplet ({})",
                failures.join("; ")
            )))
        }
    }

    fn commit(self) {
        if self.old_database.exists() {
            let _ = fs::remove_file(self.old_database);
        }
        if self.old_attachments.exists() {
            let _ = fs::remove_dir_all(self.old_attachments);
        }
        if self.staged_database.exists() {
            let _ = fs::remove_file(self.staged_database);
        }
        if self.staged_attachments.exists() {
            let _ = fs::remove_dir_all(self.staged_attachments);
        }
    }
}

impl LocalStore {
    pub fn create_backup(
        &self,
        destination: Option<String>,
        app_version: &str,
    ) -> AppResult<String> {
        let destination =
            self.resolve_output_path(destination, &self.backups_dir, "sauvegarde", "elyko")?;
        self.create_backup_at(&destination, app_version)?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub fn export_json(&self, destination: Option<String>, app_version: &str) -> AppResult<String> {
        let destination =
            self.resolve_output_path(destination, &self.exports_dir, "export", "json")?;
        let workspace = self.get_workspace()?;
        let envelope = ExportEnvelope {
            format: "helvichantier-json-export".into(),
            format_version: 1,
            exported_at: now_iso(),
            app_version: app_version.into(),
            data: workspace,
        };
        let mut file = create_new_file(&destination)?;
        serde_json::to_writer_pretty(&mut file, &envelope)?;
        file.sync_all()?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub fn restore_backup(&self, source: &str, app_version: &str) -> AppResult<()> {
        self.restore_backup_with_limits(source, app_version, ARCHIVE_EXTRACTION_LIMITS)
    }

    fn restore_backup_with_limits(
        &self,
        source: &str,
        app_version: &str,
        limits: ArchiveExtractionLimits,
    ) -> AppResult<()> {
        let source = PathBuf::from(source);
        if !source.is_file() {
            return Err(AppError::Validation(
                "La sauvegarde sélectionnée est introuvable.".into(),
            ));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("elyko") && !extension.eq_ignore_ascii_case("hchantier")
        {
            return Err(AppError::Validation(
                "La restauration exige un fichier .elyko ou une ancienne sauvegarde .hchantier."
                    .into(),
            ));
        }

        let preserved_license = self.preserved_license()?;
        let extraction = tempfile::Builder::new()
            .prefix("restore-")
            .tempdir_in(&self.data_dir)?;
        let extracted_database = extraction.path().join(DATABASE_ENTRY);
        let extracted_attachments = extraction.path().join("attachments");
        fs::create_dir_all(&extracted_attachments)?;
        self.extract_and_validate_archive_with_limits(
            &source,
            &extracted_database,
            &extracted_attachments,
            limits,
        )?;
        validate_database(&extracted_database)?;

        let safety_path = if self.database_path.is_file() {
            let safety_path = unique_default_path(&self.backups_dir, "avant-restauration", "elyko");
            self.create_backup_at(&safety_path, app_version)?;
            Some(safety_path)
        } else {
            None
        };

        self.install_restored_data_and_then(
            &extracted_database,
            &extracted_attachments,
            safety_path.as_deref(),
            || {
                self.migrate()?;
                self.restore_local_license(preserved_license.as_ref())?;
                validate_database(&self.database_path)?;
                Ok(())
            },
        )
    }

    fn create_backup_at(&self, destination: &Path, app_version: &str) -> AppResult<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if destination.exists() {
            return Err(AppError::Validation(format!(
                "Le fichier existe déjà : {}",
                destination.display()
            )));
        }

        let snapshot_dir = tempfile::Builder::new()
            .prefix("backup-")
            .tempdir_in(&self.data_dir)?;
        let snapshot_database = snapshot_dir.path().join(DATABASE_ENTRY);
        self.snapshot_database(&snapshot_database)?;

        let manifest = BackupManifest {
            format: BACKUP_FORMAT.into(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: app_version.into(),
            created_at: now_iso(),
            database_file: DATABASE_ENTRY.into(),
            attachments_prefix: ATTACHMENTS_PREFIX.into(),
        };

        let temporary_archive = destination.with_extension(format!(
            "{}.tmp-{}",
            destination
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("elyko"),
            Uuid::new_v4()
        ));
        let archive_file = create_new_file(&temporary_archive)?;
        let mut archive = ZipWriter::new(archive_file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);

        archive.start_file("manifest.json", options)?;
        archive.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        add_file_to_archive(&mut archive, &snapshot_database, DATABASE_ENTRY, options)?;
        for entry in WalkDir::new(&self.attachments_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let relative = entry
                .path()
                .strip_prefix(&self.attachments_dir)
                .map_err(|_| AppError::UnsafePath(entry.path().to_path_buf()))?;
            ensure_safe_relative(relative)?;
            let archive_name = format!(
                "{ATTACHMENTS_PREFIX}{}",
                relative.to_string_lossy().replace('\\', "/")
            );
            add_file_to_archive(&mut archive, entry.path(), &archive_name, options)?;
        }
        let file = archive.finish()?;
        file.sync_all()?;
        if let Err(error) = fs::rename(&temporary_archive, destination) {
            let _ = fs::remove_file(&temporary_archive);
            return Err(error.into());
        }
        Ok(())
    }

    fn snapshot_database(&self, destination: &Path) -> AppResult<()> {
        let source = self.connect()?;
        source.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
        let mut target = Connection::open(destination)?;
        let backup = Backup::new(&source, &mut target)?;
        backup.run_to_completion(16, Duration::from_millis(20), None)?;
        drop(backup);
        target.execute("DELETE FROM license_state", [])?;
        target.execute_batch("PRAGMA journal_mode=DELETE;")?;
        Ok(())
    }

    fn preserved_license(&self) -> AppResult<Option<PreservedLicense>> {
        let connection = self.connect()?;
        connection
            .query_row(
                "SELECT token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| {
                    Ok(PreservedLicense {
                        token: row.get(0)?,
                        license_id: row.get(1)?,
                        customer_name: row.get(2)?,
                        plan: row.get(3)?,
                        price_chf_cents: row.get(4)?,
                        issued_at: row.get(5)?,
                        valid_from: row.get(6)?,
                        valid_until: row.get(7)?,
                        verified_at: row.get(8)?,
                        last_seen_date: row.get(9)?,
                        clock_anchor_version: row.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn restore_local_license(&self, preserved: Option<&PreservedLicense>) -> AppResult<()> {
        let connection = self.connect()?;
        connection.execute("DELETE FROM license_state", [])?;
        if let Some(license) = preserved {
            connection.execute(
                "INSERT INTO license_state(id,token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    license.token,
                    license.license_id,
                    license.customer_name,
                    license.plan,
                    license.price_chf_cents,
                    license.issued_at,
                    license.valid_from,
                    license.valid_until,
                    license.verified_at,
                    license.last_seen_date,
                    license.clock_anchor_version,
                ],
            )?;
        }
        Ok(())
    }

    fn extract_and_validate_archive_with_limits(
        &self,
        source: &Path,
        database_destination: &Path,
        attachments_destination: &Path,
        limits: ArchiveExtractionLimits,
    ) -> AppResult<()> {
        let file = File::open(source)?;
        let mut archive = ZipArchive::new(file)?;
        let manifest: BackupManifest = {
            let mut entry = archive.by_name("manifest.json").map_err(|_| {
                AppError::Validation("Le manifeste de sauvegarde est absent.".into())
            })?;
            let contents = read_utf8_limited(
                &mut entry,
                limits.manifest_bytes,
                "Le manifeste de sauvegarde",
            )?;
            serde_json::from_str(&contents)?
        };
        if manifest.format != BACKUP_FORMAT
            || manifest.format_version != BACKUP_FORMAT_VERSION
            || manifest.database_file != DATABASE_ENTRY
            || manifest.attachments_prefix != ATTACHMENTS_PREFIX
        {
            return Err(AppError::Validation(
                "Le format de cette sauvegarde n'est pas reconnu.".into(),
            ));
        }

        {
            let mut database_entry = archive.by_name(DATABASE_ENTRY).map_err(|_| {
                AppError::Validation("La base SQLite est absente de la sauvegarde.".into())
            })?;
            copy_reader_to_new_file_limited(
                &mut database_entry,
                database_destination,
                limits.database_bytes,
                "La base de données de la sauvegarde",
            )?;
        }

        let mut total_attachment_bytes: u64 = 0;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let name = entry.name().replace('\\', "/");
            if !name.starts_with(ATTACHMENTS_PREFIX) || entry.is_dir() {
                continue;
            }
            let relative_name = name.trim_start_matches(ATTACHMENTS_PREFIX);
            let relative = Path::new(relative_name);
            ensure_safe_relative(relative)?;
            let destination = attachments_destination.join(relative);
            let remaining = limits
                .attachments_bytes
                .checked_sub(total_attachment_bytes)
                .ok_or_else(|| {
                    AppError::Validation(
                        "Les pièces jointes de la sauvegarde dépassent la limite autorisée.".into(),
                    )
                })?;
            let extracted = copy_reader_to_new_file_limited(
                &mut entry,
                &destination,
                remaining,
                "Les pièces jointes de la sauvegarde",
            )?;
            total_attachment_bytes =
                total_attachment_bytes
                    .checked_add(extracted)
                    .ok_or_else(|| {
                        AppError::Validation(
                            "La taille extraite des pièces jointes est invalide.".into(),
                        )
                    })?;
        }
        Ok(())
    }

    fn install_restored_data_and_then<F>(
        &self,
        restored_database: &Path,
        restored_attachments: &Path,
        safety_path: Option<&Path>,
        finalize: F,
    ) -> AppResult<()>
    where
        F: FnOnce() -> AppResult<()>,
    {
        let swap = self.install_restored_data(restored_database, restored_attachments)?;
        match finalize() {
            Ok(()) => {
                swap.commit();
                Ok(())
            }
            Err(error) => match swap.rollback() {
                Ok(()) => Err(AppError::Validation(format!(
                    "La restauration a été annulée et les données précédentes ont été rétablies. Cause : {error}{}",
                    safety_path
                        .map(|path| format!(" Une sauvegarde de sécurité reste disponible dans {}.", path.display()))
                        .unwrap_or_default()
                ))),
                Err(rollback_error) => Err(AppError::Validation(format!(
                    "La restauration a échoué ({error}) et le retour automatique est incomplet ({rollback_error}).{}",
                    safety_path
                        .map(|path| format!(" Récupérez la sauvegarde de sécurité : {}.", path.display()))
                        .unwrap_or_default()
                ))),
            },
        }
    }

    fn install_restored_data(
        &self,
        restored_database: &Path,
        restored_attachments: &Path,
    ) -> AppResult<RestoredDataSwap> {
        let token = Uuid::new_v4();
        let staged_database = self.data_dir.join(format!(".restore-{token}.sqlite3"));
        let old_database = self
            .data_dir
            .join(format!(".before-restore-{token}.sqlite3"));
        let staged_attachments = self.data_dir.join(format!(".restore-attachments-{token}"));
        let old_attachments = self
            .data_dir
            .join(format!(".before-restore-attachments-{token}"));

        let mut swap = RestoredDataSwap {
            database_path: self.database_path.clone(),
            attachments_dir: self.attachments_dir.clone(),
            staged_database,
            staged_attachments,
            old_database,
            old_attachments,
            old_database_staged: false,
            old_attachments_staged: false,
            new_database_installed: false,
            new_attachments_installed: false,
        };
        let staging_result = (|| -> AppResult<()> {
            fs::copy(restored_database, &swap.staged_database)?;
            copy_directory(restored_attachments, &swap.staged_attachments)?;
            Ok(())
        })();
        if let Err(error) = staging_result {
            let _ = swap.rollback();
            return Err(error);
        }
        let install_result = (|| -> AppResult<()> {
            remove_sqlite_sidecars(&self.database_path)?;
            if self.database_path.exists() {
                fs::rename(&self.database_path, &swap.old_database)?;
                swap.old_database_staged = true;
            }
            if self.attachments_dir.exists() {
                fs::rename(&self.attachments_dir, &swap.old_attachments)?;
                swap.old_attachments_staged = true;
            }
            fs::rename(&swap.staged_database, &self.database_path)?;
            swap.new_database_installed = true;
            fs::rename(&swap.staged_attachments, &self.attachments_dir)?;
            swap.new_attachments_installed = true;
            Ok(())
        })();
        if let Err(error) = install_result {
            return match swap.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(AppError::Validation(format!(
                    "L’installation de la sauvegarde a échoué ({error}) et les données précédentes n’ont pas pu être entièrement rétablies ({rollback_error})."
                ))),
            };
        }
        Ok(swap)
    }

    fn resolve_output_path(
        &self,
        requested: Option<String>,
        default_directory: &Path,
        label: &str,
        extension: &str,
    ) -> AppResult<PathBuf> {
        let path = requested
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| unique_default_path(default_directory, label, extension));
        let path = if path.is_dir() {
            unique_default_path(&path, label, extension)
        } else if path.extension().is_none() {
            path.with_extension(extension)
        } else {
            path
        };
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        {
            return Err(AppError::Validation(format!(
                "L'extension attendue est .{extension}."
            )));
        }
        Ok(path)
    }
}

fn validate_database(path: &Path) -> AppResult<()> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(format!(
            "La base restaurée échoue au contrôle d'intégrité : {integrity}"
        )));
    }
    let user_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version > SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "La sauvegarde nécessite une version plus récente d’Elyko ({user_version})."
        )));
    }
    let settings_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings')",
        [],
        |row| row.get(0),
    )?;
    if !settings_table {
        return Err(AppError::Validation(
            "La sauvegarde ne contient pas le schéma Elyko attendu.".into(),
        ));
    }
    let foreign_key_errors: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_errors != 0 {
        return Err(AppError::Validation(
            "La sauvegarde contient des relations incohérentes.".into(),
        ));
    }
    Ok(())
}

fn create_new_file(path: &Path) -> AppResult<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(Into::into)
}

fn copy_reader_limited<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    max_bytes: u64,
    label: &str,
) -> AppResult<u64> {
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| AppError::Validation(format!("{label} a une limite invalide.")))?;
    let mut limited = reader.take(read_limit);
    let extracted_bytes = io::copy(&mut limited, writer)?;
    if extracted_bytes > max_bytes {
        return Err(AppError::Validation(format!(
            "{label} dépasse la limite autorisée de {max_bytes} octets."
        )));
    }
    Ok(extracted_bytes)
}

fn read_utf8_limited<R: Read>(reader: &mut R, max_bytes: u64, label: &str) -> AppResult<String> {
    let mut contents = Vec::new();
    copy_reader_limited(reader, &mut contents, max_bytes, label)?;
    String::from_utf8(contents)
        .map_err(|_| AppError::Validation(format!("{label} n'est pas un texte UTF-8 valide.")))
}

fn copy_reader_to_new_file_limited<R: Read>(
    reader: &mut R,
    destination: &Path,
    max_bytes: u64,
    label: &str,
) -> AppResult<u64> {
    let mut destination_file = create_new_file(destination)?;
    let result =
        copy_reader_limited(reader, &mut destination_file, max_bytes, label).and_then(|written| {
            destination_file.sync_all()?;
            Ok(written)
        });
    drop(destination_file);

    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

fn add_file_to_archive(
    archive: &mut ZipWriter<File>,
    source: &Path,
    name: &str,
    options: SimpleFileOptions,
) -> AppResult<()> {
    archive.start_file(name, options)?;
    let mut file = File::open(source)?;
    io::copy(&mut file, archive)?;
    Ok(())
}

fn ensure_safe_relative(path: &Path) -> AppResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::UnsafePath(path.to_path_buf()));
    }
    Ok(())
}

fn unique_default_path(directory: &Path, label: &str, extension: &str) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let preferred = directory.join(format!("Elyko-{label}-{timestamp}.{extension}"));
    if !preferred.exists() {
        return preferred;
    }
    directory.join(format!(
        "Elyko-{label}-{timestamp}-{}.{}",
        Uuid::new_v4(),
        extension
    ))
}

fn copy_directory(source: &Path, destination: &Path) -> AppResult<()> {
    fs::create_dir_all(destination)?;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| AppError::UnsafePath(entry.path().to_path_buf()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        ensure_safe_relative(relative)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn remove_sqlite_sidecars(database_path: &Path) -> AppResult<()> {
    for suffix in ["-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{}", database_path.display(), suffix));
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn seed_license(store: &LocalStore, license_id: &str) {
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO license_state(id,token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version) VALUES(1,?,?,?,?,?,?,?,?,?,?,1)",
                params![
                    format!("token-{license_id}"),
                    license_id,
                    "Entreprise test",
                    "helvichantier-monthly-50-chf",
                    5_000,
                    "2026-08-30T00:00:00Z",
                    "2026-08-30",
                    "2026-09-30",
                    "2026-08-30T00:00:00Z",
                    "2026-08-30",
                ],
            )
            .unwrap();
    }

    fn stored_license_id(store: &LocalStore) -> Option<String> {
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT license_id FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    fn stored_clock_anchor_version(store: &LocalStore) -> Option<i64> {
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    #[test]
    fn database_snapshot_excludes_the_license() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        seed_license(&store, "lic-local-only");
        let snapshot = temporary.path().join("snapshot.sqlite3");

        store.snapshot_database(&snapshot).unwrap();

        let snapshot_connection = Connection::open(snapshot).unwrap();
        let snapshot_count: i64 = snapshot_connection
            .query_row("SELECT COUNT(*) FROM license_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(snapshot_count, 0);
        assert_eq!(stored_license_id(&store).as_deref(), Some("lic-local-only"));
    }

    #[test]
    fn restore_keeps_the_destination_machine_license() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        seed_license(&source, "lic-source-must-not-travel");
        let archive = temporary.path().join("source.hchantier");
        source.create_backup_at(&archive, "1.0.0").unwrap();

        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        seed_license(&destination, "lic-destination");
        destination
            .restore_backup(archive.to_str().unwrap(), "1.0.0")
            .unwrap();

        assert_eq!(
            stored_license_id(&destination).as_deref(),
            Some("lic-destination")
        );
        assert_eq!(stored_clock_anchor_version(&destination), Some(1));
        assert!(fs::read_dir(&destination.backups_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("avant-restauration")));
    }

    #[test]
    fn post_install_failure_rolls_back_database_and_attachments() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        seed_license(&destination, "lic-original");
        fs::write(
            destination.attachments_dir.join("original.txt"),
            b"original",
        )
        .unwrap();

        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        fs::write(source.attachments_dir.join("restored.txt"), b"restored").unwrap();
        let restored_database = temporary.path().join("restored.sqlite3");
        source.snapshot_database(&restored_database).unwrap();

        let error = destination
            .install_restored_data_and_then(
                &restored_database,
                &source.attachments_dir,
                None,
                || {
                    Err(AppError::Validation(
                        "échec final simulé après installation".into(),
                    ))
                },
            )
            .expect_err("the simulated finalization must fail");

        assert!(error
            .to_string()
            .contains("données précédentes ont été rétablies"));
        assert_eq!(
            stored_license_id(&destination).as_deref(),
            Some("lic-original")
        );
        assert!(destination.attachments_dir.join("original.txt").is_file());
        assert!(!destination.attachments_dir.join("restored.txt").exists());
    }

    #[test]
    fn limited_file_copy_counts_streamed_bytes_and_removes_partial_output() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("oversized.bin");
        let mut source = Cursor::new(vec![0x41; 65]);

        let error =
            copy_reader_to_new_file_limited(&mut source, &destination, 32, "Le fichier de test")
                .expect_err("the streamed content is larger than the runtime limit");

        assert!(error.to_string().contains("dépasse la limite"));
        assert!(!destination.exists());
    }

    #[test]
    fn forged_zip_size_metadata_cannot_bypass_the_stream_limit() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("forged-size.zip");
        let archive_file = File::create(&archive_path).unwrap();
        let mut writer = ZipWriter::new(archive_file);
        writer
            .start_file(
                "oversized.bin",
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(&[0x41; 65]).unwrap();
        writer.finish().unwrap();

        let mut archive_bytes = fs::read(&archive_path).unwrap();
        let local_header = archive_bytes
            .windows(4)
            .position(|window| window == b"PK\x03\x04")
            .unwrap();
        let central_header = archive_bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .unwrap();
        archive_bytes[local_header + 22..local_header + 26].copy_from_slice(&1_u32.to_le_bytes());
        archive_bytes[central_header + 24..central_header + 28]
            .copy_from_slice(&1_u32.to_le_bytes());
        fs::write(&archive_path, archive_bytes).unwrap();

        let mut archive = ZipArchive::new(File::open(&archive_path).unwrap()).unwrap();
        let mut entry = archive.by_name("oversized.bin").unwrap();
        assert_eq!(entry.size(), 1, "the forged metadata must look harmless");
        let destination = temporary.path().join("extracted.bin");

        let error = copy_reader_to_new_file_limited(
            &mut entry,
            &destination,
            32,
            "Le fichier ZIP falsifié",
        )
        .expect_err("actual decompressed bytes must enforce the limit");

        assert!(error.to_string().contains("dépasse la limite"));
        assert!(!destination.exists());
    }

    #[test]
    fn oversized_attachment_aborts_restore_without_touching_active_data() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        fs::write(source.attachments_dir.join("oversized.bin"), vec![0x41; 65]).unwrap();
        let archive = temporary.path().join("oversized.elyko");
        source.create_backup_at(&archive, "1.0.0").unwrap();

        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        seed_license(&destination, "lic-must-survive");
        fs::write(
            destination.attachments_dir.join("original.txt"),
            b"original",
        )
        .unwrap();

        let error = destination
            .restore_backup_with_limits(
                archive.to_str().unwrap(),
                "1.0.0",
                ArchiveExtractionLimits {
                    manifest_bytes: MAX_MANIFEST_BYTES,
                    database_bytes: MAX_DATABASE_BYTES,
                    attachments_bytes: 32,
                },
            )
            .expect_err("the actual attachment bytes exceed the test limit");

        assert!(error.to_string().contains("dépasse la limite"));
        assert_eq!(
            stored_license_id(&destination).as_deref(),
            Some("lic-must-survive")
        );
        assert_eq!(
            fs::read(destination.attachments_dir.join("original.txt")).unwrap(),
            b"original"
        );
        assert!(!destination.attachments_dir.join("oversized.bin").exists());
        assert!(!fs::read_dir(&destination.backups_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("avant-restauration")));
        assert!(!fs::read_dir(&destination.data_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("restore-")));
    }
}

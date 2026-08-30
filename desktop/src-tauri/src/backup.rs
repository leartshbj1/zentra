use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use rusqlite::{backup::Backup, Connection};
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

impl LocalStore {
    pub fn create_backup(
        &self,
        destination: Option<String>,
        app_version: &str,
    ) -> AppResult<String> {
        let destination =
            self.resolve_output_path(destination, &self.backups_dir, "sauvegarde", "hchantier")?;
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
        if !extension.eq_ignore_ascii_case("hchantier") {
            return Err(AppError::Validation(
                "La restauration exige un fichier .hchantier.".into(),
            ));
        }

        let extraction = tempfile::Builder::new()
            .prefix("restore-")
            .tempdir_in(&self.data_dir)?;
        let extracted_database = extraction.path().join(DATABASE_ENTRY);
        let extracted_attachments = extraction.path().join("attachments");
        fs::create_dir_all(&extracted_attachments)?;
        self.extract_and_validate_archive(&source, &extracted_database, &extracted_attachments)?;
        validate_database(&extracted_database)?;

        if self.database_path.is_file() {
            let safety_path =
                unique_default_path(&self.backups_dir, "avant-restauration", "hchantier");
            self.create_backup_at(&safety_path, app_version)?;
        }

        self.install_restored_data(&extracted_database, &extracted_attachments)?;
        self.migrate()?;
        validate_database(&self.database_path)?;
        Ok(())
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
                .unwrap_or("hchantier"),
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
        target.execute_batch("PRAGMA journal_mode=DELETE;")?;
        Ok(())
    }

    fn extract_and_validate_archive(
        &self,
        source: &Path,
        database_destination: &Path,
        attachments_destination: &Path,
    ) -> AppResult<()> {
        let file = File::open(source)?;
        let mut archive = ZipArchive::new(file)?;
        let manifest: BackupManifest = {
            let mut entry = archive.by_name("manifest.json").map_err(|_| {
                AppError::Validation("Le manifeste de sauvegarde est absent.".into())
            })?;
            if entry.size() > 64 * 1024 {
                return Err(AppError::Validation(
                    "Le manifeste de sauvegarde est anormalement volumineux.".into(),
                ));
            }
            let mut contents = String::new();
            entry.read_to_string(&mut contents)?;
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
            if database_entry.size() > 10 * 1024 * 1024 * 1024 {
                return Err(AppError::Validation(
                    "La base de données de la sauvegarde est trop volumineuse.".into(),
                ));
            }
            let mut output = create_new_file(database_destination)?;
            io::copy(&mut database_entry, &mut output)?;
            output.sync_all()?;
        }

        let mut total_attachment_bytes: u64 = 0;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let name = entry.name().replace('\\', "/");
            if !name.starts_with(ATTACHMENTS_PREFIX) || entry.is_dir() {
                continue;
            }
            total_attachment_bytes = total_attachment_bytes.saturating_add(entry.size());
            if total_attachment_bytes > 50 * 1024 * 1024 * 1024 {
                return Err(AppError::Validation(
                    "Les pièces jointes de la sauvegarde dépassent la limite autorisée.".into(),
                ));
            }
            let relative_name = name.trim_start_matches(ATTACHMENTS_PREFIX);
            let relative = Path::new(relative_name);
            ensure_safe_relative(relative)?;
            let destination = attachments_destination.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = create_new_file(&destination)?;
            io::copy(&mut entry, &mut output)?;
            output.sync_all()?;
        }
        Ok(())
    }

    fn install_restored_data(
        &self,
        restored_database: &Path,
        restored_attachments: &Path,
    ) -> AppResult<()> {
        let token = Uuid::new_v4();
        let staged_database = self.data_dir.join(format!(".restore-{token}.sqlite3"));
        let old_database = self
            .data_dir
            .join(format!(".before-restore-{token}.sqlite3"));
        let staged_attachments = self.data_dir.join(format!(".restore-attachments-{token}"));
        let old_attachments = self
            .data_dir
            .join(format!(".before-restore-attachments-{token}"));

        fs::copy(restored_database, &staged_database)?;
        copy_directory(restored_attachments, &staged_attachments)?;
        remove_sqlite_sidecars(&self.database_path)?;

        let had_database = self.database_path.exists();
        if had_database {
            fs::rename(&self.database_path, &old_database)?;
        }
        let had_attachments = self.attachments_dir.exists();
        if had_attachments {
            fs::rename(&self.attachments_dir, &old_attachments)?;
        }

        let install_result = (|| -> AppResult<()> {
            fs::rename(&staged_database, &self.database_path)?;
            fs::rename(&staged_attachments, &self.attachments_dir)?;
            Ok(())
        })();
        if let Err(error) = install_result {
            let _ = fs::remove_file(&self.database_path);
            let _ = fs::remove_dir_all(&self.attachments_dir);
            if had_database && old_database.exists() {
                let _ = fs::rename(&old_database, &self.database_path);
            }
            if had_attachments && old_attachments.exists() {
                let _ = fs::rename(&old_attachments, &self.attachments_dir);
            }
            return Err(error);
        }

        if old_database.exists() {
            fs::remove_file(old_database)?;
        }
        if old_attachments.exists() {
            fs::remove_dir_all(old_attachments)?;
        }
        Ok(())
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
            "La sauvegarde nécessite une version plus récente de HelviChantier ({user_version})."
        )));
    }
    let settings_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings')",
        [],
        |row| row.get(0),
    )?;
    if !settings_table {
        return Err(AppError::Validation(
            "La sauvegarde ne contient pas le schéma HelviChantier.".into(),
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
    let preferred = directory.join(format!("HelviChantier-{label}-{timestamp}.{extension}"));
    if !preferred.exists() {
        return preferred;
    }
    directory.join(format!(
        "HelviChantier-{label}-{timestamp}-{}.{}",
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

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
};
use uuid::Uuid;

const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Deserialize)]
pub struct AddProjectDocumentInput {
    pub project_id: String,
    pub original_name: String,
    pub content_base64: String,
}

fn document_format(name: &str, bytes: &[u8]) -> AppResult<(&'static str, &'static str)> {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let invalid = || {
        AppError::Validation("Format illisible ou non pris en charge. Choisissez un PDF, une photo, un document Office, OpenDocument, TXT ou CSV.".into())
    };
    let format = match extension.as_str() {
        "pdf" | "png" | "jpg" | "jpeg" | "webp" => {
            let mime = crate::attachments::supported_attachment_mime(bytes).ok_or_else(invalid)?;
            let expected = match extension.as_str() {
                "pdf" => ("application/pdf", "pdf"),
                "png" => ("image/png", "png"),
                "webp" => ("image/webp", "webp"),
                _ => ("image/jpeg", "jpg"),
            };
            if mime != expected.0 {
                return Err(invalid());
            }
            expected
        }
        "heic" | "heif" => {
            if bytes.len() < 16
                || &bytes[4..8] != b"ftyp"
                || !matches!(
                    &bytes[8..12],
                    b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
                )
            {
                return Err(invalid());
            }
            ("image/heic", "heic")
        }
        "txt" | "csv" => {
            let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
            if text.contains('\0') {
                return Err(invalid());
            }
            if extension == "csv" {
                ("text/csv", "csv")
            } else {
                ("text/plain", "txt")
            }
        }
        "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" => {
            let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
            if archive.len() > 10_000 {
                return Err(invalid());
            }
            let (required, mime, extension) = match extension.as_str() {
                "docx" => (
                    "word/document.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "docx",
                ),
                "xlsx" => (
                    "xl/workbook.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "xlsx",
                ),
                "pptx" => (
                    "ppt/presentation.xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    "pptx",
                ),
                "odt" => (
                    "content.xml",
                    "application/vnd.oasis.opendocument.text",
                    "odt",
                ),
                "ods" => (
                    "content.xml",
                    "application/vnd.oasis.opendocument.spreadsheet",
                    "ods",
                ),
                _ => (
                    "content.xml",
                    "application/vnd.oasis.opendocument.presentation",
                    "odp",
                ),
            };
            if !archive.file_names().any(|path| path == required)
                || archive
                    .file_names()
                    .any(|path| path.to_ascii_lowercase().ends_with("vbaproject.bin"))
            {
                return Err(invalid());
            }
            (mime, extension)
        }
        _ => return Err(invalid()),
    };
    Ok(format)
}

impl LocalStore {
    pub fn add_project_document(&self, input: AddProjectDocumentInput) -> AppResult<Value> {
        Uuid::parse_str(&input.project_id)
            .map_err(|_| AppError::Validation("Projet invalide.".into()))?;
        let name = input.original_name.trim();
        if name.is_empty()
            || name.chars().count() > 255
            || name.contains(['/', '\\'])
            || name.chars().any(char::is_control)
        {
            return Err(AppError::Validation("Nom de fichier invalide.".into()));
        }
        if input.content_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err(AppError::Validation("Le fichier dépasse 25 Mo.".into()));
        }
        let bytes = STANDARD
            .decode(&input.content_base64)
            .map_err(|_| AppError::Validation("Fichier illisible.".into()))?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(AppError::Validation(
                "Le fichier doit contenir entre 1 octet et 25 Mo.".into(),
            ));
        }
        let (mime, extension) = document_format(name, &bytes)?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            params![input.project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound("Projet introuvable.".into()));
        }
        if let Some(existing) = query_all(
            &tx,
            "SELECT * FROM attachments WHERE project_id=? AND entity_type='project' AND sha256=?",
            params![input.project_id, sha256],
        )?
        .into_iter()
        .next()
        {
            return Ok(existing);
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM attachments WHERE project_id=? AND entity_type='project'",
            params![input.project_id],
            |row| row.get(0),
        )?;
        if count >= 1000 {
            return Err(AppError::Validation(
                "Ce projet contient déjà 1 000 fichiers.".into(),
            ));
        }
        let id = Uuid::new_v4().to_string();
        let stored_name = format!("{id}.{extension}");
        let destination = self.safe_attachment_path(&stored_name)?;
        let mut staged = tempfile::NamedTempFile::new_in(&self.attachments_dir)?;
        staged.write_all(&bytes)?;
        staged.as_file().sync_all()?;
        let now = now_iso();
        tx.execute("INSERT INTO attachments(id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,'project',?,?,?,?,?,?,?,?)", params![id, input.project_id, input.project_id, name, stored_name, mime, bytes.len() as i64, sha256, now, now])?;
        let record = query_all(&tx, "SELECT * FROM attachments WHERE id=?", params![id])?.remove(0);
        append_audit(&tx, "attachment_add", "project", &input.project_id, &record)?;
        staged
            .persist_noclobber(&destination)
            .map_err(|error| AppError::Io(error.error))?;
        if let Err(error) = tx.commit() {
            let _ = fs::remove_file(destination);
            return Err(error.into());
        }
        Ok(record)
    }

    pub fn delete_project_document(&self, id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String)> = tx.query_row("SELECT project_id,stored_name FROM attachments WHERE id=? AND entity_type='project' AND entity_id=project_id", params![id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let (project_id, stored_name) =
            row.ok_or_else(|| AppError::NotFound("Document de projet introuvable.".into()))?;
        let path = self.safe_attachment_path(&stored_name)?;
        tx.execute(
            "DELETE FROM attachments WHERE id=? AND entity_type='project'",
            params![id],
        )?;
        append_audit(
            &tx,
            "attachment_delete",
            "project",
            &project_id,
            &json!({"attachment_id":id}),
        )?;
        tx.commit()?;
        // Une copie orpheline après une erreur disque est préférable à une référence cassée.
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        Ok(json!({"deleted":true}))
    }

    pub fn read_project_document(&self, id: &str) -> AppResult<String> {
        let path = self.verified_attachment_path(id)?;
        Ok(STANDARD.encode(fs::read(path)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, LocalStore, String) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let now = now_iso();
        store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Recette projets',?,?)", params![now, now]).unwrap();
        let project = store
            .create_record("projects", json!({"name":"Projet de recette"}))
            .unwrap();
        (temporary, store, project["id"].as_str().unwrap().to_owned())
    }

    fn input(project: &str, name: &str, bytes: &[u8]) -> AddProjectDocumentInput {
        AddProjectDocumentInput {
            project_id: project.into(),
            original_name: name.into(),
            content_base64: STANDARD.encode(bytes),
        }
    }

    #[test]
    fn stores_deduplicates_and_restores_project_documents_with_exact_bytes() {
        let (_temporary, store, project) = fixture();
        let bytes = crate::attachments::test_pdf_bytes();
        let first = store
            .add_project_document(input(&project, "Plan.pdf", &bytes))
            .unwrap();
        let duplicate = store
            .add_project_document(input(&project, "Plan renommé.pdf", &bytes))
            .unwrap();
        assert_eq!(first["id"], duplicate["id"]);
        assert_eq!(
            store.get_workspace().unwrap()["attachments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let id = first["id"].as_str().unwrap();
        assert_eq!(
            store.read_project_document(id).unwrap(),
            STANDARD.encode(&bytes)
        );
        assert!(store.delete_record("projects", &project).is_err());
        let backup = store.create_backup(None, "1.25.0").unwrap();
        store.delete_project_document(id).unwrap();
        assert!(store.read_project_document(id).is_err());
        store.restore_backup(&backup, "1.25.0").unwrap();
        assert_eq!(
            store.read_project_document(id).unwrap(),
            STANDARD.encode(&bytes)
        );
    }

    #[test]
    fn rejects_missing_projects_unsafe_names_and_tampered_files() {
        let (_temporary, store, project) = fixture();
        assert!(store
            .add_project_document(input(
                &uuid::Uuid::new_v4().to_string(),
                "notes.txt",
                b"notes"
            ))
            .is_err());
        assert!(store
            .add_project_document(input(&project, "../notes.txt", b"notes"))
            .is_err());
        let file = store
            .add_project_document(input(&project, "notes.txt", b"notes"))
            .unwrap();
        let path = store
            .safe_attachment_path(file["stored_name"].as_str().unwrap())
            .unwrap();
        std::fs::write(path, b"other").unwrap();
        assert!(store
            .read_project_document(file["id"].as_str().unwrap())
            .is_err());
    }
    #[test]
    fn accepts_documents_and_rejects_disguised_files() {
        assert!(document_format("plan.pdf", &crate::attachments::test_pdf_bytes()).is_ok());
        assert_eq!(
            document_format("notes.txt", b"Notes du projet").unwrap().0,
            "text/plain"
        );
        assert!(document_format("photo.jpg", b"MZ executable").is_err());
        assert!(document_format("plan.pdf.exe", &crate::attachments::test_pdf_bytes()).is_err());
        assert!(document_format("tableau.xlsx", b"not a spreadsheet").is_err());
    }
}

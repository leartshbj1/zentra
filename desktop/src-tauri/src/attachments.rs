use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
};

const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_SUPPLIER_INVOICE: i64 = 20;

#[derive(Debug, Deserialize)]
pub struct AddSupplierInvoiceAttachmentInput {
    pub supplier_invoice_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SupportedAttachment {
    mime_type: &'static str,
    extension: &'static str,
}

impl LocalStore {
    pub fn add_supplier_invoice_attachment(
        &self,
        input: AddSupplierInvoiceAttachmentInput,
    ) -> AppResult<Value> {
        let invoice_id = required_uuid(&input.supplier_invoice_id, "facture fournisseur")?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;

        let source_path = PathBuf::from(input.source_path.trim());
        let source_metadata = fs::metadata(&source_path).map_err(|_| {
            AppError::Validation("Le justificatif sélectionné est introuvable.".into())
        })?;
        if !source_metadata.is_file() {
            return Err(AppError::Validation(
                "Le justificatif sélectionné doit être un fichier régulier.".into(),
            ));
        }
        validate_size(source_metadata.len())?;
        let original_name = validated_original_name(&source_path)?;
        let detected = detect_supported_attachment(&source_path)?;

        let id = Uuid::new_v4().to_string();
        let stored_name = format!("{id}.{}", detected.extension);
        let destination = self.safe_attachment_path(&stored_name)?;
        let temporary_name = format!(".{id}.attachment-part");
        let temporary_path = self.safe_attachment_path(&temporary_name)?;
        let copy_result = copy_limited_and_hash(&source_path, &temporary_path);
        let (size_bytes, sha256) = match copy_result {
            Ok(result) => result,
            Err(error) => {
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
        };
        let copied_kind = match detect_supported_attachment(&temporary_path) {
            Ok(kind) => kind,
            Err(error) => {
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
        };
        if copied_kind != detected {
            let _ = fs::remove_file(&temporary_path);
            return Err(AppError::Validation(
                "Le justificatif a changé pendant sa copie; recommencez la sélection.".into(),
            ));
        }
        fs::rename(&temporary_path, &destination)?;

        let database_result = (|| -> AppResult<Value> {
            let mut connection = connection;
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (project_id, status): (Option<String>, String) = tx
                .query_row(
                    "SELECT project_id,status FROM supplier_invoices WHERE id=?",
                    params![invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{invoice_id}")))?;
            if status != "draft" {
                return Err(AppError::Validation(
                    "Les justificatifs d’une facture fournisseur validée sont figés.".into(),
                ));
            }
            let existing = query_all(
                &tx,
                "SELECT * FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=? AND sha256=? LIMIT 1",
                params![invoice_id, sha256],
            )?
            .into_iter()
            .next();
            if let Some(existing) = existing {
                tx.commit()?;
                return Ok(existing);
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=?",
                params![invoice_id],
                |row| row.get(0),
            )?;
            if count >= MAX_ATTACHMENTS_PER_SUPPLIER_INVOICE {
                return Err(AppError::Validation(format!(
                    "Cette facture contient déjà la limite de {MAX_ATTACHMENTS_PER_SUPPLIER_INVOICE} justificatifs."
                )));
            }
            let now = now_iso();
            tx.execute(
                "INSERT INTO attachments(id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,'supplier_invoice',?,?,?,?,?,?,?,?)",
                params![id,project_id,invoice_id,original_name,stored_name,detected.mime_type,i64::try_from(size_bytes).unwrap_or(i64::MAX),sha256,now,now],
            )?;
            let record = query_all(&tx, "SELECT * FROM attachments WHERE id=?", params![id])?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::NotFound(format!("attachments/{id}")))?;
            append_audit(
                &tx,
                "attachment_add",
                "supplier_invoice",
                &invoice_id,
                &json!({
                    "attachment_id": id,
                    "original_name": original_name,
                    "mime_type": detected.mime_type,
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                }),
            )?;
            tx.commit()?;
            Ok(record)
        })();

        if database_result.is_err() {
            let _ = fs::remove_file(&destination);
        } else if database_result
            .as_ref()
            .ok()
            .and_then(|record| record.get("id"))
            .and_then(Value::as_str)
            != Some(id.as_str())
        {
            // Un contenu identique existait déjà : ne gardez pas une seconde copie.
            let _ = fs::remove_file(&destination);
        }
        database_result
    }

    /// Enregistre une pièce déjà décodée en mémoire, par exemple depuis un
    /// message MIME choisi explicitement par l'utilisateur. Le contenu passe
    /// par les mêmes contrôles de taille, de signature binaire, de doublon et
    /// d'immuabilité que l'import depuis un fichier local.
    pub(crate) fn add_supplier_invoice_attachment_bytes(
        &self,
        supplier_invoice_id: &str,
        original_name: &str,
        bytes: &[u8],
    ) -> AppResult<Value> {
        let invoice_id = required_uuid(supplier_invoice_id, "facture fournisseur")?;
        validate_size(u64::try_from(bytes.len()).unwrap_or(u64::MAX))?;
        let original_name = validated_original_name_value(original_name)?;
        let detected = detect_supported_attachment_bytes(bytes)?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;

        let id = Uuid::new_v4().to_string();
        let stored_name = format!("{id}.{}", detected.extension);
        let destination = self.safe_attachment_path(&stored_name)?;
        let temporary_name = format!(".{id}.attachment-part");
        let temporary_path = self.safe_attachment_path(&temporary_name)?;
        let write_result = (|| -> AppResult<()> {
            let mut file = File::create(&temporary_path)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            if detect_supported_attachment(&temporary_path)? != detected {
                return Err(AppError::Validation(
                    "Le justificatif décodé ne correspond plus à son format détecté.".into(),
                ));
            }
            fs::rename(&temporary_path, &destination)?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }

        let size_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let database_result = (|| -> AppResult<Value> {
            let mut connection = connection;
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (project_id, status): (Option<String>, String) = tx
                .query_row(
                    "SELECT project_id,status FROM supplier_invoices WHERE id=?",
                    params![invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{invoice_id}")))?;
            if status != "draft" {
                return Err(AppError::Validation(
                    "Les justificatifs d’une facture fournisseur validée sont figés.".into(),
                ));
            }
            let existing = query_all(
                &tx,
                "SELECT * FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=? AND sha256=? LIMIT 1",
                params![invoice_id, sha256],
            )?
            .into_iter()
            .next();
            if let Some(existing) = existing {
                tx.commit()?;
                return Ok(existing);
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=?",
                params![invoice_id],
                |row| row.get(0),
            )?;
            if count >= MAX_ATTACHMENTS_PER_SUPPLIER_INVOICE {
                return Err(AppError::Validation(format!(
                    "Cette facture contient déjà la limite de {MAX_ATTACHMENTS_PER_SUPPLIER_INVOICE} justificatifs."
                )));
            }
            let now = now_iso();
            tx.execute(
                "INSERT INTO attachments(id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,'supplier_invoice',?,?,?,?,?,?,?,?)",
                params![id,project_id,invoice_id,original_name,stored_name,detected.mime_type,i64::try_from(size_bytes).unwrap_or(i64::MAX),sha256,now,now],
            )?;
            let record = query_all(&tx, "SELECT * FROM attachments WHERE id=?", params![id])?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::NotFound(format!("attachments/{id}")))?;
            append_audit(
                &tx,
                "attachment_add",
                "supplier_invoice",
                &invoice_id,
                &json!({
                    "attachment_id": id,
                    "original_name": original_name,
                    "mime_type": detected.mime_type,
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                    "source": "supplier_email_mime",
                }),
            )?;
            tx.commit()?;
            Ok(record)
        })();

        let destination_is_registered = database_result
            .as_ref()
            .ok()
            .and_then(|record| record.get("id"))
            .and_then(Value::as_str)
            == Some(id.as_str());
        if !destination_is_registered {
            let _ = fs::remove_file(&destination);
        }
        database_result
    }

    pub fn delete_supplier_invoice_attachment(&self, id: &str) -> AppResult<Value> {
        let id = required_uuid(id, "justificatif")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = query_all(
            &tx,
            "SELECT * FROM attachments WHERE id=? AND entity_type='supplier_invoice'",
            params![id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(format!("attachments/{id}")))?;
        let invoice_id = record["entity_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Le lien du justificatif est invalide.".into()))?;
        let status: String = tx
            .query_row(
                "SELECT status FROM supplier_invoices WHERE id=?",
                params![invoice_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{invoice_id}")))?;
        if status != "draft" {
            return Err(AppError::Validation(
                "Un justificatif validé est immuable et ne peut plus être supprimé.".into(),
            ));
        }
        tx.execute("DELETE FROM attachments WHERE id=?", params![id])?;
        append_audit(
            &tx,
            "attachment_delete",
            "supplier_invoice",
            invoice_id,
            &json!({
                "attachment_id": id,
                "original_name": record["original_name"],
                "mime_type": record["mime_type"],
                "size_bytes": record["size_bytes"],
                "sha256": record["sha256"],
            }),
        )?;
        let stored_name = record["stored_name"]
            .as_str()
            .ok_or_else(|| {
                AppError::Validation("Le stockage du justificatif est invalide.".into())
            })?
            .to_owned();
        tx.commit()?;
        let path = self.safe_attachment_path(&stored_name)?;
        if path.is_file() {
            fs::remove_file(&path)?;
        }
        Ok(json!({"deleted":true,"id":id}))
    }

    pub(crate) fn verified_attachment_path(&self, id: &str) -> AppResult<PathBuf> {
        let id = required_uuid(id, "justificatif")?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (stored_name, expected_size, expected_sha256): (String, i64, String) = connection
            .query_row(
                "SELECT stored_name,size_bytes,sha256 FROM attachments WHERE id=?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("attachments/{id}")))?;
        let path = self.safe_attachment_path(&stored_name)?;
        let metadata = fs::metadata(&path).map_err(|_| {
            AppError::Validation(
                "Le justificatif local est absent. Restaurez une sauvegarde Zentra valide.".into(),
            )
        })?;
        validate_size(metadata.len())?;
        if i64::try_from(metadata.len()).unwrap_or(i64::MAX) != expected_size {
            return Err(AppError::Validation(
                "Le justificatif local a été modifié depuis son archivage (taille différente)."
                    .into(),
            ));
        }
        detect_supported_attachment(&path)?;
        let actual_sha256 = sha256_file(&path)?;
        if actual_sha256 != expected_sha256 {
            return Err(AppError::Validation(
                "Le justificatif local a été modifié depuis son archivage (empreinte différente)."
                    .into(),
            ));
        }
        Ok(path)
    }

    pub(crate) fn remove_stored_attachment_files(&self, stored_names: &[String]) -> AppResult<()> {
        for stored_name in stored_names {
            let path = self.safe_attachment_path(stored_name)?;
            if path.is_file() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }
}

/// Supprime les métadonnées d’un brouillon dans la transaction du document et
/// renvoie les noms internes à nettoyer uniquement après le commit.
pub(crate) fn delete_draft_attachments_in_transaction(
    tx: &Transaction<'_>,
    supplier_invoice_id: &str,
) -> AppResult<Vec<String>> {
    let attachments = query_all(
        tx,
        "SELECT * FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=? ORDER BY created_at,id",
        params![supplier_invoice_id],
    )?;
    let mut stored_names = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let attachment_id = attachment["id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Identifiant de justificatif invalide.".into()))?;
        let stored_name = attachment["stored_name"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Stockage de justificatif invalide.".into()))?;
        append_audit(
            tx,
            "attachment_delete",
            "supplier_invoice",
            supplier_invoice_id,
            &json!({
                "attachment_id": attachment_id,
                "original_name": attachment["original_name"],
                "mime_type": attachment["mime_type"],
                "size_bytes": attachment["size_bytes"],
                "sha256": attachment["sha256"],
                "reason": "supplier_invoice_draft_deleted",
            }),
        )?;
        stored_names.push(stored_name.to_owned());
    }
    tx.execute(
        "DELETE FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=?",
        params![supplier_invoice_id],
    )?;
    Ok(stored_names)
}

pub(crate) fn supplier_invoice_attachment_snapshot(
    tx: &Transaction<'_>,
    supplier_invoice_id: &str,
) -> AppResult<Value> {
    Ok(Value::Array(query_all(
        tx,
        "SELECT id,original_name,mime_type,size_bytes,sha256,created_at FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=? ORDER BY created_at,id",
        params![supplier_invoice_id],
    )?))
}

fn required_uuid(value: &str, label: &str) -> AppResult<String> {
    let value = value.trim();
    Uuid::parse_str(value)
        .map_err(|_| AppError::Validation(format!("L’identifiant du {label} est invalide.")))?;
    Ok(value.to_owned())
}

fn validated_original_name(path: &Path) -> AppResult<String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Validation("Le nom du justificatif est invalide.".into()))?;
    validated_original_name_value(name)
}

fn validated_original_name_value(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 255
        || name.chars().any(char::is_control)
        || name.contains(['/', '\\'])
        || matches!(name, "." | "..")
    {
        return Err(AppError::Validation(
            "Le nom du justificatif doit contenir au plus 255 caractères valides.".into(),
        ));
    }
    Ok(name.to_owned())
}

fn validate_size(size: u64) -> AppResult<()> {
    if size == 0 {
        return Err(AppError::Validation(
            "Le justificatif sélectionné est vide.".into(),
        ));
    }
    if size > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation(
            "Le justificatif dépasse la limite de 25 Mio.".into(),
        ));
    }
    Ok(())
}

fn detect_supported_attachment(path: &Path) -> AppResult<SupportedAttachment> {
    let mut file = File::open(path)?;
    let mut signature = [0_u8; 16];
    let count = file.read(&mut signature)?;
    let bytes = &signature[..count];
    detect_supported_attachment_bytes(bytes)
}

fn detect_supported_attachment_bytes(bytes: &[u8]) -> AppResult<SupportedAttachment> {
    let kind = if bytes.starts_with(b"%PDF-") {
        Some(SupportedAttachment {
            mime_type: "application/pdf",
            extension: "pdf",
        })
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some(SupportedAttachment {
            mime_type: "image/png",
            extension: "png",
        })
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(SupportedAttachment {
            mime_type: "image/jpeg",
            extension: "jpg",
        })
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(SupportedAttachment {
            mime_type: "image/webp",
            extension: "webp",
        })
    } else {
        None
    };
    kind.ok_or_else(|| {
        AppError::Validation(
            "Format refusé. Choisissez un vrai fichier PDF, PNG, JPEG ou WebP.".into(),
        )
    })
}

pub(crate) fn supported_attachment_mime(bytes: &[u8]) -> Option<&'static str> {
    detect_supported_attachment_bytes(bytes)
        .ok()
        .map(|kind| kind.mime_type)
}

fn copy_limited_and_hash(source: &Path, destination: &Path) -> AppResult<(u64, String)> {
    let mut source = File::open(source)?;
    let mut destination = File::create(destination)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(count).unwrap_or(u64::MAX))
            .ok_or_else(|| AppError::Validation("Le justificatif est trop volumineux.".into()))?;
        if total > MAX_ATTACHMENT_BYTES {
            return Err(AppError::Validation(
                "Le justificatif dépasse la limite de 25 Mio.".into(),
            ));
        }
        digest.update(&buffer[..count]);
        destination.write_all(&buffer[..count])?;
    }
    destination.sync_all()?;
    validate_size(total)?;
    Ok((total, format!("{:x}", digest.finalize())))
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_supported_binary_signatures() {
        let temporary = tempfile::tempdir().unwrap();
        let pdf = temporary.path().join("invoice.exe");
        fs::write(&pdf, b"%PDF-1.7\nreal payload").unwrap();
        assert_eq!(detect_supported_attachment(&pdf).unwrap().extension, "pdf");

        let executable = temporary.path().join("invoice.pdf");
        fs::write(&executable, b"MZ\x90\0fake executable").unwrap();
        assert!(detect_supported_attachment(&executable).is_err());
    }

    #[test]
    fn limited_copy_hashes_the_exact_stored_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.pdf");
        let destination = temporary.path().join("destination.pdf");
        fs::write(&source, b"%PDF-1.7\ncontent").unwrap();
        let (size, digest) = copy_limited_and_hash(&source, &destination).unwrap();
        assert_eq!(size, fs::metadata(&destination).unwrap().len());
        assert_eq!(digest, sha256_file(&destination).unwrap());
    }

    #[test]
    fn migration_v16_installs_attachment_guards_on_an_existing_database() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("elyko-data");
        let store = LocalStore::initialize(data_dir.clone()).unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER attachments_supplier_insert_guard;
                 DROP TRIGGER attachments_no_update;
                 DROP TRIGGER attachments_supplier_validated_no_delete;
                 PRAGMA user_version=15;",
            )
            .unwrap();
        drop(connection);
        drop(store);

        let migrated = LocalStore::initialize(data_dir).unwrap();
        let connection = migrated.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::schema::SCHEMA_VERSION);
        let trigger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (
                    'attachments_supplier_insert_guard',
                    'attachments_no_update',
                    'attachments_supplier_validated_no_delete'
                )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(trigger_count, 3);
    }
}

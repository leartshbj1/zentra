use std::{
    fs::{self, File},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

use image::{ImageFormat, ImageReader, Limits};
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
const MAX_ATTACHMENT_IMAGE_EDGE: u32 = 12_000;
const MAX_ATTACHMENT_IMAGE_PIXELS: u64 = 24_000_000;
const MAX_ATTACHMENT_IMAGE_DECODE_BYTES: u64 = 128 * 1024 * 1024;

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

pub(crate) struct PreparedSupplierInvoiceAttachment {
    id: String,
    original_name: String,
    stored_name: String,
    detected: SupportedAttachment,
    size_bytes: u64,
    sha256: String,
    temporary_path: PathBuf,
    destination_path: PathBuf,
    installed: bool,
    retained: bool,
}

impl PreparedSupplierInvoiceAttachment {
    pub(crate) fn install(&mut self) -> AppResult<()> {
        fs::rename(&self.temporary_path, &self.destination_path)?;
        self.installed = true;
        Ok(())
    }

    pub(crate) fn retain(&mut self) {
        self.retained = true;
    }
}

impl Drop for PreparedSupplierInvoiceAttachment {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary_path);
        if self.installed && !self.retained {
            let _ = fs::remove_file(&self.destination_path);
        }
    }
}

pub(crate) struct AttachmentInsertResult {
    pub(crate) record: Value,
    pub(crate) created: bool,
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
    #[cfg(test)]
    pub(crate) fn add_supplier_invoice_attachment_bytes(
        &self,
        supplier_invoice_id: &str,
        original_name: &str,
        bytes: &[u8],
    ) -> AppResult<Value> {
        let mut prepared = self.prepare_supplier_invoice_attachment_bytes(original_name, bytes)?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut connection = connection;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = self.insert_prepared_supplier_invoice_attachment(
            &tx,
            supplier_invoice_id,
            &prepared,
            "supplier_email_mime",
        )?;
        if inserted.created {
            prepared.install()?;
        }
        tx.commit()?;
        if inserted.created {
            prepared.retain();
        }
        Ok(inserted.record)
    }

    pub(crate) fn prepare_supplier_invoice_attachment_bytes(
        &self,
        original_name: &str,
        bytes: &[u8],
    ) -> AppResult<PreparedSupplierInvoiceAttachment> {
        let size_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        validate_size(size_bytes)?;
        let original_name = validated_original_name_value(original_name)?;
        let detected = detect_supported_attachment_bytes(bytes)?;
        let id = Uuid::new_v4().to_string();
        let stored_name = format!("{id}.{}", detected.extension);
        let destination_path = self.safe_attachment_path(&stored_name)?;
        let temporary_path = self.safe_attachment_path(&format!(".{id}.attachment-part"))?;
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let prepared = PreparedSupplierInvoiceAttachment {
            id,
            original_name,
            stored_name,
            detected,
            size_bytes,
            sha256,
            temporary_path,
            destination_path,
            installed: false,
            retained: false,
        };
        let write_result = (|| -> AppResult<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&prepared.temporary_path)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            if detect_supported_attachment(&prepared.temporary_path)? != prepared.detected
                || sha256_file(&prepared.temporary_path)? != prepared.sha256
            {
                return Err(AppError::Validation(
                    "Le justificatif décodé ne correspond plus aux octets contrôlés.".into(),
                ));
            }
            Ok(())
        })();
        if let Err(error) = write_result {
            drop(prepared);
            return Err(error);
        }
        Ok(prepared)
    }

    pub(crate) fn insert_prepared_supplier_invoice_attachment(
        &self,
        tx: &Transaction<'_>,
        supplier_invoice_id: &str,
        prepared: &PreparedSupplierInvoiceAttachment,
        source: &str,
    ) -> AppResult<AttachmentInsertResult> {
        let invoice_id = required_uuid(supplier_invoice_id, "facture fournisseur")?;
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
            tx,
            "SELECT * FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=? AND sha256=? LIMIT 1",
            params![invoice_id, prepared.sha256],
        )?
        .into_iter()
        .next();
        if let Some(record) = existing {
            return Ok(AttachmentInsertResult {
                record,
                created: false,
            });
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
            params![prepared.id,project_id,invoice_id,prepared.original_name,prepared.stored_name,prepared.detected.mime_type,i64::try_from(prepared.size_bytes).unwrap_or(i64::MAX),prepared.sha256,now,now],
        )?;
        let record = query_all(
            tx,
            "SELECT * FROM attachments WHERE id=?",
            params![prepared.id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(format!("attachments/{}", prepared.id)))?;
        append_audit(
            tx,
            "attachment_add",
            "supplier_invoice",
            &invoice_id,
            &json!({
                "attachment_id": prepared.id,
                "original_name": prepared.original_name,
                "mime_type": prepared.detected.mime_type,
                "size_bytes": prepared.size_bytes,
                "sha256": prepared.sha256,
                "source": source,
            }),
        )?;
        Ok(AttachmentInsertResult {
            record,
            created: true,
        })
    }

    pub(crate) fn insert_prepared_expense_attachment(
        &self,
        tx: &Transaction<'_>,
        expense_id: &str,
        prepared: &PreparedSupplierInvoiceAttachment,
    ) -> AppResult<String> {
        let project: Option<String> = tx.query_row(
            "SELECT project_id FROM expenses WHERE id=?",
            params![expense_id],
            |row| row.get(0),
        )?;
        let now = now_iso();
        tx.execute("INSERT INTO attachments(id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,'expense',?,?,?,?,?,?,?,?)", params![prepared.id,project,expense_id,prepared.original_name,prepared.stored_name,prepared.detected.mime_type,prepared.size_bytes as i64,prepared.sha256,now,now])?;
        append_audit(
            tx,
            "attachment_add",
            "expense",
            expense_id,
            &json!({"attachment_id":prepared.id,"original_name":prepared.original_name,"sha256":prepared.sha256,"size_bytes":prepared.size_bytes,"source":"bank_expense"}),
        )?;
        Ok(prepared.id.clone())
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
        let proves_email_import: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM supplier_email_invoice_imports WHERE attachment_id=?)",
            params![id],
            |row| row.get(0),
        )?;
        if proves_email_import {
            return Err(AppError::Validation(
                "Cette pièce prouve l'import depuis l'e-mail d'origine. Supprimez le brouillon complet puis recommencez l'import pour choisir une autre pièce.".into(),
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
    let metadata = fs::metadata(path)?;
    validate_size(metadata.len())?;
    let bytes = fs::read(path)?;
    detect_supported_attachment_bytes(&bytes)
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
    let kind = kind.ok_or_else(|| {
        AppError::Validation(
            "Format refusé. Choisissez un vrai fichier PDF, PNG, JPEG ou WebP.".into(),
        )
    })?;
    validate_supported_attachment_structure(bytes, kind)?;
    Ok(kind)
}

fn validate_supported_attachment_structure(
    bytes: &[u8],
    kind: SupportedAttachment,
) -> AppResult<()> {
    match kind.extension {
        "pdf" => {
            let document = lopdf::Document::load_mem(bytes).map_err(|_| {
                AppError::Validation(
                    "Le PDF est incomplet ou illisible. Exportez à nouveau le document avant de l'ajouter."
                        .into(),
                )
            })?;
            if document.get_pages().is_empty() {
                return Err(AppError::Validation(
                    "Le PDF ne contient aucune page exploitable.".into(),
                ));
            }
        }
        "png" | "jpg" | "webp" => {
            let format = match kind.extension {
                "png" => ImageFormat::Png,
                "jpg" => ImageFormat::Jpeg,
                "webp" => ImageFormat::WebP,
                _ => unreachable!(),
            };
            let (declared_width, declared_height) =
                ImageReader::with_format(Cursor::new(bytes), format)
                    .into_dimensions()
                    .map_err(|_| {
                        AppError::Validation(
                            "L'image est incomplète ou illisible. Exportez-la à nouveau avant de l'ajouter."
                                .into(),
                        )
                    })?;
            validate_attachment_image_dimensions(declared_width, declared_height)?;

            let mut limits = Limits::default();
            limits.max_image_width = Some(MAX_ATTACHMENT_IMAGE_EDGE);
            limits.max_image_height = Some(MAX_ATTACHMENT_IMAGE_EDGE);
            limits.max_alloc = Some(MAX_ATTACHMENT_IMAGE_DECODE_BYTES);
            let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
            reader.limits(limits);
            let image = reader.decode().map_err(|_| {
                AppError::Validation(
                    "L'image est incomplète ou illisible. Exportez-la à nouveau avant de l'ajouter."
                        .into(),
                )
            })?;
            validate_attachment_image_dimensions(image.width(), image.height())?;
            if (image.width(), image.height()) != (declared_width, declared_height) {
                return Err(AppError::Validation(
                    "Les dimensions déclarées de l'image ne correspondent pas à son contenu."
                        .into(),
                ));
            }
        }
        _ => {
            return Err(AppError::Validation(
                "Le format du justificatif n'est pas pris en charge.".into(),
            ))
        }
    }
    Ok(())
}

fn validate_attachment_image_dimensions(width: u32, height: u32) -> AppResult<()> {
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0
        || height == 0
        || width > MAX_ATTACHMENT_IMAGE_EDGE
        || height > MAX_ATTACHMENT_IMAGE_EDGE
        || pixels > MAX_ATTACHMENT_IMAGE_PIXELS
    {
        return Err(AppError::Validation(format!(
            "L'image annonce {width} × {height} pixels. La limite est de {MAX_ATTACHMENT_IMAGE_EDGE} pixels par côté et {} mégapixels.",
            MAX_ATTACHMENT_IMAGE_PIXELS / 1_000_000,
        )));
    }
    Ok(())
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
pub(crate) fn test_pdf_bytes() -> Vec<u8> {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => content_id,
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
    });
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }),
    );
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog_id);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).expect("serialize test PDF");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn png_with_declared_dimensions(width: u32, height: u32) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut cursor, ImageFormat::Png)
            .unwrap();
        let mut bytes = cursor.into_inner();
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let checksum = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&checksum.to_be_bytes());
        bytes
    }

    #[test]
    fn detects_only_supported_binary_signatures() {
        let temporary = tempfile::tempdir().unwrap();
        let pdf = temporary.path().join("invoice.exe");
        fs::write(&pdf, test_pdf_bytes()).unwrap();
        assert_eq!(detect_supported_attachment(&pdf).unwrap().extension, "pdf");

        let truncated = temporary.path().join("truncated.pdf");
        fs::write(&truncated, b"%PDF-1.7\nreal payload").unwrap();
        assert!(detect_supported_attachment(&truncated).is_err());

        let executable = temporary.path().join("invoice.pdf");
        fs::write(&executable, b"MZ\x90\0fake executable").unwrap();
        assert!(detect_supported_attachment(&executable).is_err());
    }

    #[test]
    fn rejects_a_small_compressed_image_that_declares_too_many_pixels() {
        assert!(detect_supported_attachment_bytes(&png_with_declared_dimensions(1, 1)).is_ok());
        let error = detect_supported_attachment_bytes(&png_with_declared_dimensions(6_000, 5_000))
            .expect_err("oversized declared dimensions must fail before decoding");
        assert!(error.to_string().contains("24 mégapixels"));
    }

    #[test]
    fn limited_copy_hashes_the_exact_stored_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.pdf");
        let destination = temporary.path().join("destination.pdf");
        fs::write(&source, test_pdf_bytes()).unwrap();
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

use std::{fs, path::Path, sync::OnceLock};

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use chrono::NaiveDate;
use encoding_rs::Encoding;
use regex::Regex;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    attachments::supported_attachment_mime,
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{AppError, AppResult},
    models::SaveSupplierInvoiceDraftInput,
    supplier_invoices::supplier_invoice_bundle,
};

const MAX_EMAIL_BYTES: u64 = 15 * 1024 * 1024;
const MAX_VISIBLE_TEXT_BYTES: usize = 2 * 1024 * 1024;
const GENERIC_EMAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "icloud.com",
    "yahoo.com",
    "proton.me",
    "protonmail.com",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedMailbox {
    name: String,
    email: String,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
pub struct AddSupplierEmailAttachmentInput {
    pub supplier_invoice_id: String,
    pub source_path: String,
    pub source_sha256: String,
    pub attachment_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportSupplierEmailInvoiceDraftInput {
    pub invoice: SaveSupplierInvoiceDraftInput,
    pub source_path: String,
    pub source_sha256: String,
    #[serde(default)]
    pub attachment_sha256: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedEmailAttachment {
    name: String,
    mime_type: &'static str,
    bytes: Vec<u8>,
    sha256: String,
}

#[derive(Debug)]
struct ReviewedSupplierEmail {
    file_name: String,
    source_sha256: String,
    message_id: Option<String>,
    attachments: Vec<ParsedEmailAttachment>,
}

impl LocalStore {
    /// Analyse uniquement le fichier explicitement choisi par l'utilisateur.
    /// Aucun accès IMAP/API, aucune requête réseau et aucun envoi ne sont faits.
    pub fn inspect_supplier_email_file(&self, source_path: &str) -> AppResult<Value> {
        let path = Path::new(source_path.trim());
        if source_path.trim().is_empty() || !path.is_file() {
            return Err(AppError::Validation(
                "Choisissez un message e-mail local existant.".into(),
            ));
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "eml" | "txt") {
            return Err(AppError::Validation(
                "Le message doit être exporté au format .eml (ou .txt pour un e-mail enregistré en texte)."
                    .into(),
            ));
        }
        let metadata = fs::metadata(path)?;
        if metadata.len() == 0 || metadata.len() > MAX_EMAIL_BYTES {
            return Err(AppError::Validation(format!(
                "Le message doit contenir entre 1 octet et {} Mio.",
                MAX_EMAIL_BYTES / 1024 / 1024
            )));
        }
        let bytes = fs::read(path)?;
        if bytes.is_empty()
            || u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_EMAIL_BYTES
            || bytes.contains(&0)
        {
            return Err(AppError::Validation(
                "Le fichier sélectionné n'est pas un message e-mail texte valide.".into(),
            ));
        }
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let raw = String::from_utf8_lossy(&bytes);
        let unfolded = unfold_headers(&raw);
        let subject = header_value(&unfolded, "subject").unwrap_or_default();
        let mailbox = parse_mailbox(&header_value(&unfolded, "from").unwrap_or_default());
        let message_id = header_value(&unfolded, "message-id")
            .unwrap_or_default()
            .trim_matches(['<', '>'])
            .trim()
            .to_owned();
        let body = visible_email_text(&raw);
        let searchable = format!("{subject}\n{body}");
        let attachment_names = attachment_names(&raw);
        let importable_attachments = mime_attachments(&raw);
        let invoice_signal = invoice_signal(&searchable, &attachment_names);
        let reference = extract_reference(&searchable);
        let document_date = extract_labeled_date(
            &searchable,
            &[
                "date de facture",
                "invoice date",
                "rechnungsdatum",
                "facture du",
            ],
        );
        let due_date = extract_labeled_date(
            &searchable,
            &[
                "date d'échéance",
                "date echeance",
                "échéance",
                "echeance",
                "due date",
                "zahlbar bis",
                "fällig",
                "faellig",
            ],
        );
        let total_cents = extract_labeled_amount(
            &searchable,
            &[
                "total ttc",
                "montant à payer",
                "montant a payer",
                "total amount",
                "amount due",
                "rechnungsbetrag",
                "gesamtbetrag",
                "total",
            ],
        );
        let vat_cents = extract_labeled_amount(&searchable, &["montant tva", "tva", "vat", "mwst"]);
        let net_cents = extract_labeled_amount(
            &searchable,
            &["total net", "sous-total", "sous total", "subtotal", "netto"],
        );
        let currency = detect_currency(&searchable);

        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let matched_supplier_id = match_supplier(&connection, &mailbox.email)?;
        let duplicate_invoice_id = match (&matched_supplier_id, &reference) {
            (Some(supplier_id), Some(reference)) => {
                let normalized = normalize_reference(reference);
                connection
                    .query_row(
                        "SELECT id FROM supplier_invoices WHERE supplier_id=? AND reference_normalized=? ORDER BY CASE status WHEN 'validated' THEN 0 ELSE 1 END,created_at LIMIT 1",
                        params![supplier_id, normalized],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            }
            _ => None,
        };

        let mut issues = Vec::new();
        if !invoice_signal {
            issues.push(
                "Le message ne contient pas assez d'indices pour être reconnu comme une facture."
                    .to_owned(),
            );
        }
        if mailbox.email.is_empty() {
            issues.push("L'adresse de l'expéditeur n'a pas été trouvée.".to_owned());
        }
        if matched_supplier_id.is_none() {
            issues.push(
                "Choisissez le fournisseur : aucune correspondance sûre n'a été trouvée."
                    .to_owned(),
            );
        }
        if reference.is_none() {
            issues.push("Complétez la référence de la facture.".to_owned());
        }
        if document_date.is_none() {
            issues.push("Complétez la date de facture.".to_owned());
        }
        if due_date.is_none() {
            issues.push("Complétez l'échéance.".to_owned());
        }
        if total_cents.is_none() {
            issues.push("Complétez le montant total après contrôle du document joint.".to_owned());
        }
        if currency.is_none() {
            issues.push("Contrôlez et sélectionnez la devise de la facture.".to_owned());
        } else if currency.as_deref().is_some_and(|value| value != "CHF") {
            issues.push("La facture détectée n'est pas en CHF; l'import comptable automatique reste bloqué.".to_owned());
        }
        if duplicate_invoice_id.is_some() {
            issues.push("Une facture de ce fournisseur possède déjà la même référence.".to_owned());
        }

        let evidence_count = [
            invoice_signal,
            !attachment_names.is_empty(),
            reference.is_some(),
            document_date.is_some(),
            due_date.is_some(),
            total_cents.is_some(),
            matched_supplier_id.is_some(),
        ]
        .into_iter()
        .filter(|value| *value)
        .count();
        let confidence = if evidence_count >= 6 {
            "high"
        } else if evidence_count >= 3 {
            "medium"
        } else {
            "low"
        };

        Ok(json!({
            "file_name": path.file_name().and_then(|value| value.to_str()).unwrap_or("message.eml"),
            "file_size_bytes": metadata.len(),
            "sha256": sha256,
            "message_id": message_id,
            "subject": subject.trim(),
            "sender_name": mailbox.name,
            "sender_email": mailbox.email,
            "attachment_names": attachment_names,
            "importable_attachments": importable_attachments.iter().map(|attachment| json!({
                "name": attachment.name,
                "mime_type": attachment.mime_type,
                "size_bytes": attachment.bytes.len(),
                "sha256": attachment.sha256,
            })).collect::<Vec<_>>(),
            "invoice_signal": invoice_signal,
            "confidence": confidence,
            "matched_supplier_id": matched_supplier_id,
            "duplicate_invoice_id": duplicate_invoice_id,
            "reference": reference,
            "document_date": document_date,
            "due_date": due_date,
            "currency": currency.unwrap_or_default(),
            "net_cents": net_cents,
            "vat_cents": vat_cents,
            "total_cents": total_cents,
            "issues": issues,
            "network_access": false,
            "ai_used": false,
        }))
    }

    /// Enregistre le brouillon, la pièce MIME contrôlée et la provenance dans
    /// une seule transaction. Le fichier final est supprimé si la base ne peut
    /// pas être validée, ce qui évite les brouillons ou justificatifs orphelins.
    pub fn import_supplier_email_invoice_draft(
        &self,
        input: ImportSupplierEmailInvoiceDraftInput,
    ) -> AppResult<Value> {
        let reviewed = reviewed_supplier_email(&input.source_path, &input.source_sha256)?;
        let invoice_id = input
            .invoice
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::Validation(
                    "L'identifiant stable du brouillon fournisseur est obligatoire.".into(),
                )
            })?
            .to_owned();
        if invoice_id.len() > 100 {
            return Err(AppError::Validation(
                "L'identifiant du brouillon fournisseur est invalide.".into(),
            ));
        }

        let requested_attachment_sha256 = input
            .attachment_sha256
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| validated_sha256(value, "pièce jointe"))
            .transpose()?
            .ok_or_else(|| {
                AppError::Validation(
                    "Sélectionnez le justificatif original PDF ou image avant d'importer cet e-mail."
                        .into(),
                )
            })?;
        let selected_attachment = reviewed
            .attachments
            .iter()
            .find(|attachment| attachment.sha256 == requested_attachment_sha256)
            .cloned()
            .ok_or_else(|| {
                AppError::Validation(
                    "La pièce jointe contrôlée n'existe plus dans ce message.".into(),
                )
            })?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut prepared_attachment = self.prepare_supplier_invoice_attachment_bytes(
            &selected_attachment.name,
            &selected_attachment.bytes,
        )?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing_import: Option<(String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT supplier_invoice_id,attachment_sha256,attachment_id FROM supplier_email_invoice_imports WHERE source_sha256=?",
                params![reviewed.source_sha256],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((existing_invoice_id, existing_attachment_sha256, attachment_id)) =
            existing_import
        {
            if existing_invoice_id != invoice_id
                || existing_attachment_sha256.as_deref()
                    != Some(requested_attachment_sha256.as_str())
                || attachment_id.is_none()
            {
                return Err(AppError::Validation(
                    "Ce message e-mail a déjà été importé. Ouvrez le brouillon existant au lieu d'en créer un autre.".into(),
                ));
            }
            let before = supplier_invoice_bundle(&tx, &invoice_id)?;
            let after =
                self.save_supplier_invoice_draft_in_transaction(&tx, input.invoice, true)?;
            if after != before {
                return Err(AppError::Validation(
                    "Ce message e-mail a déjà été importé et son brouillon a depuis été modifié. Ouvrez le brouillon existant pour continuer.".into(),
                ));
            }
            tx.commit()?;
            return Ok(json!({
                "document": before,
                "attachment_id": attachment_id,
                "source_sha256": reviewed.source_sha256,
                "idempotent": true,
            }));
        }

        if let Some(message_id) = reviewed.message_id.as_deref() {
            let duplicate_message: Option<String> = tx
                .query_row(
                    "SELECT supplier_invoice_id FROM supplier_email_invoice_imports WHERE source_message_id=? COLLATE NOCASE LIMIT 1",
                    params![message_id],
                    |row| row.get(0),
                )
                .optional()?;
            if duplicate_message.is_some() {
                return Err(AppError::Validation(
                    "Ce message e-mail possède un identifiant déjà importé. Ouvrez le brouillon existant pour le contrôler.".into(),
                ));
            }
        }

        let document = self.save_supplier_invoice_draft_in_transaction(&tx, input.invoice, true)?;
        let inserted_attachment = self.insert_prepared_supplier_invoice_attachment(
            &tx,
            &invoice_id,
            &prepared_attachment,
            "supplier_email_atomic_import",
        )?;
        if inserted_attachment.created {
            prepared_attachment.install()?;
        }
        let attachment_id = inserted_attachment.record["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| AppError::Validation("Identifiant de justificatif invalide.".into()))?;
        let attachment_sha256 = inserted_attachment.record["sha256"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| AppError::Validation("Empreinte de justificatif invalide.".into()))?;
        if attachment_sha256 != requested_attachment_sha256 {
            return Err(AppError::Validation(
                "L'empreinte du justificatif enregistré ne correspond pas à la pièce contrôlée."
                    .into(),
            ));
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO supplier_email_invoice_imports(supplier_invoice_id,source_sha256,source_message_id,source_file_name,attachment_sha256,attachment_id,created_at) VALUES(?,?,?,?,?,?,?)",
            params![invoice_id,reviewed.source_sha256,reviewed.message_id,reviewed.file_name,requested_attachment_sha256,attachment_id,now],
        )?;
        append_audit(
            &tx,
            "import",
            "supplier_email_invoice",
            &invoice_id,
            &json!({
                "source_sha256": reviewed.source_sha256,
                "source_message_id": reviewed.message_id,
                "source_file_name": reviewed.file_name,
                "attachment_sha256": requested_attachment_sha256,
                "attachment_id": attachment_id,
                "network_access": false,
                "ai_used": false,
            }),
        )?;
        tx.commit()?;
        if inserted_attachment.created {
            prepared_attachment.retain();
        }
        Ok(json!({
            "document": document,
            "attachment": inserted_attachment.record,
            "source_sha256": reviewed.source_sha256,
            "idempotent": false,
        }))
    }

    /// Compatibilité avec les anciennes interfaces : relit toujours le message
    /// et vérifie les deux empreintes avant d'ajouter uniquement la pièce.
    #[cfg(test)]
    pub fn add_supplier_email_attachment(
        &self,
        input: AddSupplierEmailAttachmentInput,
    ) -> AppResult<Value> {
        let reviewed = reviewed_supplier_email(&input.source_path, &input.source_sha256)?;
        let attachment_sha256 = validated_sha256(&input.attachment_sha256, "pièce jointe")?;
        let attachment = reviewed
            .attachments
            .into_iter()
            .find(|attachment| attachment.sha256 == attachment_sha256)
            .ok_or_else(|| {
                AppError::Validation(
                    "La pièce jointe contrôlée n'existe plus dans ce message.".into(),
                )
            })?;
        self.add_supplier_invoice_attachment_bytes(
            &input.supplier_invoice_id,
            &attachment.name,
            &attachment.bytes,
        )
    }
}

fn reviewed_supplier_email(
    source_path: &str,
    expected_source_sha256: &str,
) -> AppResult<ReviewedSupplierEmail> {
    let path = Path::new(source_path.trim());
    if source_path.trim().is_empty() || !path.is_file() {
        return Err(AppError::Validation(
            "Le message e-mail d'origine est introuvable; sélectionnez-le à nouveau.".into(),
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "eml" | "txt") {
        return Err(AppError::Validation(
            "La source doit rester un message .eml ou .txt.".into(),
        ));
    }
    let metadata = fs::metadata(path)?;
    if metadata.len() == 0 || metadata.len() > MAX_EMAIL_BYTES {
        return Err(AppError::Validation(
            "La taille du message e-mail n'est plus valide.".into(),
        ));
    }
    let bytes = fs::read(path)?;
    if bytes.is_empty()
        || u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_EMAIL_BYTES
        || bytes.contains(&0)
    {
        return Err(AppError::Validation(
            "Le fichier sélectionné n'est pas un message e-mail texte valide.".into(),
        ));
    }
    let source_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let expected_source_sha256 = validated_sha256(expected_source_sha256, "message e-mail")?;
    if source_sha256 != expected_source_sha256 {
        return Err(AppError::Validation(
            "Le message e-mail a changé depuis votre contrôle; analysez-le à nouveau.".into(),
        ));
    }
    let raw = String::from_utf8_lossy(&bytes);
    let unfolded = unfold_headers(&raw);
    let message_id = header_value(&unfolded, "message-id")
        .unwrap_or_default()
        .trim_matches(['<', '>'])
        .trim()
        .to_owned();
    if message_id.len() > 512 {
        return Err(AppError::Validation(
            "L'identifiant technique du message e-mail est anormalement long.".into(),
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("message.eml")
        .trim()
        .to_owned();
    if file_name.is_empty() || file_name.len() > 255 || file_name.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "Le nom du fichier e-mail source est invalide.".into(),
        ));
    }
    Ok(ReviewedSupplierEmail {
        file_name,
        source_sha256,
        message_id: (!message_id.is_empty()).then_some(message_id),
        attachments: mime_attachments(&raw),
    })
}

fn validated_sha256(value: &str, label: &str) -> AppResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Validation(format!(
            "L'empreinte du {label} est invalide."
        )));
    }
    Ok(normalized)
}

fn unfold_headers(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .lines()
        .take_while(|line| !line.is_empty())
        .fold(String::new(), |mut output, line| {
            if (line.starts_with(' ') || line.starts_with('\t')) && !output.is_empty() {
                output.push(' ');
                output.push_str(line.trim());
            } else {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(line);
            }
            output
        })
}

fn header_value(headers: &str, name: &str) -> Option<String> {
    raw_header_value(headers, name).map(|value| decode_rfc2047(&value))
}

fn raw_header_value(headers: &str, name: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}

fn parse_mailbox(value: &str) -> ParsedMailbox {
    static MAILBOX: OnceLock<Regex> = OnceLock::new();
    static EMAIL: OnceLock<Regex> = OnceLock::new();
    let mailbox = MAILBOX.get_or_init(|| {
        Regex::new(r#"(?i)^\s*\"?([^\"<]*)\"?\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$"#)
            .expect("mailbox regex")
    });
    let email = EMAIL.get_or_init(|| {
        Regex::new(r"(?i)([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})")
            .expect("email regex")
    });
    if let Some(captures) = mailbox.captures(value) {
        return ParsedMailbox {
            name: captures[1].trim().to_owned(),
            email: captures[2].trim().to_ascii_lowercase(),
        };
    }
    let email = email
        .captures(value)
        .map(|captures| captures[1].trim().to_ascii_lowercase())
        .unwrap_or_default();
    ParsedMailbox {
        name: value
            .replace(&email, "")
            .trim_matches([' ', '"', '<', '>'])
            .to_owned(),
        email,
    }
}

fn visible_email_text(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    let mut output = String::new();
    collect_mime_text(&normalized, 0, &mut output);
    output
}

fn collect_mime_text(entity: &str, depth: usize, output: &mut String) {
    if depth > 12 || output.len() >= MAX_VISIBLE_TEXT_BYTES {
        return;
    }
    let (raw_headers, body) = entity.split_once("\n\n").unwrap_or(("", entity));
    let headers = unfold_headers(raw_headers);
    let content_type = raw_header_value(&headers, "content-type")
        .unwrap_or_else(|| "text/plain; charset=utf-8".to_owned());
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    if media_type.starts_with("multipart/") {
        if let Some(boundary) = mime_parameter(&content_type, "boundary") {
            let delimiter = format!("--{boundary}");
            for section in body.split(&delimiter).skip(1) {
                let section = section.trim_start_matches(['\r', '\n']);
                if section.starts_with("--") {
                    break;
                }
                collect_mime_text(section.trim_end_matches(['\r', '\n']), depth + 1, output);
            }
        }
        return;
    }

    if media_type != "text/plain" && media_type != "text/html" {
        return;
    }
    let transfer_encoding = raw_header_value(&headers, "content-transfer-encoding")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let decoded_bytes = match transfer_encoding.trim() {
        "base64" => decode_base64_mime(body).unwrap_or_default(),
        "quoted-printable" => decode_quoted_printable_bytes(body, false),
        _ => body.as_bytes().to_vec(),
    };
    let charset = mime_parameter(&content_type, "charset");
    let decoded = decode_charset(&decoded_bytes, charset.as_deref());
    let visible = if media_type == "text/html" {
        visible_html(&decoded)
    } else {
        decoded
    };
    append_visible_text(output, &visible);
}

fn mime_parameter(header: &str, parameter: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r#"(?i)(?:^|;)\s*{}\s*=\s*(?:\"([^\"]*)\"|([^;\s]+))"#,
        regex::escape(parameter)
    ))
    .ok()?;
    let captures = pattern.captures(header)?;
    captures
        .get(1)
        .or_else(|| captures.get(2))
        .map(|value| value.as_str().trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn decode_base64_mime(value: &str) -> Option<Vec<u8>> {
    let compact = value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    if compact.is_empty() {
        return Some(Vec::new());
    }
    STANDARD
        .decode(&compact)
        .or_else(|_| STANDARD_NO_PAD.decode(&compact))
        .ok()
}

fn decode_charset(bytes: &[u8], charset: Option<&str>) -> String {
    let encoding = charset
        .and_then(|label| Encoding::for_label(label.trim().as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (decoded, _, _) = encoding.decode(bytes);
    decoded.into_owned()
}

fn visible_html(value: &str) -> String {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static HIDDEN_BLOCKS: OnceLock<Regex> = OnceLock::new();
    let without_hidden = HIDDEN_BLOCKS
        .get_or_init(|| {
            Regex::new(r"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>")
                .expect("hidden html block regex")
        })
        .replace_all(value, " ");
    let without_tags = TAGS
        .get_or_init(|| Regex::new(r"(?is)<[^>]{1,1000}>").expect("html tag regex"))
        .replace_all(&without_hidden, " ");
    without_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&rsquo;", "’")
        .replace("&eacute;", "é")
        .replace("&Eacute;", "É")
        .replace("&agrave;", "à")
        .replace("&Agrave;", "À")
}

fn append_visible_text(output: &mut String, value: &str) {
    if !output.is_empty() {
        output.push('\n');
    }
    let remaining = MAX_VISIBLE_TEXT_BYTES.saturating_sub(output.len());
    if value.len() <= remaining {
        output.push_str(value);
        return;
    }
    let mut end = remaining;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&value[..end]);
}

fn decode_quoted_printable_bytes(value: &str, header_mode: bool) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if header_mode && bytes[index] == b'_' {
            decoded.push(b' ');
            index += 1;
            continue;
        }
        if bytes[index] == b'=' {
            if bytes.get(index + 1) == Some(&b'\r') && bytes.get(index + 2) == Some(&b'\n') {
                index += 3;
                continue;
            }
            if bytes.get(index + 1) == Some(&b'\n') {
                index += 2;
                continue;
            }
            if index + 2 < bytes.len() {
                if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    decoded.push(high * 16 + low);
                    index += 3;
                    continue;
                }
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    decoded
}

fn decode_rfc2047(value: &str) -> String {
    static ENCODED_WORD: OnceLock<Regex> = OnceLock::new();
    let pattern = ENCODED_WORD.get_or_init(|| {
        Regex::new(r"(?i)=\?([^?\s]+)\?([bq])\?([^?]*)\?=").expect("RFC 2047 regex")
    });
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut previous_was_encoded = false;
    for captures in pattern.captures_iter(value) {
        let Some(encoded_word) = captures.get(0) else {
            continue;
        };
        let between = &value[cursor..encoded_word.start()];
        if !(previous_was_encoded && between.chars().all(char::is_whitespace)) {
            decoded.push_str(between);
        }
        let charset = captures.get(1).map(|item| item.as_str());
        let kind = captures
            .get(2)
            .map(|item| item.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        let payload = captures
            .get(3)
            .map(|item| item.as_str())
            .unwrap_or_default();
        let bytes = if kind == "b" {
            decode_base64_mime(payload)
        } else {
            Some(decode_quoted_printable_bytes(payload, true))
        };
        if let Some(bytes) = bytes {
            decoded.push_str(&decode_charset(&bytes, charset));
            previous_was_encoded = true;
        } else {
            decoded.push_str(encoded_word.as_str());
            previous_was_encoded = false;
        }
        cursor = encoded_word.end();
    }
    decoded.push_str(&value[cursor..]);
    decoded
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn attachment_names(raw: &str) -> Vec<String> {
    static EXTENDED_FILENAME: OnceLock<Regex> = OnceLock::new();
    static FILENAME: OnceLock<Regex> = OnceLock::new();
    let normalized = raw.replace("\r\n", "\n");
    let extended = EXTENDED_FILENAME.get_or_init(|| {
        Regex::new(r#"(?i)(?:filename|name)\*\s*=\s*(?:\"([^\"]+)\"|([^;\r\n]+))"#)
            .expect("extended attachment filename regex")
    });
    let regular = FILENAME.get_or_init(|| {
        Regex::new(r#"(?i)(?:filename|name)\s*=\s*(?:\"([^\"]+)\"|([^;\r\n]+))"#)
            .expect("attachment filename regex")
    });
    let mut names = extended
        .captures_iter(&normalized)
        .filter_map(|capture| capture.get(1).or_else(|| capture.get(2)))
        .filter_map(|value| decode_rfc2231_value(value.as_str().trim()))
        .chain(
            regular
                .captures_iter(&normalized)
                .filter_map(|capture| capture.get(1).or_else(|| capture.get(2)))
                .map(|value| decode_rfc2047(value.as_str().trim())),
        )
        .filter_map(|value| safe_attachment_name(&value))
        .filter(|value| {
            let lower = value.to_ascii_lowercase();
            [".pdf", ".png", ".jpg", ".jpeg", ".webp"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

fn mime_attachments(raw: &str) -> Vec<ParsedEmailAttachment> {
    let normalized = raw.replace("\r\n", "\n");
    let mut attachments = Vec::new();
    let mut visited_parts = 0_usize;
    collect_mime_attachments(&normalized, 0, &mut visited_parts, &mut attachments);
    attachments.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.sha256.cmp(&right.sha256))
    });
    attachments.dedup_by(|left, right| left.sha256 == right.sha256);
    attachments
}

fn collect_mime_attachments(
    entity: &str,
    depth: usize,
    visited_parts: &mut usize,
    output: &mut Vec<ParsedEmailAttachment>,
) {
    if depth > 12 || *visited_parts >= 200 || output.len() >= 20 {
        return;
    }
    *visited_parts += 1;
    let (raw_headers, body) = entity.split_once("\n\n").unwrap_or(("", entity));
    let headers = unfold_headers(raw_headers);
    let content_type = raw_header_value(&headers, "content-type")
        .unwrap_or_else(|| "text/plain; charset=utf-8".to_owned());
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    if media_type.starts_with("multipart/") {
        if let Some(boundary) = mime_parameter(&content_type, "boundary") {
            let delimiter = format!("--{boundary}");
            for section in body.split(&delimiter).skip(1) {
                let section = section.trim_start_matches(['\r', '\n']);
                if section.starts_with("--") {
                    break;
                }
                collect_mime_attachments(
                    section.trim_end_matches(['\r', '\n']),
                    depth + 1,
                    visited_parts,
                    output,
                );
            }
        }
        return;
    }

    let Some(name) = mime_attachment_name(&headers) else {
        return;
    };
    let transfer_encoding = raw_header_value(&headers, "content-transfer-encoding")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let decoded = match transfer_encoding.trim() {
        "base64" => decode_base64_mime(body),
        // Le message est analysé comme texte afin d'en extraire les en-têtes.
        // Seul Base64 garantit ici que les octets binaires reconstruits sont
        // strictement identiques au justificatif original. Les autres pièces
        // restent annoncées mais doivent être ajoutées manuellement.
        _ => None,
    };
    let Some(bytes) = decoded.filter(|bytes| !bytes.is_empty()) else {
        return;
    };
    let Some(mime_type) = supported_attachment_mime(&bytes) else {
        return;
    };
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    output.push(ParsedEmailAttachment {
        name,
        mime_type,
        bytes,
        sha256,
    });
}

fn mime_attachment_name(headers: &str) -> Option<String> {
    for header_name in ["content-disposition", "content-type"] {
        let Some(header) = raw_header_value(headers, header_name) else {
            continue;
        };
        for parameter in ["filename*", "name*"] {
            if let Some(value) = mime_parameter(&header, parameter)
                .and_then(|value| decode_rfc2231_value(&value))
                .and_then(|value| safe_attachment_name(&value))
            {
                return Some(value);
            }
        }
        for parameter in ["filename", "name"] {
            if let Some(value) = mime_parameter(&header, parameter)
                .map(|value| decode_rfc2047(&value))
                .and_then(|value| safe_attachment_name(&value))
            {
                return Some(value);
            }
        }
    }
    None
}

fn decode_rfc2231_value(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('"');
    let mut components = trimmed.splitn(3, '\'');
    let first = components.next().unwrap_or_default();
    let second = components.next();
    let third = components.next();
    let (charset, encoded) = match (second, third) {
        (Some(_language), Some(encoded)) => (Some(first), encoded),
        _ => (Some("utf-8"), trimmed),
    };
    let bytes = percent_decode(encoded)?;
    Some(decode_charset(&bytes, charset))
}

fn percent_decode(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex(bytes[index + 1])?;
            let low = hex(bytes[index + 2])?;
            decoded.push(high * 16 + low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    Some(decoded)
}

fn safe_attachment_name(value: &str) -> Option<String> {
    let normalized = value.replace('\\', "/");
    let file_name = normalized
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect::<String>();
    let trimmed = file_name.trim().trim_matches('.').trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn invoice_signal(text: &str, attachments: &[String]) -> bool {
    let lower = text.to_lowercase();
    let keyword = ["facture", "invoice", "rechnung"]
        .iter()
        .any(|word| lower.contains(word));
    let named_attachment = attachments.iter().any(|name| {
        let lower = name.to_lowercase();
        ["facture", "invoice", "rechnung"]
            .iter()
            .any(|word| lower.contains(word))
    });
    keyword || named_attachment
}

fn extract_reference(text: &str) -> Option<String> {
    static REFERENCE: OnceLock<Regex> = OnceLock::new();
    let pattern = REFERENCE.get_or_init(|| {
        Regex::new(r"(?im)(?:n(?:°|o|r\.?|uméro)?\s*(?:de\s+)?facture|facture\s*(?:n(?:°|o|r\.?)?)?|invoice\s*(?:no\.?|number|#)?|rechnungs(?:nummer|nr\.?)?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9._/\-]{2,60})")
            .expect("invoice reference regex")
    });
    text.lines().find_map(|line| {
        pattern
            .captures(line)
            .and_then(|capture| capture.get(1))
            .map(|value| value.as_str().trim_matches(['.', ',', ';']).to_owned())
    })
}

fn extract_labeled_date(text: &str, labels: &[&str]) -> Option<String> {
    for label in labels {
        for line in text.lines() {
            let lower = line.to_lowercase();
            let Some(position) = lower.find(label) else {
                continue;
            };
            // L'offset vient de la version mise en minuscules. Certaines
            // conversions Unicode changent la longueur UTF-8 (par exemple
            // `K` devient `k`), il ne doit donc jamais servir à trancher la
            // chaîne originale.
            let tail = &lower[position + label.len()..];
            if let Some(date) = first_date(tail) {
                return Some(date);
            }
        }
    }
    None
}

fn first_date(value: &str) -> Option<String> {
    static DATE: OnceLock<Regex> = OnceLock::new();
    let pattern = DATE.get_or_init(|| {
        Regex::new(r"\b(20\d{2})[-./](0?[1-9]|1[0-2])[-./](0?[1-9]|[12]\d|3[01])\b|\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d{2})\b")
            .expect("date regex")
    });
    let captures = pattern.captures(value)?;
    let (year, month, day) = if let (Some(year), Some(month), Some(day)) =
        (captures.get(1), captures.get(2), captures.get(3))
    {
        (year.as_str(), month.as_str(), day.as_str())
    } else {
        (
            captures.get(6)?.as_str(),
            captures.get(5)?.as_str(),
            captures.get(4)?.as_str(),
        )
    };
    let parsed =
        NaiveDate::from_ymd_opt(year.parse().ok()?, month.parse().ok()?, day.parse().ok()?)?;
    Some(parsed.format("%Y-%m-%d").to_string())
}

fn extract_labeled_amount(text: &str, labels: &[&str]) -> Option<i64> {
    static AMOUNT: OnceLock<Regex> = OnceLock::new();
    let pattern = AMOUNT.get_or_init(|| {
        Regex::new(r"(?i)(?:CHF|Fr\.?)?\s*([0-9]{1,3}(?:['’\s][0-9]{3})*(?:[.,][0-9]{2})|[0-9]+(?:[.,][0-9]{2}))\s*(?:CHF|Fr\.?)?")
            .expect("amount regex")
    });
    for label in labels {
        for line in text.lines() {
            let lower = line.to_lowercase();
            let Some(position) = lower.find(label) else {
                continue;
            };
            let tail = &lower[position + label.len()..];
            if let Some(capture) = pattern.captures(tail) {
                if let Some(cents) = parse_money(capture.get(1)?.as_str()) {
                    if cents > 0 {
                        return Some(cents);
                    }
                }
            }
        }
    }
    None
}

fn parse_money(value: &str) -> Option<i64> {
    let normalized = value.replace(['\'', '’', ' '], "").replace(',', ".");
    let (major, minor) = normalized.split_once('.')?;
    if minor.len() != 2 {
        return None;
    }
    major
        .parse::<i64>()
        .ok()?
        .checked_mul(100)?
        .checked_add(minor.parse::<i64>().ok()?)
}

fn detect_currency(text: &str) -> Option<String> {
    let upper = text.to_ascii_uppercase();
    for currency in ["CHF", "EUR", "USD", "GBP"] {
        if upper.contains(currency) {
            return Some(currency.to_owned());
        }
    }
    None
}

fn match_supplier(
    connection: &rusqlite::Connection,
    sender_email: &str,
) -> AppResult<Option<String>> {
    if sender_email.is_empty() {
        return Ok(None);
    }
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM suppliers WHERE archived_at IS NULL AND LOWER(TRIM(email))=? ORDER BY created_at LIMIT 1",
            params![sender_email],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(Some(id));
    }
    let domain = sender_email
        .rsplit_once('@')
        .map(|(_, domain)| domain)
        .unwrap_or("");
    if domain.is_empty() || GENERIC_EMAIL_DOMAINS.contains(&domain) {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT id FROM suppliers WHERE archived_at IS NULL AND LOWER(TRIM(email)) LIKE ? ORDER BY created_at LIMIT 2",
    )?;
    let matches = statement
        .query_map(params![format!("%@{domain}")], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((matches.len() == 1).then(|| matches[0].clone()))
}

fn normalize_reference(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use rusqlite::params;

    use super::*;
    use crate::database::now_iso;
    use crate::models::{SaveSupplierInvoiceDraftInput, SupplierInvoiceLineInput};

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection.execute(
            "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise test',?,?)",
            params![now, now],
        ).unwrap();
        connection.execute(
            "INSERT INTO suppliers(id,name,email,created_at,updated_at) VALUES('supplier-1','Papeterie SA','factures@papeterie.example',?,?)",
            params![now, now],
        ).unwrap();
        drop(connection);
        (temporary, store)
    }

    fn write_email(directory: &Path, content: &str) -> String {
        let path = directory.join("facture.eml");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(content.as_bytes()).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn email_with_pdf(message_id: &str, reference: &str) -> (String, String) {
        let pdf = crate::attachments::test_pdf_bytes();
        let attachment_sha256 = format!("{:x}", Sha256::digest(&pdf));
        let payload = STANDARD.encode(pdf);
        (
            format!(
                "From: Papeterie SA <factures@papeterie.example>\r\nSubject: Facture {reference}\r\nMessage-ID: <{message_id}>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nDate de facture: 02.09.2026\r\nDate d'échéance: 02.10.2026\r\nTotal TTC CHF 108.10\r\n--x\r\nContent-Type: application/pdf; name=facture.pdf\r\nContent-Disposition: attachment; filename=facture.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n{payload}\r\n--x--\r\n"
            ),
            attachment_sha256,
        )
    }

    fn invoice_input(id: &str, reference: &str) -> SaveSupplierInvoiceDraftInput {
        SaveSupplierInvoiceDraftInput {
            id: Some(id.into()),
            supplier_id: "supplier-1".into(),
            project_id: None,
            date: "2026-09-02".into(),
            due_date: "2026-10-02".into(),
            reference: Some(reference.into()),
            note: Some("Import e-mail contrôlé".into()),
            items: vec![SupplierInvoiceLineInput {
                id: Some("bb906107-990c-4c64-bca0-e287b62797fd".into()),
                description: "Facture fournisseur".into(),
                quantity_milli: 1_000,
                unit: Some("forfait".into()),
                unit_price_cents: 10_810,
                discount_bp: 0,
                vat_bp: 0,
                category: "Fournitures".into(),
                expense_account_id: None,
                project_id: None,
            }],
        }
    }

    #[test]
    fn parses_a_realistic_eml_without_network_or_ai() {
        let (temporary, store) = initialized_store();
        let pdf_bytes = crate::attachments::test_pdf_bytes();
        let pdf_payload = STANDARD.encode(&pdf_bytes);
        let message = format!(
            "From: =?UTF-8?Q?Papeterie_L=C3=A9man_SA?= <factures@papeterie.example>\r\nSubject: =?UTF-8?Q?Votre_facture_INV-2026-0042?=\r\nMessage-ID: <mail-42@example>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nDate de facture: 02.09.2026\r\nDate d'=C3=A9ch=C3=A9ance: 02.10.2026\r\nTotal net CHF 100.00\r\nMontant TVA CHF 8.10\r\nTotal TTC CHF 108.10\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"=?UTF-8?Q?facture-=C3=A9nergie-42.pdf?=\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{pdf_payload}\r\n--x--\r\n"
        );
        let path = write_email(temporary.path(), &message);
        let result = store.inspect_supplier_email_file(&path).unwrap();
        assert_eq!(result["invoice_signal"], true);
        assert_eq!(result["matched_supplier_id"], "supplier-1");
        assert_eq!(result["sender_name"], "Papeterie Léman SA");
        assert_eq!(result["subject"], "Votre facture INV-2026-0042");
        assert_eq!(result["reference"], "INV-2026-0042");
        assert_eq!(result["document_date"], "2026-09-02");
        assert_eq!(result["due_date"], "2026-10-02");
        assert_eq!(result["total_cents"], 10_810);
        assert_eq!(result["vat_cents"], 810);
        assert_eq!(
            result["attachment_names"],
            json!(["facture-énergie-42.pdf"])
        );
        assert_eq!(
            result["importable_attachments"][0]["name"],
            "facture-énergie-42.pdf"
        );
        assert_eq!(
            result["importable_attachments"][0]["mime_type"],
            "application/pdf"
        );
        assert_eq!(
            result["importable_attachments"][0]["size_bytes"],
            pdf_bytes.len()
        );
        assert_eq!(result["network_access"], false);
        assert_eq!(result["ai_used"], false);

        let source_sha256 = result["sha256"].as_str().unwrap().to_owned();
        let attachment_sha256 = result["importable_attachments"][0]["sha256"]
            .as_str()
            .unwrap()
            .to_owned();

        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some("1b46eb74-f04b-48f7-a490-f62f73294fb2".into()),
                supplier_id: "supplier-1".into(),
                project_id: None,
                date: "2026-09-02".into(),
                due_date: "2026-10-02".into(),
                reference: Some("INV/2026/0042".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some("2b4f75c6-41ee-41cf-af8c-953394482f7a".into()),
                    description: "Papeterie".into(),
                    quantity_milli: 1_000,
                    unit: Some("forfait".into()),
                    unit_price_cents: 10_810,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériel".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap();
        let attachment = store
            .add_supplier_email_attachment(AddSupplierEmailAttachmentInput {
                supplier_invoice_id: "1b46eb74-f04b-48f7-a490-f62f73294fb2".into(),
                source_path: path.clone(),
                source_sha256: source_sha256.clone(),
                attachment_sha256: attachment_sha256.clone(),
            })
            .unwrap();
        assert_eq!(attachment["original_name"], "facture-énergie-42.pdf");
        assert_eq!(attachment["sha256"], attachment_sha256);
        let stored = store
            .verified_attachment_path(attachment["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(fs::read(stored).unwrap(), pdf_bytes);

        let repeated = store
            .add_supplier_email_attachment(AddSupplierEmailAttachmentInput {
                supplier_invoice_id: "1b46eb74-f04b-48f7-a490-f62f73294fb2".into(),
                source_path: path.clone(),
                source_sha256,
                attachment_sha256: attachment_sha256.clone(),
            })
            .unwrap();
        assert_eq!(repeated["id"], attachment["id"]);
        let attachment_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_id=?",
                params!["1b46eb74-f04b-48f7-a490-f62f73294fb2"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            attachment_count, 1,
            "une reprise ne doit pas dupliquer la pièce"
        );
        let duplicate = store.inspect_supplier_email_file(&path).unwrap();
        assert_eq!(
            duplicate["duplicate_invoice_id"],
            "1b46eb74-f04b-48f7-a490-f62f73294fb2"
        );
        let invoice_count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM supplier_invoices", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            invoice_count, 1,
            "l'inspection ne doit créer aucun brouillon"
        );
    }

    #[test]
    fn atomic_import_records_provenance_and_exact_retry_is_idempotent() {
        let (temporary, store) = initialized_store();
        let (message, attachment_sha256) =
            email_with_pdf("atomic-42@example.test", "INV-ATOMIC-42");
        let source_path = write_email(temporary.path(), &message);
        let inspection = store.inspect_supplier_email_file(&source_path).unwrap();
        let invoice_id = "cf45d803-1bef-4ca4-bfe1-30b49535d630";
        let input = ImportSupplierEmailInvoiceDraftInput {
            invoice: invoice_input(invoice_id, "INV-ATOMIC-42"),
            source_path,
            source_sha256: inspection["sha256"].as_str().unwrap().into(),
            attachment_sha256: Some(attachment_sha256),
        };

        let first = store
            .import_supplier_email_invoice_draft(input.clone())
            .unwrap();
        assert_eq!(first["idempotent"], false);
        assert_eq!(first["document"]["invoice"]["id"], invoice_id);
        assert!(first["attachment"]["id"].is_string());
        let attachment_id = first["attachment"]["id"].as_str().unwrap().to_owned();

        let retried = store.import_supplier_email_invoice_draft(input).unwrap();
        assert_eq!(retried["idempotent"], true);
        assert_eq!(retried["document"]["invoice"]["id"], invoice_id);

        let connection = store.connect().unwrap();
        let counts: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM supplier_invoices WHERE id=?1),
                   (SELECT COUNT(*) FROM supplier_invoice_items WHERE supplier_invoice_id=?1),
                   (SELECT COUNT(*) FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=?1),
                   (SELECT COUNT(*) FROM supplier_email_invoice_imports WHERE supplier_invoice_id=?1)",
                params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1, 1, 1));
        drop(connection);

        let protected_error = store
            .delete_supplier_invoice_attachment(&attachment_id)
            .unwrap_err();
        assert!(protected_error.to_string().contains("prouve l'import"));
        store.delete_supplier_invoice_draft(invoice_id).unwrap();
        let connection = store.connect().unwrap();
        let remaining: i64 = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM supplier_invoices WHERE id=?1) +
                   (SELECT COUNT(*) FROM attachments WHERE entity_id=?1) +
                   (SELECT COUNT(*) FROM supplier_email_invoice_imports WHERE supplier_invoice_id=?1)",
                params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(fs::read_dir(&store.attachments_dir).unwrap().count(), 0);
    }

    #[test]
    fn atomic_import_refuses_reusing_a_source_for_changed_invoice_data() {
        let (temporary, store) = initialized_store();
        let (message, attachment_sha256) =
            email_with_pdf("immutable-source@example.test", "INV-SOURCE-1");
        let source_path = write_email(temporary.path(), &message);
        let inspection = store.inspect_supplier_email_file(&source_path).unwrap();
        let invoice_id = "cd163953-67fc-4781-b447-65811b753e0d";
        let base = ImportSupplierEmailInvoiceDraftInput {
            invoice: invoice_input(invoice_id, "INV-SOURCE-1"),
            source_path,
            source_sha256: inspection["sha256"].as_str().unwrap().into(),
            attachment_sha256: Some(attachment_sha256),
        };
        store
            .import_supplier_email_invoice_draft(base.clone())
            .unwrap();

        let mut changed = base.clone();
        changed.invoice.reference = Some("INV-MODIFIED".into());
        let error = store
            .import_supplier_email_invoice_draft(changed)
            .unwrap_err();
        assert!(error.to_string().contains("déjà été importé"));

        let mut different_id = base;
        different_id.invoice.id = Some("2eddb7de-4818-4a5f-b0ff-4fda97862e19".into());
        different_id.invoice.items[0].id = Some("83ff504a-6a91-4a89-b1fd-b436012c6634".into());
        assert!(store
            .import_supplier_email_invoice_draft(different_id)
            .unwrap_err()
            .to_string()
            .contains("déjà été importé"));

        let connection = store.connect().unwrap();
        let reference: String = connection
            .query_row(
                "SELECT reference FROM supplier_invoices WHERE id=?",
                params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reference, "INV-SOURCE-1");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM supplier_invoices", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn malformed_email_pdf_never_creates_a_draft_or_a_file() {
        let (temporary, store) = initialized_store();
        let malformed = b"%PDF-1.7\ntruncated";
        let payload = STANDARD.encode(malformed);
        let attachment_sha256 = format!("{:x}", Sha256::digest(malformed));
        let message = format!(
            "From: Papeterie SA <factures@papeterie.example>\r\nSubject: Facture INV-BROKEN\r\nMessage-ID: <broken@example.test>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nTotal TTC CHF 10.00\r\n--x\r\nContent-Type: application/pdf; name=facture.pdf\r\nContent-Disposition: attachment; filename=facture.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n{payload}\r\n--x--\r\n"
        );
        let source_path = write_email(temporary.path(), &message);
        let source_sha256 = format!("{:x}", Sha256::digest(message.as_bytes()));

        let error = store
            .import_supplier_email_invoice_draft(ImportSupplierEmailInvoiceDraftInput {
                invoice: invoice_input("d14180b8-a7c1-46b1-93ac-71ed80dde992", "INV-BROKEN"),
                source_path,
                source_sha256,
                attachment_sha256: Some(attachment_sha256),
            })
            .unwrap_err();
        assert!(error.to_string().contains("n'existe plus"));

        let connection = store.connect().unwrap();
        let rows: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM supplier_invoices),
                   (SELECT COUNT(*) FROM attachments),
                   (SELECT COUNT(*) FROM supplier_email_invoice_imports)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(rows, (0, 0, 0));
        assert_eq!(
            fs::read_dir(&store.attachments_dir).unwrap().count(),
            0,
            "aucun fichier temporaire ou final ne doit rester"
        );
    }

    #[test]
    fn atomic_import_without_evidence_is_refused_without_creating_a_draft() {
        let (temporary, store) = initialized_store();
        let (message, _) = email_with_pdf("without-evidence@example.test", "INV-NO-PROOF");
        let source_path = write_email(temporary.path(), &message);
        let inspection = store.inspect_supplier_email_file(&source_path).unwrap();
        let invoice_id = "364d8c19-e862-4b1d-a03a-515963c777cd";
        let error = store
            .import_supplier_email_invoice_draft(ImportSupplierEmailInvoiceDraftInput {
                invoice: invoice_input(invoice_id, "INV-NO-PROOF"),
                source_path,
                source_sha256: inspection["sha256"].as_str().unwrap().into(),
                attachment_sha256: None,
            })
            .unwrap_err();
        assert!(error.to_string().contains("Sélectionnez le justificatif"));
        let connection = store.connect().unwrap();
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM supplier_invoices),
                   (SELECT COUNT(*) FROM attachments),
                   (SELECT COUNT(*) FROM supplier_email_invoice_imports)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0));
    }

    #[test]
    fn decodes_base64_html_and_rfc2231_attachment_names() {
        let (temporary, store) = initialized_store();
        let subject = STANDARD.encode("Facture INV-2026-0099".as_bytes());
        let html = "<html><body>\n<p>Date de facture: <strong>03.09.2026</strong></p>\n<p>Date d'échéance: <strong>03.10.2026</strong></p>\n<p>Total net CHF 200.00</p>\n<p>Montant TVA CHF 16.20</p>\n<p>Total TTC CHF 216.20</p>\n</body></html>";
        let body = STANDARD.encode(html.as_bytes());
        let pdf_payload = STANDARD.encode(crate::attachments::test_pdf_bytes());
        let message = format!(
            "From: =?UTF-8?B?UGFwZXRlcmllIMOJbmVyZ2llIFNB?= <factures@papeterie.example>\r\nSubject: =?UTF-8?B?{subject}?=\r\nMessage-ID: <mail-99@example>\r\nContent-Type: multipart/mixed; boundary=invoice-boundary\r\n\r\n--invoice-boundary\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}\r\n--invoice-boundary\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''Facture%20%C3%A9nergie%200099.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n{pdf_payload}\r\n--invoice-boundary--\r\n"
        );
        let path = write_email(temporary.path(), &message);

        let result = store.inspect_supplier_email_file(&path).unwrap();
        assert_eq!(result["invoice_signal"], true);
        assert_eq!(result["matched_supplier_id"], "supplier-1");
        assert_eq!(result["sender_name"], "Papeterie Énergie SA");
        assert_eq!(result["subject"], "Facture INV-2026-0099");
        assert_eq!(result["reference"], "INV-2026-0099");
        assert_eq!(result["document_date"], "2026-09-03");
        assert_eq!(result["due_date"], "2026-10-03");
        assert_eq!(result["net_cents"], 20_000);
        assert_eq!(result["vat_cents"], 1_620);
        assert_eq!(result["total_cents"], 21_620);
        assert_eq!(
            result["attachment_names"],
            json!(["Facture énergie 0099.pdf"])
        );
        assert_eq!(result["network_access"], false);
        assert_eq!(result["ai_used"], false);
        let invoice_count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM supplier_invoices", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            invoice_count, 0,
            "l'analyse MIME doit rester en lecture seule"
        );
    }

    #[test]
    fn does_not_take_the_next_body_line_as_an_invoice_reference() {
        let (temporary, store) = initialized_store();
        let path = write_email(
            temporary.path(),
            "From: Papeterie SA <factures@papeterie.example>\r\nSubject: Votre facture\r\nMessage-ID: <mail-without-reference@example>\r\n\r\nBonjour,\r\nVeuillez trouver votre document en pièce jointe.\r\n",
        );

        let result = store.inspect_supplier_email_file(&path).unwrap();

        assert!(result["reference"].is_null());
        assert_eq!(result["confidence"], "low");
        assert!(result["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue == "Complétez la référence de la facture."));
    }

    #[test]
    fn extracts_each_labeled_date_from_minified_html() {
        let (temporary, store) = initialized_store();
        let html = "<html><body><p>Date de facture: 02.09.2026</p><p>Date d'échéance: 02.10.2026</p><p>Total TTC CHF 108.10</p></body></html>";
        let body = STANDARD.encode(html.as_bytes());
        let message = format!(
            "From: Papeterie SA <factures@papeterie.example>\r\nSubject: Facture INV-2026-0100\r\nMessage-ID: <mail-minified@example>\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}\r\n"
        );
        let path = write_email(temporary.path(), &message);

        let result = store.inspect_supplier_email_file(&path).unwrap();

        assert_eq!(result["document_date"], "2026-09-02");
        assert_eq!(result["due_date"], "2026-10-02");
    }

    #[test]
    fn labeled_extractors_handle_unicode_case_expansion_without_panicking() {
        let prefix = "KKKKKKKKK";
        let date_text = format!("{prefix} DATE DE FACTURE: 02.09.2026");
        let amount_text = format!("{prefix} TOTAL TTC CHF 108.10");

        assert_eq!(
            extract_labeled_date(&date_text, &["date de facture"]),
            Some("2026-09-02".to_owned())
        );
        assert_eq!(
            extract_labeled_amount(&amount_text, &["total ttc"]),
            Some(10_810)
        );
    }

    #[test]
    fn does_not_guess_missing_accounting_fields() {
        let (temporary, store) = initialized_store();
        let path = write_email(
            temporary.path(),
            "From: inconnu@gmail.com\nSubject: Document disponible\n\nBonjour, veuillez consulter la pièce jointe.",
        );
        let result = store.inspect_supplier_email_file(&path).unwrap();
        assert_eq!(result["invoice_signal"], false);
        assert!(result["reference"].is_null());
        assert!(result["document_date"].is_null());
        assert!(result["total_cents"].is_null());
        assert!(result["matched_supplier_id"].is_null());
        assert_eq!(result["currency"], "");
        assert_eq!(result["confidence"], "low");
    }

    #[test]
    fn rejects_binary_oversized_or_unsupported_sources() {
        let (temporary, store) = initialized_store();
        let binary = temporary.path().join("mail.eml");
        fs::write(&binary, [0, 1, 2]).unwrap();
        assert!(store
            .inspect_supplier_email_file(&binary.to_string_lossy())
            .is_err());
        let pdf = temporary.path().join("mail.pdf");
        fs::write(&pdf, b"invoice").unwrap();
        assert!(store
            .inspect_supplier_email_file(&pdf.to_string_lossy())
            .is_err());
    }

    #[test]
    fn announces_but_never_imports_an_executable_disguised_as_pdf() {
        let (temporary, store) = initialized_store();
        let payload = STANDARD.encode(b"MZ\x90\0fake executable");
        let message = format!(
            "From: Papeterie SA <factures@papeterie.example>\r\nSubject: Facture INV-2026-0999\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nTotal TTC CHF 10.00\r\n--x\r\nContent-Type: application/pdf; name=invoice.pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n{payload}\r\n--x--\r\n"
        );
        let path = write_email(temporary.path(), &message);
        let result = store.inspect_supplier_email_file(&path).unwrap();
        assert_eq!(result["attachment_names"], json!(["invoice.pdf"]));
        assert_eq!(result["importable_attachments"], json!([]));
    }

    #[test]
    fn never_rewrites_a_raw_binary_attachment_through_text_decoding() {
        let (temporary, store) = initialized_store();
        let path = temporary.path().join("raw-binary.eml");
        let mut message = b"From: fournisseur@example.com\r\nSubject: Facture brute\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/pdf; name=invoice.pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\nContent-Transfer-Encoding: 8bit\r\n\r\n%PDF-1.7\r\n"
            .to_vec();
        message.extend_from_slice(&[0xff, 0xfe, b'X']);
        message.extend_from_slice(b"\r\n--x--\r\n");
        fs::write(&path, message).unwrap();

        let result = store
            .inspect_supplier_email_file(&path.to_string_lossy())
            .unwrap();
        assert_eq!(result["attachment_names"], json!(["invoice.pdf"]));
        assert_eq!(
            result["importable_attachments"],
            json!([]),
            "une pièce binaire brute doit être ajoutée manuellement plutôt qu'altérée"
        );
    }

    #[test]
    fn refuses_an_attachment_when_the_reviewed_email_changed() {
        let (temporary, store) = initialized_store();
        let pdf_payload = STANDARD.encode(crate::attachments::test_pdf_bytes());
        let message = format!(
            "From: Papeterie SA <factures@papeterie.example>\r\nSubject: Facture INV-2026-0101\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/pdf; name=invoice.pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n{pdf_payload}\r\n--x--\r\n"
        );
        let path = write_email(temporary.path(), &message);
        let inspection = store.inspect_supplier_email_file(&path).unwrap();
        fs::write(&path, b"From: changed@example.com\n\nchanged").unwrap();

        let error = store
            .add_supplier_email_attachment(AddSupplierEmailAttachmentInput {
                supplier_invoice_id: "1b46eb74-f04b-48f7-a490-f62f73294fb2".into(),
                source_path: path,
                source_sha256: inspection["sha256"].as_str().unwrap().into(),
                attachment_sha256: inspection["importable_attachments"][0]["sha256"]
                    .as_str()
                    .unwrap()
                    .into(),
            })
            .unwrap_err();
        assert!(error.to_string().contains("a changé"));
    }
}

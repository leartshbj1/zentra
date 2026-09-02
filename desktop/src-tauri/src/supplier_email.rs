use std::{fs, path::Path, sync::OnceLock};

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use chrono::NaiveDate;
use encoding_rs::Encoding;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
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
        if bytes.iter().any(|byte| *byte == 0) {
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
    let mut output = String::new();
    collect_mime_text(raw, 0, &mut output);
    output
}

fn collect_mime_text(entity: &str, depth: usize, output: &mut String) {
    if depth > 12 || output.len() >= MAX_VISIBLE_TEXT_BYTES {
        return;
    }
    let normalized = entity.replace("\r\n", "\n");
    let (raw_headers, body) = normalized.split_once("\n\n").unwrap_or(("", &normalized));
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

    #[test]
    fn parses_a_realistic_eml_without_network_or_ai() {
        let (temporary, store) = initialized_store();
        let path = write_email(
            temporary.path(),
            "From: =?UTF-8?Q?Papeterie_L=C3=A9man_SA?= <factures@papeterie.example>\r\nSubject: =?UTF-8?Q?Votre_facture_INV-2026-0042?=\r\nMessage-ID: <mail-42@example>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nDate de facture: 02.09.2026\r\nDate d'=C3=A9ch=C3=A9ance: 02.10.2026\r\nTotal net CHF 100.00\r\nMontant TVA CHF 8.10\r\nTotal TTC CHF 108.10\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"=?UTF-8?Q?facture-=C3=A9nergie-42.pdf?=\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjc=\r\n--x--\r\n",
        );
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
        assert_eq!(result["network_access"], false);
        assert_eq!(result["ai_used"], false);

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
    fn decodes_base64_html_and_rfc2231_attachment_names() {
        let (temporary, store) = initialized_store();
        let subject = STANDARD.encode("Facture INV-2026-0099".as_bytes());
        let html = "<html><body>\n<p>Date de facture: <strong>03.09.2026</strong></p>\n<p>Date d'échéance: <strong>03.10.2026</strong></p>\n<p>Total net CHF 200.00</p>\n<p>Montant TVA CHF 16.20</p>\n<p>Total TTC CHF 216.20</p>\n</body></html>";
        let body = STANDARD.encode(html.as_bytes());
        let message = format!(
            "From: =?UTF-8?B?UGFwZXRlcmllIMOJbmVyZ2llIFNB?= <factures@papeterie.example>\r\nSubject: =?UTF-8?B?{subject}?=\r\nMessage-ID: <mail-99@example>\r\nContent-Type: multipart/mixed; boundary=invoice-boundary\r\n\r\n--invoice-boundary\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}\r\n--invoice-boundary\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''Facture%20%C3%A9nergie%200099.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjc=\r\n--invoice-boundary--\r\n"
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
}

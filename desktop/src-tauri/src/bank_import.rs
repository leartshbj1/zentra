use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::Path,
};

use chrono::NaiveDate;
use quick_xml::{events::Event, name::ResolveResult, NsReader};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, record_payment_in_transaction, LocalStore},
    error::{AppError, AppResult},
    models::{AssociateBankAccountInput, ConfirmBankReconciliationInput, RecordPaymentInput},
    swiss_qr::{validate_qrr, validate_scor},
};

const MAX_CAMT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CamtProfile {
    message_type: &'static str,
    namespace_version: &'static str,
}

#[derive(Debug, Default, Clone)]
struct AccountContext {
    iban: Option<String>,
    other_id: Option<String>,
    currency: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct TxDetails {
    account_servicer_ref: Option<String>,
    end_to_end_id: Option<String>,
    transaction_id: Option<String>,
    reference_type: Option<String>,
    reference: Option<String>,
    unstructured: Vec<String>,
    counterparty_name: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct EntryBuilder {
    amount: Option<String>,
    currency: Option<String>,
    credit_debit: Option<String>,
    status: Option<String>,
    reversal: Option<bool>,
    invalid_reversal: Option<String>,
    booking_date: Option<String>,
    value_date: Option<String>,
    c_level_ref: Option<String>,
    tx_details: Vec<TxDetails>,
}

#[derive(Debug, Clone)]
struct ParsedMovement {
    sequence: i64,
    account_id: String,
    account_currency: String,
    amount_cents: i64,
    currency: String,
    credit_debit: String,
    status: String,
    reversal: bool,
    booking_date: Option<String>,
    value_date: Option<String>,
    account_servicer_ref: Option<String>,
    reference_level: Option<String>,
    end_to_end_id: Option<String>,
    transaction_id: Option<String>,
    reference_type: String,
    reference: Option<String>,
    unstructured: Option<String>,
    counterparty_name: Option<String>,
    strong_key: Option<String>,
    c_level_ref: Option<String>,
    d_level_ref: Option<String>,
    details_json: String,
}

impl ParsedMovement {
    fn stable_keys(&self) -> Vec<(String, String, String)> {
        let mut keys = Vec::new();
        if let Some(reference) = self.d_level_ref.as_deref() {
            keys.push((
                strong_key(
                    &self.account_id,
                    "D",
                    reference,
                    &self.credit_debit,
                    self.reversal,
                ),
                "D".to_owned(),
                reference.to_owned(),
            ));
        }
        if let Some(reference) = self.c_level_ref.as_deref() {
            keys.push((
                strong_key(
                    &self.account_id,
                    "C",
                    reference,
                    &self.credit_debit,
                    self.reversal,
                ),
                "C".to_owned(),
                reference.to_owned(),
            ));
        }
        if movement_tx_count_from_json(&self.details_json) == 1 {
            if let Some(reference) = self.transaction_id.as_deref() {
                keys.push((
                    strong_key(
                        &self.account_id,
                        "T",
                        reference,
                        &self.credit_debit,
                        self.reversal,
                    ),
                    "T".to_owned(),
                    reference.to_owned(),
                ));
            }
        }
        keys
    }
}

fn movement_tx_count_from_json(details: &str) -> i64 {
    serde_json::from_str::<Value>(details)
        .ok()
        .and_then(|value| value["tx_detail_count"].as_i64())
        .unwrap_or(0)
}

#[derive(Debug)]
struct ParsedCamt {
    profile: CamtProfile,
    movements: Vec<ParsedMovement>,
    entry_count: i64,
    ignored_count: i64,
    warnings: Vec<String>,
}

fn normalize_token(value: &str, max: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("NOTPROVIDED") {
        return None;
    }
    Some(value.chars().take(max).collect())
}

fn normalize_account(value: &str) -> AppResult<String> {
    let normalized = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if normalized.len() < 2
        || normalized.len() > 70
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AppError::Validation(
            "L’identifiant du compte CAMT est vide ou invalide.".into(),
        ));
    }
    Ok(normalized)
}

fn normalize_currency(value: &str) -> AppResult<String> {
    let currency = value.trim().to_uppercase();
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(AppError::Validation(format!(
            "La devise CAMT « {value} » est invalide."
        )));
    }
    Ok(currency)
}

fn parse_amount_cents(value: &str) -> AppResult<i64> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.contains(',') {
        return Err(AppError::Validation(format!(
            "Le montant CAMT « {value} » est invalide."
        )));
    }
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let decimal = parts.next();
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::Validation(format!(
            "Le montant CAMT « {value} » est invalide."
        )));
    }
    let fraction = match decimal {
        None | Some("") => 0_i128,
        Some(part) if part.len() <= 2 && part.bytes().all(|byte| byte.is_ascii_digit()) => {
            let parsed = part.parse::<i128>().map_err(|_| {
                AppError::Validation(format!("Le montant CAMT « {value} » est invalide."))
            })?;
            if part.len() == 1 {
                parsed * 10
            } else {
                parsed
            }
        }
        _ => {
            return Err(AppError::Validation(format!(
                "Le montant CAMT « {value} » doit avoir au maximum deux décimales."
            )))
        }
    };
    let whole = whole.parse::<i128>().map_err(|_| {
        AppError::Validation(format!("Le montant CAMT « {value} » est trop grand."))
    })?;
    let cents = whole
        .checked_mul(100)
        .and_then(|amount| amount.checked_add(fraction))
        .filter(|amount| *amount > 0 && *amount <= i64::MAX as i128)
        .ok_or_else(|| {
            AppError::Validation(format!("Le montant CAMT « {value} » est hors limites."))
        })?;
    Ok(cents as i64)
}

fn normalize_date(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    let date = trimmed.get(..10).unwrap_or(trimmed);
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("La date CAMT « {trimmed} » est invalide.")))?;
    Ok(date.to_owned())
}

fn profile_from_namespace(namespace: &str) -> AppResult<CamtProfile> {
    match namespace {
        "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04" => Ok(CamtProfile {
            message_type: "camt.053",
            namespace_version: "001.04",
        }),
        "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08" => Ok(CamtProfile {
            message_type: "camt.053",
            namespace_version: "001.08",
        }),
        "urn:iso:std:iso:20022:tech:xsd:camt.054.001.04" => Ok(CamtProfile {
            message_type: "camt.054",
            namespace_version: "001.04",
        }),
        "urn:iso:std:iso:20022:tech:xsd:camt.054.001.08" => Ok(CamtProfile {
            message_type: "camt.054",
            namespace_version: "001.08",
        }),
        _ => Err(AppError::Validation(
            "Le namespace réel de Document doit être camt.053 ou camt.054, version .001.04 ou .001.08."
                .into(),
        )),
    }
}

fn path_ends(path: &[String], suffix: &[&str]) -> bool {
    path.len() >= suffix.len()
        && path[path.len() - suffix.len()..]
            .iter()
            .zip(suffix)
            .all(|(actual, expected)| actual == expected)
}

fn unique_value(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let values = values.into_iter().flatten().collect::<BTreeSet<_>>();
    (values.len() == 1).then(|| values.into_iter().next().unwrap())
}

fn normalize_reference(reference_type: &str, value: &str) -> String {
    match reference_type {
        "QRR" | "SCOR" => value
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
            .to_uppercase(),
        _ => value.trim().to_owned(),
    }
}

fn strong_key(
    account_id: &str,
    level: &str,
    reference: &str,
    credit_debit: &str,
    reversal: bool,
) -> String {
    let digest = Sha256::digest(
        format!(
            "{account_id}|{level}|{reference}|{credit_debit}|{}",
            if reversal { "REVERSAL" } else { "ORIGINAL" }
        )
        .as_bytes(),
    );
    format!("sha256:{digest:x}")
}

fn finalize_entry(
    entry: EntryBuilder,
    account: &AccountContext,
    sequence: i64,
) -> AppResult<ParsedMovement> {
    if let Some(value) = entry.invalid_reversal.as_deref() {
        return Err(AppError::Validation(format!(
            "RvslInd « {value} » doit valoir true, false, 1 ou 0."
        )));
    }
    let reversal = entry.reversal.unwrap_or(false);
    let account_id = account
        .iban
        .as_deref()
        .or(account.other_id.as_deref())
        .ok_or_else(|| AppError::Validation("Le relevé ne précise aucun compte.".into()))?;
    let account_id = normalize_account(account_id)?;
    let amount_cents = parse_amount_cents(
        entry
            .amount
            .as_deref()
            .ok_or_else(|| AppError::Validation("Une écriture CAMT n’a aucun montant.".into()))?,
    )?;
    let currency = normalize_currency(
        entry
            .currency
            .as_deref()
            .or(account.currency.as_deref())
            .ok_or_else(|| AppError::Validation("Une écriture CAMT n’a aucune devise.".into()))?,
    )?;
    let account_currency = normalize_currency(account.currency.as_deref().unwrap_or(&currency))?;
    let credit_debit = entry
        .credit_debit
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    if !matches!(credit_debit.as_str(), "CRDT" | "DBIT") {
        return Err(AppError::Validation(
            "Une écriture CAMT n’indique pas CRDT ou DBIT.".into(),
        ));
    }
    let status = entry
        .status
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    let d_level_ref = (entry.tx_details.len() == 1)
        .then(|| entry.tx_details[0].account_servicer_ref.clone())
        .flatten();
    let c_level_ref = entry
        .c_level_ref
        .as_deref()
        .and_then(|reference| normalize_token(reference, 200));
    let (account_servicer_ref, reference_level) = if let Some(reference) = d_level_ref.as_ref() {
        (Some(reference.clone()), Some("D".to_owned()))
    } else if let Some(reference) = c_level_ref.clone() {
        (Some(reference), Some("C".to_owned()))
    } else {
        (None, None)
    };
    let structured = entry
        .tx_details
        .iter()
        .filter_map(|details| {
            let reference_type = details.reference_type.as_deref()?.trim().to_uppercase();
            if !matches!(reference_type.as_str(), "QRR" | "SCOR") {
                return None;
            }
            let reference = normalize_reference(&reference_type, details.reference.as_deref()?);
            (!reference.is_empty()).then_some((reference_type, reference))
        })
        .collect::<BTreeSet<_>>();
    let (reference_type, reference) = match structured.len() {
        0 => ("NON".to_owned(), None),
        1 => {
            let (kind, reference) = structured.iter().next().unwrap();
            (kind.clone(), Some(reference.clone()))
        }
        _ => (
            "CONFLICT".to_owned(),
            Some(
                structured
                    .iter()
                    .map(|(kind, reference)| format!("{kind}:{reference}"))
                    .collect::<Vec<_>>()
                    .join(" | "),
            ),
        ),
    };
    let unstructured = entry
        .tx_details
        .iter()
        .flat_map(|details| details.unstructured.iter())
        .filter_map(|value| normalize_token(value, 500))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(" | ");
    let counterparty_name = unique_value(
        entry
            .tx_details
            .iter()
            .map(|details| details.counterparty_name.clone()),
    );
    let booking_date = entry
        .booking_date
        .as_deref()
        .map(normalize_date)
        .transpose()?;
    let value_date = entry
        .value_date
        .as_deref()
        .map(normalize_date)
        .transpose()?;
    let end_to_end_id = unique_value(
        entry
            .tx_details
            .iter()
            .map(|details| details.end_to_end_id.clone()),
    );
    let transaction_id = unique_value(
        entry
            .tx_details
            .iter()
            .map(|details| details.transaction_id.clone()),
    );
    let stable_key = account_servicer_ref
        .as_deref()
        .zip(reference_level.as_deref())
        .map(|(reference, level)| {
            strong_key(&account_id, level, reference, &credit_debit, reversal)
        })
        .or_else(|| {
            (entry.tx_details.len() == 1)
                .then(|| {
                    transaction_id.as_deref().map(|reference| {
                        strong_key(&account_id, "T", reference, &credit_debit, reversal)
                    })
                })
                .flatten()
        });
    let details_json = serde_json::to_string(&json!({
        "tx_detail_count": entry.tx_details.len(),
        "structured_references": structured.iter().map(|(kind, reference)| json!({"type":kind,"reference":reference})).collect::<Vec<_>>(),
    }))?;
    Ok(ParsedMovement {
        sequence,
        account_id,
        account_currency,
        amount_cents,
        currency,
        credit_debit,
        status,
        reversal,
        booking_date,
        value_date,
        account_servicer_ref,
        reference_level,
        end_to_end_id,
        transaction_id,
        reference_type,
        reference,
        unstructured: normalize_token(&unstructured, 2000),
        counterparty_name: counterparty_name.and_then(|value| normalize_token(&value, 200)),
        strong_key: stable_key,
        c_level_ref,
        d_level_ref,
        details_json,
    })
}

fn decoded_text(event: &quick_xml::events::BytesText<'_>) -> AppResult<String> {
    event
        .decode()
        .map(|value| value.into_owned())
        .map_err(|error| AppError::Validation(format!("Texte XML CAMT invalide : {error}.")))
}

fn assign_text(
    path: &[String],
    text: &str,
    account: &mut AccountContext,
    entry: &mut Option<EntryBuilder>,
    tx: &mut Option<TxDetails>,
) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if entry.is_none() {
        if path_ends(path, &["Acct", "Id", "IBAN"]) {
            account.iban = normalize_token(text, 70);
        } else if path_ends(path, &["Acct", "Id", "Othr", "Id"]) {
            account.other_id = normalize_token(text, 70);
        } else if path_ends(path, &["Acct", "Ccy"]) {
            account.currency = normalize_token(text, 3);
        }
        return;
    }
    if let Some(details) = tx.as_mut() {
        if path_ends(path, &["TxDtls", "Refs", "AcctSvcrRef"]) {
            details.account_servicer_ref = normalize_token(text, 200);
        } else if path_ends(path, &["TxDtls", "Refs", "EndToEndId"]) {
            details.end_to_end_id = normalize_token(text, 200);
        } else if path_ends(path, &["TxDtls", "Refs", "TxId"]) {
            details.transaction_id = normalize_token(text, 200);
        } else if (path_ends(path, &["CdtrRefInf", "Tp", "CdOrPrtry", "Cd"])
            || path_ends(path, &["CdtrRefInf", "Tp", "CdOrPrtry", "Prtry"]))
            && path.iter().any(|part| part == "TxDtls")
        {
            details.reference_type = normalize_token(&text.to_uppercase(), 16);
        } else if path_ends(path, &["CdtrRefInf", "Ref"])
            && path.iter().any(|part| part == "TxDtls")
        {
            details.reference = normalize_token(text, 200);
        } else if path_ends(path, &["RmtInf", "Ustrd"]) && path.iter().any(|part| part == "TxDtls")
        {
            if let Some(value) = normalize_token(text, 500) {
                details.unstructured.push(value);
            }
        } else if path_ends(path, &["RltdPties", "Dbtr", "Nm"])
            || path_ends(path, &["RltdPties", "UltmtDbtr", "Nm"])
        {
            details.counterparty_name = normalize_token(text, 200);
        }
        return;
    }
    let entry = entry.as_mut().unwrap();
    if path_ends(path, &["Ntry", "CdtDbtInd"]) {
        entry.credit_debit = normalize_token(text, 8);
    } else if path_ends(path, &["Ntry", "Sts"]) || path_ends(path, &["Ntry", "Sts", "Cd"]) {
        entry.status = normalize_token(text, 8);
    } else if path_ends(path, &["Ntry", "RvslInd"]) {
        match text.to_ascii_lowercase().as_str() {
            "true" | "1" => entry.reversal = Some(true),
            "false" | "0" => entry.reversal = Some(false),
            _ => entry.invalid_reversal = normalize_token(text, 40),
        }
    } else if path_ends(path, &["Ntry", "BookgDt", "Dt"])
        || path_ends(path, &["Ntry", "BookgDt", "DtTm"])
    {
        entry.booking_date = normalize_token(text, 40);
    } else if path_ends(path, &["Ntry", "ValDt", "Dt"])
        || path_ends(path, &["Ntry", "ValDt", "DtTm"])
    {
        entry.value_date = normalize_token(text, 40);
    } else if path_ends(path, &["Ntry", "AcctSvcrRef"]) {
        entry.c_level_ref = normalize_token(text, 200);
    } else if path_ends(path, &["Ntry", "Amt"]) {
        entry.amount = normalize_token(text, 80);
    }
}

fn parse_camt(xml: &[u8]) -> AppResult<ParsedCamt> {
    if xml.is_empty() {
        return Err(AppError::Validation("Le fichier CAMT est vide.".into()));
    }
    let upper_head = String::from_utf8_lossy(&xml[..xml.len().min(64 * 1024)]).to_ascii_uppercase();
    if upper_head.contains("<!DOCTYPE") || upper_head.contains("<!ENTITY") {
        return Err(AppError::Validation(
            "Le fichier XML contient une DTD ou une entité externe interdite (protection XXE)."
                .into(),
        ));
    }
    let mut reader = NsReader::from_reader(xml);
    // Le texte est normalisé seulement à la fermeture de chaque élément. Ne pas
    // rogner chaque fragment préserve les espaces autour de `&amp;`/`&lt;`.
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = true;
    let mut path = Vec::<String>::new();
    let mut text_stack = Vec::<String>::new();
    let mut account = AccountContext::default();
    let mut entry: Option<EntryBuilder> = None;
    let mut tx_details: Option<TxDetails> = None;
    let mut movements = Vec::new();
    let mut warnings = Vec::new();
    let mut entry_count = 0_i64;
    let mut ignored_count = 0_i64;
    let mut profile: Option<CamtProfile> = None;
    let mut root_namespace: Option<String> = None;
    let mut expected_container_seen = false;
    let mut root_seen = false;
    let mut root_closed = false;

    loop {
        let (resolved, event) = reader.read_resolved_event().map_err(|error| {
            AppError::Validation(format!("Le fichier XML CAMT est invalide : {error}."))
        })?;
        let resolved_namespace = match resolved {
            ResolveResult::Bound(namespace) => {
                Some(String::from_utf8_lossy(namespace.as_ref()).into_owned())
            }
            ResolveResult::Unbound => None,
            ResolveResult::Unknown(prefix) => {
                return Err(AppError::Validation(format!(
                    "Le préfixe XML « {} » n’est lié à aucun namespace.",
                    String::from_utf8_lossy(&prefix)
                )))
            }
        };
        match event {
            Event::Start(element) => {
                let name = String::from_utf8_lossy(element.local_name().as_ref()).into_owned();
                if root_closed {
                    return Err(AppError::Validation(
                        "Le fichier XML CAMT contient un second élément racine.".into(),
                    ));
                }
                if !root_seen {
                    root_seen = true;
                    if name != "Document" {
                        return Err(AppError::Validation(
                            "L’élément racine du fichier CAMT doit être Document.".into(),
                        ));
                    }
                    let namespace = resolved_namespace.as_deref().ok_or_else(|| {
                        AppError::Validation(
                            "Le vrai élément Document ne déclare aucun namespace ISO 20022.".into(),
                        )
                    })?;
                    profile = Some(profile_from_namespace(namespace)?);
                    root_namespace = Some(namespace.to_owned());
                } else if resolved_namespace.as_deref() != root_namespace.as_deref() {
                    return Err(AppError::Validation(format!(
                        "L’élément {name} n’appartient pas au namespace CAMT du document."
                    )));
                }
                if matches!(name.as_str(), "BkToCstmrStmt" | "BkToCstmrDbtCdtNtfctn") {
                    let expected = match profile.as_ref().map(|value| value.message_type) {
                        Some("camt.053") => "BkToCstmrStmt",
                        Some("camt.054") => "BkToCstmrDbtCdtNtfctn",
                        _ => "",
                    };
                    if name != expected {
                        return Err(AppError::Validation(format!(
                            "Le conteneur {name} ne correspond pas au namespace déclaré."
                        )));
                    }
                    expected_container_seen = true;
                }
                if matches!(name.as_str(), "Stmt" | "Ntfctn") {
                    account = AccountContext::default();
                } else if name == "Ntry" {
                    entry = Some(EntryBuilder::default());
                    entry_count += 1;
                } else if name == "TxDtls" && entry.is_some() {
                    tx_details = Some(TxDetails::default());
                } else if name == "Amt"
                    && entry.is_some()
                    && tx_details.is_none()
                    && path.last().is_some_and(|parent| parent == "Ntry")
                {
                    for attribute in element.attributes().with_checks(true) {
                        let attribute = attribute.map_err(|error| {
                            AppError::Validation(format!("Attribut XML CAMT invalide : {error}."))
                        })?;
                        if attribute.key.local_name().as_ref() == b"Ccy" {
                            let value = String::from_utf8_lossy(attribute.value.as_ref());
                            if let Some(entry) = entry.as_mut() {
                                entry.currency = normalize_token(&value, 3);
                            }
                        }
                    }
                }
                path.push(name);
                text_stack.push(String::new());
            }
            Event::Empty(element) => {
                let name = String::from_utf8_lossy(element.local_name().as_ref()).into_owned();
                if root_closed
                    || !root_seen
                    || resolved_namespace.as_deref() != root_namespace.as_deref()
                {
                    return Err(AppError::Validation(format!(
                        "L’élément vide {name} n’appartient pas au namespace CAMT du document."
                    )));
                }
                if name == "Ntry" {
                    entry_count += 1;
                    ignored_count += 1;
                    warnings.push(format!("Écriture {entry_count} ignorée : elle est vide."));
                }
            }
            Event::Text(text) => {
                let text = decoded_text(&text)?;
                if let Some(buffer) = text_stack.last_mut() {
                    buffer.push_str(&text);
                }
            }
            Event::CData(text) => {
                let text = text.decode().map_err(|error| {
                    AppError::Validation(format!("Texte XML CAMT invalide : {error}."))
                })?;
                if let Some(buffer) = text_stack.last_mut() {
                    buffer.push_str(&text);
                }
            }
            Event::GeneralRef(reference) => {
                let reference = reference.decode().map_err(|error| {
                    AppError::Validation(format!("Entité XML CAMT invalide : {error}."))
                })?;
                let value = match reference.as_ref() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => {
                        return Err(AppError::Validation(
                            "Seules les cinq entités XML prédéfinies sont autorisées dans un import CAMT."
                                .into(),
                        ))
                    }
                };
                if let Some(buffer) = text_stack.last_mut() {
                    buffer.push_str(value);
                }
            }
            Event::End(element) => {
                let name = String::from_utf8_lossy(element.local_name().as_ref()).into_owned();
                if resolved_namespace.as_deref() != root_namespace.as_deref() {
                    return Err(AppError::Validation(format!(
                        "La fermeture de {name} n’appartient pas au namespace CAMT du document."
                    )));
                }
                let text = text_stack.pop().ok_or_else(|| {
                    AppError::Validation("La pile de texte du fichier CAMT est incohérente.".into())
                })?;
                assign_text(&path, &text, &mut account, &mut entry, &mut tx_details);
                if name == "TxDtls" {
                    if let (Some(entry), Some(details)) = (entry.as_mut(), tx_details.take()) {
                        entry.tx_details.push(details);
                    }
                } else if name == "Ntry" {
                    let sequence = entry_count;
                    let candidate = entry.take().ok_or_else(|| {
                        AppError::Validation("Structure Ntry CAMT incohérente.".into())
                    });
                    match candidate.and_then(|value| finalize_entry(value, &account, sequence)) {
                        Ok(movement) => {
                            let supported_status = match profile
                                .as_ref()
                                .map(|value| value.message_type)
                                .unwrap_or_default()
                            {
                                "camt.053" => movement.status == "BOOK",
                                "camt.054" => matches!(movement.status.as_str(), "BOOK" | "PDNG"),
                                _ => false,
                            };
                            if supported_status {
                                movements.push(movement);
                            } else {
                                ignored_count += 1;
                                warnings.push(format!(
                                    "Écriture {sequence} ignorée : statut non pris en charge pour {}.",
                                    profile
                                        .as_ref()
                                        .map(|value| value.message_type)
                                        .unwrap_or("CAMT")
                                ));
                            }
                        }
                        Err(error) => {
                            ignored_count += 1;
                            warnings.push(format!("Écriture {sequence} ignorée : {error}"));
                        }
                    }
                }
                if path.pop().as_deref() != Some(name.as_str()) {
                    return Err(AppError::Validation(
                        "La structure du fichier XML CAMT est incohérente.".into(),
                    ));
                }
                if name == "Document" {
                    root_closed = true;
                }
            }
            Event::DocType(_) => {
                return Err(AppError::Validation(
                    "Les déclarations DOCTYPE sont interdites dans un import CAMT.".into(),
                ))
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root_closed
        || !path.is_empty()
        || !text_stack.is_empty()
        || entry.is_some()
        || tx_details.is_some()
    {
        return Err(AppError::Validation(
            "Le fichier XML CAMT est tronqué ou sa racine Document n’est pas correctement fermée."
                .into(),
        ));
    }
    if entry_count == 0 {
        return Err(AppError::Validation(
            "Le fichier CAMT ne contient aucune écriture Ntry.".into(),
        ));
    }
    if !expected_container_seen {
        return Err(AppError::Validation(
            "Le conteneur bancaire attendu par le namespace CAMT est absent.".into(),
        ));
    }
    Ok(ParsedCamt {
        profile: profile.ok_or_else(|| {
            AppError::Validation("Le document CAMT ne possède aucun élément racine.".into())
        })?,
        movements,
        entry_count,
        ignored_count,
        warnings,
    })
}

#[derive(Debug)]
struct ExistingMovement {
    id: String,
    status: String,
    account_id: String,
    account_currency: String,
    amount_cents: i64,
    currency: String,
    credit_debit: String,
    reversal: bool,
    booked_import_id: Option<String>,
    booked_message_type: Option<String>,
    reconciled: bool,
    end_to_end_id: Option<String>,
    transaction_id: Option<String>,
    reference_type: String,
    reference: Option<String>,
    unstructured: Option<String>,
    counterparty_name: Option<String>,
    details_json: String,
}

enum ImportOperation {
    Insert(ParsedMovement),
    Enrich {
        existing_id: String,
        movement: ParsedMovement,
        details_json: String,
    },
}

fn optional_enrichment_compatible(old: Option<&str>, new: Option<&str>) -> bool {
    let old = old.filter(|value| !value.trim().is_empty());
    let new = new.filter(|value| !value.trim().is_empty());
    old.is_none() || new.is_none() || old == new
}

fn lifecycle_allows_enrichment(
    existing: &ExistingMovement,
    movement: &ParsedMovement,
    incoming_message_type: &str,
) -> bool {
    match (existing.status.as_str(), movement.status.as_str()) {
        ("PDNG", "BOOK") => existing.booked_import_id.is_none(),
        ("BOOK", "BOOK") => {
            existing.booked_import_id.is_some()
                && existing.booked_message_type.as_deref() == Some("camt.054")
                && incoming_message_type == "camt.053"
        }
        _ => false,
    }
}

fn can_enrich(
    existing: &ExistingMovement,
    movement: &ParsedMovement,
    incoming_message_type: &str,
) -> bool {
    !existing.reconciled
        && lifecycle_allows_enrichment(existing, movement, incoming_message_type)
        && existing.account_id == movement.account_id
        && existing.account_currency == movement.account_currency
        && existing.amount_cents == movement.amount_cents
        && existing.currency == movement.currency
        && existing.credit_debit == movement.credit_debit
        && existing.reversal == movement.reversal
        && optional_enrichment_compatible(
            existing.end_to_end_id.as_deref(),
            movement.end_to_end_id.as_deref(),
        )
        && optional_enrichment_compatible(
            existing.transaction_id.as_deref(),
            movement.transaction_id.as_deref(),
        )
        && ((existing.reference_type == movement.reference_type
            && optional_enrichment_compatible(
                existing.reference.as_deref(),
                movement.reference.as_deref(),
            ))
            || (movement.reference_type == "NON" && movement.reference.is_none())
            || (existing.reference_type == "NON"
                && existing.reference.as_deref().is_none_or(str::is_empty)))
        && optional_enrichment_compatible(
            existing.unstructured.as_deref(),
            movement.unstructured.as_deref(),
        )
        && optional_enrichment_compatible(
            existing.counterparty_name.as_deref(),
            movement.counterparty_name.as_deref(),
        )
        && {
            let old_count = movement_tx_count_from_json(&existing.details_json);
            let new_count = movement_tx_count_from_json(&movement.details_json);
            old_count == 0 || new_count == 0 || old_count == new_count
        }
}

fn merged_details_json(existing: &str, incoming: &str) -> AppResult<String> {
    let old = serde_json::from_str::<Value>(existing).unwrap_or_else(|_| json!({}));
    let new = serde_json::from_str::<Value>(incoming).unwrap_or_else(|_| json!({}));
    let old_count = old["tx_detail_count"].as_i64().unwrap_or(0);
    let new_count = new["tx_detail_count"].as_i64().unwrap_or(0);
    let tx_detail_count = old_count.max(new_count);
    let mut references = BTreeSet::<(String, String)>::new();
    for details in [&old, &new] {
        for reference in details["structured_references"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let (Some(kind), Some(value)) = (
                reference.get("type").and_then(Value::as_str),
                reference.get("reference").and_then(Value::as_str),
            ) {
                references.insert((kind.to_owned(), value.to_owned()));
            }
        }
    }
    Ok(serde_json::to_string(&json!({
        "tx_detail_count": tx_detail_count,
        "structured_references": references
            .into_iter()
            .map(|(kind, reference)| json!({"type":kind,"reference":reference}))
            .collect::<Vec<_>>(),
    }))?)
}

fn import_row(connection: &rusqlite::Connection, id: &str) -> AppResult<Value> {
    query_all(
        connection,
        "SELECT * FROM bank_imports WHERE id=?",
        params![id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::NotFound(format!("bank_imports/{id}")))
}

impl LocalStore {
    pub fn import_camt_file(&self, path: &str) -> AppResult<Value> {
        let path = path.trim();
        if path.is_empty() {
            return Err(AppError::Validation(
                "Choisissez un fichier CAMT XML à importer.".into(),
            ));
        }
        let canonical = fs::canonicalize(Path::new(path)).map_err(|_| {
            AppError::Validation("Le fichier CAMT sélectionné est introuvable.".into())
        })?;
        let metadata = fs::metadata(&canonical)?;
        if !metadata.is_file() {
            return Err(AppError::Validation(
                "Le chemin sélectionné n’est pas un fichier.".into(),
            ));
        }
        if metadata.len() == 0 {
            return Err(AppError::Validation("Le fichier CAMT est vide.".into()));
        }
        if metadata.len() > MAX_CAMT_BYTES {
            return Err(AppError::Validation(format!(
                "Le fichier CAMT dépasse la limite locale de {} Mo.",
                MAX_CAMT_BYTES / 1024 / 1024
            )));
        }
        let xml = fs::read(&canonical)?;
        if xml.is_empty() {
            return Err(AppError::Validation("Le fichier CAMT est vide.".into()));
        }
        if xml.len() as u64 > MAX_CAMT_BYTES {
            return Err(AppError::Validation(format!(
                "Le fichier CAMT dépasse la limite locale de {} Mo.",
                MAX_CAMT_BYTES / 1024 / 1024
            )));
        }
        let file_sha256 = format!("{:x}", Sha256::digest(&xml));
        let parsed = parse_camt(&xml)?;
        let source_name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("releve-camt.xml")
            .chars()
            .take(255)
            .collect::<String>();

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing_id) = transaction
            .query_row(
                "SELECT id FROM bank_imports WHERE file_sha256=?",
                params![file_sha256],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            let existing = import_row(&transaction, &existing_id)?;
            transaction.commit()?;
            return Ok(json!({
                "duplicate": true,
                "import": existing,
                "imported_count": 0,
                "skipped_duplicate_count": existing["entry_count"].as_i64().unwrap_or(0),
                "ignored_count": existing["ignored_count"].as_i64().unwrap_or(0),
                "warnings": ["Ce fichier exact a déjà été importé. Aucun paiement n’a été créé."],
            }));
        }

        let mut operations = Vec::new();
        let mut seen_strong_keys = HashSet::new();
        let mut skipped_duplicate_count = 0_i64;
        let mut warnings = parsed.warnings.clone();
        for movement in &parsed.movements {
            let stable_keys = movement.stable_keys();
            if !stable_keys.is_empty() {
                if stable_keys
                    .iter()
                    .any(|(key, _, _)| seen_strong_keys.contains(key))
                {
                    skipped_duplicate_count += 1;
                    warnings.push(format!(
                        "Écriture {} ignorée : référence bancaire stable répétée dans le même fichier.",
                        movement.sequence
                    ));
                    continue;
                }
                seen_strong_keys.extend(stable_keys.iter().map(|(key, _, _)| key.clone()));
                let mut existing_by_id = HashMap::new();
                for (key, _, _) in &stable_keys {
                    let existing = transaction
                        .query_row(
                            "SELECT m.id,m.status,m.account_id,m.account_currency,m.amount_cents,m.currency,m.credit_debit,m.reversal,m.booked_import_id,bi.message_type,EXISTS(SELECT 1 FROM bank_reconciliations r WHERE r.movement_id=m.id),m.end_to_end_id,m.transaction_id,m.reference_type,m.reference,m.unstructured,m.counterparty_name,m.details_json FROM bank_movement_keys k JOIN bank_movements m ON m.id=k.movement_id LEFT JOIN bank_imports bi ON bi.id=m.booked_import_id WHERE k.strong_key=?",
                            params![key],
                            |row| {
                                Ok(ExistingMovement {
                                    id: row.get(0)?,
                                    status: row.get(1)?,
                                    account_id: row.get(2)?,
                                    account_currency: row.get(3)?,
                                    amount_cents: row.get(4)?,
                                    currency: row.get(5)?,
                                    credit_debit: row.get(6)?,
                                    reversal: row.get::<_, i64>(7)? != 0,
                                    booked_import_id: row.get(8)?,
                                    booked_message_type: row.get(9)?,
                                    reconciled: row.get::<_, i64>(10)? != 0,
                                    end_to_end_id: row.get(11)?,
                                    transaction_id: row.get(12)?,
                                    reference_type: row.get(13)?,
                                    reference: row.get(14)?,
                                    unstructured: row.get(15)?,
                                    counterparty_name: row.get(16)?,
                                    details_json: row.get(17)?,
                                })
                            },
                        )
                        .optional()?;
                    if let Some(existing) = existing {
                        existing_by_id.insert(existing.id.clone(), existing);
                    }
                }
                if existing_by_id.len() > 1 {
                    skipped_duplicate_count += 1;
                    warnings.push(format!(
                        "Écriture {} mise en revue : ses références C et D pointent vers des mouvements différents.",
                        movement.sequence
                    ));
                    continue;
                }
                if let Some(existing) = existing_by_id.into_values().next() {
                    if can_enrich(&existing, movement, parsed.profile.message_type) {
                        operations.push(ImportOperation::Enrich {
                            existing_id: existing.id,
                            movement: movement.clone(),
                            details_json: merged_details_json(
                                &existing.details_json,
                                &movement.details_json,
                            )?,
                        });
                    } else {
                        skipped_duplicate_count += 1;
                        warnings.push(format!(
                            "Écriture {} ignorée : {}.",
                            movement.sequence,
                            if existing.reconciled {
                                "le mouvement est déjà rapproché et son instantané comptable est figé"
                            } else if existing.status == "PDNG" && movement.status == "BOOK" {
                                "sa référence bancaire existe, mais les données BOOK contredisent l’observation PDNG"
                            } else {
                                "sa référence bancaire stable existe déjà"
                            }
                        ));
                    }
                    continue;
                }
            }
            operations.push(ImportOperation::Insert(movement.clone()));
        }

        let import_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let accounts = parsed
            .movements
            .iter()
            .map(|movement| movement.account_id.clone())
            .collect::<BTreeSet<_>>();
        let account_currencies = parsed
            .movements
            .iter()
            .map(|movement| movement.account_currency.clone())
            .collect::<BTreeSet<_>>();
        let account_id = (accounts.len() == 1).then(|| accounts.iter().next().unwrap().clone());
        let account_currency = (account_currencies.len() == 1)
            .then(|| account_currencies.iter().next().unwrap().clone());
        let imported_count = operations.len() as i64;
        let ignored_count = parsed.ignored_count.saturating_add(skipped_duplicate_count);
        transaction.execute(
            "INSERT INTO bank_imports(id,source_name,file_sha256,file_size,message_type,namespace_version,account_id,account_currency,entry_count,imported_count,ignored_count,warnings_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                import_id,
                source_name,
                file_sha256,
                xml.len() as i64,
                parsed.profile.message_type,
                parsed.profile.namespace_version,
                account_id,
                account_currency,
                parsed.entry_count,
                imported_count,
                ignored_count,
                serde_json::to_string(&warnings)?,
                now,
            ],
        )?;
        for operation in operations {
            match operation {
                ImportOperation::Insert(movement) => {
                    let booked_import_id = (movement.status == "BOOK").then(|| import_id.clone());
                    let movement_id = Uuid::new_v4().to_string();
                    transaction.execute(
                        "INSERT INTO bank_movements(id,import_id,booked_import_id,entry_sequence,account_id,account_currency,amount_cents,currency,credit_debit,status,reversal,booking_date,value_date,account_servicer_ref,reference_level,end_to_end_id,transaction_id,reference_type,reference,unstructured,counterparty_name,strong_key,details_json,created_at,enriched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        params![
                            movement_id,
                            import_id,
                            booked_import_id,
                            movement.sequence,
                            movement.account_id,
                            movement.account_currency,
                            movement.amount_cents,
                            movement.currency,
                            movement.credit_debit,
                            movement.status,
                            movement.reversal as i64,
                            movement.booking_date,
                            movement.value_date,
                            movement.account_servicer_ref,
                            movement.reference_level,
                            movement.end_to_end_id,
                            movement.transaction_id,
                            movement.reference_type,
                            movement.reference,
                            movement.unstructured,
                            movement.counterparty_name,
                            movement.strong_key,
                            movement.details_json,
                            now,
                            Option::<String>::None,
                        ],
                    )?;
                    for (key, level, reference) in movement.stable_keys() {
                        transaction.execute(
                            "INSERT INTO bank_movement_keys(strong_key,movement_id,account_id,reference_level,account_servicer_ref,created_at) VALUES(?,?,?,?,?,?)",
                            params![key,movement_id,movement.account_id,level,reference,now],
                        )?;
                    }
                }
                ImportOperation::Enrich {
                    existing_id,
                    movement,
                    details_json,
                } => {
                    transaction.execute(
                        "UPDATE bank_movements SET status='BOOK',booked_import_id=?,booking_date=COALESCE(?,booking_date),value_date=COALESCE(?,value_date),account_servicer_ref=CASE WHEN ?='D' THEN ? WHEN account_servicer_ref IS NULL OR TRIM(account_servicer_ref)='' THEN ? ELSE account_servicer_ref END,reference_level=CASE WHEN ?='D' THEN 'D' WHEN reference_level IS NULL THEN ? ELSE reference_level END,end_to_end_id=COALESCE(NULLIF(end_to_end_id,''),?),transaction_id=COALESCE(NULLIF(transaction_id,''),?),reference_type=CASE WHEN reference_type='NON' AND (reference IS NULL OR TRIM(reference)='') THEN ? ELSE reference_type END,reference=COALESCE(NULLIF(reference,''),?),unstructured=COALESCE(NULLIF(unstructured,''),?),counterparty_name=COALESCE(NULLIF(counterparty_name,''),?),details_json=?,enriched_at=? WHERE id=?",
                        params![
                            import_id,
                            movement.booking_date,
                            movement.value_date,
                            movement.reference_level,
                            movement.account_servicer_ref,
                            movement.account_servicer_ref,
                            movement.reference_level,
                            movement.reference_level,
                            movement.end_to_end_id,
                            movement.transaction_id,
                            movement.reference_type,
                            movement.reference,
                            movement.unstructured,
                            movement.counterparty_name,
                            details_json,
                            now,
                            existing_id,
                        ],
                    )?;
                    for (key, level, reference) in movement.stable_keys() {
                        transaction.execute(
                            "INSERT OR IGNORE INTO bank_movement_keys(strong_key,movement_id,account_id,reference_level,account_servicer_ref,created_at) VALUES(?,?,?,?,?,?)",
                            params![key,existing_id,movement.account_id,level,reference,now],
                        )?;
                    }
                }
            }
        }
        let imported = import_row(&transaction, &import_id)?;
        append_audit(
            &transaction,
            "import",
            "bank_import",
            &import_id,
            &json!({
                "source_name": source_name,
                "file_sha256": file_sha256,
                "message_type": parsed.profile.message_type,
                "namespace_version": parsed.profile.namespace_version,
                "entry_count": parsed.entry_count,
                "imported_count": imported_count,
                "ignored_count": ignored_count,
            }),
        )?;
        transaction.commit()?;
        Ok(json!({
            "duplicate": false,
            "import": imported,
            "imported_count": imported_count,
            "skipped_duplicate_count": skipped_duplicate_count,
            "ignored_count": ignored_count,
            "warnings": warnings,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;
    use crate::{
        models::{
            AccountInput, AccountingPeriodInput, AccountingSettingsInput, OnboardingInput,
            SaveInvoiceQrBillInput, SwissQrBillInput, SwissQrParty,
        },
        schema::SCHEMA_VERSION,
        swiss_qr::generate_qrr,
    };

    const STATEMENT_IBAN: &str = "CH9300762011623852957";

    fn onboarding() -> OnboardingInput {
        OnboardingInput {
            company_name: "Entreprise CAMT de test".into(),
            legal_form: Some("Sàrl".into()),
            owner_name: None,
            email: Some("test@example.invalid".into()),
            phone: None,
            address_line1: Some("Rue locale 1".into()),
            address_line2: None,
            postal_code: Some("1000".into()),
            city: Some("Lausanne".into()),
            canton: Some("VD".into()),
            country: Some("CH".into()),
            noga_section: "F".into(),
            noga_division: "43".into(),
            activity_description: "Travaux spécialisés".into(),
            noga_detailed_code: Some("432100".into()),
            uid_number: None,
            vat_number: None,
            vat_registered: false,
            default_vat_bp: Some(0),
            // QR-IBAN volontairement différent de l'IBAN du relevé.
            iban: Some("CH44 3199 9123 0008 8901 2".into()),
            bank_name: Some("Banque locale".into()),
            currency: "CHF".into(),
            quote_prefix: "D".into(),
            invoice_prefix: "F".into(),
            credit_note_prefix: Some("A".into()),
            quote_start_number: Some(1),
            invoice_start_number: Some(1),
            credit_note_start_number: Some(1),
            payment_terms_days: 30,
            quote_validity_days: 30,
            default_hourly_rate_cents: 0,
            logo_path: None,
            extra_settings_json: Some(json!({"payroll":{"enabled":false}})),
        }
    }

    fn store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(onboarding(), "test").unwrap();
        (temporary, store)
    }

    fn value_id(value: &Value) -> String {
        value["id"].as_str().unwrap().to_owned()
    }

    fn write_xml(directory: &Path, name: &str, xml: &str) -> String {
        let path = directory.join(name);
        fs::write(&path, xml.as_bytes()).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[allow(clippy::too_many_arguments)]
    fn fixture(
        message: &str,
        version: &str,
        status: &str,
        amount: &str,
        c_level_ref: &str,
        d_level_ref: Option<&str>,
        reference_type: Option<&str>,
        reference: Option<&str>,
        reversal: bool,
        include_date: bool,
    ) -> String {
        let (container, group) = if message == "053" {
            ("BkToCstmrStmt", "Stmt")
        } else {
            ("BkToCstmrDbtCdtNtfctn", "Ntfctn")
        };
        let status = if version == "08" {
            format!("<Sts><Cd>{status}</Cd></Sts>")
        } else {
            format!("<Sts>{status}</Sts>")
        };
        let date = if include_date {
            "<BookgDt><Dt>2026-08-31</Dt></BookgDt><ValDt><Dt>2026-08-30</Dt></ValDt>"
        } else {
            ""
        };
        let d_ref = d_level_ref
            .map(|value| format!("<AcctSvcrRef>{value}</AcctSvcrRef>"))
            .unwrap_or_default();
        let structured = reference_type
            .zip(reference)
            .map(|(kind, value)| format!("<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>{kind}</Prtry></CdOrPrtry></Tp><Ref>{value}</Ref></CdtrRefInf></Strd></RmtInf>"))
            .unwrap_or_else(|| "<RmtInf><Ustrd>Paiement sans référence</Ustrd></RmtInf>".into());
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.{message}.001.{version}">
 <{container}><GrpHdr><MsgId>MSG</MsgId></GrpHdr><{group}>
  <Acct><Id><IBAN>{STATEMENT_IBAN}</IBAN></Id><Ccy>CHF</Ccy></Acct>
  <Ntry><Amt Ccy="CHF">{amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd>{status}<RvslInd>{reversal}</RvslInd>{date}<AcctSvcrRef>{c_level_ref}</AcctSvcrRef>
   <NtryDtls><TxDtls><Refs>{d_ref}<EndToEndId>E2E-{c_level_ref}</EndToEndId><TxId>TX-{c_level_ref}</TxId></Refs>{structured}<RltdPties><Dbtr><Nm>Client test</Nm></Dbtr></RltdPties></TxDtls></NtryDtls>
  </Ntry>
 </{group}></{container}>
</Document>"#,
            reversal = if reversal { "true" } else { "false" }
        )
    }

    fn create_open_invoice(store: &LocalStore, amount_cents: i64, currency: &str) -> String {
        let client = store
            .create_record("clients", json!({"name":"Client test"}))
            .unwrap();
        let invoice = store
            .create_record(
                "invoices",
                json!({"client_id":value_id(&client),"title":"Facture CAMT","currency":currency,"service_date_from":"2026-08-01","service_date_to":"2026-08-31"}),
            )
            .unwrap();
        let invoice_id = value_id(&invoice);
        store
            .create_record(
                "invoice_items",
                json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":amount_cents,"vat_bp":0}),
            )
            .unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-08-01".into()),
                Some("2026-08-31".into()),
            )
            .unwrap();
        invoice_id
    }

    fn create_invoice(store: &LocalStore, amount_cents: i64, qrr: &str) -> String {
        let invoice_id = create_open_invoice(store, amount_cents, "CHF");
        store
            .save_invoice_qr_bill(SaveInvoiceQrBillInput {
                invoice_id: invoice_id.clone(),
                bill: SwissQrBillInput {
                    iban: "CH4431999123000889012".into(),
                    creditor: SwissQrParty {
                        name: "Entreprise CAMT de test".into(),
                        street: "Rue locale".into(),
                        building_number: "1".into(),
                        postal_code: "1000".into(),
                        city: "Lausanne".into(),
                        country: "CH".into(),
                    },
                    amount_cents: Some(amount_cents),
                    currency: "CHF".into(),
                    debtor: None,
                    reference_type: "QRR".into(),
                    reference: qrr.into(),
                    unstructured_message: String::new(),
                    bill_information: String::new(),
                    alternative_procedures: Vec::new(),
                },
            })
            .unwrap();
        invoice_id
    }

    fn enable_accounting(store: &LocalStore) {
        let specs = [
            (
                "ar",
                "1100",
                "Débiteurs",
                "asset",
                "debit",
                "current_assets",
            ),
            (
                "revenue",
                "3000",
                "Produits",
                "revenue",
                "credit",
                "net_revenue",
            ),
            (
                "vat_payable",
                "2200",
                "TVA due",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            ("bank", "1020", "Banque", "asset", "debit", "current_assets"),
            (
                "expense",
                "6000",
                "Charges",
                "expense",
                "debit",
                "other_operating_expense",
            ),
            (
                "vat_receivable",
                "1170",
                "TVA préalable",
                "asset",
                "debit",
                "current_assets",
            ),
            (
                "wages_expense",
                "5000",
                "Salaires",
                "expense",
                "debit",
                "personnel_expense",
            ),
            (
                "wages_payable",
                "2000",
                "Salaires dus",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            (
                "social_expense",
                "5700",
                "Charges sociales",
                "expense",
                "debit",
                "personnel_expense",
            ),
            (
                "social_payable",
                "2270",
                "Cotisations dues",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
        ];
        let mut accounts = HashMap::new();
        for (key, code, name, account_type, normal_balance, report_section) in specs {
            let account = store
                .upsert_account(AccountInput {
                    id: None,
                    code: code.into(),
                    name: name.into(),
                    account_type: account_type.into(),
                    normal_balance: normal_balance.into(),
                    report_section: report_section.into(),
                    active: true,
                })
                .unwrap();
            accounts.insert(key, value_id(&account));
        }
        store
            .configure_accounting(AccountingSettingsInput {
                enabled: true,
                ar_account_id: Some(accounts["ar"].clone()),
                revenue_account_id: Some(accounts["revenue"].clone()),
                vat_payable_account_id: Some(accounts["vat_payable"].clone()),
                bank_account_id: Some(accounts["bank"].clone()),
                expense_account_id: Some(accounts["expense"].clone()),
                vat_receivable_account_id: Some(accounts["vat_receivable"].clone()),
                wages_expense_account_id: Some(accounts["wages_expense"].clone()),
                wages_payable_account_id: Some(accounts["wages_payable"].clone()),
                social_expense_account_id: Some(accounts["social_expense"].clone()),
                social_payable_account_id: Some(accounts["social_payable"].clone()),
            })
            .unwrap();
    }

    #[test]
    fn accepts_all_four_supported_camt_profiles() {
        for (message, version, expected_type, expected_version) in [
            ("053", "04", "camt.053", "001.04"),
            ("053", "08", "camt.053", "001.08"),
            ("054", "04", "camt.054", "001.04"),
            ("054", "08", "camt.054", "001.08"),
        ] {
            let xml = fixture(
                message,
                version,
                "BOOK",
                "10.25",
                "C-PROFILE",
                Some("D-PROFILE"),
                None,
                None,
                false,
                true,
            );
            let parsed = parse_camt(xml.as_bytes()).unwrap();
            assert_eq!(parsed.profile.message_type, expected_type);
            assert_eq!(parsed.profile.namespace_version, expected_version);
            assert_eq!(parsed.movements.len(), 1);
            assert_eq!(parsed.movements[0].amount_cents, 1_025);
        }
    }

    #[test]
    fn rejects_a_fake_namespace_comment_doctype_and_malformed_xml() {
        let fake = r#"<!-- urn:iso:std:iso:20022:tech:xsd:camt.053.001.08 -->
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.03"><BkToCstmrStmt/></Document>"#;
        assert!(parse_camt(fake.as_bytes())
            .unwrap_err()
            .to_string()
            .contains("namespace réel"));
        let xxe = r#"<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///secret">]><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"/>"#;
        assert!(parse_camt(xxe.as_bytes())
            .unwrap_err()
            .to_string()
            .contains("XXE"));
        let malformed =
            r#"<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>"#;
        assert!(parse_camt(malformed.as_bytes()).is_err());

        let valid = fixture(
            "053",
            "08",
            "BOOK",
            "10.00",
            "C-NS",
            Some("D-NS"),
            None,
            None,
            false,
            true,
        );
        let evil_child = valid
            .replace("<Ntry>", "<evil:Ntry xmlns:evil=\"urn:evil\">")
            .replace("</Ntry>", "</evil:Ntry>");
        assert!(parse_camt(evil_child.as_bytes())
            .unwrap_err()
            .to_string()
            .contains("namespace CAMT"));
        let truncated = valid
            .split("</Ntry>")
            .next()
            .map(|prefix| format!("{prefix}</Ntry>"))
            .unwrap();
        assert!(parse_camt(truncated.as_bytes()).is_err());
        let second_root = format!("{valid}{valid}");
        assert!(parse_camt(second_root.as_bytes()).is_err());
    }

    #[test]
    fn accumulates_predefined_entities_without_opening_custom_entities() {
        let xml = fixture(
            "053",
            "08",
            "BOOK",
            "10.00",
            "C-ENTITY",
            Some("D-ENTITY"),
            None,
            None,
            false,
            true,
        )
        .replace("Client test", "A &amp; B &lt;Suisse&gt;");
        let parsed = parse_camt(xml.as_bytes()).unwrap();
        assert_eq!(
            parsed.movements[0].counterparty_name.as_deref(),
            Some("A & B <Suisse>")
        );
        let custom = xml.replace("A &amp; B", "A &custom; B");
        assert!(parse_camt(custom.as_bytes()).is_err());
    }

    #[test]
    fn collective_entry_uses_only_the_c_level_stable_reference() {
        let mut xml = fixture(
            "053",
            "08",
            "BOOK",
            "10.00",
            "C-BATCH",
            Some("D-ONE"),
            None,
            None,
            false,
            true,
        );
        xml = xml.replace(
            "</NtryDtls>",
            "<TxDtls><Refs><EndToEndId>E2E-TWO</EndToEndId></Refs><RmtInf><Ustrd>Deuxième détail</Ustrd></RmtInf></TxDtls></NtryDtls>",
        );
        let parsed = parse_camt(xml.as_bytes()).unwrap();
        let movement = &parsed.movements[0];
        assert_eq!(movement.reference_level.as_deref(), Some("C"));
        assert_eq!(movement.account_servicer_ref.as_deref(), Some("C-BATCH"));
        assert_eq!(
            movement.strong_key,
            Some(strong_key(STATEMENT_IBAN, "C", "C-BATCH", "CRDT", false))
        );
    }

    #[test]
    fn exact_file_and_strong_reference_duplicates_do_not_create_movements() {
        let (temporary, store) = store();
        let xml = fixture(
            "053",
            "04",
            "BOOK",
            "10.00",
            "C-DUP",
            Some("D-DUP"),
            None,
            None,
            false,
            true,
        );
        let first_path = write_xml(temporary.path(), "first.xml", &xml);
        let first = store.import_camt_file(&first_path).unwrap();
        assert_eq!(first["imported_count"], 1);
        let exact = store.import_camt_file(&first_path).unwrap();
        assert_eq!(exact["duplicate"], true);
        let second_path = write_xml(
            temporary.path(),
            "second.xml",
            &xml.replace("<MsgId>MSG</MsgId>", "<MsgId>OTHER</MsgId>"),
        );
        let strong = store.import_camt_file(&second_path).unwrap();
        assert_eq!(strong["skipped_duplicate_count"], 1);
        let connection = store.connect().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM bank_movements", [], |row| row.get(0))
            .unwrap();
        let booked_import: Option<String> = connection
            .query_row("SELECT booked_import_id FROM bank_movements", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert!(booked_import.is_some());
    }

    #[test]
    fn pending_054_is_enriched_by_booked_053_without_a_duplicate() {
        let (temporary, store) = store();
        let pending = fixture(
            "054", "08", "PDNG", "100.00", "C-LIFE", None, None, None, false, false,
        );
        let pending_path = write_xml(temporary.path(), "pending.xml", &pending);
        let pending_import = store.import_camt_file(&pending_path).unwrap();
        let booked = fixture(
            "053",
            "04",
            "BOOK",
            "100.00",
            "C-LIFE",
            Some("D-LIFE"),
            Some("QRR"),
            Some("210000000003139471430009017"),
            false,
            true,
        );
        let booked_path = write_xml(temporary.path(), "booked.xml", &booked);
        let booked_import = store.import_camt_file(&booked_path).unwrap();
        let connection = store.connect().unwrap();
        let row: (i64, String, String, Option<String>, Option<String>, String) = connection
            .query_row(
                "SELECT COUNT(*),status,import_id,booked_import_id,booking_date,reference_type FROM bank_movements",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )
            .unwrap();
        assert_eq!(row.0, 1);
        assert_eq!(row.1, "BOOK");
        assert_eq!(row.2, pending_import["import"]["id"]);
        assert_eq!(row.3.as_deref(), booked_import["import"]["id"].as_str());
        assert_eq!(row.4.as_deref(), Some("2026-08-31"));
        assert_eq!(row.5, "QRR");
    }

    #[test]
    fn lifecycle_enrichment_matches_transaction_aliases_preserves_older_fields_and_uses_book_dates()
    {
        let (temporary, store) = store();
        let pending = fixture(
            "054", "08", "PDNG", "100.00", "", None, None, None, false, true,
        )
        .replace("<EndToEndId>E2E-</EndToEndId>", "");
        store
            .import_camt_file(&write_xml(temporary.path(), "pending-tx.xml", &pending))
            .unwrap();

        let qrr = generate_qrr("321321").unwrap();
        let booked = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-TX-BOOK",
            Some("D-TX-BOOK"),
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        )
        .replace("<TxId>TX-C-TX-BOOK</TxId>", "<TxId>TX-</TxId>")
        .replace("<EndToEndId>E2E-C-TX-BOOK</EndToEndId>", "")
        .replace("2026-08-31", "2026-09-02")
        .replace("2026-08-30", "2026-09-01")
        .replace(
            "<RltdPties><Dbtr><Nm>Client test</Nm></Dbtr></RltdPties>",
            "",
        );
        let booked_import = store
            .import_camt_file(&write_xml(temporary.path(), "booked-tx.xml", &booked))
            .unwrap();
        assert_eq!(booked_import["imported_count"], 1);

        let connection = store.connect().unwrap();
        let lifecycle: (i64, String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT COUNT(*),status,booking_date,value_date FROM bank_movements",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let details: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT reference_level,account_servicer_ref,unstructured,counterparty_name FROM bank_movements",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(lifecycle.0, 1);
        assert_eq!(lifecycle.1, "BOOK");
        assert_eq!(lifecycle.2.as_deref(), Some("2026-09-02"));
        assert_eq!(lifecycle.3.as_deref(), Some("2026-09-01"));
        assert_eq!(details.0.as_deref(), Some("D"));
        assert_eq!(details.1.as_deref(), Some("D-TX-BOOK"));
        assert_eq!(details.2.as_deref(), Some("Paiement sans référence"));
        assert_eq!(details.3.as_deref(), Some("Client test"));
        for level in ["T", "C", "D"] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM bank_movement_keys WHERE reference_level=?)",
                    params![level],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing lifecycle alias {level}");
        }
    }

    #[test]
    fn booked_054_is_enriched_by_final_053_even_when_the_final_projection_omits_d_level() {
        let (temporary, store) = store();
        let provisional = fixture(
            "054",
            "08",
            "BOOK",
            "50.00",
            "C-BOOK-LIFE",
            Some("D-BOOK-LIFE"),
            None,
            None,
            false,
            false,
        );
        let provisional_import = store
            .import_camt_file(&write_xml(temporary.path(), "booked-054.xml", &provisional))
            .unwrap();
        let qrr = generate_qrr("454545").unwrap();
        let final_statement = fixture(
            "053",
            "08",
            "BOOK",
            "50.00",
            "C-BOOK-LIFE",
            None,
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        );
        let final_import = store
            .import_camt_file(&write_xml(
                temporary.path(),
                "booked-053.xml",
                &final_statement,
            ))
            .unwrap();

        let connection = store.connect().unwrap();
        let row: (
            i64,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
        ) = connection
            .query_row(
                "SELECT COUNT(*),import_id,booked_import_id,reference_level,account_servicer_ref,reference_type FROM bank_movements",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )
            .unwrap();
        assert_eq!(row.0, 1);
        assert_eq!(row.1, provisional_import["import"]["id"]);
        assert_eq!(row.2, final_import["import"]["id"]);
        assert_eq!(row.3.as_deref(), Some("D"));
        assert_eq!(row.4.as_deref(), Some("D-BOOK-LIFE"));
        assert_eq!(row.5, "QRR");
    }

    #[test]
    fn booked_054_waits_for_053_then_becomes_confirmable_and_is_frozen() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let qrr = generate_qrr("909090").unwrap();
        let invoice_id = create_invoice(&store, 10_000, &qrr);
        let notification = fixture(
            "054",
            "08",
            "BOOK",
            "100.00",
            "C-FROZEN",
            None,
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        );
        store
            .import_camt_file(&write_xml(
                temporary.path(),
                "notification-book.xml",
                &notification,
            ))
            .unwrap();
        let waiting = store.get_bank_workspace().unwrap();
        assert_eq!(waiting["movements"][0]["suggestion"]["kind"], "review");
        assert_eq!(waiting["movements"][0]["suggestion"]["confirmable"], false);
        assert!(waiting["movements"][0]["suggestion"]["reason"]
            .as_str()
            .unwrap()
            .contains("camt.053 définitif"));
        let movement_id = waiting["movements"][0]["id"].as_str().unwrap().to_owned();
        assert!(store
            .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                movement_id: movement_id.clone(),
                invoice_id: invoice_id.clone(),
            })
            .is_err());
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM payments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );

        let statement = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-FROZEN",
            Some("D-FROZEN"),
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        )
        .replace("2026-08-31", "2026-09-02")
        .replace("2026-08-30", "2026-09-01");
        let final_import = store
            .import_camt_file(&write_xml(
                temporary.path(),
                "final-statement.xml",
                &statement,
            ))
            .unwrap();
        assert_eq!(final_import["imported_count"], 1);
        let ready = store.get_bank_workspace().unwrap();
        assert_eq!(ready["movements"].as_array().unwrap().len(), 1);
        assert_eq!(ready["movements"][0]["id"], movement_id);
        assert_eq!(ready["movements"][0]["booking_date"], "2026-09-02");
        assert_eq!(ready["movements"][0]["reference_level"], "D");
        assert_eq!(
            ready["movements"][0]["suggestion"]["kind"],
            "automatic_exact"
        );
        assert_eq!(ready["movements"][0]["suggestion"]["confirmable"], true);
        store
            .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                movement_id: movement_id.clone(),
                invoice_id,
            })
            .unwrap();

        let late_statement = statement
            .replace("<MsgId>MSG</MsgId>", "<MsgId>LATE</MsgId>")
            .replace("2026-09-02", "2026-09-04")
            .replace("2026-09-01", "2026-09-03");
        let ignored = store
            .import_camt_file(&write_xml(
                temporary.path(),
                "late-statement.xml",
                &late_statement,
            ))
            .unwrap();
        assert_eq!(ignored["imported_count"], 0);
        assert_eq!(ignored["skipped_duplicate_count"], 1);
        assert!(ignored["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().is_some_and(|text| text.contains("figé"))));

        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE bank_movements SET booked_import_id=?,booking_date='2026-09-02',enriched_at='2026-09-02T12:00:00Z' WHERE id=?",
                params![ignored["import"]["id"].as_str().unwrap(), movement_id],
            )
            .is_err());
        let snapshot: (i64, String, Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT COUNT(*),booked_import_id,booking_date,reference_level,enriched_at FROM bank_movements WHERE id=?",
                params![movement_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(snapshot.0, 1);
        assert_eq!(snapshot.1, final_import["import"]["id"]);
        assert_eq!(snapshot.2.as_deref(), Some("2026-09-02"));
        assert_eq!(snapshot.3.as_deref(), Some("D"));
        assert!(snapshot.4.is_some());
        let payment_date: String = connection
            .query_row(
                "SELECT p.date FROM payments p JOIN bank_reconciliations r ON r.payment_id=p.id WHERE r.movement_id=?",
                params![movement_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_date, "2026-09-02");
    }

    #[test]
    fn pending_reversal_and_missing_date_are_never_confirmable() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        for (name, status, reversal, include_date) in [
            ("pending.xml", "PDNG", false, true),
            ("reversal.xml", "BOOK", true, true),
            ("no-date.xml", "BOOK", false, false),
        ] {
            let message = if status == "PDNG" { "054" } else { "053" };
            let xml = fixture(
                message,
                "08",
                status,
                "10.00",
                name,
                Some(name),
                None,
                None,
                reversal,
                include_date,
            );
            let path = write_xml(temporary.path(), name, &xml);
            store.import_camt_file(&path).unwrap();
        }
        let workspace = store.get_bank_workspace().unwrap();
        assert_eq!(workspace["summary"]["unreconciled_count"], 1);
        for movement in workspace["movements"].as_array().unwrap() {
            assert_eq!(movement["suggestion"]["confirmable"], false);
        }
    }

    #[test]
    fn original_and_reversal_with_the_same_bank_reference_remain_distinct() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        create_open_invoice(&store, 10_000, "CHF");
        let original = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-SAME-REV",
            Some("D-SAME-REV"),
            None,
            None,
            false,
            true,
        );
        let reversal = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-SAME-REV",
            Some("D-SAME-REV"),
            None,
            None,
            true,
            true,
        )
        .replace("<MsgId>MSG</MsgId>", "<MsgId>REVERSAL</MsgId>");
        store
            .import_camt_file(&write_xml(temporary.path(), "original.xml", &original))
            .unwrap();
        store
            .import_camt_file(&write_xml(temporary.path(), "reversal.xml", &reversal))
            .unwrap();

        let workspace = store.get_bank_workspace().unwrap();
        assert_eq!(workspace["movements"].as_array().unwrap().len(), 2);
        let reversal = workspace["movements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|movement| movement["reversal"] == true)
            .unwrap();
        assert_eq!(reversal["suggestion"]["confirmable"], false);
        assert!(reversal["suggestion"]["reason"]
            .as_str()
            .unwrap()
            .contains("Extourne"));
        let keys = workspace["movements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|movement| movement["strong_key"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn explicit_account_link_unlocks_qrr_and_confirmation_is_atomic_idempotent() {
        let (temporary, store) = store();
        enable_accounting(&store);
        let qrr = generate_qrr("123456").unwrap();
        let invoice_id = create_invoice(&store, 10_000, &qrr);
        let xml = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-PAY",
            Some("D-PAY"),
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        );
        let path = write_xml(temporary.path(), "payment.xml", &xml);
        store.import_camt_file(&path).unwrap();
        let before = store.get_bank_workspace().unwrap();
        assert_eq!(before["accounts"][0]["link_source"], "unlinked");
        assert_eq!(before["movements"][0]["suggestion"]["confirmable"], false);
        let connection = store.connect().unwrap();
        let payments_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM payments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(payments_before, 0);
        drop(connection);

        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let ready = store.get_bank_workspace().unwrap();
        assert_eq!(ready["accounts"][0]["link_source"], "explicit");
        assert_eq!(
            ready["movements"][0]["suggestion"]["kind"],
            "automatic_exact"
        );
        let movement_id = ready["movements"][0]["id"].as_str().unwrap().to_owned();
        let input = ConfirmBankReconciliationInput {
            movement_id: movement_id.clone(),
            invoice_id: invoice_id.clone(),
        };
        let first = store.confirm_bank_reconciliation(input.clone()).unwrap();
        let retry = store.confirm_bank_reconciliation(input).unwrap();
        assert_eq!(first["payment"]["id"], retry["payment"]["id"]);
        let connection = store.connect().unwrap();
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM payments),(SELECT COUNT(*) FROM bank_reconciliations),(SELECT COUNT(*) FROM journal_entries WHERE source_type='payment')",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1, 1));
        assert_eq!(
            connection
                .query_row(
                    "SELECT paid_cents FROM invoices WHERE id=?",
                    params![invoice_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            10_000
        );
    }

    #[test]
    fn partial_qrr_is_safe_but_duplicate_invoice_reference_requires_review() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let partial_qrr = generate_qrr("777").unwrap();
        create_invoice(&store, 20_000, &partial_qrr);
        let partial = fixture(
            "053",
            "04",
            "BOOK",
            "100.00",
            "C-PART",
            Some("D-PART"),
            Some("QRR"),
            Some(&partial_qrr),
            false,
            true,
        );
        store
            .import_camt_file(&write_xml(temporary.path(), "partial.xml", &partial))
            .unwrap();
        let conflict_qrr = generate_qrr("888").unwrap();
        create_invoice(&store, 10_000, &conflict_qrr);
        create_invoice(&store, 10_000, &conflict_qrr);
        let conflict = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-CONF",
            Some("D-CONF"),
            Some("QRR"),
            Some(&conflict_qrr),
            false,
            true,
        );
        store
            .import_camt_file(&write_xml(temporary.path(), "conflict.xml", &conflict))
            .unwrap();
        let workspace = store.get_bank_workspace().unwrap();
        let suggestions = workspace["movements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|movement| movement["suggestion"].clone())
            .collect::<Vec<_>>();
        assert!(suggestions
            .iter()
            .any(|value| value["kind"] == "automatic_partial"));
        let conflict = suggestions
            .iter()
            .find(|value| {
                value["candidates"]
                    .as_array()
                    .is_some_and(|items| items.len() == 2)
            })
            .unwrap();
        assert_eq!(conflict["kind"], "review");
        assert_eq!(conflict["confirmable"], true);
    }

    #[test]
    fn batch_and_account_currency_mismatch_are_review_only() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let qrr = generate_qrr("9191").unwrap();
        let invoice_id = create_invoice(&store, 10_000, &qrr);
        let batch = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-BATCH-SAFE",
            Some("D-BATCH-SAFE"),
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        )
        .replace(
            "</NtryDtls>",
            "<TxDtls><Refs><TxId>TX-BATCH-SECOND</TxId></Refs><RmtInf><Ustrd>Solde du lot</Ustrd></RmtInf></TxDtls></NtryDtls>",
        );
        store
            .import_camt_file(&write_xml(temporary.path(), "batch-safe.xml", &batch))
            .unwrap();

        let eur_invoice = create_open_invoice(&store, 10_000, "EUR");
        let eur = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-EUR",
            Some("D-EUR"),
            None,
            None,
            false,
            true,
        )
        .replace("<Amt Ccy=\"CHF\">", "<Amt Ccy=\"EUR\">")
        .replace("Client test", "Payeur inconnu");
        store
            .import_camt_file(&write_xml(temporary.path(), "eur.xml", &eur))
            .unwrap();

        let workspace = store.get_bank_workspace().unwrap();
        let batch = workspace["movements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|movement| movement_tx_detail_count(movement) == 2)
            .unwrap();
        assert_eq!(batch["suggestion"]["kind"], "review");
        assert_eq!(batch["suggestion"]["confirmable"], false);
        assert!(store
            .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                movement_id: batch["id"].as_str().unwrap().into(),
                invoice_id,
            })
            .is_err());
        let eur_movement = workspace["movements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|movement| movement["currency"] == "EUR")
            .unwrap();
        assert_eq!(eur_movement["account_currency"], "CHF");
        assert_eq!(eur_movement["suggestion"]["confirmable"], false);
        let eur_candidate = eur_movement["suggestion"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["invoice_id"] == eur_invoice)
            .unwrap();
        assert_eq!(eur_candidate["confirmable"], false);
    }

    #[test]
    fn no_structured_reference_gets_all_safe_manual_candidates_and_stable_dedup() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let compatible = create_open_invoice(&store, 10_000, "CHF");
        let insufficient = create_open_invoice(&store, 5_000, "CHF");
        let other_currency = create_open_invoice(&store, 10_000, "EUR");
        let xml = fixture(
            "053", "08", "BOOK", "100.00", "", None, None, None, false, true,
        )
        .replace("Client test", "Payeur inconnu");
        let first = write_xml(temporary.path(), "manual-first.xml", &xml);
        store.import_camt_file(&first).unwrap();
        let second = write_xml(
            temporary.path(),
            "manual-overlap.xml",
            &xml.replace("<MsgId>MSG</MsgId>", "<MsgId>OVERLAP</MsgId>"),
        );
        let overlap = store.import_camt_file(&second).unwrap();
        assert_eq!(overlap["skipped_duplicate_count"], 1);
        let workspace = store.get_bank_workspace().unwrap();
        assert_eq!(workspace["movements"].as_array().unwrap().len(), 1);
        let movement = &workspace["movements"][0];
        assert_eq!(movement["suggestion"]["kind"], "manual");
        assert_eq!(movement["suggestion"]["confirmable"], true);
        let candidate_ids = movement["suggestion"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| candidate["invoice_id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(candidate_ids, vec![compatible.as_str()]);
        assert!(!candidate_ids.contains(&insufficient.as_str()));
        assert!(!candidate_ids.contains(&other_currency.as_str()));
        store
            .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                movement_id: movement["id"].as_str().unwrap().into(),
                invoice_id: compatible,
            })
            .unwrap();
    }

    #[test]
    fn a_false_text_match_never_hides_another_compatible_open_invoice() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let paid_id = create_open_invoice(&store, 10_000, "CHF");
        store
            .record_payment(RecordPaymentInput {
                request_id: None,
                invoice_id: paid_id.clone(),
                amount_cents: 10_000,
                date: Some("2026-08-20".into()),
                method: Some("Test".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
        let open_id = create_open_invoice(&store, 10_000, "CHF");
        let connection = store.connect().unwrap();
        let paid_number: String = connection
            .query_row(
                "SELECT number FROM invoices WHERE id=?",
                params![paid_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        let xml = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-FALSE-TEXT",
            Some("D-FALSE-TEXT"),
            None,
            None,
            false,
            true,
        )
        .replace(
            "Paiement sans référence",
            &format!("Faux indice {paid_number}"),
        )
        .replace("Client test", "Payeur inconnu");
        store
            .import_camt_file(&write_xml(temporary.path(), "false-text.xml", &xml))
            .unwrap();
        let workspace = store.get_bank_workspace().unwrap();
        let candidates = workspace["movements"][0]["suggestion"]["candidates"]
            .as_array()
            .unwrap();
        let paid = candidates
            .iter()
            .find(|candidate| candidate["invoice_id"] == paid_id)
            .unwrap();
        let open = candidates
            .iter()
            .find(|candidate| candidate["invoice_id"] == open_id)
            .unwrap();
        assert_eq!(paid["confirmable"], false);
        assert_eq!(open["confirmable"], true);
        assert_eq!(workspace["movements"][0]["suggestion"]["confirmable"], true);
    }

    #[test]
    fn a_valid_but_unknown_qrr_offers_explicit_manual_invoice_choices() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let open_id = create_open_invoice(&store, 10_000, "CHF");
        let unknown_qrr = generate_qrr("606060").unwrap();
        let xml = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-UNKNOWN-QRR",
            Some("D-UNKNOWN-QRR"),
            Some("QRR"),
            Some(&unknown_qrr),
            false,
            true,
        );
        store
            .import_camt_file(&write_xml(temporary.path(), "unknown-qrr.xml", &xml))
            .unwrap();
        let workspace = store.get_bank_workspace().unwrap();
        let suggestion = &workspace["movements"][0]["suggestion"];
        assert_eq!(suggestion["kind"], "manual");
        assert_eq!(suggestion["confirmable"], true);
        assert!(suggestion["reason"].as_str().unwrap().contains("inconnue"));
        assert!(suggestion["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |candidate| candidate["invoice_id"] == open_id && candidate["confirmable"] == true
            ));
    }

    #[test]
    fn shared_end_to_end_id_alone_neither_deduplicates_nor_allows_a_payment() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let qrr = generate_qrr("787878").unwrap();
        let invoice_id = create_invoice(&store, 10_000, &qrr);
        let xml = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "",
            None,
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        )
        .replace("<TxId>TX-</TxId>", "");
        store
            .import_camt_file(&write_xml(temporary.path(), "no-id-a.xml", &xml))
            .unwrap();
        store
            .import_camt_file(&write_xml(
                temporary.path(),
                "no-id-b.xml",
                &xml.replace("<MsgId>MSG</MsgId>", "<MsgId>OVERLAP</MsgId>"),
            ))
            .unwrap();

        let workspace = store.get_bank_workspace().unwrap();
        assert_eq!(workspace["movements"].as_array().unwrap().len(), 2);
        for movement in workspace["movements"].as_array().unwrap() {
            assert_eq!(movement["end_to_end_id"], "E2E-");
            assert!(movement["strong_key"].is_null());
            assert_eq!(movement["suggestion"]["confirmable"], false);
            assert!(store
                .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                    movement_id: movement["id"].as_str().unwrap().into(),
                    invoice_id: invoice_id.clone(),
                })
                .is_err());
        }
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM payments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn invalid_qrr_characters_and_invalid_reversal_never_become_confirmable() {
        let (temporary, store) = store();
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let qrr = generate_qrr("4343").unwrap();
        create_invoice(&store, 10_000, &qrr);
        let invalid_qrr = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-BAD-QRR",
            Some("D-BAD-QRR"),
            Some("QRR"),
            Some(&format!("ABC{qrr}XYZ")),
            false,
            true,
        );
        store
            .import_camt_file(&write_xml(temporary.path(), "bad-qrr.xml", &invalid_qrr))
            .unwrap();
        let workspace = store.get_bank_workspace().unwrap();
        assert_eq!(workspace["movements"][0]["suggestion"]["kind"], "review");
        assert_eq!(
            workspace["movements"][0]["suggestion"]["confirmable"],
            false
        );

        let invalid_reversal = fixture(
            "053",
            "08",
            "BOOK",
            "10.00",
            "C-RVSL",
            Some("D-RVSL"),
            None,
            None,
            false,
            true,
        )
        .replace("<RvslInd>false</RvslInd>", "<RvslInd>peut-être</RvslInd>");
        let parsed = parse_camt(invalid_reversal.as_bytes()).unwrap();
        assert!(parsed.movements.is_empty());
        assert_eq!(parsed.ignored_count, 1);
        assert!(parsed.warnings[0].contains("RvslInd"));
    }

    #[test]
    fn closed_payment_period_rolls_back_payment_reconciliation_and_journal() {
        let (temporary, store) = store();
        enable_accounting(&store);
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        let qrr = generate_qrr("5656").unwrap();
        let invoice_id = create_invoice(&store, 10_000, &qrr);
        let xml = fixture(
            "053",
            "08",
            "BOOK",
            "100.00",
            "C-ROLL",
            Some("D-ROLL"),
            Some("QRR"),
            Some(&qrr),
            false,
            true,
        );
        store
            .import_camt_file(&write_xml(temporary.path(), "rollback.xml", &xml))
            .unwrap();
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Journée bancaire clôturée".into(),
                date_from: "2026-08-31".into(),
                date_to: "2026-08-31".into(),
            })
            .unwrap();
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();
        let movement_id = store.get_bank_workspace().unwrap()["movements"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let error = store
            .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                movement_id,
                invoice_id: invoice_id.clone(),
            })
            .unwrap_err();
        assert!(error.to_string().contains("clôturée"));
        let connection = store.connect().unwrap();
        let state: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM payments),(SELECT COUNT(*) FROM bank_reconciliations),(SELECT COUNT(*) FROM journal_entries WHERE source_type='payment'),(SELECT paid_cents FROM invoices WHERE id=?)",
                params![invoice_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            )
            .unwrap();
        assert_eq!(state, (0, 0, 0, 0));
    }

    #[test]
    fn account_association_is_audited_reversible_and_idempotent() {
        let (_temporary, store) = store();
        let input = AssociateBankAccountInput {
            account_id: STATEMENT_IBAN.into(),
            currency: "CHF".into(),
        };
        let first = store.associate_bank_account(input.clone()).unwrap();
        let retry = store.associate_bank_account(input.clone()).unwrap();
        assert_eq!(first["confirmed_at"], retry["confirmed_at"]);
        let revoked = store.dissociate_bank_account(input.clone()).unwrap();
        assert_eq!(revoked["active"], false);
        assert!(revoked["revoked_at"].as_str().is_some());
        let reactivated = store.associate_bank_account(input).unwrap();
        assert_eq!(reactivated["active"], true);
        let connection = store.connect().unwrap();
        let audits: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='bank_account'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audits, 3);
    }

    #[test]
    fn invalid_and_oversized_files_are_rejected_without_database_writes() {
        let (temporary, store) = store();
        let invalid = write_xml(temporary.path(), "invalid.xml", "<not-camt/>");
        assert!(store.import_camt_file(&invalid).is_err());
        let huge_path = temporary.path().join("huge.xml");
        fs::write(&huge_path, vec![b' '; MAX_CAMT_BYTES as usize + 1]).unwrap();
        assert!(store
            .import_camt_file(&huge_path.to_string_lossy())
            .unwrap_err()
            .to_string()
            .contains("limite locale"));
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM bank_imports", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn fresh_schema_is_v12_and_contains_no_bank_demo_data() {
        let (_temporary, store) = store();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        for table in [
            "bank_imports",
            "bank_movements",
            "bank_movement_keys",
            "bank_reconciliations",
            "bank_account_links",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "runtime table {table} must not be seeded");
        }
    }

    #[test]
    fn v11_database_migrates_additively_to_empty_v12_bank_tables() {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let original = LocalStore::initialize(profile.clone()).unwrap();
        original
            .connect()
            .unwrap()
            .execute_batch(
                "DROP TABLE bank_reconciliations;
                 DROP TABLE bank_movement_keys;
                 DROP TABLE bank_movements;
                 DROP TABLE bank_imports;
                 DROP TABLE bank_account_links;
                 PRAGMA user_version=11;",
            )
            .unwrap();
        let migrated = LocalStore::initialize(profile).unwrap();
        let connection = migrated.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 12);
        for table in [
            "bank_imports",
            "bank_movements",
            "bank_movement_keys",
            "bank_reconciliations",
            "bank_account_links",
        ] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing migrated table {table}");
        }
    }
}

#[derive(Debug, Clone)]
struct InvoiceCandidate {
    id: String,
    number: String,
    total_cents: i64,
    paid_cents: i64,
    credited_cents: i64,
    currency: String,
    qr_reference_type: Option<String>,
    qr_reference: Option<String>,
    client_name: Option<String>,
}

impl InvoiceCandidate {
    fn remaining_cents(&self) -> i64 {
        self.total_cents
            .saturating_sub(self.paid_cents)
            .saturating_sub(self.credited_cents)
            .max(0)
    }
}

fn load_invoice_candidates(connection: &rusqlite::Connection) -> AppResult<Vec<InvoiceCandidate>> {
    let mut statement = connection.prepare(
        "SELECT i.id,i.number,i.total_cents,i.paid_cents,COALESCE((SELECT SUM(-c.total_cents) FROM invoices c WHERE c.type='avoir' AND c.original_invoice_id=i.id AND c.number IS NOT NULL AND c.status<>'annulee'),0),i.currency,q.input_json,c.name,c.company FROM invoices i LEFT JOIN invoice_qr_bills q ON q.invoice_id=i.id LEFT JOIN clients c ON c.id=i.client_id WHERE i.type='standard' AND i.number IS NOT NULL AND i.status<>'annulee' ORDER BY i.issue_date DESC,i.created_at DESC",
    )?;
    let candidates = statement
        .query_map([], |row| {
            let input_json: Option<String> = row.get(6)?;
            let qr_bill = input_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok());
            let reference_type = qr_bill
                .as_ref()
                .and_then(|value| value.get("reference_type"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let reference = qr_bill
                .as_ref()
                .and_then(|value| value.get("reference"))
                .and_then(Value::as_str)
                .map(|value| {
                    normalize_reference(reference_type.as_deref().unwrap_or("NON"), value)
                });
            let person: Option<String> = row.get(7)?;
            let company: Option<String> = row.get(8)?;
            Ok(InvoiceCandidate {
                id: row.get(0)?,
                number: row.get(1)?,
                total_cents: row.get(2)?,
                paid_cents: row.get(3)?,
                credited_cents: row.get(4)?,
                currency: row.get(5)?,
                qr_reference_type: reference_type,
                qr_reference: reference,
                client_name: company
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| person.filter(|value| !value.trim().is_empty())),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(candidates)
}

fn normalized_search(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn movement_field<'a>(movement: &'a Value, field: &str) -> Option<&'a str> {
    movement.get(field).and_then(Value::as_str)
}

fn movement_tx_detail_count(movement: &Value) -> i64 {
    match movement.get("details_json") {
        Some(Value::Object(details)) => details
            .get("tx_detail_count")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        Some(Value::String(details)) => serde_json::from_str::<Value>(details)
            .ok()
            .and_then(|value| value["tx_detail_count"].as_i64())
            .unwrap_or(0),
        _ => 0,
    }
}

fn account_link_source(
    connection: &rusqlite::Connection,
    account_id: &str,
    currency: &str,
) -> AppResult<&'static str> {
    let settings: Option<(Option<String>, String)> = connection
        .query_row("SELECT iban,currency FROM settings WHERE id=1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    if let Some((Some(settings_iban), settings_currency)) = settings {
        if normalize_account(&settings_iban).ok().as_deref() == Some(account_id)
            && settings_currency.eq_ignore_ascii_case(currency)
        {
            return Ok("settings_iban");
        }
    }
    let explicit: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM bank_account_links WHERE account_id=? AND currency=? AND active=1)",
        params![account_id, currency],
        |row| row.get(0),
    )?;
    Ok(if explicit { "explicit" } else { "unlinked" })
}

fn booked_message_type(
    connection: &rusqlite::Connection,
    movement: &Value,
) -> AppResult<Option<String>> {
    let Some(import_id) = movement_field(movement, "booked_import_id") else {
        return Ok(None);
    };
    Ok(connection
        .query_row(
            "SELECT message_type FROM bank_imports WHERE id=?",
            params![import_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn candidate_json(
    invoice: &InvoiceCandidate,
    movement_amount: i64,
    movement_currency: &str,
    base_eligible: bool,
    reason: &str,
) -> Value {
    let remaining = invoice.remaining_cents();
    let (amount_relation, amount_safe) = if remaining <= 0 {
        ("already_paid", false)
    } else if movement_amount > remaining {
        ("overpayment", false)
    } else if movement_amount == remaining {
        ("exact", true)
    } else {
        ("partial", true)
    };
    let currency_safe = invoice.currency == movement_currency;
    json!({
        "invoice_id": invoice.id,
        "invoice_number": invoice.number,
        "remaining_cents": remaining,
        "amount_relation": if currency_safe { amount_relation } else { "currency_mismatch" },
        "reason": if currency_safe { reason.to_owned() } else { "La devise du mouvement ne correspond pas à celle de la facture.".to_owned() },
        "confirmable": base_eligible && amount_safe && currency_safe,
    })
}

fn suggestion_for_movement(
    connection: &rusqlite::Connection,
    movement: &Value,
    reconciliation: Option<&Value>,
    invoices: &[InvoiceCandidate],
) -> AppResult<Value> {
    if reconciliation.is_some() {
        return Ok(json!({
            "kind":"none",
            "reason":"Ce mouvement est déjà rapproché.",
            "confirmable":false,
            "invoice_id":Value::Null,
            "invoice_number":Value::Null,
            "candidates":[],
        }));
    }
    let account_id = movement_field(movement, "account_id").unwrap_or_default();
    let account_currency = movement_field(movement, "account_currency").unwrap_or_default();
    let movement_currency = movement_field(movement, "currency").unwrap_or_default();
    let amount = movement
        .get("amount_cents")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let booked = movement_field(movement, "status") == Some("BOOK");
    let booked_message_type = booked_message_type(connection, movement)?;
    let final_statement = booked_message_type.as_deref() == Some("camt.053");
    let credit = movement_field(movement, "credit_debit") == Some("CRDT");
    let reversal = movement
        .get("reversal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_bank_date = movement_field(movement, "booking_date")
        .or_else(|| movement_field(movement, "value_date"))
        .is_some();
    let single_transaction = movement_tx_detail_count(movement) == 1;
    let account_currency_matches = movement_currency == account_currency;
    let has_stable_dedup_key = movement_field(movement, "strong_key").is_some();
    let link_source = account_link_source(connection, account_id, account_currency)?;
    let account_linked = link_source != "unlinked";
    let base_eligible = booked
        && final_statement
        && credit
        && !reversal
        && account_linked
        && has_bank_date
        && single_transaction
        && account_currency_matches
        && has_stable_dedup_key;

    let reference_type = movement_field(movement, "reference_type").unwrap_or("NON");
    let reference = movement_field(movement, "reference").unwrap_or_default();
    let structured_valid = match reference_type {
        "QRR" => validate_qrr(reference),
        "SCOR" => validate_scor(reference),
        _ => false,
    };
    if structured_valid {
        let matches = invoices
            .iter()
            .filter(|invoice| {
                invoice.qr_reference_type.as_deref() == Some(reference_type)
                    && invoice.qr_reference.as_deref() == Some(reference)
            })
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            let candidates = matches
                .iter()
                .map(|invoice| {
                    candidate_json(
                        invoice,
                        amount,
                        movement_currency,
                        base_eligible,
                        "Référence QR structurée identique.",
                    )
                })
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                let candidate = &candidates[0];
                let confirmable = candidate["confirmable"].as_bool().unwrap_or(false);
                let relation = candidate["amount_relation"].as_str().unwrap_or("review");
                let kind = if confirmable && relation == "exact" {
                    "automatic_exact"
                } else if confirmable && relation == "partial" {
                    "automatic_partial"
                } else {
                    "review"
                };
                let reason = if !booked {
                    "Le mouvement PDNG doit devenir BOOK avant rapprochement."
                } else if !final_statement {
                    "Importez le relevé camt.053 définitif avant de confirmer ce mouvement."
                } else if !credit {
                    "Un débit ne peut pas encaisser une facture client."
                } else if reversal {
                    "Une extourne ne peut pas encaisser une facture."
                } else if !account_linked {
                    "Associez explicitement ce compte bancaire à l’entreprise."
                } else if !has_bank_date {
                    "Le mouvement BOOK ne contient aucune date bancaire utilisable."
                } else if !account_currency_matches {
                    "La devise de l’écriture diffère de celle du compte bancaire; aucun rapprochement sans gestion FX."
                } else if !single_transaction {
                    "Cette écriture bancaire regroupe plusieurs transactions; vérification manuelle requise sans confirmation dans cette version."
                } else if !has_stable_dedup_key {
                    "Aucun identifiant bancaire stable ne protège contre un double import; confirmation bloquée."
                } else if relation == "overpayment" {
                    "Le montant dépasse le solde de la facture : revue obligatoire."
                } else if relation == "already_paid" {
                    "La facture est déjà soldée."
                } else if relation == "currency_mismatch" {
                    "La devise du mouvement ne correspond pas à la facture."
                } else {
                    "Référence QR structurée unique et montant contrôlé."
                };
                return Ok(json!({
                    "kind":kind,
                    "reason":reason,
                    "confirmable":confirmable,
                    "invoice_id":matches[0].id,
                    "invoice_number":matches[0].number,
                    "candidates":candidates,
                }));
            }
            let confirmable = candidates
                .iter()
                .any(|candidate| candidate["confirmable"].as_bool() == Some(true));
            return Ok(json!({
                "kind":"review",
                "reason":if booked && !final_statement { "Importez le relevé camt.053 définitif avant de confirmer ce mouvement." } else { "La même référence QR est liée à plusieurs factures : choisissez explicitement." },
                "confirmable":confirmable,
                "invoice_id":Value::Null,
                "invoice_number":Value::Null,
                "candidates":candidates,
            }));
        }
    }

    let unstructured = movement_field(movement, "unstructured").unwrap_or_default();
    let counterparty = movement_field(movement, "counterparty_name").unwrap_or_default();
    let haystack = normalized_search(unstructured);
    let counterparty = normalized_search(counterparty);
    let mut manual_matches = Vec::new();
    for invoice in invoices {
        let number_match =
            !haystack.is_empty() && haystack.contains(&normalized_search(invoice.number.as_str()));
        let name_match = invoice.client_name.as_deref().is_some_and(|name| {
            let name = normalized_search(name);
            name.len() >= 4 && (!counterparty.is_empty() && counterparty == name)
        });
        if number_match || name_match {
            manual_matches.push((
                invoice,
                if number_match {
                    "Numéro de facture repéré dans le texte libre; confirmation manuelle requise."
                } else {
                    "Nom du client repéré; confirmation manuelle requise."
                },
            ));
        }
    }
    if matches!(reference_type, "QRR" | "SCOR") && !structured_valid {
        return Ok(json!({
            "kind":"review",
            "reason":if booked && !final_statement { "Importez le relevé camt.053 définitif avant de confirmer ce mouvement." } else { "La référence structurée ne passe pas le contrôle QRR/SCOR; aucune facture ne peut être confirmée depuis cette référence." },
            "confirmable":false,
            "invoice_id":Value::Null,
            "invoice_number":Value::Null,
            "candidates":[],
        }));
    }
    if reference_type == "CONFLICT" {
        return Ok(json!({
            "kind":"review",
            "reason":if booked && !final_statement { "Importez le relevé camt.053 définitif avant de confirmer ce mouvement." } else { "Plusieurs références structurées se contredisent dans cette écriture groupée." },
            "confirmable":false,
            "invoice_id":Value::Null,
            "invoice_number":Value::Null,
            "candidates":[],
        }));
    }
    if reference_type == "NON" || structured_valid {
        let fallback_reason = if structured_valid {
            "Référence QRR/SCOR valide mais inconnue; sélection manuelle d’une facture ouverte requise."
        } else {
            "Facture ouverte compatible en devise et en solde; sélection manuelle requise."
        };
        for invoice in invoices.iter().filter(|invoice| {
            invoice.currency == movement_currency
                && invoice.remaining_cents() >= amount
                && invoice.remaining_cents() > 0
        }) {
            if !manual_matches
                .iter()
                .any(|(candidate, _)| candidate.id == invoice.id)
            {
                manual_matches.push((invoice, fallback_reason));
            }
        }
    }
    if !manual_matches.is_empty() {
        let candidates = manual_matches
            .iter()
            .map(|(invoice, reason)| {
                candidate_json(invoice, amount, movement_currency, base_eligible, reason)
            })
            .collect::<Vec<_>>();
        let confirmable = candidates
            .iter()
            .any(|candidate| candidate["confirmable"].as_bool() == Some(true));
        return Ok(json!({
            "kind":if booked && !final_statement { "review" } else if single_transaction { "manual" } else { "review" },
            "reason": if !booked { "Mouvement en attente (PDNG) : aucune confirmation possible." } else if !final_statement { "Importez le relevé camt.053 définitif avant de confirmer ce mouvement." } else if !credit { "Débit bancaire : aucun encaissement client possible." } else if reversal { "Extourne bancaire détectée : elle reste visible mais ne peut pas encaisser une facture." } else if !has_bank_date { "Le mouvement BOOK ne contient aucune date bancaire utilisable." } else if !single_transaction { "Écriture collective : les candidats restent informatifs et ne sont pas confirmables." } else if !has_stable_dedup_key { "Aucun identifiant bancaire stable : rapprochement bloqué pour éviter un double encaissement." } else if !account_linked { "Compte bancaire non associé : vérifiez-le avant toute confirmation." } else if !account_currency_matches { "Devise du mouvement différente de celle du compte : gestion FX requise." } else if structured_valid { "Référence structurée valide mais inconnue : choisissez explicitement une facture ouverte compatible." } else { "Choisissez explicitement une facture ouverte compatible." },
            "confirmable":confirmable,
            "invoice_id": if manual_matches.len()==1 { json!(manual_matches[0].0.id) } else { Value::Null },
            "invoice_number": if manual_matches.len()==1 { json!(manual_matches[0].0.number) } else { Value::Null },
            "candidates":candidates,
        }));
    }
    let reason = if !booked {
        "Mouvement en attente (PDNG)."
    } else if !final_statement {
        "Importez le relevé camt.053 définitif avant de confirmer ce mouvement."
    } else if !credit {
        "Débit bancaire : aucun encaissement client proposé."
    } else if reversal {
        "Extourne bancaire : aucun encaissement proposé."
    } else if !account_linked {
        "Compte bancaire non associé à l’entreprise."
    } else if !has_bank_date {
        "Le mouvement BOOK ne contient aucune date bancaire utilisable."
    } else if !account_currency_matches {
        "La devise du mouvement diffère de celle du compte bancaire."
    } else if !single_transaction {
        "Écriture bancaire collective : rapprochement bloqué dans cette version."
    } else if !has_stable_dedup_key {
        "Aucun identifiant bancaire stable : risque de double import."
    } else {
        "Aucune référence fiable ne permet de proposer une facture."
    };
    Ok(json!({
        "kind": if booked && credit { "review" } else { "none" },
        "reason":reason,
        "confirmable":false,
        "invoice_id":Value::Null,
        "invoice_number":Value::Null,
        "candidates":[],
    }))
}

fn parse_json_columns(record: &mut Value, columns: &[&str]) {
    let Some(object) = record.as_object_mut() else {
        return;
    };
    for column in columns {
        if let Some(Value::String(value)) = object.get(*column) {
            if let Ok(parsed) = serde_json::from_str::<Value>(value) {
                object.insert((*column).to_owned(), parsed);
            }
        }
    }
}

fn account_link_row(connection: &rusqlite::Connection, account_id: &str) -> AppResult<Value> {
    query_all(
        connection,
        "SELECT * FROM bank_account_links WHERE account_id=?",
        params![account_id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::NotFound(format!("bank_account_links/{account_id}")))
}

impl LocalStore {
    pub fn get_bank_workspace(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut imports = query_all(
            &connection,
            "SELECT * FROM bank_imports ORDER BY created_at DESC,rowid DESC",
            [],
        )?;
        for import in &mut imports {
            parse_json_columns(import, &["warnings_json"]);
        }
        let mut movements = query_all(
            &connection,
            "SELECT * FROM bank_movements ORDER BY COALESCE(booking_date,value_date,created_at) DESC,created_at DESC,entry_sequence",
            [],
        )?;
        for movement in &mut movements {
            parse_json_columns(movement, &["details_json"]);
        }
        let reconciliations = query_all(
            &connection,
            "SELECT * FROM bank_reconciliations ORDER BY confirmed_at DESC,rowid DESC",
            [],
        )?;
        let reconciliations_by_movement = reconciliations
            .iter()
            .filter_map(|reconciliation| {
                reconciliation
                    .get("movement_id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_owned(), reconciliation.clone()))
            })
            .collect::<HashMap<_, _>>();
        let invoices = load_invoice_candidates(&connection)?;
        for movement in &mut movements {
            let movement_id = movement_field(movement, "id").unwrap_or_default();
            let reconciliation = reconciliations_by_movement.get(movement_id);
            let suggestion =
                suggestion_for_movement(&connection, movement, reconciliation, &invoices)?;
            let object = movement
                .as_object_mut()
                .ok_or_else(|| AppError::Validation("Mouvement bancaire local invalide.".into()))?;
            object.insert(
                "reconciliation".into(),
                reconciliation.cloned().unwrap_or(Value::Null),
            );
            object.insert("suggestion".into(), suggestion);
        }

        let mut account_counts = HashMap::<(String, String), i64>::new();
        for movement in &movements {
            let key = (
                movement_field(movement, "account_id")
                    .unwrap_or_default()
                    .to_owned(),
                movement_field(movement, "account_currency")
                    .unwrap_or_default()
                    .to_owned(),
            );
            *account_counts.entry(key).or_default() += 1;
        }
        let mut accounts = account_counts
            .into_iter()
            .map(|((account_id, currency), movement_count)| {
                let link_source = account_link_source(&connection, &account_id, &currency)?;
                Ok(json!({
                    "account_id":account_id,
                    "currency":currency,
                    "linked":link_source != "unlinked",
                    "link_source":link_source,
                    "movement_count":movement_count,
                }))
            })
            .collect::<AppResult<Vec<_>>>()?;
        accounts.sort_by(|left, right| {
            left["account_id"]
                .as_str()
                .cmp(&right["account_id"].as_str())
        });
        let unreconciled_count = movements
            .iter()
            .filter(|movement| {
                movement["reconciliation"].is_null()
                    && movement_field(movement, "status") == Some("BOOK")
                    && movement_field(movement, "credit_debit") == Some("CRDT")
                    && !movement
                        .get("reversal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            })
            .count() as i64;
        let pending_count = movements
            .iter()
            .filter(|movement| movement_field(movement, "status") == Some("PDNG"))
            .count() as i64;
        let booked_credit_count = movements
            .iter()
            .filter(|movement| {
                movement_field(movement, "status") == Some("BOOK")
                    && movement_field(movement, "credit_debit") == Some("CRDT")
                    && !movement
                        .get("reversal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            })
            .count() as i64;
        Ok(json!({
            "summary":{
                "import_count":imports.len() as i64,
                "movement_count":movements.len() as i64,
                "unreconciled_count":unreconciled_count,
                "pending_count":pending_count,
                "booked_credit_count":booked_credit_count,
            },
            "accounts":accounts,
            "imports":imports,
            "movements":movements,
            "reconciliations":reconciliations,
        }))
    }

    pub fn associate_bank_account(&self, input: AssociateBankAccountInput) -> AppResult<Value> {
        let account_id = normalize_account(&input.account_id)?;
        let currency = normalize_currency(&input.currency)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let settings: (Option<String>, String) =
            transaction.query_row("SELECT iban,currency FROM settings WHERE id=1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        if settings
            .0
            .as_deref()
            .and_then(|value| normalize_account(value).ok())
            .as_deref()
            == Some(account_id.as_str())
            && settings.1.eq_ignore_ascii_case(&currency)
        {
            transaction.commit()?;
            return Ok(json!({
                "account_id":account_id,
                "currency":currency,
                "active":true,
                "confirmed_at":Value::Null,
                "revoked_at":Value::Null,
                "created_at":Value::Null,
                "updated_at":Value::Null,
                "link_source":"settings_iban",
            }));
        }
        let existing: Option<(String, i64)> = transaction
            .query_row(
                "SELECT currency,active FROM bank_account_links WHERE account_id=?",
                params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let now = now_iso();
        match existing {
            Some((existing_currency, 1)) if existing_currency == currency => {
                let record = account_link_row(&transaction, &account_id)?;
                transaction.commit()?;
                return Ok(record);
            }
            Some((_, 1)) => {
                return Err(AppError::Validation(
                    "Ce compte est déjà associé avec une autre devise. Dissociez-le explicitement avant de le corriger."
                        .into(),
                ))
            }
            Some((_, _)) => {
                transaction.execute(
                    "UPDATE bank_account_links SET currency=?,active=1,confirmed_at=?,revoked_at=NULL,updated_at=? WHERE account_id=?",
                    params![currency, now, now, account_id],
                )?;
            }
            None => {
                transaction.execute(
                    "INSERT INTO bank_account_links(account_id,currency,active,confirmed_at,revoked_at,created_at,updated_at) VALUES(?,?,1,?,NULL,?,?)",
                    params![account_id, currency, now, now, now],
                )?;
            }
        }
        let record = account_link_row(&transaction, &account_id)?;
        append_audit(
            &transaction,
            "associate",
            "bank_account",
            &account_id,
            &record,
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn dissociate_bank_account(&self, input: AssociateBankAccountInput) -> AppResult<Value> {
        let account_id = normalize_account(&input.account_id)?;
        let currency = normalize_currency(&input.currency)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let settings: (Option<String>, String) =
            transaction.query_row("SELECT iban,currency FROM settings WHERE id=1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        if settings
            .0
            .as_deref()
            .and_then(|value| normalize_account(value).ok())
            .as_deref()
            == Some(account_id.as_str())
            && settings.1.eq_ignore_ascii_case(&currency)
        {
            return Err(AppError::Validation(
                "Ce compte est reconnu par l’IBAN des réglages. Modifiez d’abord cet IBAN dans les réglages si l’association est erronée."
                    .into(),
            ));
        }
        let active: Option<(String, i64)> = transaction
            .query_row(
                "SELECT currency,active FROM bank_account_links WHERE account_id=?",
                params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match active {
            None => {
                return Err(AppError::NotFound(format!(
                    "bank_account_links/{account_id}"
                )))
            }
            Some((existing_currency, _)) if existing_currency != currency => {
                return Err(AppError::Validation(
                    "La devise ne correspond pas à l’association bancaire enregistrée.".into(),
                ))
            }
            Some((_, 0)) => {
                let record = account_link_row(&transaction, &account_id)?;
                transaction.commit()?;
                return Ok(record);
            }
            Some((_, _)) => {}
        }
        let now = now_iso();
        transaction.execute(
            "UPDATE bank_account_links SET active=0,revoked_at=?,updated_at=? WHERE account_id=?",
            params![now, now, account_id],
        )?;
        let record = account_link_row(&transaction, &account_id)?;
        append_audit(
            &transaction,
            "dissociate",
            "bank_account",
            &account_id,
            &record,
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn confirm_bank_reconciliation(
        &self,
        input: ConfirmBankReconciliationInput,
    ) -> AppResult<Value> {
        let movement_id = Uuid::parse_str(input.movement_id.trim())
            .map_err(|_| AppError::Validation("movement_id est invalide.".into()))?
            .to_string();
        let invoice_id = input.invoice_id.trim().to_owned();
        if invoice_id.is_empty() {
            return Err(AppError::Validation(
                "Choisissez la facture à rapprocher.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some((existing_invoice_id, payment_id)) = transaction
            .query_row(
                "SELECT invoice_id,payment_id FROM bank_reconciliations WHERE movement_id=?",
                params![movement_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if existing_invoice_id != invoice_id {
                return Err(AppError::Validation(
                    "Ce mouvement est déjà rapproché avec une autre facture.".into(),
                ));
            }
            let movement = query_all(
                &transaction,
                "SELECT * FROM bank_movements WHERE id=?",
                params![movement_id],
            )?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::NotFound(format!("bank_movements/{movement_id}")))?;
            let reconciliation = query_all(
                &transaction,
                "SELECT * FROM bank_reconciliations WHERE movement_id=?",
                params![movement_id],
            )?
            .into_iter()
            .next()
            .unwrap();
            let payment = query_record_tx(&transaction, "payments", &payment_id)?;
            let invoice = query_record_tx(&transaction, "invoices", &invoice_id)?;
            transaction.commit()?;
            return Ok(
                json!({"movement":movement,"reconciliation":reconciliation,"payment":payment,"invoice":invoice}),
            );
        }
        let movement = query_all(
            &transaction,
            "SELECT * FROM bank_movements WHERE id=?",
            params![movement_id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(format!("bank_movements/{movement_id}")))?;
        let invoices = load_invoice_candidates(&transaction)?;
        let suggestion = suggestion_for_movement(&transaction, &movement, None, &invoices)?;
        let selected = suggestion["candidates"]
            .as_array()
            .and_then(|candidates| {
                candidates.iter().find(|candidate| {
                    candidate["invoice_id"].as_str() == Some(invoice_id.as_str())
                })
            })
            .ok_or_else(|| {
                AppError::Validation(
                    "Cette facture ne fait pas partie des propositions contrôlées pour ce mouvement."
                        .into(),
                )
            })?;
        if selected["confirmable"].as_bool() != Some(true) {
            return Err(AppError::Validation(
                "Ce rapprochement ne peut pas être confirmé : vérifiez le statut, le compte, la devise et le solde."
                    .into(),
            ));
        }
        let amount_cents = movement["amount_cents"].as_i64().ok_or_else(|| {
            AppError::Validation("Le montant du mouvement local est invalide.".into())
        })?;
        let payment_date = movement_field(&movement, "booking_date")
            .or_else(|| movement_field(&movement, "value_date"))
            .ok_or_else(|| {
                AppError::Validation(
                    "Le mouvement BOOK ne contient aucune date bancaire utilisable.".into(),
                )
            })?
            .to_owned();
        let payment_reference = movement_field(&movement, "reference")
            .or_else(|| movement_field(&movement, "account_servicer_ref"))
            .map(|value| value.chars().take(160).collect::<String>());
        let payment = record_payment_in_transaction(
            &transaction,
            RecordPaymentInput {
                request_id: Some(movement_id.clone()),
                invoice_id: invoice_id.clone(),
                amount_cents,
                date: Some(payment_date),
                method: Some("Virement bancaire CAMT".into()),
                reference: payment_reference,
                notes: Some(format!(
                    "Rapprochement explicite du mouvement CAMT {movement_id}."
                )),
            },
        )?;
        let reconciliation_id = Uuid::new_v4().to_string();
        let now = now_iso();
        transaction.execute(
            "INSERT INTO bank_reconciliations(id,movement_id,invoice_id,payment_id,amount_cents,confirmed_at,created_at) VALUES(?,?,?,?,?,?,?)",
            params![reconciliation_id,movement_id,invoice_id,movement_id,amount_cents,now,now],
        )?;
        let reconciliation = query_all(
            &transaction,
            "SELECT * FROM bank_reconciliations WHERE id=?",
            params![reconciliation_id],
        )?
        .into_iter()
        .next()
        .unwrap();
        append_audit(
            &transaction,
            "confirm",
            "bank_reconciliation",
            &reconciliation_id,
            &json!({"movement_id":movement_id,"invoice_id":invoice_id,"payment_id":movement_id,"amount_cents":amount_cents}),
        )?;
        let invoice = query_record_tx(&transaction, "invoices", &invoice_id)?;
        transaction.commit()?;
        Ok(json!({
            "movement":movement,
            "reconciliation":reconciliation,
            "payment":payment,
            "invoice":invoice,
        }))
    }
}

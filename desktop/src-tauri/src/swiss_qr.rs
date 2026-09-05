use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{
        SaveInvoiceQrBillInput, SwissQrBillInput, SwissQrParty, SwissQrPayload, SwissQrValidation,
    },
};

impl LocalStore {
    pub fn get_invoice_qr_bill(&self, invoice_id: &str) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let stored = stored_qr_bill(&connection, invoice_id)?;
        if stored.is_null() {
            return Ok(stored);
        }
        validate_loaded_final_qr_bill(&connection, invoice_id, &stored)?;
        Ok(stored)
    }

    pub fn save_invoice_qr_bill(&self, input: SaveInvoiceQrBillInput) -> AppResult<Value> {
        if input.invoice_id.trim().is_empty() {
            return Err(AppError::Validation("invoice_id est obligatoire.".into()));
        }
        let validation = validate(input.bill);
        if !validation.valid {
            return Err(AppError::Validation(validation.errors.join(" ")));
        }
        let normalized = validation.normalized;
        let generated = generate(normalized.clone())?;
        let input_json = serde_json::to_string(&normalized)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (number, invoice_type, total_cents, currency, snapshot_json): (
            Option<String>,
            String,
            i64,
            String,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT number,type,total_cents,currency,snapshot_json FROM invoices WHERE id=?",
                params![input.invoice_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("invoices/{}", input.invoice_id)))?;
        if matches!(invoice_type.as_str(), "avoir" | "credit_note") {
            return Err(AppError::Validation(
                "Une QR-facture de paiement ne peut pas être attachée à un avoir.".into(),
            ));
        }
        if total_cents <= 0 || normalized.amount_cents != Some(total_cents) {
            return Err(AppError::Validation(
                "amount_cents doit correspondre exactement au total positif de la facture.".into(),
            ));
        }
        if normalized.currency != currency {
            return Err(AppError::Validation(
                "La devise QR doit correspondre à la devise de la facture.".into(),
            ));
        }
        let issued = number.as_deref().is_some_and(|value| !value.is_empty());
        if issued {
            let snapshot = parse_final_snapshot(
                snapshot_json.as_deref(),
                &input.invoice_id,
                number.as_deref().unwrap_or_default(),
            )?;
            validate_bill_against_final_snapshot(&normalized, &snapshot)?;
        }
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT input_json,payload FROM invoice_qr_bills WHERE invoice_id=?",
                params![input.invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored_input, stored_payload)) = existing.as_ref() {
            if stored_input == &input_json && stored_payload == &generated.payload {
                let result = stored_qr_bill(&tx, &input.invoice_id)?;
                tx.commit()?;
                return Ok(result);
            }
            if issued {
                return Err(AppError::Validation(
                    "La QR-facture d'une facture émise est immuable. Émettez un avoir et une nouvelle facture pour la corriger."
                        .into(),
                ));
            }
        }
        let now = now_iso();
        if existing.is_some() {
            tx.execute("UPDATE invoice_qr_bills SET input_json=?,payload=?,reference_type=?,is_qr_iban=?,character_count=?,byte_count=?,updated_at=? WHERE invoice_id=?",params![input_json,generated.payload,generated.reference_type,generated.is_qr_iban as i64,generated.character_count as i64,generated.byte_count as i64,now,input.invoice_id])?;
        } else {
            let frozen_at = issued.then_some(now.as_str());
            tx.execute("INSERT INTO invoice_qr_bills(invoice_id,input_json,payload,reference_type,is_qr_iban,character_count,byte_count,frozen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![input.invoice_id,input_json,generated.payload,generated.reference_type,generated.is_qr_iban as i64,generated.character_count as i64,generated.byte_count as i64,frozen_at,now,now])?;
        }
        let result = stored_qr_bill(&tx, &input.invoice_id)?;
        append_audit(
            &tx,
            if issued { "freeze" } else { "save" },
            "invoice_qr_bill",
            &input.invoice_id,
            &result,
        )?;
        tx.commit()?;
        Ok(result)
    }
}

/// Called inside invoice issuance, before its immutable snapshot is captured.
/// Explicit draft QR instructions remain authoritative; existing issued invoices
/// are never rewritten by this helper.
pub(crate) fn ensure_automatic_invoice_qr(
    connection: &Connection,
    snapshot: &Value,
) -> AppResult<()> {
    let document = &snapshot["document"];
    if matches!(text_at(document, "type").as_str(), "avoir" | "credit_note") {
        return Ok(());
    }
    let invoice_id = text_at(document, "id");
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM invoice_qr_bills WHERE invoice_id=?)",
        params![invoice_id],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let issuer = &snapshot["issuer"];
    let iban = text_at(issuer, "iban")
        .replace(char::is_whitespace, "")
        .to_uppercase();
    let currency = text_at(document, "currency");
    // The Swiss QR scheme has a defined account/currency scope.
    if !matches!(currency.as_str(), "CHF" | "EUR")
        || !(iban.starts_with("CH") || iban.starts_with("LI"))
    {
        return Ok(());
    }
    let qrr = qr_iid(&iban).is_some_and(|iid| (30_000..=31_999).contains(&iid));
    if qrr && currency != "CHF" {
        return Ok(());
    }
    let digest = Sha256::digest(invoice_id.as_bytes());
    let (reference_type, reference) = if qrr {
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        let base = (u128::from_be_bytes(bytes) % 10_u128.pow(26))
            .max(1)
            .to_string();
        ("QRR", generate_qrr(&base)?)
    } else {
        let body = format!("{:X}", digest);
        ("SCOR", generate_scor(&body[..21])?)
    };
    let collision: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM invoice_qr_bills WHERE reference_type=? AND json_extract(input_json,'$.reference')=?)",
        params![reference_type,reference], |row| row.get(0),
    )?;
    if collision {
        return Err(AppError::Validation(
            "La référence générée existe déjà; contrôlez la numérotation avant émission.".into(),
        ));
    }
    let bill = SwissQrBillInput {
        iban,
        creditor: snapshot_party(issuer, true),
        amount_cents: integer_at(document, "total_cents"),
        currency,
        debtor: Some(snapshot_party(&snapshot["customer"], false)),
        reference_type: reference_type.into(),
        reference,
        unstructured_message: format!("Facture {}", text_at(document, "number")),
        bill_information: String::new(),
        alternative_procedures: Vec::new(),
    };
    let generated = generate(bill.clone())?;
    validate_bill_against_final_snapshot(&bill, snapshot)?;
    let now = now_iso();
    connection.execute(
        "INSERT INTO invoice_qr_bills(invoice_id,input_json,payload,reference_type,is_qr_iban,character_count,byte_count,frozen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)",
        params![invoice_id,serde_json::to_string(&normalize(bill))?,generated.payload,generated.reference_type,generated.is_qr_iban as i64,generated.character_count as i64,generated.byte_count as i64,now,now],
    )?;
    Ok(())
}

fn parse_final_snapshot(raw: Option<&str>, invoice_id: &str, number: &str) -> AppResult<Value> {
    let raw = raw
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation(
                "La facture émise ne contient pas son instantané final; la QR-facture est bloquée."
                    .into(),
            )
        })?;
    let snapshot: Value = serde_json::from_str(raw).map_err(|_| {
        AppError::Validation("L'instantané final de la facture est illisible.".into())
    })?;
    let document = snapshot.get("document").unwrap_or(&Value::Null);
    if text_at(document, "id") != invoice_id || text_at(document, "number") != number {
        return Err(AppError::Validation(
            "L'instantané final ne correspond pas à l'identifiant et au numéro de la facture émise."
                .into(),
        ));
    }
    Ok(snapshot)
}

fn validate_loaded_final_qr_bill(
    connection: &Connection,
    invoice_id: &str,
    stored: &Value,
) -> AppResult<()> {
    let invoice: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT number,snapshot_json FROM invoices WHERE id=?",
            params![invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((number, snapshot_json)) = invoice else {
        return Err(AppError::NotFound(format!("invoices/{invoice_id}")));
    };
    let Some(number) = number.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let snapshot = parse_final_snapshot(snapshot_json.as_deref(), invoice_id, &number)?;
    let input: SwissQrBillInput = serde_json::from_value(
        stored
            .get("input")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| {
                AppError::Validation(
                    "La QR-facture enregistrée ne contient plus ses données structurées.".into(),
                )
            })?,
    )?;
    validate_bill_against_final_snapshot(&input, &snapshot)?;

    let snapshot_qr = snapshot.get("qr_bill").unwrap_or(&Value::Null);
    if snapshot_qr.is_null() {
        verify_frozen_supplement_audit(connection, invoice_id, stored)?;
    } else {
        let snapshot_input: Value = serde_json::from_str(&text_at(snapshot_qr, "input_json"))
            .map_err(|_| {
                AppError::Validation("La QR-facture de l'instantané final est illisible.".into())
            })?;
        if stored.get("input") != Some(&snapshot_input)
            || text_at(stored, "payload") != text_at(snapshot_qr, "payload")
            || text_at(stored, "frozen_at") != text_at(snapshot_qr, "frozen_at")
        {
            return Err(AppError::Validation(
                "La QR-facture relue ne correspond plus exactement à l'instantané final.".into(),
            ));
        }
    }
    Ok(())
}

fn stored_qr_bill(connection: &Connection, invoice_id: &str) -> AppResult<Value> {
    let Some(mut row) = query_all(
        connection,
        "SELECT * FROM invoice_qr_bills WHERE invoice_id=?",
        params![invoice_id],
    )?
    .into_iter()
    .next() else {
        return Ok(Value::Null);
    };
    let input = row
        .get("input_json")
        .and_then(Value::as_str)
        .map(serde_json::from_str::<Value>)
        .transpose()?
        .unwrap_or(Value::Null);
    let lines = row
        .get("payload")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split('\n')
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let frozen = row
        .get("frozen_at")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let object = row
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("QR-facture stockée invalide.".into()))?;
    object.remove("input_json");
    let is_qr_iban = object
        .get("is_qr_iban")
        .and_then(Value::as_i64)
        .is_some_and(|value| value == 1);
    object.insert("is_qr_iban".into(), json!(is_qr_iban));
    object.insert("input".into(), input);
    object.insert("lines".into(), json!(lines));
    object.insert("frozen".into(), json!(frozen));
    Ok(row)
}

fn text_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn integer_at(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn snapshot_party(issuer_or_customer: &Value, creditor: bool) -> SwissQrParty {
    let company = text_at(issuer_or_customer, "company");
    let legal_name = text_at(issuer_or_customer, "company_name");
    let bank_name = text_at(issuer_or_customer, "bank_name");
    let personal_name = text_at(issuer_or_customer, "name");
    SwissQrParty {
        name: if creditor {
            if bank_name.is_empty() {
                legal_name
            } else {
                bank_name
            }
        } else if company.is_empty() {
            personal_name
        } else {
            company
        },
        // Le champ rue SPC ne reçoit jamais address_line2. Le complément
        // d'adresse reste documentaire; le numéro de bâtiment a son propre
        // champ structuré.
        street: text_at(issuer_or_customer, "address_line1"),
        building_number: if creditor {
            text_at(issuer_or_customer, "building_number")
        } else {
            text_at(issuer_or_customer, "address_line2")
        },
        postal_code: text_at(issuer_or_customer, "postal_code"),
        city: text_at(issuer_or_customer, "city"),
        country: text_at(issuer_or_customer, "country").to_uppercase(),
    }
}

/// Vérifie l'identité de paiement d'une QR-facture contre l'instantané final.
/// Cette même règle est utilisée lors de l'ajout post-émission, de la relecture
/// et de l'export afin qu'aucun de ces chemins ne puisse diverger.
pub(crate) fn validate_bill_against_final_snapshot(
    input: &SwissQrBillInput,
    snapshot: &Value,
) -> AppResult<()> {
    let normalized = normalize(input.clone());
    let issuer = snapshot.get("issuer").unwrap_or(&Value::Null);
    let customer = snapshot.get("customer").unwrap_or(&Value::Null);
    let document = snapshot.get("document").unwrap_or(&Value::Null);
    if !issuer.is_object() || !customer.is_object() || !document.is_object() {
        return Err(AppError::Validation(
            "L'instantané final ne contient pas les parties et le document nécessaires à la QR-facture."
                .into(),
        ));
    }
    let expected_iban = text_at(issuer, "iban")
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    let expected_currency = text_at(document, "currency").to_uppercase();
    let expected_creditor = snapshot_party(issuer, true);
    let expected_debtor = snapshot_party(customer, false);
    if normalized.amount_cents != integer_at(document, "total_cents")
        || normalized.currency != expected_currency
        || normalized.iban != expected_iban
    {
        return Err(AppError::Validation(
            "La QR-facture ne correspond pas exactement au montant, à la devise ou à l'IBAN de l'instantané final."
                .into(),
        ));
    }
    if normalized.creditor != expected_creditor
        || normalized.debtor.as_ref() != Some(&expected_debtor)
    {
        return Err(AppError::Validation(
            "La QR-facture ne correspond pas exactement au créancier et au débiteur de l'instantané final."
                .into(),
        ));
    }
    Ok(())
}

/// Vérifie qu'un supplément QR ajouté après émission est figé, couvert par la
/// chaîne d'audit et identique à la preuve `freeze` enregistrée.
pub(crate) fn verify_frozen_supplement_audit(
    connection: &Connection,
    invoice_id: &str,
    stored: &Value,
) -> AppResult<()> {
    let frozen_at = text_at(stored, "frozen_at");
    if frozen_at.is_empty() || chrono::DateTime::parse_from_rfc3339(&frozen_at).is_err() {
        return Err(AppError::Validation(
            "Le supplément QR postérieur à l'émission n'est pas figé avec une date RFC 3339 valide."
                .into(),
        ));
    }
    crate::audit::verify_audit_chain(connection)?;
    let audited_payloads = query_all(
        connection,
        "SELECT payload_json FROM audit_log WHERE action='freeze' AND entity_type='invoice_qr_bill' AND entity_id=? ORDER BY rowid",
        params![invoice_id],
    )?;
    if audited_payloads.len() != 1 {
        return Err(AppError::Validation(
            "Le supplément QR figé doit être relié à une unique preuve d'audit immuable.".into(),
        ));
    }
    let audited: Value = serde_json::from_str(&text_at(&audited_payloads[0], "payload_json"))?;
    let stored_input = stored
        .get("input")
        .filter(|value| value.is_object())
        .cloned()
        .or_else(|| {
            stored
                .get("input_json")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        })
        .unwrap_or(Value::Null);
    if audited.get("input") != Some(&stored_input)
        || text_at(&audited, "payload") != text_at(stored, "payload")
        || text_at(&audited, "frozen_at") != frozen_at
        || text_at(&audited, "reference_type") != text_at(stored, "reference_type")
        || audited.get("is_qr_iban").and_then(Value::as_bool)
            != stored.get("is_qr_iban").and_then(|value| {
                value
                    .as_bool()
                    .or_else(|| value.as_i64().map(|number| number == 1))
            })
        || audited.get("character_count").and_then(Value::as_i64)
            != stored.get("character_count").and_then(Value::as_i64)
        || audited.get("byte_count").and_then(Value::as_i64)
            != stored.get("byte_count").and_then(Value::as_i64)
    {
        return Err(AppError::Validation(
            "Le supplément QR ne correspond plus exactement à sa preuve d'audit. Export bloqué."
                .into(),
        ));
    }
    Ok(())
}

pub fn validate(input: SwissQrBillInput) -> SwissQrValidation {
    let normalized = normalize(input);
    let mut errors = Vec::new();
    let warnings = Vec::new();
    let iban = normalized.iban.as_str();
    let iban_formal = validate_iban_format(iban);
    if !iban_formal {
        errors.push(
            "L'IBAN doit être un IBAN CH ou LI de 21 caractères et respecter son format.".into(),
        );
    } else if mod97(iban) != Some(1) {
        errors.push("La clé de contrôle modulo 97 de l'IBAN est invalide.".into());
    }
    let is_qr_iban =
        iban_formal && qr_iid(iban).is_some_and(|iid| (30_000..=31_999).contains(&iid));
    validate_party(&normalized.creditor, "creditor", &mut errors);
    if let Some(debtor) = &normalized.debtor {
        validate_party(debtor, "debtor", &mut errors);
    }
    if !matches!(normalized.currency.as_str(), "CHF" | "EUR") {
        errors.push("currency doit être CHF ou EUR.".into());
    }
    if let Some(amount) = normalized.amount_cents {
        if !(1..=99_999_999_999).contains(&amount) {
            errors.push("amount_cents doit représenter 0.01 à 999999999.99.".into());
        }
    }
    match normalized.reference_type.as_str() {
        "QRR" => {
            if !is_qr_iban {
                errors.push("Une référence QRR exige un QR-IBAN (QR-IID 30000 à 31999).".into());
            }
            if normalized.currency != "CHF" {
                errors.push("Le profil QR QRR de Zentra prend uniquement en charge le CHF.".into());
            }
            if !validate_qrr(&normalized.reference) {
                errors.push("La référence QRR doit contenir 27 chiffres, ne pas être nulle et réussir le modulo 10 récursif.".into());
            }
        }
        "SCOR" => {
            if is_qr_iban {
                errors.push("Un QR-IBAN ne peut pas être utilisé avec SCOR.".into());
            }
            if !validate_scor(&normalized.reference) {
                errors.push("La Creditor Reference SCOR (RF) est invalide.".into());
            }
        }
        "NON" => {
            if is_qr_iban {
                errors.push("Un QR-IBAN exige une référence QRR.".into());
            }
            if !normalized.reference.is_empty() {
                errors.push("reference doit être vide lorsque reference_type vaut NON.".into());
            }
        }
        _ => errors.push("reference_type doit être QRR, SCOR ou NON.".into()),
    }
    validate_text(
        &normalized.unstructured_message,
        "unstructured_message",
        140,
        false,
        &mut errors,
    );
    validate_text(
        &normalized.bill_information,
        "bill_information",
        140,
        false,
        &mut errors,
    );
    if normalized.unstructured_message.chars().count() + normalized.bill_information.chars().count()
        > 140
    {
        errors.push(
            "unstructured_message et bill_information sont limités ensemble à 140 caractères."
                .into(),
        );
    }
    if normalized.alternative_procedures.len() > 2 {
        errors.push("Deux procédures alternatives au maximum sont autorisées.".into());
    }
    if !normalized.alternative_procedures.is_empty() {
        errors.push("Les procédures alternatives ne sont pas générées sans identifiant de syntaxe officiellement enregistré.".into());
    }
    for (index, value) in normalized.alternative_procedures.iter().enumerate() {
        validate_text(
            value,
            &format!("alternative_procedures[{index}]"),
            100,
            true,
            &mut errors,
        );
    }
    let lines = build_lines(&normalized);
    let payload = lines.join("\n");
    if payload.chars().count() > 997 {
        errors.push("Le payload SPC dépasse 997 caractères, séparateurs compris.".into());
    }
    SwissQrValidation {
        valid: errors.is_empty(),
        errors,
        warnings,
        normalized,
        is_qr_iban,
    }
}

pub fn generate(input: SwissQrBillInput) -> AppResult<SwissQrPayload> {
    let validation = validate(input);
    if !validation.valid {
        return Err(AppError::Validation(validation.errors.join(" ")));
    }
    let lines = build_lines(&validation.normalized);
    let payload = lines.join("\n");
    Ok(SwissQrPayload {
        character_count: payload.chars().count(),
        byte_count: payload.len(),
        payload,
        lines,
        reference_type: validation.normalized.reference_type,
        is_qr_iban: validation.is_qr_iban,
    })
}

pub fn generate_qrr(base: &str) -> AppResult<String> {
    let value = base
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    if value.len() > 26 || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::Validation(
            "La base QRR doit contenir 1 à 26 chiffres.".into(),
        ));
    }
    let padded = format!("{:0>26}", value);
    let table = [0_u8, 9, 4, 6, 8, 2, 7, 1, 3, 5];
    let mut report = 0_usize;
    for digit in padded.bytes() {
        report = table[(report + (digit - b'0') as usize) % 10] as usize;
    }
    let check = (10 - report) % 10;
    Ok(format!("{padded}{check}"))
}

pub fn generate_scor(body: &str) -> AppResult<String> {
    let body = body
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if body.is_empty() || body.len() > 21 || !body.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::Validation(
            "Le corps SCOR doit contenir 1 à 21 caractères alphanumériques.".into(),
        ));
    }
    let candidate = format!("{body}RF00");
    let remainder = mod97_alphanumeric(&candidate)
        .ok_or_else(|| AppError::Validation("Corps SCOR invalide.".into()))?;
    Ok(format!("RF{:02}{body}", 98 - remainder))
}

pub(crate) fn normalize_and_validate_iban(value: &str) -> AppResult<String> {
    let normalized = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if !validate_iban_format(&normalized) || mod97(&normalized) != Some(1) {
        return Err(AppError::Validation(
            "iban doit être un IBAN CH ou LI valide avec une clé modulo 97 correcte.".into(),
        ));
    }
    Ok(normalized)
}

fn normalize(mut input: SwissQrBillInput) -> SwissQrBillInput {
    input.iban = input
        .iban
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    input.currency = input.currency.trim().to_uppercase();
    input.reference_type = input.reference_type.trim().to_uppercase();
    input.reference = input
        .reference
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    normalize_party(&mut input.creditor);
    if let Some(p) = input.debtor.as_mut() {
        normalize_party(p);
    }
    input.unstructured_message = input.unstructured_message.trim().into();
    input.bill_information = input.bill_information.trim().into();
    input.alternative_procedures = input
        .alternative_procedures
        .into_iter()
        .map(|v| v.trim().into())
        .collect();
    input
}
fn normalize_party(p: &mut SwissQrParty) {
    p.name = p.name.trim().into();
    p.street = p.street.trim().into();
    p.building_number = p.building_number.trim().into();
    p.postal_code = p.postal_code.trim().into();
    p.city = p.city.trim().into();
    p.country = p.country.trim().to_uppercase();
}
fn validate_party(p: &SwissQrParty, prefix: &str, errors: &mut Vec<String>) {
    validate_text(&p.name, &format!("{prefix}.name"), 70, true, errors);
    validate_text(&p.street, &format!("{prefix}.street"), 70, false, errors);
    validate_text(
        &p.building_number,
        &format!("{prefix}.building_number"),
        16,
        false,
        errors,
    );
    validate_text(
        &p.postal_code,
        &format!("{prefix}.postal_code"),
        16,
        true,
        errors,
    );
    validate_text(&p.city, &format!("{prefix}.city"), 35, true, errors);
    if !is_iso_3166_alpha_2(&p.country) {
        errors.push(format!(
            "{prefix}.country doit être un code pays ISO 3166-1 alpha-2 réel en majuscules."
        ));
    }
}

fn is_iso_3166_alpha_2(value: &str) -> bool {
    // Liste officielle alpha-2 (249 territoires). XK n'est volontairement pas
    // inclus car il ne s'agit pas d'un code ISO 3166-1 attribué.
    const CODES: &str = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";
    value.len() == 2
        && value.bytes().all(|byte| byte.is_ascii_uppercase())
        && CODES.split_ascii_whitespace().any(|code| code == value)
}
fn validate_text(value: &str, field: &str, max: usize, required: bool, errors: &mut Vec<String>) {
    let count = value.chars().count();
    if required && count == 0 {
        errors.push(format!("{field} est obligatoire."));
        return;
    }
    if count > max {
        errors.push(format!("{field} dépasse {max} caractères."));
    }
    if value.chars().any(|c| !allowed_char(c)) {
        errors.push(format!("{field} contient un caractère non admis par SIX."));
    }
}
fn allowed_char(c: char) -> bool {
    matches!(c as u32,0x20..=0x7e|0x00a0..=0x00ff|0x0100..=0x017f|0x0218|0x0219|0x021a|0x021b|0x20ac)
}
fn validate_iban_format(iban: &str) -> bool {
    iban.is_ascii()
        && iban.len() == 21
        && matches!(&iban[0..2], "CH" | "LI")
        && iban.as_bytes()[2..9].iter().all(u8::is_ascii_digit)
        && iban.as_bytes()[9..].iter().all(u8::is_ascii_alphanumeric)
}
fn qr_iid(iban: &str) -> Option<i64> {
    iban.get(4..9)?.parse().ok()
}
fn mod97(value: &str) -> Option<i64> {
    if value.len() < 4 {
        return None;
    }
    let rearranged = format!("{}{}", &value[4..], &value[..4]);
    mod97_alphanumeric(&rearranged)
}
fn mod97_alphanumeric(value: &str) -> Option<i64> {
    let mut remainder = 0_i64;
    for b in value.bytes() {
        if b.is_ascii_digit() {
            remainder = (remainder * 10 + (b - b'0') as i64) % 97;
        } else if b.is_ascii_uppercase() {
            let n = (b - b'A' + 10) as i64;
            remainder = (remainder * 100 + n) % 97;
        } else {
            return None;
        }
    }
    Some(remainder)
}
pub(crate) fn validate_qrr(value: &str) -> bool {
    if value.len() != 27
        || value.bytes().all(|b| b == b'0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    let table = [0_u8, 9, 4, 6, 8, 2, 7, 1, 3, 5];
    let mut report = 0_usize;
    for digit in value.bytes() {
        report = table[(report + (digit - b'0') as usize) % 10] as usize;
    }
    report == 0
}
pub(crate) fn validate_scor(value: &str) -> bool {
    value.len() >= 5
        && value.len() <= 25
        && value.starts_with("RF")
        && value.as_bytes()[2..4].iter().all(u8::is_ascii_digit)
        && value.bytes().all(|b| b.is_ascii_alphanumeric())
        && mod97(value) == Some(1)
}
fn build_lines(input: &SwissQrBillInput) -> Vec<String> {
    let mut lines = vec![
        "SPC".into(),
        "0200".into(),
        "1".into(),
        input.iban.clone(),
        "S".into(),
        input.creditor.name.clone(),
        input.creditor.street.clone(),
        input.creditor.building_number.clone(),
        input.creditor.postal_code.clone(),
        input.creditor.city.clone(),
        input.creditor.country.clone(),
    ];
    lines.extend((0..7).map(|_| String::new()));
    lines.push(
        input
            .amount_cents
            .map(|v| format!("{}.{:02}", v / 100, v % 100))
            .unwrap_or_default(),
    );
    lines.push(input.currency.clone());
    if let Some(p) = &input.debtor {
        lines.extend([
            "S".into(),
            p.name.clone(),
            p.street.clone(),
            p.building_number.clone(),
            p.postal_code.clone(),
            p.city.clone(),
            p.country.clone(),
        ]);
    } else {
        lines.extend((0..7).map(|_| String::new()));
    }
    lines.extend([
        input.reference_type.clone(),
        input.reference.clone(),
        input.unstructured_message.clone(),
        "EPD".into(),
    ]);
    if !input.bill_information.is_empty() || !input.alternative_procedures.is_empty() {
        lines.push(input.bill_information.clone());
        for value in &input.alternative_procedures {
            lines.push(value.clone());
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_qrr_vector() {
        assert_eq!(
            generate_qrr("21000000000313947143000901").unwrap(),
            "210000000003139471430009017"
        );
        assert!(validate_qrr("210000000003139471430009017"));
    }
    #[test]
    fn scor_round_trip() {
        let reference = generate_scor("HELVI2026").unwrap();
        assert!(validate_scor(&reference));
    }
    #[test]
    fn six_spc_payload_is_strict_and_has_no_network_dependency() {
        let input = SwissQrBillInput {
            iban: "CH4431999123000889012".into(),
            creditor: SwissQrParty {
                name: "Robert Schneider AG".into(),
                street: "Rue du Lac".into(),
                building_number: "1268".into(),
                postal_code: "2501".into(),
                city: "Biel".into(),
                country: "CH".into(),
            },
            amount_cents: Some(194_900),
            currency: "CHF".into(),
            debtor: None,
            reference_type: "QRR".into(),
            reference: "210000000003139471430009017".into(),
            unstructured_message: String::new(),
            bill_information: String::new(),
            alternative_procedures: vec![],
        };
        let validation = validate(input.clone());
        assert!(validation.valid, "{:?}", validation.errors);
        let generated = generate(input).unwrap();
        assert_eq!(generated.lines.len(), 31);
        assert_eq!(generated.lines[0], "SPC");
        assert_eq!(generated.lines[1], "0200");
        assert_eq!(generated.lines[30], "EPD");
        assert!(!generated.payload.ends_with('\n'));
    }

    fn party(country: &str) -> SwissQrParty {
        SwissQrParty {
            name: "Société Exemple".into(),
            street: "Rue du Lac".into(),
            building_number: "8".into(),
            postal_code: "1000".into(),
            city: "Lausanne".into(),
            country: country.into(),
        }
    }

    fn non_reference_bill(country: &str) -> SwissQrBillInput {
        SwissQrBillInput {
            iban: "CH9300762011623852957".into(),
            creditor: party(country),
            amount_cents: Some(10_000),
            currency: "CHF".into(),
            debtor: Some(party(country)),
            reference_type: "NON".into(),
            reference: String::new(),
            unstructured_message: String::new(),
            bill_information: String::new(),
            alternative_procedures: vec![],
        }
    }

    #[test]
    fn country_must_be_a_real_iso_3166_alpha_2_code() {
        for country in ["CH", "LI", "FR"] {
            let validation = validate(non_reference_bill(country));
            assert!(validation.valid, "{country}: {:?}", validation.errors);
        }
        for country in ["ZZ", "XX"] {
            let validation = validate(non_reference_bill(country));
            assert!(!validation.valid, "{country} doit être rejeté");
            assert!(validation
                .errors
                .iter()
                .any(|error| error.contains("ISO 3166-1")));
        }
    }

    #[test]
    fn final_snapshot_identity_uses_address_line1_without_address_line2() {
        let snapshot = json!({
            "issuer": {
                "company_name": "Société Exemple",
                "bank_name": "Titulaire Exemple",
                "address_line1": "Rue canonique",
                "address_line2": "Complément bâtiment B",
                "building_number": "8",
                "postal_code": "1000",
                "city": "Lausanne",
                "country": "CH",
                "iban": "CH93 0076 2011 6238 5295 7"
            },
            "customer": {
                "name": "Client Exemple",
                "company": "",
                "address_line1": "Route du Client",
                "address_line2": "12",
                "postal_code": "1200",
                "city": "Genève",
                "country": "FR"
            },
            "document": {"total_cents": 10_000, "currency": "CHF"}
        });
        let mut input = non_reference_bill("CH");
        input.creditor = SwissQrParty {
            name: "Titulaire Exemple".into(),
            street: "Rue canonique".into(),
            building_number: "8".into(),
            postal_code: "1000".into(),
            city: "Lausanne".into(),
            country: "CH".into(),
        };
        input.debtor = Some(SwissQrParty {
            name: "Client Exemple".into(),
            street: "Route du Client".into(),
            building_number: "12".into(),
            postal_code: "1200".into(),
            city: "Genève".into(),
            country: "FR".into(),
        });
        assert!(validate_bill_against_final_snapshot(&input, &snapshot).is_ok());

        let mut address_line2_leaked = input.clone();
        address_line2_leaked.creditor.street = "Rue canonique\nComplément bâtiment B".into();
        assert!(validate_bill_against_final_snapshot(&address_line2_leaked, &snapshot).is_err());

        let mut wrong_iban = input.clone();
        wrong_iban.iban = "CH4431999123000889012".into();
        assert!(validate_bill_against_final_snapshot(&wrong_iban, &snapshot).is_err());

        let mut wrong_debtor = input;
        wrong_debtor.debtor.as_mut().unwrap().city = "Nyon".into();
        assert!(validate_bill_against_final_snapshot(&wrong_debtor, &snapshot).is_err());
    }
}

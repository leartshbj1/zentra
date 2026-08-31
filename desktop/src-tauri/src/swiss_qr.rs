use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

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
        stored_qr_bill(&connection, invoice_id)
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
        let (number, invoice_type, total_cents, currency): (Option<String>, String, i64, String) =
            tx.query_row(
                "SELECT number,type,total_cents,currency FROM invoices WHERE id=?",
                params![input.invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
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
                errors.push("Le profil QR QRR d'Elyko prend uniquement en charge le CHF.".into());
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
    if p.country.len() != 2 || !p.country.bytes().all(|b| b.is_ascii_uppercase()) {
        errors.push(format!(
            "{prefix}.country doit être un code ISO alpha-2 en majuscules."
        ));
    }
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
}

//! Coordonnées de paiement des factures fournisseurs (lues sur la QR-facture)
//! et ordres de paiement pain.001 pour l'e-banking.
//!
//! Le fichier XML est construit par l'interface à partir des données de
//! l'app. Ici, chaque ligne est recontrôlée contre la base (facture validée,
//! solde ouvert, compte de l'entreprise) avant d'écrire le fichier et de
//! garder la trace de l'ordre. Rien n'est payé : la banque exécute l'ordre,
//! puis le relevé CAMT confirme chaque paiement par le rapprochement habituel.

use std::{collections::HashSet, io::Write, path::PathBuf};

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
    swiss_qr::{normalize_and_validate_iban, validate_qrr, validate_scor},
};

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierInvoicePaymentDetailsInput {
    pub supplier_invoice_id: String,
    pub creditor_iban: String,
    pub reference_type: String,
    #[serde(default)]
    pub reference: String,
    pub creditor_name: String,
    #[serde(default)]
    pub creditor_street: String,
    #[serde(default)]
    pub creditor_building_number: String,
    #[serde(default)]
    pub creditor_postal_code: String,
    #[serde(default)]
    pub creditor_city: String,
    #[serde(default)]
    pub creditor_country: String,
    #[serde(default)]
    pub amount_cents: Option<i64>,
    pub currency: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub bill_information: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierPaymentOrderItemInput {
    pub supplier_invoice_id: String,
    pub end_to_end_id: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportSupplierPaymentOrderInput {
    pub destination: String,
    pub message_id: String,
    pub execution_date: String,
    pub debtor_iban: String,
    pub xml: String,
    pub items: Vec<SupplierPaymentOrderItemInput>,
}

fn trimmed(value: &str, label: &str, max: usize) -> AppResult<String> {
    let value = value.trim();
    if value.chars().count() > max {
        return Err(AppError::Validation(format!("{label} : {max} caractères au plus.")));
    }
    Ok(value.to_owned())
}

/// Identifiant ISO 20022 (35 caractères, jeu restreint des SPS).
fn identifier(value: &str, label: &str) -> AppResult<String> {
    let value = value.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || "+?/-:().,' ".contains(c);
    if value.is_empty() || value.chars().count() > 35 || !value.chars().all(allowed) {
        return Err(AppError::Validation(format!("{label} invalide pour l'ordre de paiement.")));
    }
    Ok(value.to_owned())
}

/// IBAN avec clé 97, longueur 15 à 34. Les IBAN CH/LI suivent la règle suisse complète.
fn creditor_iban(value: &str) -> AppResult<String> {
    let iban: String = value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    if iban.starts_with("CH") || iban.starts_with("LI") {
        return normalize_and_validate_iban(&iban);
    }
    let shape = iban.len() >= 15
        && iban.len() <= 34
        && iban.is_ascii()
        && iban.as_bytes()[..2].iter().all(u8::is_ascii_uppercase)
        && iban.as_bytes()[2..4].iter().all(u8::is_ascii_digit)
        && iban.bytes().all(|b| b.is_ascii_alphanumeric());
    if !shape || iban_mod97(&iban) != Some(1) {
        return Err(invalid("L'IBAN du fournisseur n'est pas valide."));
    }
    Ok(iban)
}

fn iban_mod97(iban: &str) -> Option<u32> {
    let rearranged = format!("{}{}", iban.get(4..)?, iban.get(..4)?);
    let mut remainder = 0_u32;
    for byte in rearranged.bytes() {
        if byte.is_ascii_digit() {
            remainder = (remainder * 10 + u32::from(byte - b'0')) % 97;
        } else if byte.is_ascii_uppercase() {
            remainder = (remainder * 100 + u32::from(byte - b'A') + 10) % 97;
        } else {
            return None;
        }
    }
    Some(remainder)
}

fn is_qr_iban(iban: &str) -> bool {
    (iban.starts_with("CH") || iban.starts_with("LI"))
        && iban.get(4..9).and_then(|value| value.parse::<u32>().ok()).is_some_and(|iid| (30000..=31999).contains(&iid))
}

pub(crate) fn validate_payment_details(input: &SupplierInvoicePaymentDetailsInput) -> AppResult<SupplierInvoicePaymentDetailsInput> {
    let iban = creditor_iban(&input.creditor_iban)?;
    let reference_type = input.reference_type.trim().to_uppercase();
    let reference: String = input.reference.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    match reference_type.as_str() {
        "QRR" if !validate_qrr(&reference) => return Err(invalid("La référence QR n'est pas valide.")),
        "SCOR" if !validate_scor(&reference) => return Err(invalid("La référence créancier (RF) n'est pas valide.")),
        "NON" if !reference.is_empty() => return Err(invalid("Une communication sans référence ne porte pas de numéro de référence.")),
        "QRR" | "SCOR" | "NON" => {}
        _ => return Err(invalid("Type de référence de paiement inconnu.")),
    }
    // Règles de la QR-facture : QR-IBAN avec référence QR, et seulement avec elle.
    if is_qr_iban(&iban) != (reference_type == "QRR") {
        return Err(invalid("Un QR-IBAN s'utilise avec une référence QR, et une référence QR avec un QR-IBAN."));
    }
    let currency = input.currency.trim().to_uppercase();
    if currency != "CHF" && currency != "EUR" {
        return Err(invalid("La monnaie de paiement doit être CHF ou EUR."));
    }
    if let Some(amount) = input.amount_cents {
        if !(1..=99_999_999_999).contains(&amount) {
            return Err(invalid("Le montant de la QR-facture est invalide."));
        }
    }
    let country = input.creditor_country.trim().to_uppercase();
    if !country.is_empty() && (country.len() != 2 || !country.bytes().all(|b| b.is_ascii_uppercase())) {
        return Err(invalid("Le pays du créancier doit être un code à deux lettres."));
    }
    let source = input.source.trim();
    if source != "qr_bill" && source != "manual" {
        return Err(invalid("Origine des coordonnées de paiement inconnue."));
    }
    let name = trimmed(&input.creditor_name, "Nom du créancier", 70)?;
    if name.is_empty() {
        return Err(invalid("Le nom du créancier est obligatoire."));
    }
    Ok(SupplierInvoicePaymentDetailsInput {
        supplier_invoice_id: trimmed(&input.supplier_invoice_id, "Facture fournisseur", 100)?,
        creditor_iban: iban,
        reference_type,
        reference,
        creditor_name: name,
        creditor_street: trimmed(&input.creditor_street, "Rue", 70)?,
        creditor_building_number: trimmed(&input.creditor_building_number, "Numéro", 16)?,
        creditor_postal_code: trimmed(&input.creditor_postal_code, "NPA", 16)?,
        creditor_city: trimmed(&input.creditor_city, "Localité", 35)?,
        creditor_country: country,
        amount_cents: input.amount_cents,
        currency,
        message: trimmed(&input.message, "Communication", 140)?,
        bill_information: trimmed(&input.bill_information, "Informations de facture", 140)?,
        source: source.to_owned(),
    })
}

pub(crate) fn validate_xml_destination(raw_path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_absolute() {
        return Err(invalid("Choisissez un emplacement local pour l'ordre de paiement."));
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("xml"))
    {
        return Err(invalid("L'ordre de paiement doit porter l'extension .xml."));
    }
    let parent = path.parent().ok_or_else(|| invalid("Le dossier de destination est invalide."))?;
    if !parent.is_dir() {
        return Err(invalid("Le dossier de destination n'existe pas."));
    }
    Ok(path)
}

pub(crate) fn format_amount(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

/// Contrôles de cohérence du fichier reçu de l'interface, sans le réécrire.
pub(crate) fn check_order_xml(xml: &str, message_id: &str, execution_date: &str, debtor_iban: &str, items: &[SupplierPaymentOrderItemInput]) -> AppResult<()> {
    if xml.len() > 5_000_000 || !xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>") {
        return Err(invalid("Le fichier d'ordre de paiement est invalide."));
    }
    let total: i64 = items.iter().map(|item| item.amount_cents).sum();
    let required = [
        "xmlns=\"urn:iso:std:iso:20022:tech:xsd:pain.001.001.09\"".to_owned(),
        format!("<MsgId>{message_id}</MsgId>"),
        format!("<Dt>{execution_date}</Dt>"),
        format!("<IBAN>{debtor_iban}</IBAN>"),
        format!("<CtrlSum>{}</CtrlSum>", format_amount(total)),
        format!("<NbOfTxs>{}</NbOfTxs>", items.len()),
    ];
    if required.iter().any(|needle| !xml.contains(needle.as_str())) {
        return Err(invalid("Le fichier ne correspond pas aux factures choisies. Préparez l'ordre à nouveau."));
    }
    if xml.matches("<CdtTrfTxInf>").count() != items.len() {
        return Err(invalid("Le nombre de paiements du fichier ne correspond pas aux factures choisies."));
    }
    for item in items {
        if !xml.contains(&format!("<EndToEndId>{}</EndToEndId>", item.end_to_end_id)) {
            return Err(invalid("Un paiement du fichier ne correspond pas aux factures choisies."));
        }
    }
    Ok(())
}

impl LocalStore {
    pub fn save_supplier_invoice_payment_details(&self, input: SupplierInvoicePaymentDetailsInput) -> AppResult<Value> {
        let details = validate_payment_details(&input)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=?)",
            params![details.supplier_invoice_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("supplier_invoices/{}", details.supplier_invoice_id)));
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO supplier_invoice_payment_details(supplier_invoice_id,creditor_iban,reference_type,reference,creditor_name,creditor_street,creditor_building_number,creditor_postal_code,creditor_city,creditor_country,amount_cents,currency,message,bill_information,source,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(supplier_invoice_id) DO UPDATE SET creditor_iban=excluded.creditor_iban,reference_type=excluded.reference_type,reference=excluded.reference,creditor_name=excluded.creditor_name,creditor_street=excluded.creditor_street,creditor_building_number=excluded.creditor_building_number,creditor_postal_code=excluded.creditor_postal_code,creditor_city=excluded.creditor_city,creditor_country=excluded.creditor_country,amount_cents=excluded.amount_cents,currency=excluded.currency,message=excluded.message,bill_information=excluded.bill_information,source=excluded.source,updated_at=excluded.updated_at",
            params![
                details.supplier_invoice_id,
                details.creditor_iban,
                details.reference_type,
                details.reference,
                details.creditor_name,
                details.creditor_street,
                details.creditor_building_number,
                details.creditor_postal_code,
                details.creditor_city,
                details.creditor_country,
                details.amount_cents,
                details.currency,
                details.message,
                details.bill_information,
                details.source,
                now,
                now,
            ],
        )?;
        let saved = query_all(
            &tx,
            "SELECT * FROM supplier_invoice_payment_details WHERE supplier_invoice_id=?",
            params![details.supplier_invoice_id],
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
        append_audit(&tx, "payment_details.saved", "supplier_invoice", &details.supplier_invoice_id, &saved)?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn delete_supplier_invoice_payment_details(&self, supplier_invoice_id: &str) -> AppResult<Value> {
        let id = trimmed(supplier_invoice_id, "Facture fournisseur", 100)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed = tx.execute("DELETE FROM supplier_invoice_payment_details WHERE supplier_invoice_id=?", params![id])?;
        if removed > 0 {
            append_audit(&tx, "payment_details.deleted", "supplier_invoice", &id, &json!({"supplier_invoice_id": id}))?;
        }
        tx.commit()?;
        Ok(json!({"deleted": removed > 0, "supplierInvoiceId": id}))
    }

    pub fn export_supplier_payment_order(&self, input: ExportSupplierPaymentOrderInput) -> AppResult<Value> {
        let path = validate_xml_destination(&input.destination)?;
        let message_id = identifier(&input.message_id, "Identifiant de l'ordre")?;
        if chrono::NaiveDate::parse_from_str(&input.execution_date, "%Y-%m-%d").is_err() {
            return Err(invalid("La date d'exécution est invalide."));
        }
        if input.items.is_empty() || input.items.len() > 1000 {
            return Err(invalid("Choisissez entre 1 et 1000 factures à payer."));
        }
        let debtor_iban = normalize_and_validate_iban(&input.debtor_iban)?;
        let mut seen_invoices = HashSet::new();
        let mut seen_ids = HashSet::new();
        for item in &input.items {
            identifier(&item.end_to_end_id, "Référence de paiement")?;
            if item.amount_cents <= 0 {
                return Err(invalid("Chaque paiement doit avoir un montant positif."));
            }
            if !seen_invoices.insert(item.supplier_invoice_id.clone()) || !seen_ids.insert(item.end_to_end_id.clone()) {
                return Err(invalid("Une facture figure deux fois dans l'ordre de paiement."));
            }
        }
        check_order_xml(&input.xml, &message_id, &input.execution_date, &debtor_iban, &input.items)?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let company_iban: Option<String> = tx
            .query_row("SELECT iban FROM settings WHERE id=1", [], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten();
        let company_iban = company_iban
            .map(|value| value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase())
            .unwrap_or_default();
        if company_iban != debtor_iban {
            return Err(invalid("Le compte à débiter doit être l'IBAN de l'entreprise, enregistré dans les réglages."));
        }
        for item in &input.items {
            let row: Option<(String, i64)> = tx
                .query_row(
                    "SELECT status,MAX(0,total_cents-paid_cents-COALESCE(credited_cents,0)) FROM supplier_invoices WHERE id=?",
                    params![item.supplier_invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((status, balance)) = row else {
                return Err(AppError::NotFound(format!("supplier_invoices/{}", item.supplier_invoice_id)));
            };
            if status != "validated" {
                return Err(invalid("Seule une facture fournisseur validée peut être payée."));
            }
            if item.amount_cents > balance {
                return Err(invalid("Un montant dépasse le solde ouvert de sa facture. Actualisez la liste et préparez l'ordre à nouveau."));
            }
        }
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM supplier_payment_orders WHERE message_id=?)",
            params![message_id],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(invalid("Cet ordre de paiement a déjà été enregistré."));
        }

        let sha = format!("{:x}", Sha256::digest(input.xml.as_bytes()));
        let total: i64 = input.items.iter().map(|item| item.amount_cents).sum();
        let id = Uuid::new_v4().to_string();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("ordre-de-paiement.xml")
            .chars()
            .take(200)
            .collect::<String>();
        let created_at = now_iso();
        tx.execute(
            "INSERT INTO supplier_payment_orders(id,message_id,execution_date,debtor_iban,transaction_count,total_cents,xml_sha256,file_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            params![id, message_id, input.execution_date, debtor_iban, input.items.len() as i64, total, sha, file_name, created_at],
        )?;
        for item in &input.items {
            tx.execute(
                "INSERT INTO supplier_payment_order_items(payment_order_id,supplier_invoice_id,end_to_end_id,amount_cents) VALUES(?,?,?,?)",
                params![id, item.supplier_invoice_id, item.end_to_end_id, item.amount_cents],
            )?;
        }
        append_audit(
            &tx,
            "supplier_payment_order.exported",
            "supplier_payment_order",
            &id,
            &json!({"message_id": message_id, "execution_date": input.execution_date, "total_cents": total, "count": input.items.len(), "xml_sha256": sha, "file_name": file_name}),
        )?;
        // Le fichier est écrit avant la validation de la trace : si l'écriture
        // échoue, aucun ordre fantôme ne reste en base.
        let parent = path.parent().ok_or_else(|| invalid("Le dossier de destination est invalide."))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(input.xml.as_bytes())?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path).map_err(|error| AppError::Io(error.error))?;
        tx.commit()?;
        Ok(json!({
            "id": id,
            "path": path.to_string_lossy(),
            "messageId": message_id,
            "transactionCount": input.items.len(),
            "totalCents": total,
            "xmlSha256": sha,
        }))
    }
}

#[tauri::command]
pub fn save_supplier_invoice_payment_details(
    state: tauri::State<'_, LocalStore>,
    input: SupplierInvoicePaymentDetailsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_supplier_invoice_payment_details(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_supplier_invoice_payment_details(
    state: tauri::State<'_, LocalStore>,
    supplier_invoice_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_supplier_invoice_payment_details(&supplier_invoice_id).map_err(command_error)
}

#[tauri::command]
pub fn export_supplier_payment_order(
    state: tauri::State<'_, LocalStore>,
    input: ExportSupplierPaymentOrderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.export_supplier_payment_order(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(iban: &str, kind: &str, reference: &str) -> SupplierInvoicePaymentDetailsInput {
        SupplierInvoicePaymentDetailsInput {
            supplier_invoice_id: "s1".into(),
            creditor_iban: iban.into(),
            reference_type: kind.into(),
            reference: reference.into(),
            creditor_name: "Robert Schneider AG".into(),
            creditor_street: "Rue du Lac".into(),
            creditor_building_number: "1268".into(),
            creditor_postal_code: "2501".into(),
            creditor_city: "Biel".into(),
            creditor_country: "ch".into(),
            amount_cents: Some(194_975),
            currency: "chf".into(),
            message: String::new(),
            bill_information: String::new(),
            source: "qr_bill".into(),
        }
    }

    #[test]
    fn payment_details_follow_the_qr_bill_rules() {
        let ok = validate_payment_details(&details("CH44 3199 9123 0008 8901 2", "QRR", "21 00000 00003 13947 14300 09017")).unwrap();
        assert_eq!(ok.creditor_iban, "CH4431999123000889012");
        assert_eq!(ok.reference, "210000000003139471430009017");
        assert_eq!(ok.creditor_country, "CH");
        assert_eq!(ok.currency, "CHF");
        assert!(validate_payment_details(&details("CH5800791123000889012", "SCOR", "RF18 5390 0754 7034")).is_ok());
        assert!(validate_payment_details(&details("CH5800791123000889012", "NON", "")).is_ok());
        // QR-IBAN sans référence QR, et l'inverse.
        assert!(validate_payment_details(&details("CH4431999123000889012", "NON", "")).is_err());
        assert!(validate_payment_details(&details("CH5800791123000889012", "QRR", "210000000003139471430009017")).is_err());
        assert!(validate_payment_details(&details("CH4431999123000889012", "QRR", "210000000003139471430009018")).is_err());
        assert!(validate_payment_details(&details("DE89370400440532013000", "NON", "")).is_ok());
        assert!(validate_payment_details(&details("DE89370400440532013001", "NON", "")).is_err());
    }

    #[test]
    fn order_file_must_match_the_chosen_invoices() {
        let items = vec![
            SupplierPaymentOrderItemInput { supplier_invoice_id: "a".into(), end_to_end_id: "R-1".into(), amount_cents: 194_975 },
            SupplierPaymentOrderItemInput { supplier_invoice_id: "b".into(), end_to_end_id: "R-2".into(), amount_cents: 8_990 },
        ];
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:pain.001.001.09\"><MsgId>M1</MsgId><NbOfTxs>2</NbOfTxs><CtrlSum>2039.65</CtrlSum><Dt>2026-10-21</Dt><IBAN>CH9300762011623852957</IBAN><CdtTrfTxInf><EndToEndId>R-1</EndToEndId></CdtTrfTxInf><CdtTrfTxInf><EndToEndId>R-2</EndToEndId></CdtTrfTxInf></Document>";
        assert!(check_order_xml(xml, "M1", "2026-10-21", "CH9300762011623852957", &items).is_ok());
        assert!(check_order_xml(xml, "M1", "2026-10-22", "CH9300762011623852957", &items).is_err());
        assert!(check_order_xml(&xml.replace("2039.65", "2039.66"), "M1", "2026-10-21", "CH9300762011623852957", &items).is_err());
        assert!(check_order_xml(xml, "M1", "2026-10-21", "CH9300762011623852957", &items[..1]).is_err());
        assert_eq!(format_amount(1), "0.01");
        assert_eq!(format_amount(194_975), "1949.75");
    }

    #[test]
    fn destination_must_be_an_absolute_xml_file() {
        assert!(validate_xml_destination("ordre.xml").is_err());
        let folder = tempfile::tempdir().unwrap();
        assert!(validate_xml_destination(&folder.path().join("ordre.pdf").to_string_lossy()).is_err());
        assert!(validate_xml_destination(&folder.path().join("ordre.xml").to_string_lossy()).is_ok());
        assert!(validate_xml_destination(&folder.path().join("absent").join("ordre.xml").to_string_lossy()).is_err());
    }
}

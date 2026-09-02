use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use encoding_rs::WINDOWS_1252;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, ObjectId, Stream, StringFormat,
};
use qrcode::{Color as QrColor, EcLevel, QrCode};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    branding::{load_pdf_logo_with_fallback, PdfLogo},
    database::{enrich_issuer_snapshot, query_all, row_to_json_public, LocalStore},
    error::{AppError, AppResult},
    models::{GenerateSalesDocumentPdfInput, SwissQrBillInput},
    swiss_qr,
};

const fn mm(value: f32) -> f32 {
    value * 72.0 / 25.4
}

const PAGE_WIDTH: f32 = mm(210.0);
const PAGE_HEIGHT: f32 = mm(297.0);
const QR_SECTION_HEIGHT: f32 = mm(105.0);
const MARGIN: f32 = mm(15.0);
const INK: [f32; 3] = [0.075, 0.12, 0.1];
const GREEN: [f32; 3] = [0.075, 0.30, 0.20];
const GREEN_PALE: [f32; 3] = [0.93, 0.96, 0.94];
const MUTED: [f32; 3] = [0.36, 0.43, 0.39];
const LINE: [f32; 3] = [0.82, 0.86, 0.83];
const DRAFT: [f32; 3] = [0.91, 0.92, 0.91];
const DESCRIPTION_TEXT_WIDTH: f32 = 190.0;
const NOTES_TEXT_WIDTH: f32 = 245.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SalesDocumentKind {
    Quote,
    Invoice,
}

#[derive(Debug, Clone)]
struct SalesPdfIssuer {
    company_name: String,
    legal_form: String,
    address: Vec<String>,
    uid_number: String,
    vat_number: String,
    vat_registered: bool,
    iban: String,
    logo_path: String,
}

#[derive(Debug, Clone)]
struct SalesPdfCustomer {
    name: String,
    address: Vec<String>,
    email: String,
}

#[derive(Debug, Clone)]
struct SalesPdfLine {
    description: String,
    quantity: f64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    net_cents: i64,
    vat_cents: i64,
    total_cents: i64,
}

#[derive(Debug, Clone)]
struct SalesPdfTotals {
    subtotal_cents: i64,
    discount_cents: i64,
    net_cents: i64,
    vat_cents: i64,
    total_cents: i64,
}

#[derive(Debug, Clone)]
struct SalesPdfQr {
    input: SwissQrBillInput,
    payload: String,
    frozen_at: String,
}

#[derive(Debug, Clone)]
struct SalesPdfData {
    kind: SalesDocumentKind,
    number: String,
    title: String,
    document_type: String,
    issue_date: String,
    deadline_date: String,
    service_date_from: String,
    service_date_to: String,
    currency: String,
    notes: String,
    terms: String,
    captured_at: String,
    original_invoice_number: String,
    issuer: SalesPdfIssuer,
    customer: SalesPdfCustomer,
    lines: Vec<SalesPdfLine>,
    totals: SalesPdfTotals,
    qr: Option<SalesPdfQr>,
    final_document: bool,
}

impl LocalStore {
    pub fn generate_sales_document_pdf(
        &self,
        input: GenerateSalesDocumentPdfInput,
    ) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let destination = validate_pdf_destination(&input.destination_path)?;
        let data = load_sales_pdf_data(&connection, input.entity.trim(), input.document_id.trim())?;
        let page_count = render_sales_pdf(
            &destination,
            &data,
            Some(self.attachments_dir.join("branding").as_path()),
        )?;
        Ok(json!({
            "path": destination.to_string_lossy(),
            "pages": page_count,
            "final_document": data.final_document,
            "has_qr": data.qr.is_some(),
            "document_type": match data.kind {
                SalesDocumentKind::Quote => "quote",
                SalesDocumentKind::Invoice => if is_credit_note(&data.document_type) { "credit_note" } else { "invoice" },
            },
        }))
    }
}

fn validate_pdf_destination(raw_path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_absolute() {
        return Err(AppError::Validation(
            "Choisissez un emplacement local absolu pour le PDF.".into(),
        ));
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("pdf"))
    {
        return Err(AppError::Validation(
            "Le fichier de destination doit porter l'extension .pdf.".into(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        AppError::Validation("Le dossier de destination du PDF est invalide.".into())
    })?;
    if !parent.is_dir() {
        return Err(AppError::Validation(
            "Le dossier de destination du PDF n'existe pas.".into(),
        ));
    }
    Ok(path)
}

fn load_sales_pdf_data(
    connection: &Connection,
    entity: &str,
    document_id: &str,
) -> AppResult<SalesPdfData> {
    let (kind, table, items_table, parent_column) = match entity {
        "quotes" => (
            SalesDocumentKind::Quote,
            "quotes",
            "quote_items",
            "quote_id",
        ),
        "invoices" => (
            SalesDocumentKind::Invoice,
            "invoices",
            "invoice_items",
            "invoice_id",
        ),
        _ => {
            return Err(AppError::Validation(
                "entity doit être quotes ou invoices.".into(),
            ))
        }
    };
    if document_id.is_empty() {
        return Err(AppError::Validation(
            "Le document à exporter est obligatoire.".into(),
        ));
    }

    let live_document = connection
        .query_row(
            &format!("SELECT * FROM {table} WHERE id=?"),
            params![document_id],
            row_to_json_public,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("{table}/{document_id}")))?;
    let final_document = !string_at(&live_document, "number").is_empty();

    let (issuer, customer, document, items, captured_at, snapshot_qr) = if final_document {
        let raw_snapshot = string_at(&live_document, "snapshot_json");
        if raw_snapshot.is_empty() {
            return Err(AppError::Validation(
                "Ce document émis ne contient pas son instantané figé. L'export final est bloqué pour éviter une reconstitution depuis des données modifiables."
                    .into(),
            ));
        }
        let snapshot: Value = serde_json::from_str(&raw_snapshot)?;
        if string_at(&snapshot, "schema") != "helvichantier.document_snapshot.v1" {
            return Err(AppError::Validation(
                "Le format de l'instantané figé de ce document n'est pas reconnu.".into(),
            ));
        }
        let issuer = snapshot.get("issuer").cloned().unwrap_or(Value::Null);
        let customer = snapshot.get("customer").cloned().unwrap_or(Value::Null);
        let document = snapshot.get("document").cloned().unwrap_or(Value::Null);
        let captured_at = string_at(&snapshot, "captured_at");
        let items = snapshot
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let issuer_name = string_at(&issuer, "company_name");
        let customer_name = string_at(&customer, "name");
        let customer_company = string_at(&customer, "company");
        if !issuer.is_object()
            || !customer.is_object()
            || !document.is_object()
            || issuer_name.is_empty()
            || (customer_name.is_empty() && customer_company.is_empty())
            || string_at(&document, "number").is_empty()
            || items.is_empty()
        {
            return Err(AppError::Validation(
                "L'instantané figé est incomplet : identité émettrice, destinataire nommé, numéro ou lignes manquants."
                    .into(),
            ));
        }
        let live_number = string_at(&live_document, "number");
        if string_at(&document, "id") != document_id
            || string_at(&document, "number") != live_number
        {
            return Err(AppError::Validation(
                "L'instantané figé n'est pas relié au même document et au même numéro que la facture ou le devis actif."
                    .into(),
            ));
        }
        if captured_at.is_empty() || chrono::DateTime::parse_from_rfc3339(&captured_at).is_err() {
            return Err(AppError::Validation(
                "L'instantané figé ne contient pas une date de capture RFC 3339 valide.".into(),
            ));
        }
        validate_document_snapshot_legal_fields(
            if kind == SalesDocumentKind::Quote {
                "quotes"
            } else {
                "invoices"
            },
            &snapshot,
        )?;
        validate_final_issue_audit(
            connection,
            kind,
            document_id,
            &live_number,
            &raw_snapshot,
            &snapshot,
        )?;
        (
            issuer,
            customer,
            document,
            items,
            captured_at,
            snapshot.get("qr_bill").cloned().unwrap_or(Value::Null),
        )
    } else {
        let issuer = enrich_issuer_snapshot(connection.query_row(
            "SELECT * FROM settings WHERE id=1",
            [],
            row_to_json_public,
        )?)?;
        let customer = live_document
            .get("client_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|client_id| {
                connection
                    .query_row(
                        "SELECT * FROM clients WHERE id=?",
                        params![client_id],
                        row_to_json_public,
                    )
                    .optional()
            })
            .transpose()?
            .flatten()
            .unwrap_or(Value::Null);
        let items = query_all(
            connection,
            &format!("SELECT * FROM {items_table} WHERE {parent_column}=? ORDER BY position,rowid"),
            params![document_id],
        )?;
        (
            issuer,
            customer,
            live_document.clone(),
            items,
            String::new(),
            Value::Null,
        )
    };

    let lines = items
        .iter()
        .map(|item| sales_line_from_value(item, final_document))
        .collect::<AppResult<Vec<_>>>()?;
    if lines.is_empty() {
        return Err(AppError::Validation(
            "Le document ne contient aucune ligne à exporter.".into(),
        ));
    }

    let totals = totals_from_values(&document, &lines, final_document)?;
    let currency = if final_document {
        required_final_currency(&document)?
    } else {
        fallback_string(&document, "currency", "CHF").to_uppercase()
    };
    let document_type = match (kind, final_document) {
        (SalesDocumentKind::Invoice, true) => required_final_invoice_type(&document)?,
        (SalesDocumentKind::Invoice, false) => fallback_string(&document, "type", "standard"),
        (SalesDocumentKind::Quote, _) => "quote".into(),
    };
    let original_invoice_id = string_at(&document, "original_invoice_id");
    let original_invoice_number =
        if kind == SalesDocumentKind::Invoice && !original_invoice_id.is_empty() {
            connection
                .query_row(
                    "SELECT number FROM invoices WHERE id=?",
                    params![original_invoice_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .unwrap_or_default()
        } else {
            String::new()
        };

    let qr = if kind == SalesDocumentKind::Invoice && !is_credit_note(&document_type) {
        // Un document émis utilise soit la QR de son instantané, soit le
        // supplément QR immuable créé atomiquement et audité après émission.
        // Il ne relit jamais une valeur active non figée.
        let qr_value = if final_document {
            if snapshot_qr.is_null() {
                load_verified_qr_supplement(connection, document_id, &issuer, &customer, &document)?
                    .unwrap_or(Value::Null)
            } else if !qr_value_has_payload(&snapshot_qr) {
                return Err(AppError::Validation(
                    "La QR-facture de l'instantané figé est incomplète. L'export final est bloqué."
                        .into(),
                ));
            } else {
                snapshot_qr
            }
        } else {
            load_stored_qr_value(connection, document_id)?.unwrap_or(Value::Null)
        };
        verified_qr_from_value(&qr_value, totals.total_cents, &currency, final_document)?
    } else {
        None
    };

    Ok(SalesPdfData {
        kind,
        number: string_at(&document, "number"),
        title: string_at(&document, "title"),
        document_type,
        issue_date: string_at(&document, "issue_date"),
        deadline_date: if kind == SalesDocumentKind::Quote {
            string_at(&document, "valid_until")
        } else {
            string_at(&document, "due_date")
        },
        service_date_from: string_at(&document, "service_date_from"),
        service_date_to: string_at(&document, "service_date_to"),
        currency,
        notes: string_at(&document, "notes"),
        terms: string_at(&document, "terms"),
        captured_at,
        original_invoice_number,
        issuer: issuer_from_value(&issuer),
        customer: customer_from_value(&customer),
        lines,
        totals,
        qr,
        final_document,
    })
}

pub(crate) fn validate_document_snapshot_legal_fields(
    entity: &str,
    snapshot: &Value,
) -> AppResult<()> {
    let issuer = snapshot.get("issuer").ok_or_else(|| {
        AppError::Validation("L'instantané final ne contient pas l'émetteur.".into())
    })?;
    let customer = snapshot.get("customer").ok_or_else(|| {
        AppError::Validation("L'instantané final ne contient pas le destinataire.".into())
    })?;
    let document = snapshot.get("document").ok_or_else(|| {
        AppError::Validation("L'instantané final ne contient pas le document.".into())
    })?;
    fn require_text(value: &Value, key: &str, label: &str) -> AppResult<()> {
        if !string_at(value, key).is_empty() {
            return Ok(());
        }
        Err(AppError::Validation(format!(
            "L'instantané final ne contient pas {label}. L'export est bloqué pour éviter un document légal incomplet."
        )))
    }
    fn require_date(value: &Value, key: &str, label: &str) -> AppResult<()> {
        let raw = string_at(value, key);
        if chrono::NaiveDate::parse_from_str(&raw, "%Y-%m-%d").is_ok() {
            return Ok(());
        }
        Err(AppError::Validation(format!(
            "L'instantané final ne contient pas {label} au format AAAA-MM-JJ."
        )))
    }

    required_final_currency(document)?;
    for (key, label) in [
        ("company_name", "le nom légal de l'émetteur"),
        ("address_line1", "la rue de l'émetteur"),
        ("postal_code", "le NPA de l'émetteur"),
        ("city", "la localité de l'émetteur"),
    ] {
        require_text(issuer, key, label)?;
    }
    if bool_at(issuer, "vat_registered") {
        require_text(
            issuer,
            "vat_number",
            "le numéro TVA de l'émetteur assujetti",
        )?;
    }
    if string_at(customer, "name").is_empty() && string_at(customer, "company").is_empty() {
        return Err(AppError::Validation(
            "L'instantané final ne contient pas le nom du destinataire.".into(),
        ));
    }
    for (key, label) in [
        ("address_line1", "la rue du destinataire"),
        ("postal_code", "le NPA du destinataire"),
        ("city", "la localité du destinataire"),
    ] {
        require_text(customer, key, label)?;
    }
    require_date(document, "issue_date", "une date d'émission valide")?;
    match entity {
        "quotes" => {
            require_date(document, "valid_until", "une date de validité valide")?;
        }
        "invoices" => {
            required_final_invoice_type(document)?;
            validate_snapshot_qr_consistency(snapshot)?;
            require_date(document, "due_date", "une date d'échéance valide")?;
            require_date(
                document,
                "service_date_from",
                "une date de début de prestation valide",
            )?;
            require_date(
                document,
                "service_date_to",
                "une date de fin de prestation valide",
            )?;
        }
        _ => {
            return Err(AppError::Validation(
                "Type de document commercial inconnu pour le contrôle légal.".into(),
            ))
        }
    }
    Ok(())
}

fn validate_snapshot_qr_consistency(snapshot: &Value) -> AppResult<()> {
    let qr = snapshot.get("qr_bill").unwrap_or(&Value::Null);
    if qr.is_null() {
        return Ok(());
    }
    let input_json = string_at(qr, "input_json");
    let input: SwissQrBillInput = serde_json::from_str(&input_json).map_err(|_| {
        AppError::Validation(
            "La QR-facture enregistrée ne contient plus son entrée structurée valide.".into(),
        )
    })?;
    let generated = swiss_qr::generate(input.clone())?;
    if generated.payload != string_at(qr, "payload") {
        return Err(AppError::Validation(
            "Le payload SPC de la QR-facture ne correspond plus à son entrée structurée.".into(),
        ));
    }
    swiss_qr::validate_bill_against_final_snapshot(&input, snapshot)?;
    let frozen_at = string_at(qr, "frozen_at");
    if chrono::DateTime::parse_from_rfc3339(&frozen_at).is_err() {
        return Err(AppError::Validation(
            "La QR-facture n'a pas pu être figée avec un horodatage vérifiable.".into(),
        ));
    }
    Ok(())
}

fn validate_final_issue_audit(
    connection: &Connection,
    kind: SalesDocumentKind,
    document_id: &str,
    live_number: &str,
    raw_snapshot: &str,
    snapshot: &Value,
) -> AppResult<()> {
    crate::audit::verify_audit_chain(connection)?;
    let entity_type = match kind {
        SalesDocumentKind::Quote => "quote",
        SalesDocumentKind::Invoice => {
            if is_credit_note(&string_at(
                snapshot.get("document").unwrap_or(&Value::Null),
                "type",
            )) {
                "credit_note"
            } else {
                "invoice"
            }
        }
    };
    let events = query_all(
        connection,
        "SELECT payload_json FROM audit_log WHERE action='issue' AND entity_type=? AND entity_id=? ORDER BY rowid",
        params![entity_type, document_id],
    )?;
    if events.len() != 1 {
        return Err(AppError::Validation(
            "Le document final doit être relié à un unique événement d'émission dans la chaîne d'audit."
                .into(),
        ));
    }
    let payload: Value = serde_json::from_str(&string_at(&events[0], "payload_json"))?;
    let audited_document = match kind {
        SalesDocumentKind::Quote => &payload,
        SalesDocumentKind::Invoice => payload.get("document").unwrap_or(&Value::Null),
    };
    let snapshot_number = string_at(snapshot.get("document").unwrap_or(&Value::Null), "number");
    if string_at(audited_document, "number") != live_number || snapshot_number != live_number {
        return Err(AppError::Validation(
            "Le numéro du document final ne correspond pas exactement à celui de son événement d'émission."
                .into(),
        ));
    }
    let audited_snapshot_raw = audited_document
        .get("snapshot_json")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let audited_snapshot = serde_json::from_str::<Value>(audited_snapshot_raw).map_err(|_| {
        AppError::Validation(
            "L'événement d'émission ne contient pas un instantané final lisible.".into(),
        )
    })?;
    if audited_snapshot_raw != raw_snapshot || &audited_snapshot != snapshot {
        return Err(AppError::Validation(
            "L'instantané final ne correspond pas exactement à celui de l'événement d'émission. Export bloqué."
                .into(),
        ));
    }
    Ok(())
}

fn required_final_currency(document: &Value) -> AppResult<String> {
    let currency = string_at(document, "currency").to_uppercase();
    if currency.len() == 3 && currency.bytes().all(|value| value.is_ascii_uppercase()) {
        return Ok(currency);
    }
    Err(AppError::Validation(
        "L'instantané final ne contient pas une devise ISO explicite sur trois lettres. Aucun défaut CHF n'est appliqué après émission."
            .into(),
    ))
}

fn required_final_invoice_type(document: &Value) -> AppResult<String> {
    let document_type = string_at(document, "type");
    if matches!(
        document_type.as_str(),
        "standard"
            | "acompte"
            | "deposit"
            | "situation"
            | "progress"
            | "finale"
            | "final"
            | "avoir"
            | "credit_note"
    ) {
        return Ok(document_type);
    }
    Err(AppError::Validation(
        "L'instantané final ne contient pas un type de facture explicite et reconnu. Aucun type standard n'est inventé après émission."
            .into(),
    ))
}

fn load_stored_qr_value(connection: &Connection, invoice_id: &str) -> AppResult<Option<Value>> {
    connection
        .query_row(
            "SELECT invoice_id,input_json,payload,reference_type,is_qr_iban,character_count,byte_count,frozen_at,created_at,updated_at FROM invoice_qr_bills WHERE invoice_id=?",
            params![invoice_id],
            row_to_json_public,
        )
        .optional()
        .map_err(Into::into)
}

fn load_verified_qr_supplement(
    connection: &Connection,
    invoice_id: &str,
    issuer: &Value,
    customer: &Value,
    document: &Value,
) -> AppResult<Option<Value>> {
    let Some(stored) = load_stored_qr_value(connection, invoice_id)? else {
        return Ok(None);
    };
    let stored_input: SwissQrBillInput = stored
        .get("input_json")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Validation(
                "Le supplément QR ne contient plus ses données structurées.".into(),
            )
        })
        .and_then(|raw| serde_json::from_str(raw).map_err(Into::into))?;
    let final_snapshot = json!({
        "issuer": issuer,
        "customer": customer,
        "document": document,
    });
    swiss_qr::validate_bill_against_final_snapshot(&stored_input, &final_snapshot)?;
    swiss_qr::verify_frozen_supplement_audit(connection, invoice_id, &stored)?;
    Ok(Some(stored))
}

fn qr_value_has_payload(value: &Value) -> bool {
    value
        .get("payload")
        .and_then(Value::as_str)
        .is_some_and(|payload| !payload.trim().is_empty())
}

fn verified_qr_from_value(
    value: &Value,
    total_cents: i64,
    currency: &str,
    final_document: bool,
) -> AppResult<Option<SalesPdfQr>> {
    if !qr_value_has_payload(value) {
        return Ok(None);
    }
    let payload = string_at(value, "payload");
    let input_value = value
        .get("input")
        .filter(|candidate| candidate.is_object())
        .cloned()
        .or_else(|| {
            value
                .get("input_json")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        })
        .ok_or_else(|| {
            AppError::Validation(
                "La QR-facture enregistrée ne contient plus ses données structurées.".into(),
            )
        })?;
    let input: SwissQrBillInput = serde_json::from_value(input_value)?;
    let regenerated = swiss_qr::generate(input.clone())?;
    if regenerated.payload != payload {
        return Err(AppError::Validation(
            "Le payload SPC figé ne correspond plus aux données structurées de la QR-facture. Export bloqué."
                .into(),
        ));
    }
    if input.amount_cents != Some(total_cents) || input.currency != currency {
        return Err(AppError::Validation(
            "Le montant ou la devise de la QR-facture ne correspond pas au document figé.".into(),
        ));
    }
    if final_document && input.debtor.is_none() {
        return Err(AppError::Validation(
            "La QR-facture figée ne contient pas le débiteur. Ajoutez le destinataire avant l'émission afin d'éviter une zone de saisie manuelle incomplète."
                .into(),
        ));
    }
    if final_document && string_at(value, "frozen_at").is_empty() {
        return Err(AppError::Validation(
            "La QR-facture d'un document émis doit être figée avant export.".into(),
        ));
    }
    Ok(Some(SalesPdfQr {
        input,
        payload,
        frozen_at: string_at(value, "frozen_at"),
    }))
}

fn issuer_from_value(value: &Value) -> SalesPdfIssuer {
    SalesPdfIssuer {
        company_name: string_at(value, "company_name"),
        legal_form: string_at(value, "legal_form"),
        address: compact_lines([
            join_non_empty(
                &string_at(value, "address_line1"),
                &string_at(value, "building_number"),
            ),
            string_at(value, "address_line2"),
            join_non_empty(&string_at(value, "postal_code"), &string_at(value, "city")),
            string_at(value, "country"),
        ]),
        uid_number: string_at(value, "uid_number"),
        vat_number: string_at(value, "vat_number"),
        vat_registered: bool_at(value, "vat_registered"),
        iban: string_at(value, "iban"),
        logo_path: string_at(value, "logo_path"),
    }
}

fn customer_from_value(value: &Value) -> SalesPdfCustomer {
    let company = string_at(value, "company");
    let name = if company.is_empty() {
        string_at(value, "name")
    } else {
        company
    };
    SalesPdfCustomer {
        name,
        address: compact_lines([
            string_at(value, "address_line1"),
            string_at(value, "address_line2"),
            join_non_empty(&string_at(value, "postal_code"), &string_at(value, "city")),
            string_at(value, "country"),
        ]),
        email: string_at(value, "email"),
    }
}

fn sales_line_from_value(value: &Value, require_persisted_totals: bool) -> AppResult<SalesPdfLine> {
    let description = string_at(value, "description");
    if description.is_empty() {
        return Err(AppError::Validation(
            "Une ligne du document ne contient aucune description.".into(),
        ));
    }
    let quantity = if require_persisted_totals {
        required_final_number(value, "quantity", "la quantité")?
    } else {
        number_at(value, "quantity")
    };
    let unit_price_cents = if require_persisted_totals {
        required_final_integer(value, "unit_price_cents", "le prix unitaire")?
    } else {
        integer_at(value, "unit_price_cents")
    };
    let discount_bp = if require_persisted_totals {
        required_final_basis_points(value, "discount_bp", "la remise")?
    } else {
        integer_at(value, "discount_bp")
    };
    let vat_bp = if require_persisted_totals {
        required_final_basis_points(value, "vat_bp", "le taux TVA")?
    } else {
        integer_at(value, "vat_bp")
    };
    if quantity < 0.0 {
        return Err(AppError::Validation(
            "Une ligne du document contient une quantité négative.".into(),
        ));
    }
    let base_value = quantity * unit_price_cents as f64;
    if !base_value.is_finite() || base_value < i64::MIN as f64 || base_value > i64::MAX as f64 {
        return Err(AppError::Validation(
            "Une ligne du document dépasse la capacité de calcul exacte en centimes.".into(),
        ));
    }
    let base = base_value.round() as i64;
    let discount = round_basis_points(base, discount_bp);
    let computed_net = base.saturating_sub(discount);
    let computed_vat = round_basis_points(computed_net, vat_bp);
    let stored_net = optional_integer_at(value, "line_net_cents");
    let stored_vat = optional_integer_at(value, "line_vat_cents");
    let stored_total = optional_integer_at(value, "line_total_cents");
    if require_persisted_totals
        && (stored_net.is_none() || stored_vat.is_none() || stored_total.is_none())
    {
        return Err(AppError::Validation(
            "Une ligne du document final ne contient plus ses montants figés net, TVA et total."
                .into(),
        ));
    }
    let net_cents = stored_net.unwrap_or(computed_net);
    let vat_cents = stored_vat.unwrap_or(computed_vat);
    let total_cents = stored_total.unwrap_or(computed_net.saturating_add(computed_vat));
    if require_persisted_totals
        && (net_cents != computed_net
            || vat_cents != computed_vat
            || total_cents != computed_net.saturating_add(computed_vat))
    {
        return Err(AppError::Validation(
            "Une ligne du document final contient des montants figés incompatibles avec sa quantité, son prix, sa remise ou son taux TVA."
                .into(),
        ));
    }
    Ok(SalesPdfLine {
        description,
        quantity,
        unit: string_at(value, "unit"),
        unit_price_cents,
        discount_bp,
        vat_bp,
        net_cents,
        vat_cents,
        total_cents,
    })
}

fn required_final_number(value: &Value, key: &str, label: &str) -> AppResult<f64> {
    let number = value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| {
            AppError::Validation(format!(
                "Une ligne du document final ne contient pas {label} sous forme numérique explicite."
            ))
        })?;
    Ok(number)
}

fn required_final_integer(value: &Value, key: &str, label: &str) -> AppResult<i64> {
    optional_integer_at(value, key).ok_or_else(|| {
        AppError::Validation(format!(
            "Une ligne du document final ne contient pas {label} sous forme entière explicite."
        ))
    })
}

fn required_final_basis_points(value: &Value, key: &str, label: &str) -> AppResult<i64> {
    let basis_points = required_final_integer(value, key, label)?;
    if (0..=10_000).contains(&basis_points) {
        return Ok(basis_points);
    }
    Err(AppError::Validation(format!(
        "Une ligne du document final contient {label} hors de la plage 0 à 100 %."
    )))
}

fn totals_from_values(
    document: &Value,
    lines: &[SalesPdfLine],
    require_persisted_totals: bool,
) -> AppResult<SalesPdfTotals> {
    let computed_subtotal = lines
        .iter()
        .map(|line| (line.quantity * line.unit_price_cents as f64).round() as i64)
        .sum();
    let computed_net: i64 = lines.iter().map(|line| line.net_cents).sum();
    let computed_vat: i64 = lines.iter().map(|line| line.vat_cents).sum();
    let computed_total: i64 = lines.iter().map(|line| line.total_cents).sum();
    let stored_subtotal = optional_integer_at(document, "subtotal_cents");
    let stored_discount = optional_integer_at(document, "discount_cents");
    let stored_vat = optional_integer_at(document, "vat_cents");
    let stored_total = optional_integer_at(document, "total_cents");
    if require_persisted_totals
        && (stored_subtotal.is_none()
            || stored_discount.is_none()
            || stored_vat.is_none()
            || stored_total.is_none())
    {
        return Err(AppError::Validation(
            "Le document final ne contient plus ses totaux figés complets.".into(),
        ));
    }
    let subtotal = stored_subtotal.unwrap_or(computed_subtotal);
    let discount = stored_discount.unwrap_or(subtotal.saturating_sub(computed_net));
    let vat = stored_vat.unwrap_or(computed_vat);
    let total = stored_total.unwrap_or(computed_total);
    if require_persisted_totals
        && (subtotal != computed_subtotal
            || discount != subtotal.saturating_sub(computed_net)
            || vat != computed_vat
            || total != computed_total
            || total != computed_net.saturating_add(computed_vat))
    {
        return Err(AppError::Validation(
            "Les totaux figés du document ne correspondent pas à ses lignes figées. Export bloqué."
                .into(),
        ));
    }
    Ok(SalesPdfTotals {
        subtotal_cents: subtotal,
        discount_cents: discount,
        net_cents: subtotal.saturating_sub(discount),
        vat_cents: vat,
        total_cents: total,
    })
}

fn render_sales_pdf(
    path: &Path,
    data: &SalesPdfData,
    branding_dir: Option<&Path>,
) -> AppResult<usize> {
    validate_visible_texts(data)?;
    validate_layout_capacity(data)?;
    let all_notes = notes_lines(data);
    let dedicated_notes = all_notes.len() > 6;
    let chunks = paginate_sales_lines(data, !dedicated_notes);
    let note_chunks = if dedicated_notes {
        paginate_note_lines(&all_notes)
    } else {
        Vec::new()
    };
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let regular_font = add_font(&mut document, "Helvetica");
    let bold_font = add_font(&mut document, "Helvetica-Bold");
    let logo = load_document_logo(&data.issuer.logo_path, branding_dir);
    if data.final_document && !data.issuer.logo_path.is_empty() && logo.is_none() {
        return Err(AppError::Validation(
            "Le logo figé de ce document est introuvable ou altéré. Restaurez le fichier de marque avant l'export final."
                .into(),
        ));
    }
    let logo_object = logo
        .as_ref()
        .map(|image| add_logo_image(&mut document, image));
    let mut resources = dictionary! {
        "Font" => dictionary! {
            "F1" => regular_font,
            "F2" => bold_font,
        }
    };
    if let Some(logo_object) = logo_object {
        resources.set("XObject", dictionary! { "Logo" => logo_object });
    }
    let resources_id = document.add_object(resources);
    let total_pages = chunks.len() + note_chunks.len() + usize::from(dedicated_notes);
    let mut page_ids = Vec::with_capacity(total_pages);
    let mut rendered_pages = Vec::with_capacity(total_pages);
    for (index, chunk) in chunks.iter().enumerate() {
        let first = index == 0;
        let last = !dedicated_notes && index + 1 == chunks.len();
        let operations = render_page(
            data,
            chunk,
            index + 1,
            total_pages,
            first,
            last,
            logo.as_ref(),
        )?;
        rendered_pages.push(operations);
    }
    for (index, note_chunk) in note_chunks.iter().enumerate() {
        let page_number = chunks.len() + index + 1;
        rendered_pages.push(render_notes_page(
            data,
            note_chunk,
            page_number,
            total_pages,
            index + 1,
            note_chunks.len(),
        ));
    }
    if dedicated_notes {
        let mut totals_data = data.clone();
        totals_data.notes.clear();
        totals_data.terms.clear();
        rendered_pages.push(render_page(
            &totals_data,
            &[],
            total_pages,
            total_pages,
            false,
            true,
            logo.as_ref(),
        )?);
    }

    for operations in rendered_pages {
        let content = Content { operations }.encode().map_err(|error| {
            AppError::Validation(format!("Le contenu PDF est invalide : {error}"))
        })?;
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(PAGE_WIDTH), Object::Real(PAGE_HEIGHT)],
            "Resources" => resources_id,
        });
        page_ids.push(page_id);
    }

    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => total_pages as i64,
        }),
    );
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    let label = document_label(data);
    let info_id = document.add_object(dictionary! {
        "Title" => pdf_literal(&format!("{} {}", label, fallback(&data.number))),
        "Author" => pdf_literal(&data.issuer.company_name),
        "Creator" => pdf_literal("Zentra - documents locaux"),
        "Subject" => pdf_literal(if data.final_document { "Document commercial figé" } else { "Brouillon de document commercial" }),
    });
    document.trailer.set("Root", catalog_id);
    document.trailer.set("Info", info_id);
    document.compress();

    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    document
        .save(&temporary)
        .map_err(|error| AppError::Validation(format!("Le PDF n'a pas pu être écrit : {error}")))?;
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(total_pages)
}

/// Charge un logo de document sans jamais contourner le condensat porté par
/// les noms immuables `logo-<sha256>.<ext>`. Pour un ancien chemin non hashé,
/// `load_pdf_logo_with_fallback` conserve volontairement le comportement
/// historique de chargement direct.
fn load_document_logo(raw_path: &str, branding_dir: Option<&Path>) -> Option<PdfLogo> {
    let original = Path::new(raw_path.trim());
    let verification_dir = branding_dir.or_else(|| original.parent())?;
    load_pdf_logo_with_fallback(raw_path, verification_dir)
}

fn validate_visible_texts(data: &SalesPdfData) -> AppResult<()> {
    let mut fields: Vec<(&str, &str)> = vec![
        ("nom de l'entreprise", &data.issuer.company_name),
        ("forme juridique", &data.issuer.legal_form),
        ("IDE", &data.issuer.uid_number),
        ("numéro TVA", &data.issuer.vat_number),
        ("IBAN", &data.issuer.iban),
        ("nom du destinataire", &data.customer.name),
        ("e-mail du destinataire", &data.customer.email),
        ("numéro du document", &data.number),
        ("titre", &data.title),
        ("date d'émission", &data.issue_date),
        ("date d'échéance", &data.deadline_date),
        ("début de prestation", &data.service_date_from),
        ("fin de prestation", &data.service_date_to),
        ("date de capture", &data.captured_at),
        ("devise", &data.currency),
        ("notes", &data.notes),
        ("conditions", &data.terms),
        (
            "numéro de la facture corrigée",
            &data.original_invoice_number,
        ),
    ];
    fields.extend(
        data.issuer
            .address
            .iter()
            .map(|value| ("adresse de l'entreprise", value.as_str())),
    );
    fields.extend(
        data.customer
            .address
            .iter()
            .map(|value| ("adresse du destinataire", value.as_str())),
    );
    for line in &data.lines {
        fields.push(("description de ligne", &line.description));
        fields.push(("unité de ligne", &line.unit));
    }
    if let Some(qr) = &data.qr {
        fields.extend([
            ("nom du créancier QR", qr.input.creditor.name.as_str()),
            ("rue du créancier QR", qr.input.creditor.street.as_str()),
            (
                "numéro de rue du créancier QR",
                qr.input.creditor.building_number.as_str(),
            ),
            (
                "NPA du créancier QR",
                qr.input.creditor.postal_code.as_str(),
            ),
            ("localité du créancier QR", qr.input.creditor.city.as_str()),
            ("pays du créancier QR", qr.input.creditor.country.as_str()),
            ("IBAN QR", qr.input.iban.as_str()),
            ("devise QR", qr.input.currency.as_str()),
            ("référence QR", qr.input.reference.as_str()),
            ("message QR", qr.input.unstructured_message.as_str()),
            ("informations QR", qr.input.bill_information.as_str()),
        ]);
        if let Some(debtor) = &qr.input.debtor {
            fields.extend([
                ("nom du débiteur QR", debtor.name.as_str()),
                ("rue du débiteur QR", debtor.street.as_str()),
                (
                    "numéro de rue du débiteur QR",
                    debtor.building_number.as_str(),
                ),
                ("NPA du débiteur QR", debtor.postal_code.as_str()),
                ("localité du débiteur QR", debtor.city.as_str()),
                ("pays du débiteur QR", debtor.country.as_str()),
            ]);
        }
    }
    for (field, value) in fields {
        ensure_winansi(field, value)?;
    }
    Ok(())
}

fn validate_layout_capacity(data: &SalesPdfData) -> AppResult<()> {
    fn require_width(
        field: &str,
        value: &str,
        max_width: f32,
        font_size: f32,
        bold: bool,
    ) -> AppResult<()> {
        let width = helvetica_text_width(value.trim(), font_size, bold);
        if width <= max_width {
            return Ok(());
        }
        Err(AppError::Validation(format!(
            "Le champ « {field} » mesure environ {width:.1} pt, mais sa zone PDF n'en accepte que {max_width:.1}. Raccourcissez-le avant l'export : Zentra refuse tout débordement ou chevauchement."
        )))
    }

    require_width(
        "nom de l'entreprise",
        &data.issuer.company_name,
        250.0,
        11.0,
        true,
    )?;
    require_width(
        "forme juridique",
        &data.issuer.legal_form,
        250.0,
        7.2,
        false,
    )?;
    if data.issuer.address.len() > 4 {
        return Err(AppError::Validation(
            "L'adresse de l'entreprise comporte plus de quatre lignes. Regroupez-la avant l'export : aucune ligne ne sera masquée."
                .into(),
        ));
    }
    for value in &data.issuer.address {
        require_width("ligne d'adresse de l'entreprise", value, 250.0, 7.3, false)?;
    }
    let identity = [
        (!data.issuer.uid_number.is_empty()).then(|| format!("IDE {}", data.issuer.uid_number)),
        (data.issuer.vat_registered && !data.issuer.vat_number.is_empty())
            .then(|| format!("TVA {}", data.issuer.vat_number)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" - ");
    require_width("identifiants IDE/TVA", &identity, 250.0, 7.0, false)?;
    require_width(
        "numéro du document",
        &fallback(&data.number),
        170.0,
        10.0,
        true,
    )?;
    let customer_block_width = PAGE_WIDTH - 2.0 * MARGIN - 24.0;
    require_width(
        "nom du destinataire",
        &fallback(&data.customer.name),
        customer_block_width,
        9.5,
        true,
    )?;
    let customer_address = data.customer.address.join(" - ");
    let email_width = helvetica_text_width(&data.customer.email, 7.0, false);
    let address_width = if data.customer.email.is_empty() {
        customer_block_width
    } else {
        customer_block_width - email_width - 14.0
    };
    require_width(
        "adresse du destinataire",
        &customer_address,
        address_width.max(0.0),
        7.2,
        false,
    )?;
    require_width(
        "e-mail du destinataire",
        &data.customer.email,
        220.0,
        7.0,
        false,
    )?;
    require_width(
        "titre du document",
        &data.title,
        PAGE_WIDTH - 2.0 * MARGIN,
        12.0,
        true,
    )?;
    if data.currency.chars().count() != 3 {
        return Err(AppError::Validation(
            "La devise du document doit être un code ISO à trois lettres pour le PDF.".into(),
        ));
    }
    for (index, line) in data.lines.iter().enumerate() {
        require_width(
            &format!("quantité de la ligne {}", index + 1),
            &format_quantity(line.quantity),
            33.0,
            6.6,
            false,
        )?;
        require_width(
            &format!("unité de la ligne {}", index + 1),
            &line.unit,
            39.0,
            6.6,
            false,
        )?;
        require_width(
            &format!("prix unitaire de la ligne {}", index + 1),
            &format_amount(line.unit_price_cents),
            60.0,
            6.8,
            true,
        )?;
        require_width(
            &format!("remise de la ligne {}", index + 1),
            &format_percent(line.discount_bp),
            42.0,
            6.6,
            false,
        )?;
        require_width(
            &format!("TVA de la ligne {}", index + 1),
            &format_percent(line.vat_bp),
            40.0,
            6.6,
            false,
        )?;
        require_width(
            &format!("total de la ligne {}", index + 1),
            &format_amount(line.net_cents),
            75.0,
            6.8,
            true,
        )?;
        if line_height(line) > table_top(false) - 55.0 {
            return Err(AppError::Validation(format!(
                "La description de la ligne {} dépasse une page PDF entière. Scindez cette prestation en plusieurs lignes : Zentra refuse d'en masquer une partie.",
                index + 1
            )));
        }
    }
    for (rate, (basis, _)) in vat_groups(data) {
        let label = format!(
            "TVA {} sur {}",
            format_percent(rate),
            format_money(&data.currency, basis)
        );
        let amount = format_money(&data.currency, data.totals.vat_cents);
        let amount_width = helvetica_text_width(&amount, 7.0, true);
        require_width(
            "libellé de total TVA",
            &label,
            (PAGE_WIDTH - MARGIN - 10.0 - 315.0 - amount_width - 12.0).max(0.0),
            6.5,
            false,
        )?;
    }
    if final_table_floor(data) > table_top(false) {
        return Err(AppError::Validation(
            "Le détail des totaux et taux de TVA dépasse la capacité de la page finale. Regroupez les taux avant l'export : Zentra refuse tout chevauchement."
                .into(),
        ));
    }
    validate_qr_visible_layout(data)?;
    Ok(())
}

fn ensure_winansi(field: &str, value: &str) -> AppResult<()> {
    let normalized = normalize_pdf_text(value);
    let (_, _, had_errors) = WINDOWS_1252.encode(&normalized);
    if !had_errors {
        return Ok(());
    }
    let invalid = normalized
        .chars()
        .find(|character| {
            let (_, _, error) = WINDOWS_1252.encode(&character.to_string());
            error
        })
        .unwrap_or('?');
    Err(AppError::Validation(format!(
        "Le champ « {field} » contient le caractère « {invalid} », non pris en charge par la police PDF locale. Remplacez-le avant l'export afin d'éviter toute altération silencieuse."
    )))
}

fn document_label(data: &SalesPdfData) -> &'static str {
    match data.kind {
        SalesDocumentKind::Quote => "DEVIS",
        SalesDocumentKind::Invoice if is_credit_note(&data.document_type) => "AVOIR",
        SalesDocumentKind::Invoice => "FACTURE",
    }
}

fn table_top(first: bool) -> f32 {
    if first {
        555.0
    } else {
        772.0
    }
}

fn line_height(line: &SalesPdfLine) -> f32 {
    let description_lines = wrap_text_width(&line.description, DESCRIPTION_TEXT_WIDTH, 7.2, true)
        .len()
        .max(1);
    18.0 + description_lines as f32 * 8.0
}

fn lines_height(lines: &[SalesPdfLine]) -> f32 {
    lines.iter().map(line_height).sum()
}

fn final_table_floor(data: &SalesPdfData) -> f32 {
    let totals_top_gap = 12.0;
    if data.qr.is_some() {
        QR_SECTION_HEIGHT + 27.0 + totals_box_height(data) + totals_top_gap
    } else {
        64.0 + totals_box_height(data) + totals_top_gap
    }
}

fn largest_fitting_prefix(lines: &[SalesPdfLine], budget: f32) -> usize {
    let mut height = 0.0;
    for (index, line) in lines.iter().enumerate() {
        height += line_height(line);
        if height > budget {
            return index;
        }
    }
    lines.len()
}

fn paginate_sales_lines(data: &SalesPdfData, reserve_totals: bool) -> Vec<Vec<SalesPdfLine>> {
    let mut chunks = Vec::new();
    let mut remaining = data.lines.as_slice();
    while !remaining.is_empty() {
        let first = chunks.is_empty();
        let final_floor = if reserve_totals {
            final_table_floor(data)
        } else {
            55.0
        };
        let final_budget = table_top(first) - final_floor;
        if final_budget >= 0.0 && lines_height(remaining) <= final_budget {
            chunks.push(remaining.to_vec());
            break;
        }
        let non_final_floor = 55.0;
        let non_final_budget = (table_top(first) - non_final_floor).max(30.0);
        let count = largest_fitting_prefix(remaining, non_final_budget);
        if count == 0 && first {
            // La première page réserve davantage de place à l'identité et au
            // destinataire. Une description très longue passe intacte sur une
            // page de continuation plutôt que de déborder ou d'être tronquée.
            chunks.push(Vec::new());
            continue;
        }
        if reserve_totals && count >= remaining.len() {
            // Toutes les lignes tiennent sur une page ordinaire mais pas avec
            // les totaux/conditions. On les rend ici puis on réserve une page
            // finale vide pour ces blocs, sans dupliquer de ligne.
            chunks.push(remaining.to_vec());
            chunks.push(Vec::new());
            break;
        }
        chunks.push(remaining[..count].to_vec());
        remaining = &remaining[count..];
    }
    if chunks.is_empty() {
        chunks.push(Vec::new());
    }
    chunks
}

fn paginate_note_lines(lines: &[String]) -> Vec<Vec<String>> {
    const NOTE_LINES_PER_PAGE: usize = 68;
    lines
        .chunks(NOTE_LINES_PER_PAGE)
        .map(|chunk| chunk.to_vec())
        .collect()
}

fn render_notes_page(
    data: &SalesPdfData,
    lines: &[String],
    page_number: usize,
    total_pages: usize,
    note_page: usize,
    note_pages: usize,
) -> Vec<Operation> {
    let mut ops = Vec::new();
    if !data.final_document {
        rotated_text(
            &mut ops,
            112.0,
            380.0,
            38.0,
            "F2",
            DRAFT,
            "BROUILLON - NON EMIS",
        );
    }
    render_continuation_header(&mut ops, data);
    text_right(
        &mut ops,
        PAGE_WIDTH - MARGIN,
        PAGE_HEIGHT - 27.0,
        7.0,
        "F1",
        MUTED,
        &format!("Page {page_number}/{total_pages}"),
    );
    text(
        &mut ops,
        MARGIN,
        742.0,
        12.0,
        "F2",
        INK,
        "REMARQUES ET CONDITIONS",
    );
    text(
        &mut ops,
        MARGIN,
        725.0,
        6.5,
        "F1",
        MUTED,
        &format!("Partie {note_page}/{note_pages} - contenu contractuel intégral"),
    );
    line_segment(
        &mut ops,
        MARGIN,
        713.0,
        PAGE_WIDTH - 2.0 * MARGIN,
        0.7,
        LINE,
    );
    for (index, line) in lines.iter().enumerate() {
        text(
            &mut ops,
            MARGIN,
            695.0 - index as f32 * 9.0,
            6.8,
            "F1",
            INK,
            line,
        );
    }
    render_footer(&mut ops, data, page_number, total_pages, false);
    ops
}

fn render_page(
    data: &SalesPdfData,
    lines: &[SalesPdfLine],
    page_number: usize,
    total_pages: usize,
    first: bool,
    last: bool,
    logo: Option<&PdfLogo>,
) -> AppResult<Vec<Operation>> {
    let mut ops = Vec::new();
    if !data.final_document {
        rotated_text(
            &mut ops,
            112.0,
            380.0,
            38.0,
            "F2",
            DRAFT,
            "BROUILLON - NON EMIS",
        );
    }
    if first {
        render_first_header(&mut ops, data, logo);
    } else {
        render_continuation_header(&mut ops, data);
    }
    text_right(
        &mut ops,
        PAGE_WIDTH - MARGIN,
        PAGE_HEIGHT - 27.0,
        7.0,
        "F1",
        MUTED,
        &format!("Page {page_number}/{total_pages}"),
    );
    let mut y = table_top(first);
    render_table_header(&mut ops, y);
    y -= 22.0;
    for line in lines {
        let height = line_height(line);
        render_line(&mut ops, line, y, height);
        y -= height;
    }
    if last {
        render_totals_and_notes(&mut ops, data);
        if let Some(qr) = &data.qr {
            render_qr_section(&mut ops, qr)?;
        }
    }
    render_footer(&mut ops, data, page_number, total_pages, last);
    Ok(ops)
}

fn render_first_header(ops: &mut Vec<Operation>, data: &SalesPdfData, logo: Option<&PdfLogo>) {
    fill_rect(ops, 0.0, PAGE_HEIGHT - 8.0, PAGE_WIDTH, 8.0, GREEN);
    let mut brand_y = PAGE_HEIGHT - 46.0;
    if let Some(logo) = logo {
        let (width, height) = fitted_size(logo.width, logo.height, 88.0, 32.0);
        draw_image(ops, "Logo", MARGIN, PAGE_HEIGHT - 53.0, width, height);
        brand_y = PAGE_HEIGHT - 66.0;
    }
    text(
        ops,
        MARGIN,
        brand_y,
        11.0,
        "F2",
        INK,
        &data.issuer.company_name,
    );
    if !data.issuer.legal_form.is_empty() {
        text(
            ops,
            MARGIN,
            brand_y - 13.0,
            7.2,
            "F1",
            MUTED,
            &data.issuer.legal_form,
        );
    }
    let mut address_y = brand_y - 27.0;
    for line in &data.issuer.address {
        text(ops, MARGIN, address_y, 7.3, "F1", MUTED, line);
        address_y -= 10.0;
    }
    let identity = [
        (!data.issuer.uid_number.is_empty()).then(|| format!("IDE {}", data.issuer.uid_number)),
        (data.issuer.vat_registered && !data.issuer.vat_number.is_empty())
            .then(|| format!("TVA {}", data.issuer.vat_number)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" - ");
    if !identity.is_empty() {
        text(ops, MARGIN, address_y, 7.0, "F1", MUTED, &identity);
    }

    text_right(
        ops,
        PAGE_WIDTH - MARGIN,
        PAGE_HEIGHT - 64.0,
        24.0,
        "F2",
        GREEN,
        document_label(data),
    );
    text_right(
        ops,
        PAGE_WIDTH - MARGIN,
        PAGE_HEIGHT - 84.0,
        10.0,
        "F2",
        INK,
        &fallback(&data.number),
    );
    let state = if data.final_document {
        "DOCUMENT FIGE"
    } else {
        "BROUILLON - NON EMIS"
    };
    text_right(
        ops,
        PAGE_WIDTH - MARGIN,
        PAGE_HEIGHT - 102.0,
        7.0,
        "F2",
        if data.final_document { GREEN } else { MUTED },
        state,
    );
    line_segment(ops, MARGIN, 704.0, PAGE_WIDTH - 2.0 * MARGIN, 1.6, GREEN);

    let meta_y = 676.0;
    meta_block(
        ops,
        315.0,
        meta_y,
        "EMIS LE",
        &format_date(&data.issue_date),
    );
    if data.kind == SalesDocumentKind::Invoice && !is_credit_note(&data.document_type) {
        let service = if data.service_date_from == data.service_date_to {
            format_date(&data.service_date_from)
        } else {
            format!(
                "{} - {}",
                format_date(&data.service_date_from),
                format_date(&data.service_date_to)
            )
        };
        meta_block(ops, 405.0, meta_y, "PRESTATION", &service);
    }
    let deadline_label = if data.kind == SalesDocumentKind::Quote {
        "VALABLE JUSQU'AU"
    } else if is_credit_note(&data.document_type) {
        "FACTURE CORRIGEE"
    } else {
        "ECHEANCE"
    };
    let deadline = if is_credit_note(&data.document_type) {
        fallback(&data.original_invoice_number)
    } else {
        format_date(&data.deadline_date)
    };
    meta_block(ops, 500.0, meta_y, deadline_label, &deadline);

    fill_rect(
        ops,
        MARGIN,
        605.0,
        PAGE_WIDTH - 2.0 * MARGIN,
        54.0,
        GREEN_PALE,
    );
    text(ops, MARGIN + 12.0, 644.0, 6.5, "F2", MUTED, "DESTINATAIRE");
    text(
        ops,
        MARGIN + 12.0,
        628.0,
        9.5,
        "F2",
        INK,
        &fallback(&data.customer.name),
    );
    let address = data.customer.address.join(" - ");
    text(ops, MARGIN + 12.0, 614.0, 7.2, "F1", MUTED, &address);
    if !data.customer.email.is_empty() {
        text_right(
            ops,
            PAGE_WIDTH - MARGIN - 12.0,
            614.0,
            7.0,
            "F1",
            MUTED,
            &data.customer.email,
        );
    }
    text(ops, MARGIN, 579.0, 12.0, "F2", INK, &data.title);
}

fn render_continuation_header(ops: &mut Vec<Operation>, data: &SalesPdfData) {
    fill_rect(ops, 0.0, PAGE_HEIGHT - 8.0, PAGE_WIDTH, 8.0, GREEN);
    text(
        ops,
        MARGIN,
        PAGE_HEIGHT - 42.0,
        10.0,
        "F2",
        GREEN,
        "ZENTRA - DOCUMENT LOCAL",
    );
    text_right(
        ops,
        PAGE_WIDTH - MARGIN,
        PAGE_HEIGHT - 42.0,
        10.0,
        "F2",
        INK,
        &format!(
            "{} {} - SUITE",
            document_label(data),
            fallback(&data.number)
        ),
    );
    line_segment(
        ops,
        MARGIN,
        PAGE_HEIGHT - 55.0,
        PAGE_WIDTH - 2.0 * MARGIN,
        1.0,
        GREEN,
    );
}

fn meta_block(ops: &mut Vec<Operation>, right: f32, y: f32, label: &str, value: &str) {
    text_right(ops, right, y, 6.0, "F2", MUTED, label);
    text_right(ops, right, y - 13.0, 7.5, "F2", INK, value);
}

fn render_table_header(ops: &mut Vec<Operation>, y: f32) {
    fill_rect(ops, MARGIN, y - 2.0, PAGE_WIDTH - 2.0 * MARGIN, 22.0, GREEN);
    for (x, label) in [
        (MARGIN + 7.0, "DESCRIPTION"),
        (249.0, "QTE"),
        (287.0, "UNITE"),
        (331.0, "PRIX UNIT."),
        (403.0, "REMISE"),
        (450.0, "TVA"),
    ] {
        text(ops, x, y + 5.0, 6.0, "F2", [1.0, 1.0, 1.0], label);
    }
    text_right(
        ops,
        PAGE_WIDTH - MARGIN - 7.0,
        y + 5.0,
        6.0,
        "F2",
        [1.0, 1.0, 1.0],
        "TOTAL NET",
    );
}

fn render_line(ops: &mut Vec<Operation>, line: &SalesPdfLine, top: f32, height: f32) {
    line_segment(
        ops,
        MARGIN,
        top - height,
        PAGE_WIDTH - 2.0 * MARGIN,
        0.4,
        LINE,
    );
    for (index, wrapped) in wrap_text_width(&line.description, DESCRIPTION_TEXT_WIDTH, 7.2, true)
        .iter()
        .enumerate()
    {
        text(
            ops,
            MARGIN + 7.0,
            top - 13.0 - index as f32 * 8.0,
            if index == 0 { 7.2 } else { 6.8 },
            if index == 0 { "F2" } else { "F1" },
            INK,
            wrapped,
        );
    }
    let baseline = top - 13.0;
    text(
        ops,
        249.0,
        baseline,
        6.6,
        "F1",
        INK,
        &format_quantity(line.quantity),
    );
    text(ops, 287.0, baseline, 6.6, "F1", INK, &line.unit);
    text_right(
        ops,
        397.0,
        baseline,
        6.6,
        "F1",
        INK,
        &format_amount(line.unit_price_cents),
    );
    text_right(
        ops,
        442.0,
        baseline,
        6.6,
        "F1",
        INK,
        if line.discount_bp == 0 {
            "-".into()
        } else {
            format_percent(line.discount_bp)
        }
        .as_str(),
    );
    text_right(
        ops,
        480.0,
        baseline,
        6.6,
        "F1",
        INK,
        &format_percent(line.vat_bp),
    );
    text_right(
        ops,
        PAGE_WIDTH - MARGIN - 7.0,
        baseline,
        6.8,
        "F2",
        INK,
        &format_amount(line.net_cents),
    );
}

fn render_totals_and_notes(ops: &mut Vec<Operation>, data: &SalesPdfData) {
    let base_y = if data.qr.is_some() {
        QR_SECTION_HEIGHT + 27.0
    } else {
        64.0
    };
    let vat_groups = vat_groups(data);
    let totals_height = totals_box_height(data);
    let box_x = 305.0;
    fill_rect(
        ops,
        box_x,
        base_y,
        PAGE_WIDTH - MARGIN - box_x,
        totals_height,
        GREEN_PALE,
    );
    let mut y = base_y + totals_height - 18.0;
    total_row(
        ops,
        y,
        data,
        "Sous-total avant remise",
        data.totals.subtotal_cents,
    );
    y -= 15.0;
    total_row(ops, y, data, "Remises", -data.totals.discount_cents);
    y -= 15.0;
    total_row(ops, y, data, "Total net", data.totals.net_cents);
    y -= 15.0;
    for (rate, (basis, vat)) in vat_groups {
        total_row(
            ops,
            y,
            data,
            &format!(
                "TVA {} sur {}",
                format_percent(rate),
                format_money(&data.currency, basis)
            ),
            vat,
        );
        y -= 15.0;
    }
    total_row(ops, y, data, "TVA totale", data.totals.vat_cents);
    fill_rect(ops, box_x, base_y, PAGE_WIDTH - MARGIN - box_x, 22.0, GREEN);
    text(
        ops,
        box_x + 10.0,
        base_y + 7.0,
        8.5,
        "F2",
        [1.0, 1.0, 1.0],
        if is_credit_note(&data.document_type) {
            "TOTAL AVOIR"
        } else {
            "TOTAL TTC"
        },
    );
    text_right(
        ops,
        PAGE_WIDTH - MARGIN - 10.0,
        base_y + 6.5,
        10.0,
        "F2",
        [1.0, 1.0, 1.0],
        &format_money(&data.currency, data.totals.total_cents),
    );

    let notes = inline_notes_lines(data);
    if !notes.is_empty() {
        text(
            ops,
            MARGIN,
            base_y + totals_height - 13.0,
            6.5,
            "F2",
            MUTED,
            "REMARQUES ET CONDITIONS",
        );
        for (index, line) in notes.iter().enumerate() {
            text(
                ops,
                MARGIN,
                base_y + totals_height - 29.0 - index as f32 * 9.0,
                6.8,
                "F1",
                INK,
                line,
            );
        }
    }
    if data.qr.is_none() && !data.issuer.iban.is_empty() && !is_credit_note(&data.document_type) {
        text(
            ops,
            MARGIN,
            base_y + 8.0,
            7.0,
            "F2",
            INK,
            &format!("IBAN {}", grouped_iban(&data.issuer.iban)),
        );
    }
}

fn totals_box_height(data: &SalesPdfData) -> f32 {
    // La zone claire comprend une vraie garde au-dessus de la barre verte de
    // 22 pt. La dernière ligne « TVA totale » conserve ainsi sa ligne de base
    // à 31 pt du bas et ne peut plus être recouverte par le total TTC.
    let financial_height = 34.0 + (4 + vat_groups(data).len()) as f32 * 15.0;
    let notes = inline_notes_lines(data);
    let notes_height = if notes.is_empty() {
        0.0
    } else {
        37.0 + notes.len().saturating_sub(1) as f32 * 9.0
    };
    financial_height.max(notes_height)
}

fn notes_lines(data: &SalesPdfData) -> Vec<String> {
    let notes = [data.notes.trim(), data.terms.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" - ");
    if notes.is_empty() {
        Vec::new()
    } else {
        wrap_text_width(&notes, NOTES_TEXT_WIDTH, 6.8, false)
    }
}

fn inline_notes_lines(data: &SalesPdfData) -> Vec<String> {
    let lines = notes_lines(data);
    if lines.len() <= 6 {
        lines
    } else {
        Vec::new()
    }
}

fn total_row(
    ops: &mut Vec<Operation>,
    y: f32,
    data: &SalesPdfData,
    label: &str,
    amount_cents: i64,
) {
    text(ops, 315.0, y, 6.5, "F1", MUTED, label);
    text_right(
        ops,
        PAGE_WIDTH - MARGIN - 10.0,
        y,
        7.0,
        "F2",
        INK,
        &format_money(&data.currency, amount_cents),
    );
}

fn vat_groups(data: &SalesPdfData) -> BTreeMap<i64, (i64, i64)> {
    let mut groups = BTreeMap::new();
    for line in &data.lines {
        let entry = groups.entry(line.vat_bp).or_insert((0_i64, 0_i64));
        entry.0 = entry.0.saturating_add(line.net_cents);
        entry.1 = entry.1.saturating_add(line.vat_cents);
    }
    groups
}

fn render_footer(
    ops: &mut Vec<Operation>,
    data: &SalesPdfData,
    page_number: usize,
    total_pages: usize,
    last: bool,
) {
    let page_label = format!("Zentra - {page_number}/{total_pages}");
    if last && data.qr.is_some() {
        // La ligne horizontale doit rester visuellement réservée à
        // l'instruction de détachement de la QR-facture.
        if let Some(qr) = &data.qr {
            let frozen_date = qr
                .frozen_at
                .split('T')
                .next()
                .filter(|value| !value.is_empty())
                .map(format_date)
                .unwrap_or_else(|| "date inconnue".into());
            text(
                ops,
                MARGIN,
                QR_SECTION_HEIGHT + 18.0,
                6.2,
                "F1",
                MUTED,
                &format!("Document et QR figés localement - QR du {frozen_date}"),
            );
        }
        text_right(
            ops,
            PAGE_WIDTH - MARGIN,
            QR_SECTION_HEIGHT + 9.0,
            6.2,
            "F1",
            MUTED,
            &page_label,
        );
        return;
    }
    let y = 28.0;
    let proof = if data.final_document {
        if data.captured_at.is_empty() {
            "Valeurs issues de l'instantané local immuable".to_owned()
        } else {
            format!(
                "Valeurs figées localement le {}",
                format_date(
                    data.captured_at
                        .split('T')
                        .next()
                        .unwrap_or(&data.captured_at)
                )
            )
        }
    } else {
        "Brouillon local - non émis - contrôle obligatoire".to_owned()
    };
    text(ops, MARGIN, y, 6.2, "F1", MUTED, &proof);
    text_right(ops, PAGE_WIDTH - MARGIN, y, 6.2, "F1", MUTED, &page_label);
}

fn render_qr_section(ops: &mut Vec<Operation>, qr: &SalesPdfQr) -> AppResult<()> {
    let receipt_width = mm(62.0);
    dashed_line(ops, 0.0, QR_SECTION_HEIGHT, PAGE_WIDTH, 0.7);
    dashed_vertical_line(ops, receipt_width, 0.0, QR_SECTION_HEIGHT, 0.7);
    // Une QR-facture électronique doit identifier explicitement chaque ligne
    // de séparation. Les instructions restent hors du contenu de paiement.
    text(
        ops,
        mm(5.0),
        QR_SECTION_HEIGHT + mm(2.0),
        6.0,
        "F2",
        [0.0, 0.0, 0.0],
        "À DÉTACHER AVANT LE VERSEMENT",
    );
    vertical_text(
        ops,
        receipt_width - mm(1.5),
        mm(38.0),
        5.5,
        "F2",
        [0.0, 0.0, 0.0],
        "À DÉTACHER AVANT LE VERSEMENT",
    );
    text(
        ops,
        mm(5.0),
        QR_SECTION_HEIGHT - mm(10.0),
        11.0,
        "F2",
        [0.0, 0.0, 0.0],
        "Récépissé",
    );
    text(
        ops,
        receipt_width + mm(5.0),
        QR_SECTION_HEIGHT - mm(10.0),
        11.0,
        "F2",
        [0.0, 0.0, 0.0],
        "Section paiement",
    );

    render_qr_receipt(ops, qr);
    let code_x = receipt_width + mm(10.0);
    let code_y = mm(35.0);
    render_qr_code(ops, &qr.payload, code_x, code_y, mm(46.0))?;
    render_swiss_cross(ops, code_x + mm(23.0), code_y + mm(23.0));
    render_qr_payment_copy(ops, qr, receipt_width + mm(61.0));
    Ok(())
}

const QR_VALUE_FONT_SIZE: f32 = 6.0;
const QR_VALUE_LINE_HEIGHT: f32 = 7.2;
const QR_RECEIPT_TEXT_WIDTH: f32 = mm(52.0);
const QR_PAYMENT_TEXT_WIDTH: f32 = mm(80.0);

fn render_qr_receipt(ops: &mut Vec<Operation>, qr: &SalesPdfQr) {
    let input = &qr.input;
    let x = mm(5.0);
    let mut y = QR_SECTION_HEIGHT - mm(18.0);
    qr_label(ops, x, y, "Compte / Payable à");
    y -= 8.0;
    y = render_qr_values(
        ops,
        x,
        y,
        &wrapped_qr_party_lines(&input.creditor, Some(&input.iban), QR_RECEIPT_TEXT_WIDTH),
    );
    if !input.reference.is_empty() {
        y -= 3.0;
        qr_label(ops, x, y, "Référence");
        y -= 8.0;
        y = render_qr_values(
            ops,
            x,
            y,
            &wrap_text_width(
                &grouped_reference(input),
                QR_RECEIPT_TEXT_WIDTH,
                QR_VALUE_FONT_SIZE,
                false,
            ),
        );
    }
    if let Some(debtor) = &input.debtor {
        y -= 3.0;
        qr_label(ops, x, y, "Payable par");
        y -= 8.0;
        let _ = render_qr_values(
            ops,
            x,
            y,
            &wrapped_qr_party_lines(debtor, None, QR_RECEIPT_TEXT_WIDTH),
        );
    }
    qr_amount(ops, x, mm(16.0), input);
    text_right(
        ops,
        receipt_width_right(),
        mm(5.0),
        6.0,
        "F2",
        [0.0, 0.0, 0.0],
        "Point de dépôt",
    );
}

fn receipt_width_right() -> f32 {
    mm(62.0) - mm(5.0)
}

fn render_qr_payment_copy(ops: &mut Vec<Operation>, qr: &SalesPdfQr, x: f32) {
    let input = &qr.input;
    let mut y = QR_SECTION_HEIGHT - mm(19.0);
    qr_label(ops, x, y, "Compte / Payable à");
    y -= 8.0;
    y = render_qr_values(
        ops,
        x,
        y,
        &wrapped_qr_party_lines(&input.creditor, Some(&input.iban), QR_PAYMENT_TEXT_WIDTH),
    );
    if !input.reference.is_empty() {
        y -= 3.0;
        qr_label(ops, x, y, "Référence");
        y -= 8.0;
        y = render_qr_values(
            ops,
            x,
            y,
            &wrap_text_width(
                &grouped_reference(input),
                QR_PAYMENT_TEXT_WIDTH,
                QR_VALUE_FONT_SIZE,
                false,
            ),
        );
    }
    let extra = wrapped_qr_extra_lines(input, QR_PAYMENT_TEXT_WIDTH);
    if !extra.is_empty() {
        y -= 3.0;
        qr_label(ops, x, y, "Informations supplémentaires");
        y -= 8.0;
        y = render_qr_values(ops, x, y, &extra);
    }
    if let Some(debtor) = &input.debtor {
        y -= 3.0;
        qr_label(ops, x, y, "Payable par");
        y -= 8.0;
        let _ = render_qr_values(
            ops,
            x,
            y,
            &wrapped_qr_party_lines(debtor, None, QR_PAYMENT_TEXT_WIDTH),
        );
    }
    qr_amount(ops, mm(67.0), mm(8.0), input);
}

fn render_qr_values(ops: &mut Vec<Operation>, x: f32, mut y: f32, lines: &[String]) -> f32 {
    for line in lines {
        text(ops, x, y, QR_VALUE_FONT_SIZE, "F1", [0.0, 0.0, 0.0], line);
        y -= QR_VALUE_LINE_HEIGHT;
    }
    y
}

fn wrapped_qr_party_lines(
    party: &crate::models::SwissQrParty,
    iban: Option<&str>,
    max_width: f32,
) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(iban) = iban {
        values.push(grouped_iban(iban));
    }
    values.extend(party_address_lines(party));
    values
        .into_iter()
        .flat_map(|value| wrap_text_width(&value, max_width, QR_VALUE_FONT_SIZE, false))
        .collect()
}

fn wrapped_qr_extra_lines(input: &SwissQrBillInput, max_width: f32) -> Vec<String> {
    [
        input.unstructured_message.trim(),
        input.bill_information.trim(),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .flat_map(|value| wrap_text_width(value, max_width, QR_VALUE_FONT_SIZE, false))
    .collect()
}

fn qr_visible_content_bottom(
    input: &SwissQrBillInput,
    max_width: f32,
    start_y: f32,
    include_extra: bool,
) -> f32 {
    let mut y = start_y - 8.0;
    y -= wrapped_qr_party_lines(&input.creditor, Some(&input.iban), max_width).len() as f32
        * QR_VALUE_LINE_HEIGHT;
    if !input.reference.is_empty() {
        y -= 3.0 + 8.0;
        y -= wrap_text_width(
            &grouped_reference(input),
            max_width,
            QR_VALUE_FONT_SIZE,
            false,
        )
        .len() as f32
            * QR_VALUE_LINE_HEIGHT;
    }
    if include_extra {
        let extra = wrapped_qr_extra_lines(input, max_width);
        if !extra.is_empty() {
            y -= 3.0 + 8.0;
            y -= extra.len() as f32 * QR_VALUE_LINE_HEIGHT;
        }
    }
    if let Some(debtor) = &input.debtor {
        y -= 3.0 + 8.0;
        y -= wrapped_qr_party_lines(debtor, None, max_width).len() as f32 * QR_VALUE_LINE_HEIGHT;
    }
    y
}

fn validate_qr_visible_layout(data: &SalesPdfData) -> AppResult<()> {
    let Some(qr) = &data.qr else {
        return Ok(());
    };
    let receipt_bottom = qr_visible_content_bottom(
        &qr.input,
        QR_RECEIPT_TEXT_WIDTH,
        QR_SECTION_HEIGHT - mm(18.0),
        false,
    );
    let payment_bottom = qr_visible_content_bottom(
        &qr.input,
        QR_PAYMENT_TEXT_WIDTH,
        QR_SECTION_HEIGHT - mm(19.0),
        true,
    );
    if receipt_bottom < mm(22.0) || payment_bottom < mm(18.0) {
        return Err(AppError::Validation(
            "Les valeurs de la QR-facture dépassent les zones visibles SIX. Raccourcissez les noms, adresses ou informations supplémentaires : Zentra refuse toute ellipse ou omission."
                .into(),
        ));
    }
    Ok(())
}

fn qr_label(ops: &mut Vec<Operation>, x: f32, y: f32, value: &str) {
    text(ops, x, y, 6.0, "F2", [0.0, 0.0, 0.0], value);
}

fn qr_amount(ops: &mut Vec<Operation>, x: f32, y: f32, input: &SwissQrBillInput) {
    text(ops, x, y + 11.0, 6.0, "F2", [0.0, 0.0, 0.0], "Monnaie");
    text(ops, x, y, 8.0, "F2", [0.0, 0.0, 0.0], &input.currency);
    text(
        ops,
        x + mm(20.0),
        y + 11.0,
        6.0,
        "F2",
        [0.0, 0.0, 0.0],
        "Montant",
    );
    text(
        ops,
        x + mm(20.0),
        y,
        8.0,
        "F2",
        [0.0, 0.0, 0.0],
        &input.amount_cents.map(format_qr_amount).unwrap_or_default(),
    );
}

fn format_qr_amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let absolute = cents.unsigned_abs();
    let francs = absolute / 100;
    let decimals = absolute % 100;
    let digits = francs.to_string();
    let mut grouped = String::new();
    for (index, character) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(' ');
        }
        grouped.push(character);
    }
    let grouped: String = grouped.chars().rev().collect();
    format!("{sign}{grouped}.{decimals:02}")
}

fn party_address_lines(party: &crate::models::SwissQrParty) -> Vec<String> {
    compact_lines([
        party.name.clone(),
        join_non_empty(&party.street, &party.building_number),
        join_non_empty(&party.postal_code, &party.city),
        party.country.clone(),
    ])
}

fn grouped_iban(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<Vec<_>>()
        .chunks(4)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

fn grouped_reference(input: &SwissQrBillInput) -> String {
    let raw = input
        .reference
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    if input.reference_type == "QRR" && raw.len() > 2 {
        let mut groups = vec![raw[..2].to_owned()];
        groups.extend(
            raw[2..]
                .as_bytes()
                .chunks(5)
                .map(|chunk| String::from_utf8_lossy(chunk).into_owned()),
        );
        groups.join(" ")
    } else {
        raw.as_bytes()
            .chunks(4)
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn render_qr_code(
    ops: &mut Vec<Operation>,
    payload: &str,
    x: f32,
    y: f32,
    size: f32,
) -> AppResult<()> {
    let code =
        QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M).map_err(|error| {
            AppError::Validation(format!("Le code QR SPC ne peut pas être encodé : {error}"))
        })?;
    let width = code.width();
    if width == 0 {
        return Err(AppError::Validation("La matrice QR SPC est vide.".into()));
    }
    let colors = code.to_colors();
    let module = size / width as f32;
    for row in 0..width {
        let mut column = 0;
        while column < width {
            if colors[row * width + column] != QrColor::Dark {
                column += 1;
                continue;
            }
            let start = column;
            while column < width && colors[row * width + column] == QrColor::Dark {
                column += 1;
            }
            fill_rect(
                ops,
                x + start as f32 * module,
                y + (width - 1 - row) as f32 * module,
                (column - start) as f32 * module,
                module,
                [0.0, 0.0, 0.0],
            );
        }
    }
    Ok(())
}

fn render_swiss_cross(ops: &mut Vec<Operation>, center_x: f32, center_y: f32) {
    // Le symbole de reconnaissance complet, bord blanc inclus, reste dans
    // l'enveloppe réglementaire exacte de 7 x 7 mm.
    let border = mm(7.0);
    let square = mm(6.4);
    fill_rect(
        ops,
        center_x - border / 2.0,
        center_y - border / 2.0,
        border,
        border,
        [1.0, 1.0, 1.0],
    );
    fill_rect(
        ops,
        center_x - square / 2.0,
        center_y - square / 2.0,
        square,
        square,
        [0.0, 0.0, 0.0],
    );
    fill_rect(
        ops,
        center_x - mm(1.92),
        center_y - mm(0.62),
        mm(3.84),
        mm(1.24),
        [1.0, 1.0, 1.0],
    );
    fill_rect(
        ops,
        center_x - mm(0.62),
        center_y - mm(1.92),
        mm(1.24),
        mm(3.84),
        [1.0, 1.0, 1.0],
    );
}

fn replace_file(temporary: &Path, destination: &Path) -> AppResult<()> {
    if !destination.exists() {
        fs::rename(temporary, destination)?;
        return Ok(());
    }
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf");
    let backup = destination.with_file_name(format!(
        ".{file_name}.{}.zentra-backup",
        uuid::Uuid::new_v4()
    ));
    fs::rename(destination, &backup)?;
    match fs::rename(temporary, destination) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(write_error) => match fs::rename(&backup, destination) {
            Ok(()) => Err(write_error.into()),
            Err(rollback_error) => Err(AppError::Validation(format!(
                "Le nouveau PDF n'a pas pu remplacer l'ancien et la restauration automatique a échoué. L'ancien fichier reste récupérable ici : {} ({rollback_error})",
                backup.to_string_lossy()
            ))),
        },
    }
}

fn add_font(document: &mut Document, base_font: &str) -> ObjectId {
    document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => base_font,
        "Encoding" => "WinAnsiEncoding",
    })
}

fn add_logo_image(document: &mut Document, logo: &PdfLogo) -> ObjectId {
    document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => i64::from(logo.width),
            "Height" => i64::from(logo.height),
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        logo.rgb.clone(),
    ))
}

fn fitted_size(width: u32, height: u32, max_width: f32, max_height: f32) -> (f32, f32) {
    let width = width.max(1) as f32;
    let height = height.max(1) as f32;
    let scale = (max_width / width).min(max_height / height);
    (width * scale, height * scale)
}

fn draw_image(ops: &mut Vec<Operation>, name: &str, x: f32, y: f32, width: f32, height: f32) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "cm",
        vec![
            Object::Real(width),
            0.into(),
            0.into(),
            Object::Real(height),
            Object::Real(x),
            Object::Real(y),
        ],
    ));
    ops.push(Operation::new(
        "Do",
        vec![Object::Name(name.as_bytes().to_vec())],
    ));
    ops.push(Operation::new("Q", vec![]));
}

fn text(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    size: f32,
    font: &str,
    color: [f32; 3],
    value: &str,
) {
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(font.as_bytes().to_vec()), Object::Real(size)],
    ));
    ops.push(Operation::new(
        "rg",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new(
        "Tm",
        vec![
            1.into(),
            0.into(),
            0.into(),
            1.into(),
            Object::Real(x),
            Object::Real(y),
        ],
    ));
    ops.push(Operation::new("Tj", vec![pdf_literal(value)]));
    ops.push(Operation::new("ET", vec![]));
}

fn rotated_text(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    size: f32,
    font: &str,
    color: [f32; 3],
    value: &str,
) {
    let angle = 0.42_f32;
    let (sin, cos) = angle.sin_cos();
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(font.as_bytes().to_vec()), Object::Real(size)],
    ));
    ops.push(Operation::new(
        "rg",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new(
        "Tm",
        vec![
            Object::Real(cos),
            Object::Real(sin),
            Object::Real(-sin),
            Object::Real(cos),
            Object::Real(x),
            Object::Real(y),
        ],
    ));
    ops.push(Operation::new("Tj", vec![pdf_literal(value)]));
    ops.push(Operation::new("ET", vec![]));
}

fn vertical_text(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    size: f32,
    font: &str,
    color: [f32; 3],
    value: &str,
) {
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(font.as_bytes().to_vec()), Object::Real(size)],
    ));
    ops.push(Operation::new(
        "rg",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new(
        "Tm",
        vec![
            0.into(),
            1.into(),
            (-1).into(),
            0.into(),
            Object::Real(x),
            Object::Real(y),
        ],
    ));
    ops.push(Operation::new("Tj", vec![pdf_literal(value)]));
    ops.push(Operation::new("ET", vec![]));
}

fn text_right(
    ops: &mut Vec<Operation>,
    right: f32,
    y: f32,
    size: f32,
    font: &str,
    color: [f32; 3],
    value: &str,
) {
    let width = helvetica_text_width(value, size, font == "F2");
    text(
        ops,
        (right - width).max(MARGIN),
        y,
        size,
        font,
        color,
        value,
    );
}

fn fill_rect(ops: &mut Vec<Operation>, x: f32, y: f32, width: f32, height: f32, color: [f32; 3]) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "rg",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new(
        "re",
        [x, y, width, height]
            .into_iter()
            .map(Object::Real)
            .collect(),
    ));
    ops.push(Operation::new("f", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn line_segment(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    width: f32,
    line_width: f32,
    color: [f32; 3],
) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "RG",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new("w", vec![Object::Real(line_width)]));
    ops.push(Operation::new("m", vec![Object::Real(x), Object::Real(y)]));
    ops.push(Operation::new(
        "l",
        vec![Object::Real(x + width), Object::Real(y)],
    ));
    ops.push(Operation::new("S", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn dashed_line(ops: &mut Vec<Operation>, x: f32, y: f32, width: f32, line_width: f32) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new("RG", vec![0.into(), 0.into(), 0.into()]));
    ops.push(Operation::new("w", vec![Object::Real(line_width)]));
    ops.push(Operation::new(
        "d",
        vec![Object::Array(vec![3.into(), 2.into()]), 0.into()],
    ));
    ops.push(Operation::new("m", vec![Object::Real(x), Object::Real(y)]));
    ops.push(Operation::new(
        "l",
        vec![Object::Real(x + width), Object::Real(y)],
    ));
    ops.push(Operation::new("S", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn dashed_vertical_line(ops: &mut Vec<Operation>, x: f32, y: f32, height: f32, line_width: f32) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new("RG", vec![0.into(), 0.into(), 0.into()]));
    ops.push(Operation::new("w", vec![Object::Real(line_width)]));
    ops.push(Operation::new(
        "d",
        vec![Object::Array(vec![3.into(), 2.into()]), 0.into()],
    ));
    ops.push(Operation::new("m", vec![Object::Real(x), Object::Real(y)]));
    ops.push(Operation::new(
        "l",
        vec![Object::Real(x), Object::Real(y + height)],
    ));
    ops.push(Operation::new("S", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn pdf_literal(value: &str) -> Object {
    let normalized = normalize_pdf_text(value);
    let (encoded, _, _) = WINDOWS_1252.encode(&normalized);
    Object::String(encoded.into_owned(), StringFormat::Literal)
}

fn normalize_pdf_text(value: &str) -> String {
    value
        .replace('’', "'")
        .replace(['–', '—', '·'], "-")
        .replace('→', "->")
        .replace(['\n', '\r'], " ")
}

fn helvetica_glyph_width_1000(character: char, bold: bool) -> f32 {
    // Bornes conservatrices en unités AFM pour Helvetica/Helvetica-Bold.
    // Chaque valeur est égale ou supérieure à la largeur Adobe correspondante
    // (notamment G/O/Q=778, m gras=889, w gras=778 et ligatures jusqu'à 1000).
    // Les glyphes inconnus prennent 1100: le wrapping peut être anticipé, mais
    // ne doit jamais sous-estimer la place imprimée ni déborder silencieusement.
    match character {
        ' ' | '\u{00a0}' => 300.0,
        'W' => 960.0,
        'M' => {
            if bold {
                900.0
            } else {
                850.0
            }
        }
        'm' => {
            if bold {
                900.0
            } else {
                850.0
            }
        }
        'w' => {
            if bold {
                800.0
            } else {
                740.0
            }
        }
        'Æ' | 'Œ' => 1_100.0,
        'æ' | 'œ' => 1_000.0,
        'I' | 'i' | 'l' | '!' | '|' | '.' | ',' | ':' | ';' | '\'' | '`' => {
            if bold && matches!(character, '!' | ':' | ';') {
                340.0
            } else {
                300.0
            }
        }
        'f' | 't' | 'r' | 'j' | '(' | ')' | '[' | ']' | '{' | '}' => 400.0,
        '-' | '_' | '/' | '\\' => 400.0,
        '0'..='9' => 600.0,
        'G' | 'O' | 'Q' => 800.0,
        'A'..='Z' => {
            if bold {
                760.0
            } else {
                730.0
            }
        }
        'a'..='z' => {
            if bold {
                620.0
            } else {
                600.0
            }
        }
        character if character.is_uppercase() => 800.0,
        character if character.is_lowercase() || character.is_alphabetic() => 700.0,
        _ => 1_100.0,
    }
}

fn helvetica_text_width(value: &str, font_size: f32, bold: bool) -> f32 {
    normalize_pdf_text(value)
        .chars()
        .map(|character| helvetica_glyph_width_1000(character, bold))
        .sum::<f32>()
        * font_size
        / 1_000.0
}

fn wrap_text_width(value: &str, max_width: f32, font_size: f32, bold: bool) -> Vec<String> {
    let normalized = normalize_pdf_text(value.trim());
    if normalized.is_empty() {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in normalized.split_whitespace() {
        if helvetica_text_width(word, font_size, bold) > max_width {
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            let mut segment = String::new();
            for character in word.chars() {
                let mut proposed = segment.clone();
                proposed.push(character);
                if !segment.is_empty()
                    && helvetica_text_width(&proposed, font_size, bold) > max_width
                {
                    lines.push(std::mem::take(&mut segment));
                }
                segment.push(character);
            }
            if !segment.is_empty() {
                lines.push(segment);
            }
            continue;
        }
        let proposed = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if helvetica_text_width(&proposed, font_size, bold) > max_width && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn fallback_string(value: &Value, key: &str, fallback: &str) -> String {
    let current = string_at(value, key);
    if current.is_empty() {
        fallback.into()
    } else {
        current
    }
}

fn integer_at(value: &Value, key: &str) -> i64 {
    optional_integer_at(value, key).unwrap_or_default()
}

fn optional_integer_at(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|entry| {
        entry
            .as_i64()
            .or_else(|| entry.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

fn number_at(value: &Value, key: &str) -> f64 {
    value
        .get(key)
        .and_then(|entry| {
            entry
                .as_f64()
                .or_else(|| entry.as_i64().map(|number| number as f64))
        })
        .unwrap_or_default()
}

fn bool_at(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|entry| {
            entry
                .as_bool()
                .or_else(|| entry.as_i64().map(|number| number != 0))
        })
        .unwrap_or(false)
}

fn compact_lines<const N: usize>(values: [String; N]) -> Vec<String> {
    values
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect()
}

fn join_non_empty(left: &str, right: &str) -> String {
    [left.trim(), right.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn fallback(value: &str) -> String {
    if value.trim().is_empty() {
        "-".into()
    } else {
        value.trim().into()
    }
}

fn round_basis_points(value: i64, basis_points: i64) -> i64 {
    if value == 0 || basis_points == 0 {
        return 0;
    }
    let absolute = value.unsigned_abs() as u128;
    let rate = basis_points.unsigned_abs() as u128;
    let rounded = ((absolute * rate + 5_000) / 10_000).min(i64::MAX as u128) as i64;
    if value < 0 {
        -rounded
    } else {
        rounded
    }
}

fn format_money(currency: &str, cents: i64) -> String {
    format!("{} {}", fallback(currency), format_amount(cents))
}

fn format_amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let absolute = cents.unsigned_abs();
    let francs = absolute / 100;
    let decimals = absolute % 100;
    let digits = francs.to_string();
    let mut grouped = String::new();
    for (index, character) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push('\'');
        }
        grouped.push(character);
    }
    let grouped: String = grouped.chars().rev().collect();
    format!("{sign}{grouped}.{decimals:02}")
}

fn format_percent(basis_points: i64) -> String {
    let integer = basis_points / 100;
    let decimals = basis_points.unsigned_abs() % 100;
    if decimals == 0 {
        format!("{integer}%")
    } else {
        format!("{integer}.{decimals:02}%")
    }
}

fn format_quantity(value: f64) -> String {
    let mut formatted = format!("{value:.3}");
    while formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    formatted
}

fn format_date(value: &str) -> String {
    let parts = value.split('-').collect::<Vec<_>>();
    if parts.len() == 3 {
        format!("{}.{}.{}", parts[2], parts[1], parts[0])
    } else {
        fallback(value)
    }
}

fn is_credit_note(value: &str) -> bool {
    matches!(value, "avoir" | "credit_note")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage_then_tamper_logo(directory: &tempfile::TempDir) -> (String, PathBuf) {
        let store = LocalStore::initialize(directory.path().join("profile")).expect("store");
        let source = directory.path().join("source-logo.png");
        image::DynamicImage::new_rgba8(64, 32)
            .save_with_format(&source, image::ImageFormat::Png)
            .expect("write original logo");
        let staged = store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("stage immutable logo");
        image::DynamicImage::new_rgba8(80, 40)
            .save_with_format(&staged, image::ImageFormat::Png)
            .expect("replace immutable logo with another valid image");
        assert!(
            crate::branding::load_pdf_logo(&staged).is_some(),
            "the altered file stays a valid image, so only its digest can reject it"
        );
        let branding_dir = Path::new(&staged)
            .parent()
            .expect("branding directory")
            .to_path_buf();
        (staged, branding_dir)
    }

    fn install_audit_table(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE audit_log(
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    previous_hash TEXT,
                    entry_hash TEXT NOT NULL UNIQUE
                );",
            )
            .unwrap();
    }

    fn append_quote_issue(connection: &Connection, id: &str, number: &str, snapshot_json: &str) {
        let transaction = connection.unchecked_transaction().unwrap();
        crate::audit::append_audit(
            &transaction,
            "issue",
            "quote",
            id,
            &json!({
                "id": id,
                "number": number,
                "snapshot_json": snapshot_json,
            }),
        )
        .unwrap();
        transaction.commit().unwrap();
    }

    fn sample_qr() -> SalesPdfQr {
        let input = SwissQrBillInput {
            iban: "CH4431999123000889012".into(),
            creditor: crate::models::SwissQrParty {
                name: "Atelier Exemple SA".into(),
                street: "Rue du Lac".into(),
                building_number: "8".into(),
                postal_code: "1000".into(),
                city: "Lausanne".into(),
                country: "CH".into(),
            },
            amount_cents: Some(194_900),
            currency: "CHF".into(),
            debtor: Some(crate::models::SwissQrParty {
                name: "Client Exemple Sàrl".into(),
                street: "Route du Test".into(),
                building_number: "12".into(),
                postal_code: "1200".into(),
                city: "Genève".into(),
                country: "CH".into(),
            }),
            reference_type: "QRR".into(),
            reference: "210000000003139471430009017".into(),
            unstructured_message: "Facture F-2026-0001".into(),
            bill_information: String::new(),
            alternative_procedures: vec![],
        };
        let payload = swiss_qr::generate(input.clone()).unwrap().payload;
        SalesPdfQr {
            input,
            payload,
            frozen_at: "2026-09-01T10:00:00Z".into(),
        }
    }

    fn sample_data(line_count: usize, qr: bool) -> SalesPdfData {
        let lines = (0..line_count)
            .map(|index| SalesPdfLine {
                description: format!(
                    "Prestation professionnelle numéro {} avec une description contrôlée",
                    index + 1
                ),
                quantity: 1.0,
                unit: "forfait".into(),
                unit_price_cents: if index == 0 { 194_900 } else { 0 },
                discount_bp: 0,
                vat_bp: 0,
                net_cents: if index == 0 { 194_900 } else { 0 },
                vat_cents: 0,
                total_cents: if index == 0 { 194_900 } else { 0 },
            })
            .collect();
        SalesPdfData {
            kind: SalesDocumentKind::Invoice,
            number: "F-2026-0001".into(),
            title: "Prestations de septembre".into(),
            document_type: "standard".into(),
            issue_date: "2026-09-01".into(),
            deadline_date: "2026-09-30".into(),
            service_date_from: "2026-08-01".into(),
            service_date_to: "2026-08-31".into(),
            currency: "CHF".into(),
            notes: "Merci pour votre confiance.".into(),
            terms: "Paiement à 30 jours.".into(),
            captured_at: "2026-09-01T10:00:00Z".into(),
            original_invoice_number: String::new(),
            issuer: SalesPdfIssuer {
                company_name: "Atelier Exemple SA".into(),
                legal_form: "SA".into(),
                address: vec!["Rue du Lac 8".into(), "1000 Lausanne".into(), "CH".into()],
                uid_number: "CHE-123.456.789".into(),
                vat_number: "CHE-123.456.789 TVA".into(),
                vat_registered: true,
                iban: "CH4431999123000889012".into(),
                logo_path: String::new(),
            },
            customer: SalesPdfCustomer {
                name: "Client Exemple Sàrl".into(),
                address: vec!["Route du Test 12".into(), "1200 Genève".into(), "CH".into()],
                email: "client@example.ch".into(),
            },
            lines,
            totals: SalesPdfTotals {
                subtotal_cents: 194_900,
                discount_cents: 0,
                net_cents: 194_900,
                vat_cents: 0,
                total_cents: 194_900,
            },
            qr: qr.then(sample_qr),
            final_document: true,
        }
    }

    #[test]
    fn final_snapshot_is_used_instead_of_live_document_values() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE quotes(id TEXT PRIMARY KEY, number TEXT, snapshot_json TEXT);
                 INSERT INTO quotes VALUES(
                   'quote-1',
                   'D-2026-0001',
                   '{\"schema\":\"helvichantier.document_snapshot.v1\",\"captured_at\":\"2026-09-01T10:00:00Z\",\"issuer\":{\"company_name\":\"Société figée\",\"address_line1\":\"Rue du Lac 1\",\"postal_code\":\"1000\",\"city\":\"Lausanne\",\"vat_registered\":false},\"customer\":{\"name\":\"Client figé\",\"address_line1\":\"Rue du Test 2\",\"postal_code\":\"1200\",\"city\":\"Genève\"},\"document\":{\"id\":\"quote-1\",\"number\":\"D-2026-0001\",\"title\":\"Devis figé\",\"issue_date\":\"2026-09-01\",\"valid_until\":\"2026-09-30\",\"currency\":\"CHF\",\"subtotal_cents\":10000,\"discount_cents\":0,\"vat_cents\":0,\"total_cents\":10000},\"items\":[{\"description\":\"Ligne figée\",\"quantity\":1,\"unit\":\"forfait\",\"unit_price_cents\":10000,\"discount_bp\":0,\"vat_bp\":0,\"line_net_cents\":10000,\"line_vat_cents\":0,\"line_total_cents\":10000}],\"qr_bill\":null}'
                 );",
            )
            .unwrap();
        install_audit_table(&connection);
        let snapshot_json: String = connection
            .query_row(
                "SELECT snapshot_json FROM quotes WHERE id='quote-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        append_quote_issue(&connection, "quote-1", "D-2026-0001", &snapshot_json);
        let data = load_sales_pdf_data(&connection, "quotes", "quote-1").unwrap();
        assert!(data.final_document);
        assert_eq!(data.issuer.company_name, "Société figée");
        assert_eq!(data.customer.name, "Client figé");
        assert_eq!(data.lines[0].description, "Ligne figée");
        assert_eq!(data.totals.total_cents, 10_000);
    }

    #[test]
    fn final_pdf_requires_exact_issue_event_number_and_snapshot() {
        fn final_quote_connection(
            event_number: &str,
            event_snapshot_override: Option<&str>,
        ) -> Connection {
            let connection = Connection::open_in_memory().unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE quotes(id TEXT PRIMARY KEY, number TEXT, snapshot_json TEXT);",
                )
                .unwrap();
            let snapshot = json!({
                "schema": "helvichantier.document_snapshot.v1",
                "captured_at": "2026-09-01T10:00:00Z",
                "issuer": {
                    "company_name": "Société figée",
                    "address_line1": "Rue du Lac 1",
                    "postal_code": "1000",
                    "city": "Lausanne",
                    "vat_registered": false
                },
                "customer": {
                    "name": "Client figé",
                    "address_line1": "Rue du Test 2",
                    "postal_code": "1200",
                    "city": "Genève"
                },
                "document": {
                    "id": "quote-audit",
                    "number": "D-2026-0004",
                    "title": "Devis audité",
                    "issue_date": "2026-09-01",
                    "valid_until": "2026-09-30",
                    "currency": "CHF",
                    "subtotal_cents": 10_000,
                    "discount_cents": 0,
                    "vat_cents": 0,
                    "total_cents": 10_000
                },
                "items": [{
                    "description": "Ligne figée",
                    "quantity": 1,
                    "unit": "forfait",
                    "unit_price_cents": 10_000,
                    "discount_bp": 0,
                    "vat_bp": 0,
                    "line_net_cents": 10_000,
                    "line_vat_cents": 0,
                    "line_total_cents": 10_000
                }],
                "qr_bill": null
            })
            .to_string();
            connection
                .execute(
                    "INSERT INTO quotes(id,number,snapshot_json) VALUES('quote-audit','D-2026-0004',?)",
                    params![snapshot],
                )
                .unwrap();
            install_audit_table(&connection);
            let event_snapshot = event_snapshot_override.unwrap_or(&snapshot);
            append_quote_issue(&connection, "quote-audit", event_number, event_snapshot);
            connection
        }

        let wrong_number = final_quote_connection("D-2026-9999", None);
        let error = load_sales_pdf_data(&wrong_number, "quotes", "quote-audit").unwrap_err();
        assert!(error.to_string().contains("numéro"));

        let altered_snapshot = json!({"schema":"helvichantier.document_snapshot.v1"}).to_string();
        let wrong_snapshot = final_quote_connection("D-2026-0004", Some(&altered_snapshot));
        let error = load_sales_pdf_data(&wrong_snapshot, "quotes", "quote-audit").unwrap_err();
        assert!(error.to_string().contains("instantané final"));

        let broken_chain = final_quote_connection("D-2026-0004", None);
        broken_chain
            .execute(
                "UPDATE audit_log SET payload_json='{}' WHERE entity_id='quote-audit'",
                [],
            )
            .unwrap();
        let error = load_sales_pdf_data(&broken_chain, "quotes", "quote-audit").unwrap_err();
        assert!(error.to_string().contains("audit"));
    }

    #[test]
    fn incomplete_final_snapshot_is_rejected_without_recalculation() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE quotes(id TEXT PRIMARY KEY, number TEXT, snapshot_json TEXT);
                 INSERT INTO quotes VALUES(
                   'quote-corrupt',
                   'D-2026-0002',
                   '{\"schema\":\"helvichantier.document_snapshot.v1\",\"captured_at\":\"2026-09-01T10:00:00Z\",\"issuer\":{\"company_name\":\"Société figée\",\"address_line1\":\"Rue du Lac 1\",\"postal_code\":\"1000\",\"city\":\"Lausanne\",\"vat_registered\":false},\"customer\":{\"name\":\"Client figé\",\"address_line1\":\"Rue du Test 2\",\"postal_code\":\"1200\",\"city\":\"Genève\"},\"document\":{\"id\":\"quote-corrupt\",\"number\":\"D-2026-0002\",\"title\":\"Devis incomplet\",\"issue_date\":\"2026-09-01\",\"valid_until\":\"2026-09-30\",\"currency\":\"CHF\",\"subtotal_cents\":10000,\"discount_cents\":0,\"vat_cents\":0,\"total_cents\":10000},\"items\":[{\"description\":\"Ligne sans totaux figés\",\"quantity\":1,\"unit\":\"forfait\",\"unit_price_cents\":10000,\"discount_bp\":0,\"vat_bp\":0}],\"qr_bill\":null}'
                 );",
            )
            .unwrap();
        install_audit_table(&connection);
        let snapshot_json: String = connection
            .query_row(
                "SELECT snapshot_json FROM quotes WHERE id='quote-corrupt'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        append_quote_issue(&connection, "quote-corrupt", "D-2026-0002", &snapshot_json);
        let error = load_sales_pdf_data(&connection, "quotes", "quote-corrupt").unwrap_err();
        assert!(error.to_string().contains("montants figés"));
    }

    #[test]
    fn final_line_amounts_must_match_quantity_discount_and_vat_rate() {
        let corrupted = json!({
            "description": "Prestation",
            "quantity": 2.0,
            "unit": "h",
            "unit_price_cents": 10_000,
            "discount_bp": 1_000,
            "vat_bp": 810,
            "line_net_cents": 18_000,
            "line_vat_cents": 999,
            "line_total_cents": 18_999
        });
        let error = sales_line_from_value(&corrupted, true).unwrap_err();
        assert!(error.to_string().contains("taux TVA"));

        let corrupted_credit = json!({
            "description": "Avoir prestation",
            "quantity": 1.0,
            "unit": "forfait",
            "unit_price_cents": -10_000,
            "discount_bp": 0,
            "vat_bp": 810,
            "line_net_cents": -10_000,
            "line_vat_cents": -700,
            "line_total_cents": -10_700
        });
        assert!(sales_line_from_value(&corrupted_credit, true).is_err());
    }

    #[test]
    fn zero_value_final_lines_still_require_every_source_field_and_type() {
        let valid = json!({
            "description": "Ligne gratuite",
            "quantity": 1.0,
            "unit": "forfait",
            "unit_price_cents": 0,
            "discount_bp": 0,
            "vat_bp": 0,
            "line_net_cents": 0,
            "line_vat_cents": 0,
            "line_total_cents": 0
        });
        assert!(sales_line_from_value(&valid, true).is_ok());
        for key in ["quantity", "unit_price_cents", "discount_bp", "vat_bp"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(
                sales_line_from_value(&missing, true).is_err(),
                "{key} absent doit bloquer"
            );
            let mut mistyped = valid.clone();
            mistyped[key] = json!("0");
            assert!(
                sales_line_from_value(&mistyped, true).is_err(),
                "{key} mal typé doit bloquer"
            );
        }
        let mut invalid_rate = valid;
        invalid_rate["vat_bp"] = json!(10_001);
        assert!(sales_line_from_value(&invalid_rate, true).is_err());
    }

    #[test]
    fn unnamed_final_parties_are_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE quotes(id TEXT PRIMARY KEY, number TEXT, snapshot_json TEXT);
                 INSERT INTO quotes VALUES(
                   'quote-parties',
                   'D-2026-0003',
                   '{\"schema\":\"helvichantier.document_snapshot.v1\",\"captured_at\":\"2026-09-01T10:00:00Z\",\"issuer\":{\"company_name\":\"\"},\"customer\":{\"name\":\"\",\"company\":\"\"},\"document\":{\"id\":\"quote-parties\",\"number\":\"D-2026-0003\",\"title\":\"Devis incomplet\",\"issue_date\":\"2026-09-01\",\"valid_until\":\"2026-09-30\",\"currency\":\"CHF\",\"subtotal_cents\":10000,\"discount_cents\":0,\"vat_cents\":0,\"total_cents\":10000},\"items\":[{\"description\":\"Ligne figée\",\"quantity\":1,\"unit\":\"forfait\",\"unit_price_cents\":10000,\"discount_bp\":0,\"vat_bp\":0,\"line_net_cents\":10000,\"line_vat_cents\":0,\"line_total_cents\":10000}],\"qr_bill\":null}'
                 );",
            )
            .unwrap();
        let error = load_sales_pdf_data(&connection, "quotes", "quote-parties").unwrap_err();
        assert!(error.to_string().contains("destinataire nommé"));
    }

    #[test]
    fn final_currency_and_invoice_type_are_never_invented() {
        assert_eq!(
            required_final_currency(&json!({"currency": "chf"})).unwrap(),
            "CHF"
        );
        assert!(required_final_currency(&json!({})).is_err());
        assert!(required_final_currency(&json!({"currency": "CH"})).is_err());
        assert_eq!(
            required_final_invoice_type(&json!({"type": "standard"})).unwrap(),
            "standard"
        );
        assert!(required_final_invoice_type(&json!({})).is_err());
        assert!(required_final_invoice_type(&json!({"type": "autre"})).is_err());
    }

    #[test]
    fn qr_invoice_is_paginated_and_pdf_bytes_are_deterministic() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("facture-a.pdf");
        let second = directory.path().join("facture-b.pdf");
        let data = sample_data(55, true);
        let pages = render_sales_pdf(&first, &data, None).unwrap();
        let second_pages = render_sales_pdf(&second, &data, None).unwrap();
        if let Some(requested) = std::env::var_os("ELYKO_SALES_SAMPLE_PDF") {
            let requested = PathBuf::from(requested);
            if let Some(parent) = requested.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::copy(&first, requested).unwrap();
        }
        assert!(pages >= 3);
        assert_eq!(pages, second_pages);
        assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
        let parsed = Document::load(&first).unwrap();
        assert_eq!(parsed.get_pages().len(), pages);
        let chunks = paginate_sales_lines(&data, true);
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), 55);
        assert!(
            lines_height(chunks.last().unwrap()) <= table_top(false) - final_table_floor(&data)
        );
    }

    #[test]
    fn managed_company_logo_is_embedded_and_drawn_in_sales_pdf_header() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(directory.path().join("profile")).expect("store");
        let source = directory.path().join("logo-client.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            180,
            72,
            image::Rgb([18, 72, 50]),
        ))
        .save_with_format(&source, image::ImageFormat::Png)
        .expect("write company logo");
        let staged = store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("stage company logo");
        let mut data = sample_data(2, false);
        data.issuer.logo_path = staged;
        let destination = directory.path().join("devis-logo.pdf");

        render_sales_pdf(
            &destination,
            &data,
            Some(store.attachments_dir.join("branding").as_path()),
        )
        .expect("render PDF with company logo");
        if let Some(requested) = std::env::var_os("ZENTRA_SALES_LOGO_SAMPLE_PDF") {
            let requested = PathBuf::from(requested);
            if let Some(parent) = requested.parent() {
                fs::create_dir_all(parent).expect("create visual QA directory");
            }
            fs::copy(&destination, requested).expect("copy visual QA PDF");
        }
        let parsed = Document::load(&destination).expect("parse generated PDF");
        let first_page = *parsed.get_pages().values().next().expect("first PDF page");
        let (inline_resources, resource_ids) = parsed
            .get_page_resources(first_page)
            .expect("read page resources");
        let resources = inline_resources
            .or_else(|| {
                resource_ids
                    .first()
                    .and_then(|id| parsed.get_dictionary(*id).ok())
            })
            .expect("page resources");
        let xobjects = resources
            .get(b"XObject")
            .and_then(Object::as_dict)
            .expect("image resources");
        let logo_id = xobjects
            .get(b"Logo")
            .and_then(Object::as_reference)
            .expect("logo resource");
        let logo = parsed
            .get_object(logo_id)
            .and_then(Object::as_stream)
            .expect("logo image stream");
        assert_eq!(
            logo.dict.get(b"Subtype").unwrap(),
            &Object::Name(b"Image".to_vec())
        );
        assert_eq!(logo.dict.get(b"Width").unwrap(), &Object::Integer(180));
        assert_eq!(logo.dict.get(b"Height").unwrap(), &Object::Integer(72));

        let content = Content::decode(
            &parsed
                .get_page_content(first_page)
                .expect("read first page content"),
        )
        .expect("decode first page operations");
        assert!(content.operations.iter().any(|operation| {
            operation.operator == "Do"
                && operation.operands.first() == Some(&Object::Name(b"Logo".to_vec()))
        }));
    }

    #[test]
    fn tampered_immutable_logo_is_rejected_for_final_invoice_and_quote() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let (staged_logo, branding_dir) = stage_then_tamper_logo(&directory);
        assert!(load_document_logo(&staged_logo, None).is_none());

        for (kind, file_name) in [
            (SalesDocumentKind::Invoice, "facture.pdf"),
            (SalesDocumentKind::Quote, "devis.pdf"),
        ] {
            let mut data = sample_data(1, false);
            data.kind = kind;
            data.issuer.logo_path = staged_logo.clone();
            let error = render_sales_pdf(
                &directory.path().join(file_name),
                &data,
                Some(&branding_dir),
            )
            .expect_err("a final document must reject an altered immutable logo");
            assert!(error.to_string().contains("introuvable ou altéré"));
        }

        fs::remove_file(&staged_logo).expect("remove immutable logo");
        let mut data = sample_data(1, false);
        data.issuer.logo_path = staged_logo;
        let error = render_sales_pdf(
            &directory.path().join("facture-logo-manquant.pdf"),
            &data,
            Some(&branding_dir),
        )
        .expect_err("a final document must reject a missing immutable logo");
        assert!(error.to_string().contains("introuvable ou altéré"));
    }

    #[test]
    fn legacy_non_hashed_sales_logo_remains_loadable() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let logo_path = directory.path().join("ancien-logo.png");
        image::DynamicImage::new_rgba8(64, 32)
            .save_with_format(&logo_path, image::ImageFormat::Png)
            .expect("write legacy logo");

        assert!(load_document_logo(
            logo_path.to_str().expect("legacy logo path"),
            Some(directory.path()),
        )
        .is_some());
    }

    #[test]
    fn qr_payload_mismatch_is_rejected_before_rendering() {
        let qr = sample_qr();
        let value = json!({
            "input_json": serde_json::to_string(&qr.input).unwrap(),
            "payload": format!("{}ALT", qr.payload),
            "frozen_at": "2026-09-01T10:00:00Z"
        });
        let error = verified_qr_from_value(&value, 194_900, "CHF", true).unwrap_err();
        assert!(error.to_string().contains("payload SPC figé"));
    }

    #[test]
    fn qr_vector_has_dark_module_rectangles_and_swiss_cross() {
        let qr = sample_qr();
        let mut operations = Vec::new();
        render_qr_code(&mut operations, &qr.payload, 0.0, 0.0, mm(46.0)).unwrap();
        let qr_rectangles = operations
            .iter()
            .filter(|operation| operation.operator == "re")
            .count();
        assert!(qr_rectangles > 100);
        let before_cross = operations.len();
        render_swiss_cross(&mut operations, mm(23.0), mm(23.0));
        assert!(operations.len() > before_cross);
        let outer = operations[before_cross..]
            .iter()
            .find(|operation| operation.operator == "re")
            .unwrap();
        assert_eq!(outer.operands[2], Object::Real(mm(7.0)));
        assert_eq!(outer.operands[3], Object::Real(mm(7.0)));
    }

    #[test]
    fn qr_amount_uses_spaces_for_thousands() {
        assert_eq!(format_qr_amount(123_456_789), "1 234 567.89");
    }

    #[test]
    fn width_measurement_wraps_wide_glyphs_without_crossing_the_column() {
        let wide = "W".repeat(70);
        let lines = wrap_text_width(&wide, QR_RECEIPT_TEXT_WIDTH, QR_VALUE_FONT_SIZE, false);
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| {
            helvetica_text_width(line, QR_VALUE_FONT_SIZE, false) <= QR_RECEIPT_TEXT_WIDTH
        }));
        assert!(
            helvetica_text_width(&"W".repeat(20), 12.0, true)
                > helvetica_text_width(&"i".repeat(20), 12.0, true)
        );
    }

    #[test]
    fn conservative_metrics_cover_helvetica_oqg_and_bold_lowercase_afm_widths() {
        let regular_oqg_afm = 3.0 * 778.0 * 12.0 / 1_000.0;
        let bold_oqg_afm = 3.0 * 778.0 * 12.0 / 1_000.0;
        assert!(helvetica_text_width("OQG", 12.0, false) >= regular_oqg_afm);
        assert!(helvetica_text_width("OQG", 12.0, true) >= bold_oqg_afm);
        assert!(helvetica_text_width("m", 12.0, true) >= 889.0 * 12.0 / 1_000.0);
        assert!(helvetica_text_width("w", 12.0, true) >= 778.0 * 12.0 / 1_000.0);

        let max_width = 147.4;
        let wrapped = wrap_text_width(&"O".repeat(70), max_width, 6.0, false);
        assert!(wrapped.len() > 1);
        assert!(wrapped
            .iter()
            .all(|line| { line.chars().count() as f32 * 778.0 * 6.0 / 1_000.0 <= max_width }));
    }

    #[test]
    fn right_aligned_text_uses_the_same_font_metric_as_the_guard() {
        let mut operations = Vec::new();
        let value = "WWWWWW";
        let right = 300.0;
        text_right(&mut operations, right, 100.0, 12.0, "F2", INK, value);
        let matrix = operations
            .iter()
            .find(|operation| operation.operator == "Tm")
            .unwrap();
        let x = match matrix.operands[4] {
            Object::Real(value) => value,
            Object::Integer(value) => value as f32,
            ref other => panic!("coordonnée PDF inattendue: {other:?}"),
        };
        let width = helvetica_text_width(value, 12.0, true);
        assert!((x + width - right).abs() < 0.01);
    }

    #[test]
    fn wide_header_is_rejected_instead_of_overflowing() {
        let mut data = sample_data(1, false);
        data.title = "W".repeat(74);
        let error = validate_layout_capacity(&data).unwrap_err();
        assert!(error.to_string().contains("titre du document"));
        assert!(error.to_string().contains("débordement"));
    }

    #[test]
    fn long_contract_terms_are_paginated_without_omission() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("conditions-longues.pdf");
        let mut data = sample_data(1, false);
        data.notes = (0..900)
            .map(|index| format!("condition-{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let note_lines = notes_lines(&data);
        assert!(note_lines.len() > 68);
        let note_chunks = paginate_note_lines(&note_lines);
        assert_eq!(
            note_chunks.iter().map(Vec::len).sum::<usize>(),
            note_lines.len()
        );
        let pages = render_sales_pdf(&destination, &data, None).unwrap();
        assert_eq!(
            pages,
            paginate_sales_lines(&data, false).len() + note_chunks.len() + 1
        );
        assert_eq!(
            Document::load(destination).unwrap().get_pages().len(),
            pages
        );
    }

    #[test]
    fn qr_extreme_width_is_rejected_instead_of_ellipsized() {
        let mut data = sample_data(1, true);
        let qr = data.qr.as_mut().unwrap();
        qr.input.creditor.name = "W".repeat(70);
        qr.input.creditor.street = "W".repeat(70);
        qr.input.creditor.building_number = "W".repeat(16);
        qr.input.creditor.postal_code = "W".repeat(16);
        qr.input.creditor.city = "W".repeat(35);
        qr.input.debtor = Some(qr.input.creditor.clone());
        let error = validate_qr_visible_layout(&data).unwrap_err();
        assert!(error.to_string().contains("refuse toute ellipse"));
    }

    #[test]
    fn vat_total_baseline_stays_above_the_grand_total_bar() {
        let data = sample_data(1, true);
        let rows = 4 + vat_groups(&data).len();
        let last_row_y = totals_box_height(&data) - 18.0 - (rows - 1) as f32 * 15.0;
        assert!(last_row_y >= 30.0);
        assert!(
            final_table_floor(&data) >= QR_SECTION_HEIGHT + 27.0 + totals_box_height(&data) + 12.0
        );
    }

    #[test]
    fn unsupported_visible_unicode_is_rejected_instead_of_replaced() {
        let mut data = sample_data(1, false);
        data.customer.name = "Client 🚧".into();
        let error = validate_visible_texts(&data).unwrap_err();
        assert!(error.to_string().contains("non pris en charge"));
    }

    #[test]
    fn failed_replace_restores_the_previous_pdf() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("document.pdf");
        let missing_temporary = directory.path().join("missing.tmp");
        fs::write(&destination, b"ancien PDF intact").unwrap();
        assert!(replace_file(&missing_temporary, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"ancien PDF intact");
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            1
        );
    }
}

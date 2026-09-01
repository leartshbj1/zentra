use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Local, NaiveDate};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{assign_document_number, now_iso, query_all, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{
        CancelSalesOrderInput, CancelSalesOrderInvoiceDraftInput, CancelSalesOrderRemainderInput,
        ConfirmSalesOrderInput, ConvertQuoteToSalesOrderInput, CreateSalesOrderInvoiceInput,
        DeliveryNoteLineInput, IssueDeliveryNoteInput, PreviewSalesOrderInvoiceInput,
        ReverseDeliveryNoteInput, SalesOrderInvoiceAllocationInput, SalesOrderLineInput,
        SaveDeliveryNoteDraftInput, SaveSalesOrderDraftInput,
    },
};

const MAX_QUANTITY_MILLI: i64 = 9_000_000_000_000_000;
const MAX_MONEY_CENTS: i64 = 9_000_000_000_000_000;
const MAX_LINES: usize = 10_000;

#[derive(Debug, Clone)]
struct Amounts {
    gross: i64,
    net: i64,
    vat: i64,
    total: i64,
}

#[derive(Debug, Clone)]
struct OrderLine {
    id: String,
    catalog_item_id: Option<String>,
    position: i64,
    description: String,
    quantity_milli: i64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    fulfillment_mode: String,
}

#[derive(Debug, Clone)]
struct PreparedAllocation {
    sales_order_line_id: String,
    delivery_note_line_id: Option<String>,
    catalog_item_id: Option<String>,
    description: String,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    quantity_milli: i64,
    amounts: Amounts,
}

#[derive(Debug, Clone)]
struct InvoicePreview {
    role: &'static str,
    invoice_type: &'static str,
    allocations: Vec<PreparedAllocation>,
    subtotal_cents: i64,
    discount_cents: i64,
    vat_cents: i64,
    total_cents: i64,
}

#[derive(Debug)]
struct OperationReplay {
    entity_type: String,
    entity_id: String,
}

#[derive(Debug)]
struct OperationState {
    request_id: String,
    payload_sha256: String,
    replay: Option<OperationReplay>,
}

#[derive(Debug)]
struct ReservationEvent<'a> {
    catalog_item_id: &'a str,
    sales_order_id: &'a str,
    sales_order_line_id: &'a str,
    delivery_note_line_id: Option<&'a str>,
    event_type: &'a str,
    quantity_delta_milli: i64,
    reason: Option<&'a str>,
}

fn required_text(value: &str, field: &str, max: usize) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Validation(format!("{field} est obligatoire.")));
    }
    if value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} ne peut pas dépasser {max} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn optional_text(value: Option<String>, field: &str, max: usize) -> AppResult<Option<String>> {
    value
        .map(|value| required_text(&value, field, max))
        .transpose()
}

fn valid_date(value: &str, field: &str) -> AppResult<String> {
    let value = required_text(value, field, 10)?;
    NaiveDate::parse_from_str(&value, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(format!(
            "{field} doit être une date valide au format AAAA-MM-JJ."
        ))
    })?;
    Ok(value)
}

fn optional_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    value.map(|value| valid_date(&value, field)).transpose()
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn normalized_uuid(value: &str, field: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|value| value.to_string())
        .map_err(|_| AppError::Validation(format!("{field} doit être un UUID valide.")))
}

fn validate_quantity(value: i64, field: &str) -> AppResult<i64> {
    if !(1..=MAX_QUANTITY_MILLI).contains(&value) {
        return Err(AppError::Validation(format!(
            "{field} doit être compris entre 1 et {MAX_QUANTITY_MILLI}."
        )));
    }
    Ok(value)
}

fn quantity_to_milli(value: f64) -> AppResult<i64> {
    if !value.is_finite() || value <= 0.0 {
        return Err(AppError::Validation(
            "Chaque ligne du devis doit avoir une quantité strictement positive.".into(),
        ));
    }
    let scaled = value * 1_000.0;
    let rounded = scaled.round();
    if !scaled.is_finite()
        || (scaled - rounded).abs() > 0.000_001
        || rounded < 1.0
        || rounded > MAX_QUANTITY_MILLI as f64
    {
        return Err(AppError::Validation(
            "Les quantités de commande doivent être exprimables en millièmes d'unité.".into(),
        ));
    }
    Ok(rounded as i64)
}

fn rounded_div(numerator: i128, denominator: i128, field: &str) -> AppResult<i64> {
    if numerator < 0 || denominator <= 0 {
        return Err(AppError::Validation(format!(
            "Le calcul de {field} est invalide."
        )));
    }
    let value = numerator
        .checked_add(denominator / 2)
        .and_then(|value| value.checked_div(denominator))
        .and_then(|value| i64::try_from(value).ok())
        .filter(|value| *value <= MAX_MONEY_CENTS)
        .ok_or_else(|| AppError::Validation(format!("{field} dépasse la limite autorisée.")))?;
    Ok(value)
}

fn calculate_amounts(
    quantity_milli: i64,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
) -> AppResult<Amounts> {
    validate_quantity(quantity_milli, "quantity_milli")?;
    if !(0..=MAX_MONEY_CENTS).contains(&unit_price_cents) {
        return Err(AppError::Validation(
            "unit_price_cents est hors limite.".into(),
        ));
    }
    if !(0..=10_000).contains(&discount_bp) || !(0..=10_000).contains(&vat_bp) {
        return Err(AppError::Validation(
            "discount_bp et vat_bp doivent être compris entre 0 et 10000.".into(),
        ));
    }
    let gross = rounded_div(
        i128::from(quantity_milli) * i128::from(unit_price_cents),
        1_000,
        "montant brut",
    )?;
    let discount = rounded_div(
        i128::from(gross) * i128::from(discount_bp),
        10_000,
        "remise",
    )?;
    let net = gross
        .checked_sub(discount)
        .ok_or_else(|| AppError::Validation("Le calcul du montant net est invalide.".into()))?;
    let vat = rounded_div(i128::from(net) * i128::from(vat_bp), 10_000, "TVA")?;
    let total = net
        .checked_add(vat)
        .filter(|value| *value <= MAX_MONEY_CENTS)
        .ok_or_else(|| AppError::Validation("Le total de ligne dépasse la limite.".into()))?;
    Ok(Amounts {
        gross,
        net,
        vat,
        total,
    })
}

fn payload_sha256<T: Serialize>(payload: &T) -> AppResult<String> {
    let bytes = serde_json::to_vec(payload)?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn begin_operation<T: Serialize>(
    transaction: &Transaction<'_>,
    request_id: &str,
    operation: &str,
    payload: &T,
) -> AppResult<OperationState> {
    let request_id = normalized_uuid(request_id, "request_id")?;
    let hash = payload_sha256(payload)?;
    let existing: Option<(String, String, String, String)> = transaction
        .query_row(
            "SELECT operation,payload_sha256,result_entity_type,result_entity_id FROM sales_operation_requests WHERE request_id=?",
            params![request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((existing_operation, existing_hash, entity_type, entity_id)) = existing {
        if existing_operation != operation || existing_hash != hash {
            return Err(AppError::Validation(
                "Ce request_id a déjà été utilisé pour une autre opération commerciale.".into(),
            ));
        }
        return Ok(OperationState {
            request_id,
            payload_sha256: hash,
            replay: Some(OperationReplay {
                entity_type,
                entity_id,
            }),
        });
    }
    Ok(OperationState {
        request_id,
        payload_sha256: hash,
        replay: None,
    })
}

fn finish_operation(
    transaction: &Transaction<'_>,
    request_id: &str,
    operation: &str,
    hash: &str,
    entity_type: &str,
    entity_id: &str,
) -> AppResult<()> {
    transaction.execute(
        "INSERT INTO sales_operation_requests(request_id,operation,payload_sha256,result_entity_type,result_entity_id,created_at) VALUES(?,?,?,?,?,?)",
        params![request_id, operation, hash, entity_type, entity_id, now_iso()],
    )?;
    Ok(())
}

fn load_order_result(
    transaction: &Transaction<'_>,
    sales_order_id: &str,
    idempotent: bool,
) -> AppResult<Value> {
    let order = query_record_tx(transaction, "sales_orders", sales_order_id)?;
    let lines = query_all(
        transaction,
        "SELECT * FROM sales_order_lines WHERE sales_order_id=? ORDER BY position,created_at",
        params![sales_order_id],
    )?;
    Ok(json!({"order":order,"lines":lines,"idempotent":idempotent}))
}

fn load_delivery_result(
    transaction: &Transaction<'_>,
    delivery_note_id: &str,
    idempotent: bool,
) -> AppResult<Value> {
    let delivery_note = query_record_tx(transaction, "delivery_notes", delivery_note_id)?;
    let lines = query_all(
        transaction,
        "SELECT * FROM delivery_note_lines WHERE delivery_note_id=? ORDER BY position,created_at",
        params![delivery_note_id],
    )?;
    Ok(json!({"delivery_note":delivery_note,"lines":lines,"idempotent":idempotent}))
}

fn load_invoice_result(
    transaction: &Transaction<'_>,
    invoice_id: &str,
    idempotent: bool,
) -> AppResult<Value> {
    let invoice = query_record_tx(transaction, "invoices", invoice_id)?;
    let invoice_items = query_all(
        transaction,
        "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY position,created_at",
        params![invoice_id],
    )?;
    let batch = transaction
        .query_row(
            "SELECT id FROM sales_order_invoice_batches WHERE invoice_id=?",
            params![invoice_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let allocations = if let Some(batch_id) = batch.as_deref() {
        query_all(
            transaction,
            "SELECT * FROM sales_order_invoice_allocations WHERE batch_id=? ORDER BY rowid",
            params![batch_id],
        )?
    } else {
        Vec::new()
    };
    Ok(
        json!({"invoice":invoice,"invoice_items":invoice_items,"allocations":allocations,"idempotent":idempotent}),
    )
}

fn replay_result(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
) -> AppResult<Value> {
    match entity_type {
        "sales_order" => load_order_result(transaction, entity_id, true),
        "delivery_note" => load_delivery_result(transaction, entity_id, true),
        "invoice" => load_invoice_result(transaction, entity_id, true),
        _ => Err(AppError::Validation(
            "Le résultat idempotent enregistré est invalide.".into(),
        )),
    }
}

fn ensure_client_project(
    transaction: &Transaction<'_>,
    client_id: &str,
    project_id: Option<&str>,
) -> AppResult<()> {
    let client_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM clients WHERE id=? AND archived_at IS NULL)",
        params![client_id],
        |row| row.get(0),
    )?;
    if !client_exists {
        return Err(AppError::Validation(
            "Le client est introuvable ou archivé.".into(),
        ));
    }
    if let Some(project_id) = project_id {
        let project_client: Option<Option<String>> = transaction
            .query_row(
                "SELECT client_id FROM projects WHERE id=?",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(project_client) = project_client else {
            return Err(AppError::NotFound(format!("projects/{project_id}")));
        };
        if project_client
            .as_deref()
            .is_some_and(|value| value != client_id)
        {
            return Err(AppError::Validation(
                "Le projet sélectionné appartient à un autre client.".into(),
            ));
        }
    }
    Ok(())
}

fn prepare_line(
    transaction: &Transaction<'_>,
    input: SalesOrderLineInput,
) -> AppResult<(OrderLine, Amounts)> {
    let description = required_text(&input.description, "description", 10_000)?;
    let unit = required_text(&input.unit, "unit", 100)?;
    let quantity_milli = validate_quantity(input.quantity_milli, "quantity_milli")?;
    if !(0..=1_000_000).contains(&input.position) {
        return Err(AppError::Validation(
            "position doit être comprise entre 0 et 1000000.".into(),
        ));
    }
    let fulfillment_mode = match input.fulfillment_mode.trim() {
        "stocked_delivery" => "stocked_delivery",
        "untracked_delivery" => "untracked_delivery",
        "direct" => "direct",
        _ => {
            return Err(AppError::Validation(
                "fulfillment_mode doit valoir stocked_delivery, untracked_delivery ou direct."
                    .into(),
            ))
        }
    }
    .to_owned();
    let catalog_item_id = input
        .catalog_item_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned());
    if let Some(catalog_item_id) = catalog_item_id.as_deref() {
        let catalog: Option<(String, i64, Option<String>)> = transaction
            .query_row(
                "SELECT kind,track_stock,archived_at FROM catalog_items WHERE id=?",
                params![catalog_item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((kind, track_stock, archived_at)) = catalog else {
            return Err(AppError::NotFound(format!(
                "catalog_items/{catalog_item_id}"
            )));
        };
        if archived_at.is_some() {
            return Err(AppError::Validation(
                "Un article archivé ne peut pas être ajouté à une commande.".into(),
            ));
        }
        match fulfillment_mode.as_str() {
            "stocked_delivery" if kind != "product" || track_stock != 1 => {
                return Err(AppError::Validation(
                    "stocked_delivery exige un produit suivi en stock.".into(),
                ))
            }
            "direct" if track_stock == 1 => {
                return Err(AppError::Validation(
                    "Un article suivi en stock doit passer par une livraison.".into(),
                ))
            }
            "untracked_delivery" if track_stock == 1 => {
                return Err(AppError::Validation(
                    "Un article suivi doit utiliser stocked_delivery.".into(),
                ))
            }
            _ => {}
        }
    } else if fulfillment_mode == "stocked_delivery" {
        return Err(AppError::Validation(
            "stocked_delivery exige catalog_item_id.".into(),
        ));
    }
    let amounts = calculate_amounts(
        quantity_milli,
        input.unit_price_cents,
        input.discount_bp,
        input.vat_bp,
    )?;
    Ok((
        OrderLine {
            id: input
                .id
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            catalog_item_id,
            position: input.position,
            description,
            quantity_milli,
            unit,
            unit_price_cents: input.unit_price_cents,
            discount_bp: input.discount_bp,
            vat_bp: input.vat_bp,
            fulfillment_mode,
        },
        amounts,
    ))
}

fn sum_checked(values: impl IntoIterator<Item = i64>, field: &str) -> AppResult<i64> {
    values
        .into_iter()
        .try_fold(0_i64, |sum, value| sum.checked_add(value))
        .filter(|value| *value <= MAX_MONEY_CENTS)
        .ok_or_else(|| AppError::Validation(format!("{field} dépasse la limite autorisée.")))
}

fn current_reserved_for_line(transaction: &Transaction<'_>, line_id: &str) -> AppResult<i64> {
    Ok(transaction.query_row(
        "SELECT COALESCE(SUM(quantity_delta_milli),0) FROM stock_reservation_events WHERE sales_order_line_id=?",
        params![line_id],
        |row| row.get(0),
    )?)
}

fn current_reserved_for_catalog(
    transaction: &Transaction<'_>,
    catalog_item_id: &str,
) -> AppResult<i64> {
    Ok(transaction.query_row(
        "SELECT COALESCE(SUM(quantity_delta_milli),0) FROM stock_reservation_events WHERE catalog_item_id=?",
        params![catalog_item_id],
        |row| row.get(0),
    )?)
}

fn append_reservation_event(
    transaction: &Transaction<'_>,
    event: ReservationEvent<'_>,
) -> AppResult<()> {
    let line_after = current_reserved_for_line(transaction, event.sales_order_line_id)?
        .checked_add(event.quantity_delta_milli)
        .filter(|value| *value >= 0)
        .ok_or_else(|| {
            AppError::Validation(
                "La réservation de ligne deviendrait négative; l'opération est annulée.".into(),
            )
        })?;
    let catalog_after = current_reserved_for_catalog(transaction, event.catalog_item_id)?
        .checked_add(event.quantity_delta_milli)
        .filter(|value| *value >= 0)
        .ok_or_else(|| {
            AppError::Validation(
                "La réservation d'article deviendrait négative; l'opération est annulée.".into(),
            )
        })?;
    transaction.execute(
        "INSERT INTO stock_reservation_events(id,catalog_item_id,sales_order_id,sales_order_line_id,delivery_note_line_id,event_type,quantity_delta_milli,line_reserved_after_milli,catalog_reserved_after_milli,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params![Uuid::new_v4().to_string(),event.catalog_item_id,event.sales_order_id,event.sales_order_line_id,event.delivery_note_line_id,event.event_type,event.quantity_delta_milli,line_after,catalog_after,event.reason,now_iso()],
    )?;
    Ok(())
}

fn cancelled_quantity(transaction: &Transaction<'_>, line_id: &str) -> AppResult<i64> {
    Ok(transaction.query_row(
        "SELECT COALESCE(SUM(quantity_milli),0) FROM sales_order_cancellation_lines WHERE sales_order_line_id=?",
        params![line_id],
        |row| row.get(0),
    )?)
}

fn delivered_quantity(transaction: &Transaction<'_>, line_id: &str) -> AppResult<i64> {
    Ok(transaction.query_row(
        "SELECT COALESCE(SUM(line.quantity_milli),0) FROM delivery_note_lines line JOIN delivery_notes note ON note.id=line.delivery_note_id WHERE line.sales_order_line_id=? AND note.status='issued'",
        params![line_id],
        |row| row.get(0),
    )?)
}

fn allocated_quantity(transaction: &Transaction<'_>, line_id: &str) -> AppResult<i64> {
    Ok(transaction.query_row(
        "SELECT COALESCE(SUM(quantity_milli),0) FROM sales_order_invoice_allocations WHERE sales_order_line_id=?",
        params![line_id],
        |row| row.get(0),
    )?)
}

pub(crate) fn close_sales_order_if_fully_allocated(
    transaction: &Transaction<'_>,
    sales_order_id: &str,
) -> AppResult<bool> {
    let fully_allocated: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sales_order_lines WHERE sales_order_id=?)
                AND NOT EXISTS(
                  SELECT 1 FROM sales_order_lines line
                  WHERE line.sales_order_id=?
                    AND line.quantity_milli-
                        COALESCE((SELECT SUM(cancelled.quantity_milli) FROM sales_order_cancellation_lines cancelled WHERE cancelled.sales_order_line_id=line.id),0)
                        <> COALESCE((SELECT SUM(allocation.quantity_milli) FROM sales_order_invoice_allocations allocation WHERE allocation.sales_order_line_id=line.id),0)
                )",
        params![sales_order_id,sales_order_id],
        |row| row.get(0),
    )?;
    if !fully_allocated {
        return Ok(false);
    }
    let has_active_draft: bool = transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sales_order_invoice_batches batch
           JOIN invoices invoice ON invoice.id=batch.invoice_id
           WHERE batch.sales_order_id=? AND invoice.status='brouillon' AND invoice.number IS NULL
         )",
        params![sales_order_id],
        |row| row.get(0),
    )?;
    if has_active_draft {
        return Ok(false);
    }
    let closed_at = now_iso();
    Ok(transaction.execute(
        "UPDATE sales_orders SET status='closed',closed_at=?,updated_at=? WHERE id=? AND status='confirmed'",
        params![closed_at,closed_at,sales_order_id],
    )? == 1)
}

fn order_lines(transaction: &Transaction<'_>, sales_order_id: &str) -> AppResult<Vec<OrderLine>> {
    let mut statement = transaction.prepare(
        "SELECT id,catalog_item_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,fulfillment_mode FROM sales_order_lines WHERE sales_order_id=? ORDER BY position,created_at",
    )?;
    let lines = statement
        .query_map(params![sales_order_id], |row| {
            Ok(OrderLine {
                id: row.get(0)?,
                catalog_item_id: row.get(1)?,
                position: row.get(2)?,
                description: row.get(3)?,
                quantity_milli: row.get(4)?,
                unit: row.get(5)?,
                unit_price_cents: row.get(6)?,
                discount_bp: row.get(7)?,
                vat_bp: row.get(8)?,
                fulfillment_mode: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(lines)
}

impl LocalStore {
    pub fn convert_quote_to_sales_order(
        &self,
        input: ConvertQuoteToSalesOrderInput,
    ) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "convert_quote_to_sales_order",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let quote_id = required_text(&input.quote_id, "quote_id", 255)?;
        let quote = query_record_tx(&transaction, "quotes", &quote_id)?;
        if quote.get("status").and_then(Value::as_str) != Some("accepte") {
            return Err(AppError::Validation(
                "Seul un devis accepté peut devenir une commande client.".into(),
            ));
        }
        let direct_conversion: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM quote_conversions WHERE quote_id=?)",
            params![quote_id],
            |row| row.get(0),
        )?;
        if direct_conversion {
            return Err(AppError::Validation(
                "Ce devis a déjà été converti directement en facture.".into(),
            ));
        }
        let existing_order: Option<String> = transaction
            .query_row(
                "SELECT id FROM sales_orders WHERE quote_id=?",
                params![quote_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_order) = existing_order {
            return Err(AppError::Validation(format!(
                "Ce devis a déjà été converti en commande {existing_order}."
            )));
        }
        let client_id = quote
            .get("client_id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation("Le devis accepté n'a pas de client.".into()))?;
        let project_id = quote.get("project_id").and_then(Value::as_str);
        ensure_client_project(&transaction, client_id, project_id)?;
        if quote.get("currency").and_then(Value::as_str) != Some("CHF") {
            return Err(AppError::Validation(
                "Les commandes de ce module doivent être en CHF.".into(),
            ));
        }
        let mut statement = transaction.prepare(
            "SELECT line.id,line.catalog_item_id,line.position,line.description,line.quantity,line.unit,line.unit_price_cents,line.discount_bp,line.vat_bp,line.line_net_cents,line.line_vat_cents,line.line_total_cents,item.kind,item.track_stock
             FROM quote_items line LEFT JOIN catalog_items item ON item.id=line.catalog_item_id
             WHERE line.quote_id=? ORDER BY line.position,line.rowid",
        )?;
        let quote_lines = statement
            .query_map(params![quote_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if quote_lines.is_empty() || quote_lines.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Le devis doit contenir entre 1 et {MAX_LINES} lignes."
            )));
        }
        let sales_order_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let order_date = quote
            .get("issue_date")
            .and_then(Value::as_str)
            .and_then(|value| valid_date(value, "issue_date").ok())
            .unwrap_or_else(today);
        let snapshot_json = serde_json::to_string(&json!({"source_quote":quote}))?;
        transaction.execute(
            "INSERT INTO sales_orders(id,client_id,project_id,quote_id,title,status,order_date,currency,subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)",
            params![sales_order_id,client_id,project_id,quote_id,quote["title"].as_str().unwrap_or("Commande"),order_date,"CHF",quote["subtotal_cents"].as_i64().unwrap_or(0),quote["discount_cents"].as_i64().unwrap_or(0),quote["vat_cents"].as_i64().unwrap_or(0),quote["total_cents"].as_i64().unwrap_or(0),quote["notes"].as_str(),quote["terms"].as_str(),snapshot_json,now,now],
        )?;
        for line in quote_lines {
            let quantity_milli = quantity_to_milli(line.4)?;
            let fulfillment_mode = match (line.12.as_deref(), line.13.unwrap_or(0)) {
                (_, 1) => "stocked_delivery",
                (Some("product"), _) => "untracked_delivery",
                _ => "direct",
            };
            transaction.execute(
                "INSERT INTO sales_order_lines(id,sales_order_id,quote_item_id,catalog_item_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,fulfillment_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),sales_order_id,line.0,line.1,line.2,line.3,quantity_milli,line.5,line.6,line.7,line.8,line.9,line.10,line.11,fulfillment_mode,now,now],
            )?;
        }
        finish_operation(
            &transaction,
            &request_id,
            "convert_quote_to_sales_order",
            &hash,
            "sales_order",
            &sales_order_id,
        )?;
        let result = load_order_result(&transaction, &sales_order_id, false)?;
        append_audit(
            &transaction,
            "convert_to_sales_order",
            "quote",
            &quote_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn save_sales_order_draft(&self, input: SaveSalesOrderDraftInput) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Une commande doit contenir entre 1 et {MAX_LINES} lignes."
            )));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let client_id = required_text(&input.order.client_id, "client_id", 255)?;
        let project_id = input
            .order
            .project_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_owned());
        ensure_client_project(&transaction, &client_id, project_id.as_deref())?;
        let title = required_text(&input.order.title, "title", 300)?;
        let order_date = valid_date(&input.order.order_date, "order_date")?;
        if input.order.currency.trim().to_uppercase() != "CHF" {
            return Err(AppError::Validation(
                "La devise de commande doit être CHF.".into(),
            ));
        }
        let notes = optional_text(input.order.notes, "notes", 20_000)?;
        let terms = optional_text(input.order.terms, "terms", 20_000)?;
        let mut prepared = Vec::with_capacity(input.lines.len());
        let mut ids = HashSet::new();
        for line in input.lines {
            let (line, amounts) = prepare_line(&transaction, line)?;
            if !ids.insert(line.id.clone()) {
                return Err(AppError::Validation(
                    "Deux lignes de commande utilisent le même identifiant.".into(),
                ));
            }
            prepared.push((line, amounts));
        }
        let subtotal = sum_checked(
            prepared.iter().map(|(_, amount)| amount.gross),
            "Sous-total",
        )?;
        let net = sum_checked(prepared.iter().map(|(_, amount)| amount.net), "Total net")?;
        let discount = subtotal
            .checked_sub(net)
            .ok_or_else(|| AppError::Validation("La remise totale est invalide.".into()))?;
        let vat = sum_checked(prepared.iter().map(|(_, amount)| amount.vat), "TVA")?;
        let total = sum_checked(prepared.iter().map(|(_, amount)| amount.total), "Total")?;
        let sales_order_id = input
            .order
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let existing: Option<String> = transaction
            .query_row(
                "SELECT status FROM sales_orders WHERE id=?",
                params![sales_order_id],
                |row| row.get(0),
            )
            .optional()?;
        let now = now_iso();
        if let Some(status) = existing {
            if status != "draft" {
                return Err(AppError::Validation(
                    "Seule une commande brouillon peut être modifiée.".into(),
                ));
            }
            transaction.execute(
                "UPDATE sales_orders SET client_id=?,project_id=?,title=?,order_date=?,currency='CHF',subtotal_cents=?,discount_cents=?,vat_cents=?,total_cents=?,notes=?,terms=?,updated_at=? WHERE id=?",
                params![client_id,project_id,title,order_date,subtotal,discount,vat,total,notes,terms,now,sales_order_id],
            )?;
            transaction.execute(
                "DELETE FROM sales_order_lines WHERE sales_order_id=?",
                params![sales_order_id],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO sales_orders(id,client_id,project_id,title,status,order_date,currency,subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,created_at,updated_at) VALUES(?,?,?,?,'draft',?,'CHF',?,?,?,?,?,?,?,?)",
                params![sales_order_id,client_id,project_id,title,order_date,subtotal,discount,vat,total,notes,terms,now,now],
            )?;
        }
        for (line, amounts) in prepared {
            transaction.execute(
                "INSERT INTO sales_order_lines(id,sales_order_id,catalog_item_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,fulfillment_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![line.id,sales_order_id,line.catalog_item_id,line.position,line.description,line.quantity_milli,line.unit,line.unit_price_cents,line.discount_bp,line.vat_bp,amounts.net,amounts.vat,amounts.total,line.fulfillment_mode,now,now],
            )?;
        }
        let result = load_order_result(&transaction, &sales_order_id, false)?;
        append_audit(
            &transaction,
            "save_draft",
            "sales_order",
            &sales_order_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn confirm_sales_order(&self, input: ConfirmSalesOrderInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "confirm_sales_order",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let sales_order_id = required_text(&input.sales_order_id, "sales_order_id", 255)?;
        let order = query_record_tx(&transaction, "sales_orders", &sales_order_id)?;
        if order.get("status").and_then(Value::as_str) != Some("draft") {
            return Err(AppError::Validation(
                "Seule une commande brouillon peut être confirmée.".into(),
            ));
        }
        let lines = order_lines(&transaction, &sales_order_id)?;
        if lines.is_empty() {
            return Err(AppError::Validation(
                "La commande ne contient aucune ligne.".into(),
            ));
        }
        let mut required_by_catalog: BTreeMap<String, i64> = BTreeMap::new();
        for line in &lines {
            if line.fulfillment_mode == "stocked_delivery" {
                let catalog_id = line.catalog_item_id.as_ref().ok_or_else(|| {
                    AppError::Validation("Une ligne stockée n'a pas d'article.".into())
                })?;
                let required = required_by_catalog.entry(catalog_id.clone()).or_default();
                *required = required.checked_add(line.quantity_milli).ok_or_else(|| {
                    AppError::Validation("La quantité réservée dépasse la limite.".into())
                })?;
            }
        }
        for (catalog_id, required) in &required_by_catalog {
            let on_hand: i64 = transaction
                .query_row(
                    "SELECT stock_quantity_milli FROM catalog_items WHERE id=? AND track_stock=1",
                    params![catalog_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    AppError::Validation(format!(
                        "L'article {catalog_id} n'est plus suivi en stock."
                    ))
                })?;
            let reserved = current_reserved_for_catalog(&transaction, catalog_id)?;
            let available = on_hand.checked_sub(reserved).ok_or_else(|| {
                AppError::Validation("Le registre des réservations est incohérent.".into())
            })?;
            if *required > available {
                return Err(AppError::Validation(format!(
                    "Stock disponible insuffisant pour {catalog_id}: {available} millièmes disponibles, {required} requis."
                )));
            }
        }
        let order_date = order
            .get("order_date")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation("La date de commande est absente.".into()))?;
        let number = assign_document_number(
            &transaction,
            "sales_orders",
            &sales_order_id,
            "sales_order",
            order_date,
        )?;
        let now = now_iso();
        let client = query_record_tx(
            &transaction,
            "clients",
            order.get("client_id").and_then(Value::as_str).unwrap_or(""),
        )?;
        let snapshot_json = serde_json::to_string(&json!({
            "order":order,
            "lines":query_all(&transaction,"SELECT * FROM sales_order_lines WHERE sales_order_id=? ORDER BY position,created_at",params![sales_order_id])?,
            "client":client
        }))?;
        transaction.execute(
            "UPDATE sales_orders SET number=?,status='confirmed',confirmed_at=?,snapshot_json=?,updated_at=? WHERE id=?",
            params![number, now, snapshot_json, now, sales_order_id],
        )?;
        for line in &lines {
            if line.fulfillment_mode == "stocked_delivery" {
                append_reservation_event(
                    &transaction,
                    ReservationEvent {
                        catalog_item_id: line.catalog_item_id.as_deref().expect("validated"),
                        sales_order_id: &sales_order_id,
                        sales_order_line_id: &line.id,
                        delivery_note_line_id: None,
                        event_type: "reserve",
                        quantity_delta_milli: line.quantity_milli,
                        reason: Some("Confirmation de la commande client"),
                    },
                )?;
            }
        }
        finish_operation(
            &transaction,
            &request_id,
            "confirm_sales_order",
            &hash,
            "sales_order",
            &sales_order_id,
        )?;
        let result = load_order_result(&transaction, &sales_order_id, false)?;
        append_audit(
            &transaction,
            "confirm",
            "sales_order",
            &sales_order_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn cancel_sales_order(&self, input: CancelSalesOrderInput) -> AppResult<Value> {
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "cancel_sales_order",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let sales_order_id = required_text(&input.sales_order_id, "sales_order_id", 255)?;
        let status: String = transaction
            .query_row(
                "SELECT status FROM sales_orders WHERE id=?",
                params![sales_order_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("sales_orders/{sales_order_id}")))?;
        if !matches!(status.as_str(), "draft" | "confirmed") {
            return Err(AppError::Validation(
                "Cette commande ne peut plus être annulée.".into(),
            ));
        }
        if status == "confirmed" {
            let has_fulfillment: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM delivery_notes WHERE sales_order_id=? AND status IN ('issued','reversed')
                   UNION ALL
                   SELECT 1 FROM sales_order_invoice_batches WHERE sales_order_id=?
                 )",
                params![sales_order_id, sales_order_id],
                |row| row.get(0),
            )?;
            if has_fulfillment {
                return Err(AppError::Validation(
                    "La commande possède déjà une livraison ou une facture. Annulez uniquement son reliquat."
                        .into(),
                ));
            }
            transaction.execute(
                "DELETE FROM delivery_notes WHERE sales_order_id=? AND status='draft'",
                params![sales_order_id],
            )?;
        }
        let lines = order_lines(&transaction, &sales_order_id)?;
        let now = now_iso();
        for line in &lines {
            transaction.execute(
                "INSERT INTO sales_order_cancellation_lines(id,request_id,sales_order_id,sales_order_line_id,quantity_milli,reason,created_at) VALUES(?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),request_id,sales_order_id,line.id,line.quantity_milli,reason,now],
            )?;
            if status == "confirmed" && line.fulfillment_mode == "stocked_delivery" {
                append_reservation_event(
                    &transaction,
                    ReservationEvent {
                        catalog_item_id: line.catalog_item_id.as_deref().expect("validated"),
                        sales_order_id: &sales_order_id,
                        sales_order_line_id: &line.id,
                        delivery_note_line_id: None,
                        event_type: "release",
                        quantity_delta_milli: -line.quantity_milli,
                        reason: Some(&reason),
                    },
                )?;
            }
        }
        transaction.execute(
            "UPDATE sales_orders SET status='cancelled',cancelled_at=?,cancellation_reason=?,updated_at=? WHERE id=?",
            params![now, reason, now, sales_order_id],
        )?;
        finish_operation(
            &transaction,
            &request_id,
            "cancel_sales_order",
            &hash,
            "sales_order",
            &sales_order_id,
        )?;
        let result = load_order_result(&transaction, &sales_order_id, false)?;
        append_audit(
            &transaction,
            "cancel",
            "sales_order",
            &sales_order_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn cancel_sales_order_remainder(
        &self,
        input: CancelSalesOrderRemainderInput,
    ) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(
                "Indiquez au moins une ligne de reliquat à annuler.".into(),
            ));
        }
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "cancel_sales_order_remainder",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let sales_order_id = required_text(&input.sales_order_id, "sales_order_id", 255)?;
        let status: String = transaction
            .query_row(
                "SELECT status FROM sales_orders WHERE id=?",
                params![sales_order_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("sales_orders/{sales_order_id}")))?;
        if status != "confirmed" {
            return Err(AppError::Validation(
                "Le reliquat ne peut être annulé que sur une commande confirmée.".into(),
            ));
        }
        let all_lines = order_lines(&transaction, &sales_order_id)?;
        let by_id: HashMap<_, _> = all_lines
            .iter()
            .map(|line| (line.id.as_str(), line))
            .collect();
        let mut seen = HashSet::new();
        let now = now_iso();
        for requested in &input.lines {
            let line_id =
                required_text(&requested.sales_order_line_id, "sales_order_line_id", 255)?;
            if !seen.insert(line_id.clone()) {
                return Err(AppError::Validation(
                    "Une ligne de reliquat ne peut apparaître qu'une fois.".into(),
                ));
            }
            let line = by_id.get(line_id.as_str()).ok_or_else(|| {
                AppError::Validation("Une ligne n'appartient pas à cette commande.".into())
            })?;
            let quantity = validate_quantity(requested.quantity_milli, "quantity_milli")?;
            let cancelled = cancelled_quantity(&transaction, &line.id)?;
            let delivered = delivered_quantity(&transaction, &line.id)?;
            let allocated = allocated_quantity(&transaction, &line.id)?;
            let protected = delivered.max(allocated);
            let cancellable = line
                .quantity_milli
                .checked_sub(cancelled)
                .and_then(|value| value.checked_sub(protected))
                .filter(|value| *value >= 0)
                .ok_or_else(|| {
                    AppError::Validation("Le suivi de cette ligne est incohérent.".into())
                })?;
            if quantity > cancellable {
                return Err(AppError::Validation(format!(
                    "Le reliquat annulable de la ligne {} est de {cancellable} millièmes.",
                    line.id
                )));
            }
            transaction.execute(
                "INSERT INTO sales_order_cancellation_lines(id,request_id,sales_order_id,sales_order_line_id,quantity_milli,reason,created_at) VALUES(?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),request_id,sales_order_id,line.id,quantity,reason,now],
            )?;
            if line.fulfillment_mode == "stocked_delivery" {
                append_reservation_event(
                    &transaction,
                    ReservationEvent {
                        catalog_item_id: line.catalog_item_id.as_deref().expect("validated"),
                        sales_order_id: &sales_order_id,
                        sales_order_line_id: &line.id,
                        delivery_note_line_id: None,
                        event_type: "release",
                        quantity_delta_milli: -quantity,
                        reason: Some(&reason),
                    },
                )?;
            }
        }
        let (effective_total, allocated_total): (i64, i64) = transaction.query_row(
            "SELECT
               COALESCE(SUM(line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM sales_order_cancellation_lines cancelled WHERE cancelled.sales_order_line_id=line.id),0)),0),
               COALESCE(SUM(COALESCE((SELECT SUM(allocation.quantity_milli) FROM sales_order_invoice_allocations allocation WHERE allocation.sales_order_line_id=line.id),0)),0)
             FROM sales_order_lines line WHERE line.sales_order_id=?",
            params![sales_order_id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        )?;
        if effective_total == 0 && allocated_total == 0 {
            return Err(AppError::Validation(
                "Pour annuler une commande entière sans exécution, utilisez cancel_sales_order."
                    .into(),
            ));
        }
        close_sales_order_if_fully_allocated(&transaction, &sales_order_id)?;
        finish_operation(
            &transaction,
            &request_id,
            "cancel_sales_order_remainder",
            &hash,
            "sales_order",
            &sales_order_id,
        )?;
        let result = load_order_result(&transaction, &sales_order_id, false)?;
        append_audit(
            &transaction,
            "cancel_remainder",
            "sales_order",
            &sales_order_id,
            &json!({"reason":reason,"request_id":request_id,"result":result}),
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn save_delivery_note_draft(&self, input: SaveDeliveryNoteDraftInput) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Un bon de livraison doit contenir entre 1 et {MAX_LINES} lignes."
            )));
        }
        let sales_order_id =
            required_text(&input.delivery_note.sales_order_id, "sales_order_id", 255)?;
        let delivery_date = valid_date(&input.delivery_note.delivery_date, "delivery_date")?;
        let reference = optional_text(input.delivery_note.reference, "reference", 200)?;
        let notes = optional_text(input.delivery_note.notes, "notes", 20_000)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let order_status: String = transaction
            .query_row(
                "SELECT status FROM sales_orders WHERE id=?",
                params![sales_order_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("sales_orders/{sales_order_id}")))?;
        if order_status != "confirmed" {
            return Err(AppError::Validation(
                "Un bon de livraison exige une commande confirmée et ouverte.".into(),
            ));
        }
        let order_lines = order_lines(&transaction, &sales_order_id)?;
        let by_id: HashMap<_, _> = order_lines
            .iter()
            .map(|line| (line.id.as_str(), line))
            .collect();
        let delivery_note_id = input
            .delivery_note
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT status,sales_order_id FROM delivery_notes WHERE id=?",
                params![delivery_note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let now = now_iso();
        if let Some((status, existing_order_id)) = existing {
            if status != "draft" || existing_order_id != sales_order_id {
                return Err(AppError::Validation(
                    "Ce bon de livraison n'est plus modifiable ou appartient à une autre commande."
                        .into(),
                ));
            }
            transaction.execute(
                "UPDATE delivery_notes SET delivery_date=?,reference=?,notes=?,updated_at=? WHERE id=?",
                params![delivery_date, reference, notes, now, delivery_note_id],
            )?;
            transaction.execute(
                "DELETE FROM delivery_note_lines WHERE delivery_note_id=?",
                params![delivery_note_id],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO delivery_notes(id,sales_order_id,status,delivery_date,reference,notes,created_at,updated_at) VALUES(?,?,'draft',?,?,?,?,?)",
                params![delivery_note_id,sales_order_id,delivery_date,reference,notes,now,now],
            )?;
        }
        let mut seen = HashSet::new();
        for DeliveryNoteLineInput {
            sales_order_line_id,
            quantity_milli,
        } in input.lines
        {
            let line_id = required_text(&sales_order_line_id, "sales_order_line_id", 255)?;
            if !seen.insert(line_id.clone()) {
                return Err(AppError::Validation(
                    "Une ligne de commande ne peut apparaître qu'une fois dans un BL.".into(),
                ));
            }
            let line = by_id.get(line_id.as_str()).ok_or_else(|| {
                AppError::Validation("Une ligne du BL n'appartient pas à cette commande.".into())
            })?;
            if line.fulfillment_mode == "direct" {
                return Err(AppError::Validation(
                    "Une prestation directe ne doit pas figurer sur un bon de livraison.".into(),
                ));
            }
            let quantity_milli = validate_quantity(quantity_milli, "quantity_milli")?;
            let cancelled = cancelled_quantity(&transaction, &line.id)?;
            let already_delivered = delivered_quantity(&transaction, &line.id)?;
            let remaining = line
                .quantity_milli
                .checked_sub(cancelled)
                .and_then(|value| value.checked_sub(already_delivered))
                .filter(|value| *value >= 0)
                .ok_or_else(|| {
                    AppError::Validation("Le suivi de livraison est incohérent.".into())
                })?;
            if quantity_milli > remaining {
                return Err(AppError::Validation(format!(
                    "La quantité livrable restante de la ligne {} est de {remaining} millièmes.",
                    line.id
                )));
            }
            transaction.execute(
                "INSERT INTO delivery_note_lines(id,delivery_note_id,sales_order_line_id,position,quantity_milli,description,unit,created_at) VALUES(?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),delivery_note_id,line.id,line.position,quantity_milli,line.description,line.unit,now],
            )?;
        }
        let result = load_delivery_result(&transaction, &delivery_note_id, false)?;
        append_audit(
            &transaction,
            "save_draft",
            "delivery_note",
            &delivery_note_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn issue_delivery_note(&self, input: IssueDeliveryNoteInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "issue_delivery_note",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let delivery_note_id = required_text(&input.delivery_note_id, "delivery_note_id", 255)?;
        let note = query_record_tx(&transaction, "delivery_notes", &delivery_note_id)?;
        if note.get("status").and_then(Value::as_str) != Some("draft") {
            return Err(AppError::Validation(
                "Seul un bon de livraison brouillon peut être émis.".into(),
            ));
        }
        let sales_order_id = note
            .get("sales_order_id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation("Le BL n'a pas de commande.".into()))?;
        let order_status: String = transaction.query_row(
            "SELECT status FROM sales_orders WHERE id=?",
            params![sales_order_id],
            |row| row.get(0),
        )?;
        if order_status != "confirmed" {
            return Err(AppError::Validation(
                "La commande doit être confirmée et ouverte pour émettre ce BL.".into(),
            ));
        }
        let mut statement = transaction.prepare(
            "SELECT delivery.id,delivery.sales_order_line_id,delivery.quantity_milli,order_line.catalog_item_id,order_line.quantity_milli,order_line.fulfillment_mode
             FROM delivery_note_lines delivery JOIN sales_order_lines order_line ON order_line.id=delivery.sales_order_line_id
             WHERE delivery.delivery_note_id=? ORDER BY delivery.position,delivery.rowid",
        )?;
        let lines = statement
            .query_map(params![delivery_note_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if lines.is_empty() {
            return Err(AppError::Validation(
                "Le BL ne contient aucune ligne.".into(),
            ));
        }
        for line in &lines {
            let cancelled = cancelled_quantity(&transaction, &line.1)?;
            let already_delivered = delivered_quantity(&transaction, &line.1)?;
            let remaining = line
                .4
                .checked_sub(cancelled)
                .and_then(|value| value.checked_sub(already_delivered))
                .filter(|value| *value >= 0)
                .ok_or_else(|| {
                    AppError::Validation("Le suivi de livraison est incohérent.".into())
                })?;
            if line.2 > remaining {
                return Err(AppError::Validation(format!(
                    "La ligne {} dépasse le reliquat livrable ({remaining}).",
                    line.1
                )));
            }
            if line.5 == "stocked_delivery" {
                let catalog_id = line.3.as_deref().ok_or_else(|| {
                    AppError::Validation("Une ligne stockée n'a pas d'article.".into())
                })?;
                if current_reserved_for_line(&transaction, &line.1)? < line.2 {
                    return Err(AppError::Validation(
                        "La quantité livrée dépasse la réservation active.".into(),
                    ));
                }
                let on_hand: i64 = transaction.query_row(
                    "SELECT stock_quantity_milli FROM catalog_items WHERE id=? AND track_stock=1",
                    params![catalog_id],
                    |row| row.get(0),
                )?;
                if on_hand < line.2 {
                    return Err(AppError::Validation(format!(
                        "Stock physique insuffisant pour {catalog_id}."
                    )));
                }
            }
        }
        let delivery_date = note
            .get("delivery_date")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation("La date de livraison est absente.".into()))?;
        let number = assign_document_number(
            &transaction,
            "delivery_notes",
            &delivery_note_id,
            "delivery_note",
            delivery_date,
        )?;
        let snapshot_json = serde_json::to_string(&json!({
            "delivery_note":note,
            "lines":query_all(&transaction,"SELECT * FROM delivery_note_lines WHERE delivery_note_id=? ORDER BY position,created_at",params![delivery_note_id])?,
            "order":query_record_tx(&transaction,"sales_orders",sales_order_id)?
        }))?;
        let now = now_iso();
        transaction.execute(
            "UPDATE delivery_notes SET number=?,status='issued',issued_at=?,snapshot_json=?,updated_at=? WHERE id=?",
            params![number, now, snapshot_json, now, delivery_note_id],
        )?;
        for (line_id, order_line_id, quantity, catalog_id, _, mode) in lines {
            if mode != "stocked_delivery" {
                continue;
            }
            let catalog_id = catalog_id.expect("validated");
            let current_balance: i64 = transaction.query_row(
                "SELECT stock_quantity_milli FROM catalog_items WHERE id=?",
                params![catalog_id],
                |row| row.get(0),
            )?;
            let balance_after = current_balance
                .checked_sub(quantity)
                .ok_or_else(|| AppError::Validation("Le stock deviendrait négatif.".into()))?;
            let movement_id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO stock_movements(id,source_key,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,reference,movement_date,source_type,delivery_note_id,delivery_note_line_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'delivery',?,?,?)",
                params![movement_id,format!("delivery:{line_id}"),catalog_id,"exit",-quantity,balance_after,format!("Sortie sur bon de livraison {number}"),number,delivery_date,delivery_note_id,line_id,now],
            )?;
            transaction.execute(
                "UPDATE delivery_note_lines SET stock_movement_id=? WHERE id=?",
                params![movement_id, line_id],
            )?;
            append_reservation_event(
                &transaction,
                ReservationEvent {
                    catalog_item_id: &catalog_id,
                    sales_order_id,
                    sales_order_line_id: &order_line_id,
                    delivery_note_line_id: Some(&line_id),
                    event_type: "delivery",
                    quantity_delta_milli: -quantity,
                    reason: Some("Livraison client émise"),
                },
            )?;
        }
        finish_operation(
            &transaction,
            &request_id,
            "issue_delivery_note",
            &hash,
            "delivery_note",
            &delivery_note_id,
        )?;
        let result = load_delivery_result(&transaction, &delivery_note_id, false)?;
        append_audit(
            &transaction,
            "issue",
            "delivery_note",
            &delivery_note_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn reverse_delivery_note(&self, input: ReverseDeliveryNoteInput) -> AppResult<Value> {
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "reverse_delivery_note",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let delivery_note_id = required_text(&input.delivery_note_id, "delivery_note_id", 255)?;
        let note = query_record_tx(&transaction, "delivery_notes", &delivery_note_id)?;
        if note.get("status").and_then(Value::as_str) != Some("issued") {
            return Err(AppError::Validation(
                "Seul un bon de livraison émis peut être extourné.".into(),
            ));
        }
        let sales_order_id = note["sales_order_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Le BL n'a pas de commande.".into()))?;
        let order_status: String = transaction.query_row(
            "SELECT status FROM sales_orders WHERE id=?",
            params![sales_order_id],
            |row| row.get(0),
        )?;
        if order_status != "confirmed" {
            return Err(AppError::Validation(
                "Une livraison d'une commande clôturée ou annulée ne peut pas être extournée."
                    .into(),
            ));
        }
        let allocated: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sales_order_invoice_allocations allocation JOIN delivery_note_lines line ON line.id=allocation.delivery_note_line_id WHERE line.delivery_note_id=?)",
            params![delivery_note_id],
            |row| row.get(0),
        )?;
        if allocated {
            return Err(AppError::Validation(
                "Ce BL est déjà lié à une facture; annulez d'abord la facture brouillon ou utilisez un avoir."
                    .into(),
            ));
        }
        let now = now_iso();
        transaction.execute(
            "UPDATE delivery_notes SET status='reversed',reversed_at=?,reversal_reason=?,updated_at=? WHERE id=?",
            params![now, reason, now, delivery_note_id],
        )?;
        let mut statement = transaction.prepare(
            "SELECT line.id,line.sales_order_line_id,line.quantity_milli,order_line.catalog_item_id,order_line.fulfillment_mode,line.stock_movement_id
             FROM delivery_note_lines line JOIN sales_order_lines order_line ON order_line.id=line.sales_order_line_id
             WHERE line.delivery_note_id=? ORDER BY line.position,line.rowid",
        )?;
        let lines = statement
            .query_map(params![delivery_note_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let number = note["number"].as_str().unwrap_or("BL");
        let movement_date = note["delivery_date"].as_str().unwrap_or("");
        for (line_id, order_line_id, quantity, catalog_id, mode, original_movement_id) in lines {
            if mode != "stocked_delivery" {
                continue;
            }
            let catalog_id = catalog_id.expect("validated");
            let original_movement_id = original_movement_id.ok_or_else(|| {
                AppError::Validation("La sortie de stock originale du BL est absente.".into())
            })?;
            let current_balance: i64 = transaction.query_row(
                "SELECT stock_quantity_milli FROM catalog_items WHERE id=?",
                params![catalog_id],
                |row| row.get(0),
            )?;
            let balance_after = current_balance
                .checked_add(quantity)
                .filter(|value| *value <= MAX_QUANTITY_MILLI)
                .ok_or_else(|| {
                    AppError::Validation("Le stock restauré dépasse la limite.".into())
                })?;
            let movement_id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO stock_movements(id,source_key,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,reference,movement_date,source_type,delivery_note_id,delivery_note_line_id,reverses_stock_movement_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'delivery',?,?,?,?)",
                params![movement_id,format!("delivery-reversal:{line_id}"),catalog_id,"entry",quantity,balance_after,format!("Extourne du bon de livraison {number}: {reason}"),number,movement_date,delivery_note_id,line_id,original_movement_id,now],
            )?;
            transaction.execute(
                "UPDATE delivery_note_lines SET reversal_stock_movement_id=? WHERE id=?",
                params![movement_id, line_id],
            )?;
            append_reservation_event(
                &transaction,
                ReservationEvent {
                    catalog_item_id: &catalog_id,
                    sales_order_id,
                    sales_order_line_id: &order_line_id,
                    delivery_note_line_id: Some(&line_id),
                    event_type: "restore",
                    quantity_delta_milli: quantity,
                    reason: Some(&reason),
                },
            )?;
        }
        finish_operation(
            &transaction,
            &request_id,
            "reverse_delivery_note",
            &hash,
            "delivery_note",
            &delivery_note_id,
        )?;
        let result = load_delivery_result(&transaction, &delivery_note_id, false)?;
        append_audit(
            &transaction,
            "reverse",
            "delivery_note",
            &delivery_note_id,
            &json!({"reason":reason,"result":result}),
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
macro_rules! sales_fulfillment_tests {
    () => {
        mod tests {
    use std::fs;

    use rusqlite::{params, Connection};
    use serde_json::json;

    use super::*;
    use crate::{
        models::{
            ConvertQuoteInput, RecordPaymentInput, SaveDocumentWithItemsInput, StockEntryInput,
        },
        schema::{SCHEMA_SQL, SCHEMA_VERSION},
    };

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,iban,address_line1,postal_code,city,country,created_at,updated_at)
                 VALUES(1,1,'Entreprise logistique','CH9300762011623852957','Rue du Test 1','1000','Lausanne','CH',?,?)",
                params![now, now],
            )
            .unwrap();
        drop(connection);
        (temporary, store)
    }

    fn id(record: &Value) -> String {
        record["id"].as_str().unwrap().to_owned()
    }

    fn tracked_order(
        store: &LocalStore,
        ordered_quantity_milli: i64,
        initial_stock_milli: i64,
    ) -> (String, String, String, String) {
        let client_id = id(&store
            .create_record(
                "clients",
                json!({
                    "name":"Client logistique",
                    "address_line1":"Route du Client 2",
                    "postal_code":"1200",
                    "city":"Genève",
                    "country":"CH"
                }),
            )
            .unwrap());
        let catalog_item_id = id(&store
            .create_record(
                "catalog_items",
                json!({
                    "kind":"product",
                    "name":"Matériel réservé",
                    "unit":"pièce",
                    "sales_price_cents":10_000,
                    "track_stock":true
                }),
            )
            .unwrap());
        store
            .record_stock_entry(StockEntryInput {
                request_id: Uuid::new_v4().to_string(),
                catalog_item_id: catalog_item_id.clone(),
                quantity_milli: initial_stock_milli,
                reason: "Stock de départ du test".into(),
                reference: Some("TEST-V20".into()),
                date: Some("2026-01-01".into()),
            })
            .unwrap();
        let quote_id = id(&store
            .create_record(
                "quotes",
                json!({"client_id":client_id,"title":"Offre matériel"}),
            )
            .unwrap());
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":quote_id,
                    "catalog_item_id":catalog_item_id,
                    "description":"Matériel livré",
                    "quantity":ordered_quantity_milli as f64/1000.0,
                    "unit":"pièce",
                    "unit_price_cents":10_000,
                    "discount_bp":0,
                    "vat_bp":810
                }),
            )
            .unwrap();
        store
            .issue_quote(
                &quote_id,
                Some("2026-01-02".into()),
                Some("2026-02-01".into()),
            )
            .unwrap();
        store.update_quote_status(&quote_id, "accepted").unwrap();
        let direct_error = store
            .convert_quote_to_invoice(ConvertQuoteInput {
                quote_id: quote_id.clone(),
                title: None,
                issue_date: None,
                due_date: None,
                service_date_from: Some("2026-01-01".into()),
                service_date_to: Some("2026-01-31".into()),
            })
            .unwrap_err();
        assert!(direct_error.to_string().contains("suivi en stock"));
        let conversion = ConvertQuoteToSalesOrderInput {
            request_id: Uuid::new_v4().to_string(),
            quote_id: quote_id.clone(),
        };
        let order = store
            .convert_quote_to_sales_order(conversion.clone())
            .unwrap();
        let sales_order_id = order["order"]["id"].as_str().unwrap().to_owned();
        let sales_order_line_id = order["lines"][0]["id"].as_str().unwrap().to_owned();
        let replay = store.convert_quote_to_sales_order(conversion).unwrap();
        assert_eq!(replay["order"]["id"], sales_order_id);
        assert_eq!(replay["idempotent"], true);
        store
            .confirm_sales_order(ConfirmSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: sales_order_id.clone(),
            })
            .unwrap();
        (
            client_id,
            catalog_item_id,
            sales_order_id,
            sales_order_line_id,
        )
    }

    fn issue_delivery(
        store: &LocalStore,
        sales_order_id: &str,
        sales_order_line_id: &str,
        quantity_milli: i64,
        date: &str,
    ) -> (String, String) {
        let draft = store
            .save_delivery_note_draft(SaveDeliveryNoteDraftInput {
                delivery_note: crate::models::DeliveryNoteDraftInput {
                    id: None,
                    sales_order_id: sales_order_id.into(),
                    delivery_date: date.into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![DeliveryNoteLineInput {
                    sales_order_line_id: sales_order_line_id.into(),
                    quantity_milli,
                }],
            })
            .unwrap();
        let delivery_note_id = draft["delivery_note"]["id"].as_str().unwrap().to_owned();
        let delivery_note_line_id = draft["lines"][0]["id"].as_str().unwrap().to_owned();
        store
            .issue_delivery_note(IssueDeliveryNoteInput {
                request_id: Uuid::new_v4().to_string(),
                delivery_note_id: delivery_note_id.clone(),
            })
            .unwrap();
        (delivery_note_id, delivery_note_line_id)
    }

    #[test]
    fn migration_v19_to_v20_preserves_historical_stock_and_is_idempotent() {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        fs::create_dir_all(&profile).unwrap();
        let database_path = profile.join("helvichantier.sqlite3");
        let connection = Connection::open(&database_path).unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        let now = "2026-01-01T00:00:00Z";
        connection
            .execute(
                "INSERT INTO catalog_items(id,kind,name,track_stock,stock_quantity_milli,created_at,updated_at) VALUES('legacy-item','product','Article historique',1,0,?,?)",
                params![now,now],
            )
            .unwrap();
        let request_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO stock_movements(id,source_key,request_id,request_sha256,request_json,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,reference,movement_date,source_type,created_at)
                 VALUES('legacy-movement',? ,? ,?,'{}','legacy-item','entry',1000,1000,'Entrée historique','LEGACY','2026-01-01','manual',?)",
                params![format!("manual:{request_id}"),request_id,"0".repeat(64),now],
            )
            .unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            19
        );
        drop(connection);

        let store = LocalStore::initialize(profile).unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let preserved: (i64, i64, Option<String>) = connection
            .query_row(
                "SELECT COUNT(*),MAX(balance_after_milli),MAX(delivery_note_id) FROM stock_movements WHERE id='legacy-movement'",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )
            .unwrap();
        assert_eq!(preserved, (1, 1_000, None));
        assert_eq!(
            connection
                .query_row(
                    "SELECT stock_quantity_milli FROM catalog_items WHERE id='legacy-item'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1_000
        );
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        connection.pragma_update(None, "user_version", 19).unwrap();
        drop(connection);
        store.migrate().unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM stock_movements", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_key_check", [], |row| row
                    .get::<_, String>(0))
                .optional()
                .unwrap(),
            None
        );
    }

    #[test]
    fn quote_order_delivery_invoice_flow_is_idempotent_and_never_double_exits_stock() {
        let (_temporary, store) = initialized_store();
        let (client_id, catalog_item_id, sales_order_id, sales_order_line_id) =
            tracked_order(&store, 5_000, 10_000);
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["schema_version"], SCHEMA_VERSION);
        assert_eq!(workspace["stock_availability"][0]["on_hand_milli"], 10_000);
        assert_eq!(workspace["stock_availability"][0]["reserved_milli"], 5_000);
        assert_eq!(workspace["stock_availability"][0]["available_milli"], 5_000);

        let manual_invoice = store
            .save_document_with_items(SaveDocumentWithItemsInput {
                entity: "invoices".into(),
                id: None,
                data: json!({
                    "client_id":client_id,
                    "title":"Facture indépendante interdite",
                    "type":"standard",
                    "service_date_from":"2026-01-01",
                    "service_date_to":"2026-01-31"
                }),
                items: vec![json!({
                    "catalog_item_id":catalog_item_id,
                    "position":0,
                    "description":"Tentative sur stock réservé",
                    "quantity":6,
                    "unit":"pièce",
                    "unit_price_cents":10_000,
                    "discount_bp":0,
                    "vat_bp":810
                })],
            })
            .unwrap();
        let manual_invoice_id = manual_invoice["document"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let reserved_error = store
            .issue_invoice(
                &manual_invoice_id,
                Some("2026-01-10".into()),
                Some("2026-02-10".into()),
            )
            .unwrap_err();
        assert!(reserved_error.to_string().contains("disponibles"));
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM stock_movements WHERE source_type='invoice'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        let (_, first_delivery_line_id) = issue_delivery(
            &store,
            &sales_order_id,
            &sales_order_line_id,
            2_000,
            "2026-01-15",
        );
        let partial_input = CreateSalesOrderInvoiceInput {
            request_id: Uuid::new_v4().to_string(),
            sales_order_id: sales_order_id.clone(),
            issue_date: None,
            due_date: None,
            service_date_from: "2026-01-01".into(),
            service_date_to: "2026-01-31".into(),
            allocations: vec![SalesOrderInvoiceAllocationInput {
                sales_order_line_id: sales_order_line_id.clone(),
                delivery_note_line_id: Some(first_delivery_line_id),
                quantity_milli: 2_000,
            }],
        };
        let partial = store
            .create_sales_order_invoice(partial_input.clone())
            .unwrap();
        assert_eq!(partial["role"], "partial");
        assert_eq!(partial["invoice"]["type"], "situation");
        let partial_replay = store.create_sales_order_invoice(partial_input).unwrap();
        assert_eq!(partial_replay["idempotent"], true);
        assert!(store
            .preview_sales_order_invoice(PreviewSalesOrderInvoiceInput {
                sales_order_id: sales_order_id.clone(),
                allocations: vec![],
            })
            .is_err());
        let partial_invoice_id = partial["invoice"]["id"].as_str().unwrap();
        store
            .issue_invoice(
                partial_invoice_id,
                Some("2026-02-01".into()),
                Some("2026-03-01".into()),
            )
            .unwrap();
        let early_payment = store
            .record_payment(RecordPaymentInput {
                request_id: Some(Uuid::new_v4().to_string()),
                invoice_id: partial_invoice_id.into(),
                amount_cents: 1_000,
                date: Some("2026-01-31".into()),
                method: Some("bank".into()),
                reference: Some("CAMT-ANTERIEUR".into()),
                notes: None,
            })
            .unwrap_err();
        assert!(early_payment.to_string().contains("précéder"));
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM payments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            query_record_tx(
                &store.connect().unwrap().unchecked_transaction().unwrap(),
                "sales_orders",
                &sales_order_id,
            )
            .unwrap()["status"],
            "confirmed"
        );

        let (_, second_delivery_line_id) = issue_delivery(
            &store,
            &sales_order_id,
            &sales_order_line_id,
            3_000,
            "2026-02-15",
        );
        let final_input = CreateSalesOrderInvoiceInput {
            request_id: Uuid::new_v4().to_string(),
            sales_order_id: sales_order_id.clone(),
            issue_date: None,
            due_date: None,
            service_date_from: "2026-02-01".into(),
            service_date_to: "2026-02-28".into(),
            allocations: vec![SalesOrderInvoiceAllocationInput {
                sales_order_line_id: sales_order_line_id.clone(),
                delivery_note_line_id: Some(second_delivery_line_id.clone()),
                quantity_milli: 3_000,
            }],
        };
        let first_final = store
            .create_sales_order_invoice(final_input.clone())
            .unwrap();
        let first_final_invoice_id = first_final["invoice"]["id"].as_str().unwrap().to_owned();
        assert_eq!(first_final["role"], "final");
        assert_eq!(
            store.get_workspace().unwrap()["sales_orders"][0]["status"],
            "confirmed"
        );
        store
            .cancel_sales_order_invoice_draft(CancelSalesOrderInvoiceDraftInput {
                request_id: Uuid::new_v4().to_string(),
                invoice_id: first_final_invoice_id.clone(),
                reason: "Recréation contrôlée".into(),
            })
            .unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM invoices WHERE id=?",
                    params![first_final_invoice_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        let mut final_input = final_input;
        final_input.request_id = Uuid::new_v4().to_string();
        let final_invoice = store.create_sales_order_invoice(final_input).unwrap();
        let final_invoice_id = final_invoice["invoice"]["id"].as_str().unwrap().to_owned();
        store
            .connect()
            .unwrap()
            .execute("UPDATE settings SET iban='INVALIDE' WHERE id=1", [])
            .unwrap();
        assert!(store
            .issue_invoice(
                &final_invoice_id,
                Some("2026-03-01".into()),
                Some("2026-04-01".into()),
            )
            .is_err());
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["sales_orders"][0]["status"], "confirmed");
        assert_eq!(
            workspace["invoices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|invoice| invoice["id"] == final_invoice_id)
                .unwrap()["status"],
            "brouillon"
        );
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE settings SET iban='CH9300762011623852957' WHERE id=1",
                [],
            )
            .unwrap();
        store
            .issue_invoice(
                &final_invoice_id,
                Some("2026-03-01".into()),
                Some("2026-04-01".into()),
            )
            .unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["sales_orders"][0]["status"], "closed");
        assert_eq!(workspace["stock_availability"][0]["on_hand_milli"], 5_000);
        assert_eq!(workspace["stock_availability"][0]["reserved_milli"], 0);
        assert_eq!(
            workspace["stock_movements"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|movement| movement["source_type"] == "delivery")
                .count(),
            2
        );
        assert_eq!(
            workspace["stock_movements"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|movement| movement["source_type"] == "invoice")
                .count(),
            0
        );
    }

    #[test]
    fn backup_restore_keeps_order_reservation_delivery_invoice_links_and_local_license() {
        let (temporary, store) = initialized_store();
        let (_, _, sales_order_id, sales_order_line_id) =
            tracked_order(&store, 3_000, 5_000);
        let (_, delivery_note_line_id) = issue_delivery(
            &store,
            &sales_order_id,
            &sales_order_line_id,
            1_000,
            "2026-01-15",
        );
        let invoice = store
            .create_sales_order_invoice(CreateSalesOrderInvoiceInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: sales_order_id.clone(),
                issue_date: None,
                due_date: None,
                service_date_from: "2026-01-01".into(),
                service_date_to: "2026-01-31".into(),
                allocations: vec![SalesOrderInvoiceAllocationInput {
                    sales_order_line_id: sales_order_line_id.clone(),
                    delivery_note_line_id: Some(delivery_note_line_id.clone()),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let invoice_id = invoice["invoice"]["id"].as_str().unwrap().to_owned();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-02-01".into()),
                Some("2026-03-01".into()),
            )
            .unwrap();

        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO license_state(id,token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version) VALUES(1,'token-source','lic-source','Entreprise source','elyko-monthly-50-chf',5000,'2026-01-01T00:00:00Z','2026-01-01','2027-01-01','2026-01-01T00:00:00Z','2026-01-01',1)",
                [],
            )
            .unwrap();
        let sequence_snapshot: Vec<(String, i64, i64)> = connection
            .prepare(
                "SELECT document_type,year,next_value FROM number_sequences ORDER BY document_type,year",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(connection);

        let backup_path = temporary.path().join("sales-v20.elyko");
        store
            .create_backup(
                Some(backup_path.to_string_lossy().into_owned()),
                "1.7.0",
            )
            .unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE license_state SET token='token-destination',license_id='lic-destination' WHERE id=1",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE number_sequences SET next_value=999", [])
            .unwrap();
        drop(connection);

        store
            .restore_backup(&backup_path.to_string_lossy(), "1.7.0")
            .unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["sales_orders"][0]["id"], sales_order_id);
        assert_eq!(workspace["sales_orders"][0]["status"], "confirmed");
        assert_eq!(workspace["stock_availability"][0]["on_hand_milli"], 4_000);
        assert_eq!(workspace["stock_availability"][0]["reserved_milli"], 2_000);
        assert_eq!(workspace["stock_availability"][0]["available_milli"], 2_000);
        assert_eq!(workspace["delivery_note_lines"][0]["id"], delivery_note_line_id);
        assert_eq!(
            workspace["sales_order_invoice_batches"][0]["invoice_id"],
            invoice_id
        );

        let connection = store.connect().unwrap();
        let restored_license: (String, String) = connection
            .query_row(
                "SELECT token,license_id FROM license_state WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            restored_license,
            ("token-destination".into(), "lic-destination".into())
        );
        let restored_sequences: Vec<(String, i64, i64)> = connection
            .prepare(
                "SELECT document_type,year,next_value FROM number_sequences ORDER BY document_type,year",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(restored_sequences, sequence_snapshot);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sales_order_invoice_allocations allocation
                     JOIN sales_order_invoice_batches batch ON batch.id=allocation.batch_id
                     JOIN invoices invoice ON invoice.id=batch.invoice_id
                     JOIN sales_order_lines order_line ON order_line.id=allocation.sales_order_line_id
                     JOIN delivery_note_lines delivery_line ON delivery_line.id=allocation.delivery_note_line_id
                     JOIN delivery_notes delivery ON delivery.id=delivery_line.delivery_note_id
                     WHERE batch.sales_order_id=? AND order_line.sales_order_id=batch.sales_order_id
                       AND delivery.sales_order_id=batch.sales_order_id AND invoice.id=?",
                    params![sales_order_id, invoice_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_key_check", [], |row| row.get::<_, String>(0))
                .optional()
                .unwrap(),
            None
        );
        let counts = store.business_row_counts().unwrap();
        assert_eq!(counts["sales_orders"], 1);
        assert_eq!(counts["sales_order_lines"], 1);
        assert_eq!(counts["delivery_notes"], 1);
        assert_eq!(counts["delivery_note_lines"], 1);
        assert_eq!(counts["sales_order_invoice_batches"], 1);
        assert_eq!(counts["sales_order_invoice_allocations"], 1);
        assert_eq!(counts["stock_reservation_events"], 2);
    }

    #[test]
    fn cancellation_removes_only_drafts_and_closes_an_already_invoiced_remainder() {
        let (_temporary, store) = initialized_store();
        let (_, _, cancel_order_id, cancel_line_id) = tracked_order(&store, 2_000, 10_000);
        let draft = store
            .save_delivery_note_draft(SaveDeliveryNoteDraftInput {
                delivery_note: crate::models::DeliveryNoteDraftInput {
                    id: None,
                    sales_order_id: cancel_order_id.clone(),
                    delivery_date: "2026-01-20".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![DeliveryNoteLineInput {
                    sales_order_line_id: cancel_line_id,
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let draft_note_id = draft["delivery_note"]["id"].as_str().unwrap().to_owned();
        store
            .cancel_sales_order(CancelSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: cancel_order_id,
                reason: "Commande abandonnée".into(),
            })
            .unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM delivery_notes WHERE id=?",
                    params![draft_note_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);

        let (_, second_catalog_item_id, order_id, line_id) = tracked_order(&store, 5_000, 10_000);
        let (_, delivery_line_id) =
            issue_delivery(&store, &order_id, &line_id, 2_000, "2026-02-01");
        let invoice = store
            .create_sales_order_invoice(CreateSalesOrderInvoiceInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
                issue_date: None,
                due_date: None,
                service_date_from: "2026-02-01".into(),
                service_date_to: "2026-02-28".into(),
                allocations: vec![SalesOrderInvoiceAllocationInput {
                    sales_order_line_id: line_id.clone(),
                    delivery_note_line_id: Some(delivery_line_id),
                    quantity_milli: 2_000,
                }],
            })
            .unwrap();
        store
            .issue_invoice(
                invoice["invoice"]["id"].as_str().unwrap(),
                Some("2026-03-01".into()),
                Some("2026-04-01".into()),
            )
            .unwrap();
        let cancelled = store
            .cancel_sales_order_remainder(CancelSalesOrderRemainderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
                reason: "Solde non requis".into(),
                lines: vec![crate::models::CancelSalesOrderRemainderLineInput {
                    sales_order_line_id: line_id,
                    quantity_milli: 3_000,
                }],
            })
            .unwrap();
        assert_eq!(cancelled["order"]["status"], "closed");
        assert_eq!(
            store.get_workspace().unwrap()["stock_availability"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["catalog_item_id"] == second_catalog_item_id)
                .unwrap()["available_milli"],
            8_000
        );
    }

    #[test]
    fn emitted_headers_event_ledgers_and_parentage_are_sql_hardened() {
        let (_temporary, store) = initialized_store();
        let (client_id, catalog_item_id, sales_order_id, sales_order_line_id) =
            tracked_order(&store, 2_000, 5_000);
        let draft_order = store
            .save_sales_order_draft(SaveSalesOrderDraftInput {
                order: crate::models::SalesOrderDraftInput {
                    id: None,
                    client_id,
                    project_id: None,
                    title: "Brouillon protégé".into(),
                    order_date: "2026-01-10".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![SalesOrderLineInput {
                    id: None,
                    catalog_item_id: None,
                    position: 0,
                    description: "Service direct".into(),
                    quantity_milli: 1_000,
                    unit: "forfait".into(),
                    unit_price_cents: 1_000,
                    discount_bp: 0,
                    vat_bp: 0,
                    fulfillment_mode: "direct".into(),
                }],
            })
            .unwrap();
        let draft_order_id = draft_order["order"]["id"].as_str().unwrap().to_owned();
        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE sales_orders SET status='confirmed',number='C-FORGED',confirmed_at=?,title='Altération simultanée' WHERE id=?",
                params![now_iso(),draft_order_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE sales_orders SET title='Altération' WHERE id=?",
                params![sales_order_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO sales_order_lines(id,sales_order_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,fulfillment_mode,created_at,updated_at)
                 VALUES('forged-line',?,99,'Ajout tardif',1000,'pièce',100,0,0,100,0,100,'direct',?,?)",
                params![sales_order_id,now_iso(),now_iso()],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE sales_operation_requests SET operation='forged' WHERE result_entity_id=?",
                params![sales_order_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM sales_operation_requests WHERE result_entity_id=?",
                params![sales_order_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO stock_reservation_events(id,catalog_item_id,sales_order_id,sales_order_line_id,event_type,quantity_delta_milli,line_reserved_after_milli,catalog_reserved_after_milli,created_at)
                 VALUES(?,?,?,?, 'reserve',1000,999999,999999,?)",
                params![Uuid::new_v4().to_string(),catalog_item_id,sales_order_id,sales_order_line_id,now_iso()],
            )
            .is_err());
        drop(connection);
        let (_, _, _, other_order_line_id) = tracked_order(&store, 1_000, 2_000);
        let draft_delivery = store
            .save_delivery_note_draft(SaveDeliveryNoteDraftInput {
                delivery_note: crate::models::DeliveryNoteDraftInput {
                    id: None,
                    sales_order_id: sales_order_id.clone(),
                    delivery_date: "2026-01-25".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![DeliveryNoteLineInput {
                    sales_order_line_id: sales_order_line_id.clone(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let delivery_note_id = draft_delivery["delivery_note"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let delivery_note_line_id = draft_delivery["lines"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "INSERT INTO delivery_note_lines(id,delivery_note_id,sales_order_line_id,position,quantity_milli,description,unit,created_at)
                 VALUES('foreign-order-line',?,?,9,1000,'Mauvaise commande','pièce',?)",
                params![delivery_note_id,other_order_line_id,now_iso()],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE delivery_note_lines SET sales_order_line_id=? WHERE id=?",
                params![other_order_line_id, delivery_note_line_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE delivery_notes SET status='issued',number='BL-FORGED',issued_at=?,notes='Altération simultanée' WHERE id=?",
                params![now_iso(),delivery_note_id],
            )
            .is_err());
        drop(connection);
        store
            .issue_delivery_note(IssueDeliveryNoteInput {
                request_id: Uuid::new_v4().to_string(),
                delivery_note_id: delivery_note_id.clone(),
            })
            .unwrap();
        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE delivery_notes SET notes='Altération' WHERE id=?",
                params![delivery_note_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO sales_order_cancellation_lines(id,request_id,sales_order_id,sales_order_line_id,quantity_milli,reason,created_at)
                 VALUES(?,?,?,?,2000,'Annulation forgée',?)",
                params![Uuid::new_v4().to_string(),Uuid::new_v4().to_string(),sales_order_id,sales_order_line_id,now_iso()],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO delivery_note_lines(id,delivery_note_id,sales_order_line_id,position,quantity_milli,description,unit,created_at)
                 VALUES('forged-delivery-line',?,?,9,1000,'Ajout tardif','pièce',?)",
                params![delivery_note_id,sales_order_line_id,now_iso()],
            )
            .is_err());
    }

    #[test]
    fn quote_cross_exclusion_is_atomic_in_both_directions() {
        let (_temporary, store) = initialized_store();
        let client_id = id(&store
            .create_record("clients", json!({"name":"Client exclusion"}))
            .unwrap());
        let make_quote = |title: &str| {
            let quote_id = id(&store
                .create_record("quotes", json!({"client_id":client_id,"title":title}))
                .unwrap());
            store
                .create_record(
                    "quote_items",
                    json!({"quote_id":quote_id,"description":"Service","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0}),
                )
                .unwrap();
            store
                .issue_quote(
                    &quote_id,
                    Some("2026-01-01".into()),
                    Some("2026-01-31".into()),
                )
                .unwrap();
            store.update_quote_status(&quote_id, "accepted").unwrap();
            quote_id
        };
        let direct_quote = make_quote("Conversion directe");
        store
            .convert_quote_to_invoice(ConvertQuoteInput {
                quote_id: direct_quote.clone(),
                title: None,
                issue_date: None,
                due_date: None,
                service_date_from: Some("2026-01-01".into()),
                service_date_to: Some("2026-01-31".into()),
            })
            .unwrap();
        assert!(store
            .convert_quote_to_sales_order(ConvertQuoteToSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                quote_id: direct_quote,
            })
            .is_err());

        let order_quote = make_quote("Conversion commande");
        store
            .convert_quote_to_sales_order(ConvertQuoteToSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                quote_id: order_quote.clone(),
            })
            .unwrap();
        assert!(store
            .convert_quote_to_invoice(ConvertQuoteInput {
                quote_id: order_quote,
                title: None,
                issue_date: None,
                due_date: None,
                service_date_from: Some("2026-01-01".into()),
                service_date_to: Some("2026-01-31".into()),
            })
            .is_err());
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM quote_conversions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sales_orders WHERE quote_id IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        }
    }
    };
}

fn amounts_for_cumulative(
    quantity_milli: i64,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
) -> AppResult<Amounts> {
    if quantity_milli == 0 {
        return Ok(Amounts {
            gross: 0,
            net: 0,
            vat: 0,
            total: 0,
        });
    }
    calculate_amounts(quantity_milli, unit_price_cents, discount_bp, vat_bp)
}

fn subtract_amounts(after: Amounts, before: Amounts) -> AppResult<Amounts> {
    let checked = |a: i64, b: i64, name: &str| {
        a.checked_sub(b).filter(|value| *value >= 0).ok_or_else(|| {
            AppError::Validation(format!("La ventilation de {name} est incohérente."))
        })
    };
    Ok(Amounts {
        gross: checked(after.gross, before.gross, "montant brut")?,
        net: checked(after.net, before.net, "montant net")?,
        vat: checked(after.vat, before.vat, "TVA")?,
        total: checked(after.total, before.total, "total")?,
    })
}

fn prepare_invoice_preview(
    transaction: &Transaction<'_>,
    sales_order_id: &str,
    allocations: &[SalesOrderInvoiceAllocationInput],
) -> AppResult<InvoicePreview> {
    if allocations.is_empty() || allocations.len() > MAX_LINES {
        return Err(AppError::Validation(format!(
            "Une facture de commande doit contenir entre 1 et {MAX_LINES} allocations."
        )));
    }
    let status: String = transaction
        .query_row(
            "SELECT status FROM sales_orders WHERE id=?",
            params![sales_order_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("sales_orders/{sales_order_id}")))?;
    if status != "confirmed" {
        return Err(AppError::Validation(
            "La facturation exige une commande confirmée et ouverte.".into(),
        ));
    }
    let has_final: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sales_order_invoice_batches WHERE sales_order_id=? AND role='final')",
        params![sales_order_id],
        |row| row.get(0),
    )?;
    if has_final {
        return Err(AppError::Validation(
            "Une facture finale existe déjà pour cette commande.".into(),
        ));
    }
    let has_active_draft: bool = transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sales_order_invoice_batches batch
           JOIN invoices invoice ON invoice.id=batch.invoice_id
           WHERE batch.sales_order_id=? AND invoice.status='brouillon' AND invoice.number IS NULL
         )",
        params![sales_order_id],
        |row| row.get(0),
    )?;
    if has_active_draft {
        return Err(AppError::Validation(
            "Une facture brouillon est déjà active pour cette commande. Émettez-la ou annulez-la avant d'en créer une autre."
                .into(),
        ));
    }
    let lines = order_lines(transaction, sales_order_id)?;
    let line_by_id: HashMap<_, _> = lines.iter().map(|line| (line.id.as_str(), line)).collect();
    let mut prior_by_line = HashMap::new();
    let mut effective_by_line = HashMap::new();
    for line in &lines {
        let cancelled = cancelled_quantity(transaction, &line.id)?;
        let effective = line
            .quantity_milli
            .checked_sub(cancelled)
            .filter(|value| *value >= 0)
            .ok_or_else(|| {
                AppError::Validation("Le reliquat de commande est incohérent.".into())
            })?;
        let prior = allocated_quantity(transaction, &line.id)?;
        if prior > effective {
            return Err(AppError::Validation(
                "Les allocations existantes dépassent la commande.".into(),
            ));
        }
        prior_by_line.insert(line.id.clone(), prior);
        effective_by_line.insert(line.id.clone(), effective);
    }
    let mut running_by_line: HashMap<String, i64> = HashMap::new();
    let mut seen_pairs = HashSet::new();
    let mut prepared = Vec::with_capacity(allocations.len());
    for allocation in allocations {
        let line_id = required_text(&allocation.sales_order_line_id, "sales_order_line_id", 255)?;
        let line = line_by_id.get(line_id.as_str()).ok_or_else(|| {
            AppError::Validation("Une allocation n'appartient pas à cette commande.".into())
        })?;
        let quantity = validate_quantity(allocation.quantity_milli, "quantity_milli")?;
        let delivery_line_id = allocation
            .delivery_note_line_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::trim)
            .map(ToOwned::to_owned);
        let pair = (line_id.clone(), delivery_line_id.clone());
        if !seen_pairs.insert(pair) {
            return Err(AppError::Validation(
                "Une même source de livraison ne peut être allouée deux fois dans la requête."
                    .into(),
            ));
        }
        match line.fulfillment_mode.as_str() {
            "direct" => {
                if delivery_line_id.is_some() {
                    return Err(AppError::Validation(
                        "Une prestation directe ne doit pas référencer un bon de livraison.".into(),
                    ));
                }
            }
            "stocked_delivery" | "untracked_delivery" => {
                let delivery_line_id = delivery_line_id.as_deref().ok_or_else(|| {
                    AppError::Validation(
                        "Un article à livrer exige une ligne de BL émise avant facturation.".into(),
                    )
                })?;
                let delivered: Option<(String, i64)> = transaction
                    .query_row(
                        "SELECT delivery_line.sales_order_line_id,delivery_line.quantity_milli
                         FROM delivery_note_lines delivery_line
                         JOIN delivery_notes note ON note.id=delivery_line.delivery_note_id
                         WHERE delivery_line.id=? AND note.sales_order_id=? AND note.status='issued'",
                        params![delivery_line_id,sales_order_id],
                        |row| Ok((row.get(0)?,row.get(1)?)),
                    )
                    .optional()?;
                let Some((delivered_order_line_id, delivered_quantity)) = delivered else {
                    return Err(AppError::Validation(
                        "La ligne de livraison est absente, extournée ou non émise.".into(),
                    ));
                };
                if delivered_order_line_id != line.id {
                    return Err(AppError::Validation(
                        "La ligne de livraison ne correspond pas à la ligne de commande.".into(),
                    ));
                }
                let prior_delivery_allocated: i64 = transaction.query_row(
                    "SELECT COALESCE(SUM(quantity_milli),0) FROM sales_order_invoice_allocations WHERE delivery_note_line_id=?",
                    params![delivery_line_id],
                    |row| row.get(0),
                )?;
                if prior_delivery_allocated
                    .checked_add(quantity)
                    .is_none_or(|value| value > delivered_quantity)
                {
                    return Err(AppError::Validation(
                        "La quantité facturée dépasse la quantité de ce BL.".into(),
                    ));
                }
            }
            _ => {
                return Err(AppError::Validation(
                    "Le mode de livraison de la ligne est invalide.".into(),
                ))
            }
        }
        let prior = *prior_by_line.get(&line.id).unwrap_or(&0);
        let running = running_by_line.entry(line.id.clone()).or_default();
        let before_quantity = prior
            .checked_add(*running)
            .ok_or_else(|| AppError::Validation("La quantité allouée dépasse la limite.".into()))?;
        let after_quantity = before_quantity
            .checked_add(quantity)
            .ok_or_else(|| AppError::Validation("La quantité allouée dépasse la limite.".into()))?;
        if after_quantity > *effective_by_line.get(&line.id).unwrap_or(&0) {
            return Err(AppError::Validation(format!(
                "La quantité facturée dépasse le reliquat de la ligne {}.",
                line.id
            )));
        }
        let before_amounts = amounts_for_cumulative(
            before_quantity,
            line.unit_price_cents,
            line.discount_bp,
            line.vat_bp,
        )?;
        let after_amounts = amounts_for_cumulative(
            after_quantity,
            line.unit_price_cents,
            line.discount_bp,
            line.vat_bp,
        )?;
        let amounts = subtract_amounts(after_amounts, before_amounts)?;
        *running = running
            .checked_add(quantity)
            .ok_or_else(|| AppError::Validation("La quantité allouée dépasse la limite.".into()))?;
        prepared.push(PreparedAllocation {
            sales_order_line_id: line.id.clone(),
            delivery_note_line_id: delivery_line_id,
            catalog_item_id: line.catalog_item_id.clone(),
            description: line.description.clone(),
            unit: line.unit.clone(),
            unit_price_cents: line.unit_price_cents,
            discount_bp: line.discount_bp,
            vat_bp: line.vat_bp,
            quantity_milli: quantity,
            amounts,
        });
    }
    let is_final = lines.iter().all(|line| {
        let prior = *prior_by_line.get(&line.id).unwrap_or(&0);
        let current = *running_by_line.get(&line.id).unwrap_or(&0);
        let effective = *effective_by_line.get(&line.id).unwrap_or(&0);
        prior.checked_add(current) == Some(effective)
    });
    let subtotal_cents = sum_checked(
        prepared.iter().map(|allocation| allocation.amounts.gross),
        "Sous-total de facture",
    )?;
    let net_cents = sum_checked(
        prepared.iter().map(|allocation| allocation.amounts.net),
        "Total net de facture",
    )?;
    let vat_cents = sum_checked(
        prepared.iter().map(|allocation| allocation.amounts.vat),
        "TVA de facture",
    )?;
    let total_cents = sum_checked(
        prepared.iter().map(|allocation| allocation.amounts.total),
        "Total de facture",
    )?;
    let discount_cents = subtotal_cents
        .checked_sub(net_cents)
        .ok_or_else(|| AppError::Validation("La remise de facture est incohérente.".into()))?;
    if total_cents != net_cents.checked_add(vat_cents).unwrap_or(-1) {
        return Err(AppError::Validation(
            "Les totaux de facture sont incohérents.".into(),
        ));
    }
    // Discount is verified here so callers can safely derive it as subtotal-net.
    let _ = discount_cents;
    Ok(InvoicePreview {
        role: if is_final { "final" } else { "partial" },
        invoice_type: if is_final { "finale" } else { "situation" },
        allocations: prepared,
        subtotal_cents,
        discount_cents,
        vat_cents,
        total_cents,
    })
}

fn invoice_preview_json(preview: &InvoicePreview) -> Value {
    let allocations = preview
        .allocations
        .iter()
        .map(|allocation| {
            json!({
                "sales_order_line_id":allocation.sales_order_line_id,
                "delivery_note_line_id":allocation.delivery_note_line_id,
                "catalog_item_id":allocation.catalog_item_id,
                "description":allocation.description,
                "unit":allocation.unit,
                "quantity_milli":allocation.quantity_milli,
                "unit_price_cents":allocation.unit_price_cents,
                "discount_bp":allocation.discount_bp,
                "vat_bp":allocation.vat_bp,
                "gross_cents":allocation.amounts.gross,
                "net_cents":allocation.amounts.net,
                "vat_cents":allocation.amounts.vat,
                "total_cents":allocation.amounts.total,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "role":preview.role,
        "invoice_type":preview.invoice_type,
        "subtotal_cents":preview.subtotal_cents,
        "discount_cents":preview.discount_cents,
        "vat_cents":preview.vat_cents,
        "total_cents":preview.total_cents,
        "allocations":allocations,
    })
}

impl LocalStore {
    pub fn preview_sales_order_invoice(
        &self,
        input: PreviewSalesOrderInvoiceInput,
    ) -> AppResult<Value> {
        let sales_order_id = required_text(&input.sales_order_id, "sales_order_id", 255)?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.unchecked_transaction()?;
        let preview = prepare_invoice_preview(&transaction, &sales_order_id, &input.allocations)?;
        let result = invoice_preview_json(&preview);
        transaction.commit()?;
        Ok(result)
    }

    pub fn create_sales_order_invoice(
        &self,
        input: CreateSalesOrderInvoiceInput,
    ) -> AppResult<Value> {
        let service_date_from = valid_date(&input.service_date_from, "service_date_from")?;
        let service_date_to = valid_date(&input.service_date_to, "service_date_to")?;
        if service_date_to < service_date_from {
            return Err(AppError::Validation(
                "service_date_to précède service_date_from.".into(),
            ));
        }
        let issue_date = optional_date(input.issue_date.clone(), "issue_date")?;
        let due_date = optional_date(input.due_date.clone(), "due_date")?;
        if let (Some(issue), Some(due)) = (issue_date.as_deref(), due_date.as_deref()) {
            if due < issue {
                return Err(AppError::Validation("due_date précède issue_date.".into()));
            }
        }
        let sales_order_id = required_text(&input.sales_order_id, "sales_order_id", 255)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "create_sales_order_invoice",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let preview = prepare_invoice_preview(&transaction, &sales_order_id, &input.allocations)?;
        let order = query_record_tx(&transaction, "sales_orders", &sales_order_id)?;
        let client_id = order["client_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La commande n'a pas de client.".into()))?;
        let title = format!(
            "Facture {} — {}",
            if preview.role == "final" {
                "finale"
            } else {
                "de situation"
            },
            order["number"].as_str().unwrap_or("commande")
        );
        let invoice_id = Uuid::new_v4().to_string();
        let batch_id = Uuid::new_v4().to_string();
        let now = now_iso();
        transaction.execute(
            "INSERT INTO invoices(id,client_id,project_id,title,type,status,issue_date,due_date,service_date_from,service_date_to,currency,subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,created_at,updated_at) VALUES(?,?,?,? ,?,'brouillon',?,?,?,?, 'CHF',?,?,?,?,?,?,?,?)",
            params![invoice_id,client_id,order["project_id"].as_str(),title,preview.invoice_type,issue_date,due_date,service_date_from,service_date_to,preview.subtotal_cents,preview.discount_cents,preview.vat_cents,preview.total_cents,order["notes"].as_str(),order["terms"].as_str(),now,now],
        )?;
        let mut allocation_rows = Vec::with_capacity(preview.allocations.len());
        for (position, allocation) in preview.allocations.iter().enumerate() {
            let invoice_item_id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![invoice_item_id,invoice_id,allocation.catalog_item_id,position as i64,allocation.description,allocation.quantity_milli as f64/1000.0,allocation.unit,allocation.unit_price_cents,allocation.discount_bp,allocation.vat_bp,allocation.amounts.net,allocation.amounts.vat,allocation.amounts.total,now,now],
            )?;
            allocation_rows.push((allocation, invoice_item_id));
        }
        transaction.execute(
            "INSERT INTO sales_order_invoice_batches(id,sales_order_id,invoice_id,role,created_at) VALUES(?,?,?,?,?)",
            params![batch_id,sales_order_id,invoice_id,preview.role,now],
        )?;
        for (allocation, invoice_item_id) in allocation_rows {
            transaction.execute(
                "INSERT INTO sales_order_invoice_allocations(id,batch_id,sales_order_line_id,delivery_note_line_id,invoice_item_id,quantity_milli,gross_cents,net_cents,vat_cents,total_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),batch_id,allocation.sales_order_line_id,allocation.delivery_note_line_id,invoice_item_id,allocation.quantity_milli,allocation.amounts.gross,allocation.amounts.net,allocation.amounts.vat,allocation.amounts.total,now],
            )?;
        }
        let snapshot_json = serde_json::to_string(&json!({
            "sales_order":order,
            "invoice_preview":invoice_preview_json(&preview)
        }))?;
        transaction.execute(
            "UPDATE invoices SET snapshot_json=? WHERE id=?",
            params![snapshot_json, invoice_id],
        )?;
        finish_operation(
            &transaction,
            &request_id,
            "create_sales_order_invoice",
            &hash,
            "invoice",
            &invoice_id,
        )?;
        let mut result = load_invoice_result(&transaction, &invoice_id, false)?;
        if let Some(object) = result.as_object_mut() {
            object.insert("role".into(), json!(preview.role));
            object.insert("sales_order_id".into(), json!(sales_order_id));
        }
        append_audit(
            &transaction,
            "create_invoice",
            "sales_order",
            &sales_order_id,
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn cancel_sales_order_invoice_draft(
        &self,
        input: CancelSalesOrderInvoiceDraftInput,
    ) -> AppResult<Value> {
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let OperationState {
            request_id,
            payload_sha256: hash,
            replay,
        } = begin_operation(
            &transaction,
            &input.request_id,
            "cancel_sales_order_invoice_draft",
            &input,
        )?;
        if let Some(replay) = replay {
            let result = replay_result(&transaction, &replay.entity_type, &replay.entity_id)?;
            transaction.commit()?;
            return Ok(result);
        }
        let invoice_id = required_text(&input.invoice_id, "invoice_id", 255)?;
        let linked: Option<(String, String, String, Option<String>)> = transaction
            .query_row(
                "SELECT batch.sales_order_id,batch.role,invoice.status,invoice.number FROM sales_order_invoice_batches batch JOIN invoices invoice ON invoice.id=batch.invoice_id WHERE invoice.id=?",
                params![invoice_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            )
            .optional()?;
        let Some((sales_order_id, role, status, number)) = linked else {
            return Err(AppError::Validation(
                "Cette facture n'appartient pas à une commande client.".into(),
            ));
        };
        if status != "brouillon" || number.as_deref().is_some_and(|value| !value.is_empty()) {
            return Err(AppError::Validation(
                "Seule une facture de commande encore brouillon peut être annulée.".into(),
            ));
        }
        transaction.execute("DELETE FROM invoices WHERE id=?", params![invoice_id])?;
        let _ = role;
        finish_operation(
            &transaction,
            &request_id,
            "cancel_sales_order_invoice_draft",
            &hash,
            "sales_order",
            &sales_order_id,
        )?;
        let result = load_order_result(&transaction, &sales_order_id, false)?;
        append_audit(
            &transaction,
            "cancel_invoice_draft",
            "sales_order",
            &sales_order_id,
            &json!({"invoice_id":invoice_id,"reason":reason,"result":result}),
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
sales_fulfillment_tests!();

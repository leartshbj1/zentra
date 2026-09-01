use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    accounting::{ensure_accounting_date_open, post_entry, EntryLine},
    audit::append_audit,
    database::{assign_document_number, now_iso, query_all, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{
        ApplySupplierCreditInput, CancelSupplierOrderRemainderInput, ConfirmSupplierOrderInput,
        IssueSupplierReceiptInput, ReclassifySupplierInvoiceExpenseInput,
        ReverseSupplierCreditAllocationInput, ReverseSupplierReceiptInput,
        SaveSupplierCreditNoteDraftInput, SaveSupplierInvoiceMatchInput,
        SaveSupplierOrderDraftInput, SaveSupplierReceiptDraftInput, SupplierInvoiceLineInput,
        ValidateSupplierCreditNoteInput,
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
struct PreparedOrderLine {
    id: String,
    catalog_item_id: Option<String>,
    position: i64,
    description: String,
    quantity_milli: i64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    category: String,
    expense_account_id: Option<String>,
    project_id: Option<String>,
    fulfillment_mode: String,
    amounts: Amounts,
}

#[derive(Debug, Clone)]
struct PreparedCreditLine {
    id: String,
    description: String,
    quantity_milli: i64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    category: String,
    expense_account_id: Option<String>,
    project_id: Option<String>,
    amounts: Amounts,
}

#[derive(Debug)]
struct OperationState {
    request_id: String,
    payload_sha256: String,
    payload_json: String,
    replay: Option<Value>,
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

fn optional_id(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
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

fn rounded_div(numerator: i128, denominator: i128, field: &str) -> AppResult<i64> {
    if numerator < 0 || denominator <= 0 {
        return Err(AppError::Validation(format!(
            "Le calcul de {field} est invalide."
        )));
    }
    numerator
        .checked_add(denominator / 2)
        .and_then(|value| value.checked_div(denominator))
        .and_then(|value| i64::try_from(value).ok())
        .filter(|value| *value <= MAX_MONEY_CENTS)
        .ok_or_else(|| AppError::Validation(format!("{field} dépasse la limite autorisée.")))
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
        .ok_or_else(|| AppError::Validation("La remise est incohérente.".into()))?;
    let vat = rounded_div(i128::from(net) * i128::from(vat_bp), 10_000, "TVA")?;
    let total = net
        .checked_add(vat)
        .filter(|value| *value <= MAX_MONEY_CENTS)
        .ok_or_else(|| AppError::Validation("Le total dépasse la limite autorisée.".into()))?;
    Ok(Amounts {
        gross,
        net,
        vat,
        total,
    })
}

fn checked_sum(mut values: impl Iterator<Item = i64>, field: &str) -> AppResult<i64> {
    values.try_fold(0_i64, |sum, value| {
        sum.checked_add(value)
            .filter(|value| *value <= MAX_MONEY_CENTS)
            .ok_or_else(|| AppError::Validation(format!("{field} dépasse la limite autorisée.")))
    })
}

fn payload_sha256<T: Serialize>(payload: &T) -> AppResult<(String, String)> {
    let bytes = serde_json::to_vec(payload)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = format!("{:x}", hasher.finalize());
    let compact_payload = serde_json::to_string(&json!({
        "schema":"elyko.supplier_operation_payload.v1",
        "sha256":hash
    }))?;
    Ok((hash, compact_payload))
}

fn begin_operation<T: Serialize>(
    tx: &Transaction<'_>,
    request_id: &str,
    operation: &str,
    payload: &T,
) -> AppResult<OperationState> {
    let request_id = normalized_uuid(request_id, "request_id")?;
    let (hash, payload_json) = payload_sha256(payload)?;
    let existing: Option<(String, String, String, String, String)> = tx
        .query_row(
            "SELECT operation,payload_sha256,result_entity_type,result_entity_id,response_json FROM supplier_operation_requests WHERE request_id=?",
            params![request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    if let Some((existing_operation, existing_hash, entity_type, entity_id, response_json)) =
        existing
    {
        if existing_operation != operation || existing_hash != hash {
            return Err(AppError::Validation(
                "Ce request_id a déjà été utilisé pour une autre opération fournisseur.".into(),
            ));
        }
        let stored_response: Value = serde_json::from_str(&response_json)?;
        let response = if stored_response["schema"] == "elyko.supplier_operation_replay.v1" {
            replay_operation(
                tx,
                &existing_operation,
                &entity_type,
                &entity_id,
                &stored_response,
            )?
        } else {
            let mut legacy_response = stored_response;
            if let Some(object) = legacy_response.as_object_mut() {
                object.insert("idempotent".into(), Value::Bool(true));
            }
            legacy_response
        };
        return Ok(OperationState {
            request_id,
            payload_sha256: hash,
            payload_json,
            replay: Some(response),
        });
    }
    Ok(OperationState {
        request_id,
        payload_sha256: hash,
        payload_json,
        replay: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn finish_operation(
    tx: &Transaction<'_>,
    state: &OperationState,
    operation: &str,
    entity_type: &str,
    entity_id: &str,
    response: &Value,
) -> AppResult<()> {
    let compact_response = compact_operation_response(operation, response)?;
    tx.execute(
        "INSERT INTO supplier_operation_requests(request_id,operation,payload_sha256,payload_json,result_entity_type,result_entity_id,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        params![state.request_id,operation,state.payload_sha256,state.payload_json,entity_type,entity_id,compact_response,now_iso()],
    )?;
    Ok(())
}

fn compact_operation_response(operation: &str, response: &Value) -> AppResult<String> {
    let context = if operation == "save_supplier_invoice_match" {
        json!({
            "supplier_order_id":response.pointer("/order/order/id").and_then(Value::as_str)
        })
    } else {
        json!({})
    };
    serde_json::to_string(&json!({
        "schema":"elyko.supplier_operation_replay.v1",
        "context":context
    }))
    .map_err(Into::into)
}

fn require_supplier(
    tx: &Transaction<'_>,
    supplier_id: &str,
    allow_archived: bool,
) -> AppResult<String> {
    let row: Option<(String, bool)> = tx
        .query_row(
            "SELECT name,archived_at IS NOT NULL FROM suppliers WHERE id=?",
            params![supplier_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (name, archived) =
        row.ok_or_else(|| AppError::NotFound(format!("suppliers/{supplier_id}")))?;
    if archived && !allow_archived {
        return Err(AppError::Validation(
            "Ce fournisseur est archivé. Réactivez-le avant de créer un document.".into(),
        ));
    }
    Ok(name)
}

fn require_project(tx: &Transaction<'_>, project_id: Option<&str>) -> AppResult<()> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        params![project_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound(format!("projects/{project_id}")));
    }
    Ok(())
}

fn require_account(tx: &Transaction<'_>, account_id: &str, account_type: &str) -> AppResult<()> {
    let valid: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=1 AND account_type=?)",
        params![account_id, account_type],
        |row| row.get(0),
    )?;
    if !valid {
        return Err(AppError::Validation(format!(
            "Le compte {account_id} doit être actif et de type {account_type}."
        )));
    }
    Ok(())
}

fn validate_vat_rate(tx: &Transaction<'_>, vat_bp: i64) -> AppResult<()> {
    let (registered, default_bp, extra): (bool, i64, String) = tx.query_row(
        "SELECT vat_registered,default_vat_bp,extra_settings_json FROM settings WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if !registered && vat_bp != 0 {
        return Err(AppError::Validation(
            "L’entreprise n’est pas assujettie à la TVA; utilisez un taux nul.".into(),
        ));
    }
    let mut allowed = HashSet::from([0_i64, default_bp]);
    if let Ok(value) = serde_json::from_str::<Value>(&extra) {
        if let Some(rates) = value
            .pointer("/billing/vatRatesBp")
            .and_then(Value::as_array)
        {
            allowed.extend(rates.iter().filter_map(Value::as_i64));
        }
    }
    if registered && vat_bp != 0 && !allowed.contains(&vat_bp) {
        return Err(AppError::Validation(format!(
            "Le taux TVA {:.2} % n’est pas configuré.",
            vat_bp as f64 / 100.0
        )));
    }
    Ok(())
}

fn prepare_order_line(
    tx: &Transaction<'_>,
    input: crate::models::SupplierOrderLineInput,
) -> AppResult<PreparedOrderLine> {
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let id = normalized_uuid(&id, "line.id")?;
    let description = required_text(&input.description, "description", 10_000)?;
    let unit = required_text(&input.unit, "unit", 100)?;
    let category = required_text(&input.category, "category", 100)?;
    if !(0..=1_000_000).contains(&input.position) {
        return Err(AppError::Validation("position est hors limite.".into()));
    }
    let fulfillment_mode = required_text(&input.fulfillment_mode, "fulfillment_mode", 40)?;
    if !matches!(
        fulfillment_mode.as_str(),
        "stocked_receipt" | "untracked_receipt" | "direct"
    ) {
        return Err(AppError::Validation(
            "fulfillment_mode est invalide.".into(),
        ));
    }
    validate_vat_rate(tx, input.vat_bp)?;
    let catalog_item_id = optional_id(input.catalog_item_id);
    if let Some(catalog_id) = catalog_item_id.as_deref() {
        let row: Option<(String, bool, bool)> = tx
            .query_row(
                "SELECT kind,track_stock,archived_at IS NOT NULL FROM catalog_items WHERE id=?",
                params![catalog_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (kind, track_stock, archived) =
            row.ok_or_else(|| AppError::NotFound(format!("catalog_items/{catalog_id}")))?;
        if archived {
            return Err(AppError::Validation(
                "L’article sélectionné est archivé.".into(),
            ));
        }
        if fulfillment_mode == "stocked_receipt" && (kind != "product" || !track_stock) {
            return Err(AppError::Validation(
                "Une réception stockée exige un produit avec suivi de stock actif.".into(),
            ));
        }
    } else if fulfillment_mode == "stocked_receipt" {
        return Err(AppError::Validation(
            "Une réception stockée exige un article de catalogue.".into(),
        ));
    }
    let project_id = optional_id(input.project_id);
    require_project(tx, project_id.as_deref())?;
    let expense_account_id = optional_id(input.expense_account_id);
    if let Some(account_id) = expense_account_id.as_deref() {
        require_account(tx, account_id, "expense")?;
    }
    let amounts = calculate_amounts(
        input.quantity_milli,
        input.unit_price_cents,
        input.discount_bp,
        input.vat_bp,
    )?;
    Ok(PreparedOrderLine {
        id,
        catalog_item_id,
        position: input.position,
        description,
        quantity_milli: input.quantity_milli,
        unit,
        unit_price_cents: input.unit_price_cents,
        discount_bp: input.discount_bp,
        vat_bp: input.vat_bp,
        category,
        expense_account_id,
        project_id,
        fulfillment_mode,
        amounts,
    })
}

fn prepare_credit_line(
    tx: &Transaction<'_>,
    input: SupplierInvoiceLineInput,
) -> AppResult<PreparedCreditLine> {
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let id = normalized_uuid(&id, "item.id")?;
    let description = required_text(&input.description, "description", 10_000)?;
    let unit = optional_text(input.unit, "unit", 100)?.unwrap_or_else(|| "unité".into());
    let category = required_text(&input.category, "category", 100)?;
    validate_vat_rate(tx, input.vat_bp)?;
    let project_id = optional_id(input.project_id);
    require_project(tx, project_id.as_deref())?;
    let expense_account_id = optional_id(input.expense_account_id);
    if let Some(account_id) = expense_account_id.as_deref() {
        require_account(tx, account_id, "expense")?;
    }
    let amounts = calculate_amounts(
        input.quantity_milli,
        input.unit_price_cents,
        input.discount_bp,
        input.vat_bp,
    )?;
    Ok(PreparedCreditLine {
        id,
        description,
        quantity_milli: input.quantity_milli,
        unit,
        unit_price_cents: input.unit_price_cents,
        discount_bp: input.discount_bp,
        vat_bp: input.vat_bp,
        category,
        expense_account_id,
        project_id,
        amounts,
    })
}

pub(crate) fn supplier_order_bundle(
    tx: &Transaction<'_>,
    id: &str,
    idempotent: bool,
) -> AppResult<Value> {
    let order = query_record_tx(tx, "supplier_orders", id)?;
    let lines = query_all(
        tx,
        "SELECT line.*,
                COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0) AS cancelled_quantity_milli,
                COALESCE((SELECT SUM(receipt_line.quantity_milli) FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.supplier_order_line_id=line.id AND receipt.status='issued'),0) AS received_quantity_milli,
                COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row WHERE match_row.supplier_order_line_id=line.id),0) AS matched_quantity_milli,
                CASE WHEN line.fulfillment_mode='direct' THEN 0 ELSE MAX(0,line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0)-COALESCE((SELECT SUM(receipt_line.quantity_milli) FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.supplier_order_line_id=line.id AND receipt.status='issued'),0)) END AS remaining_receivable_milli,
                MAX(0,line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0)-COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row WHERE match_row.supplier_order_line_id=line.id),0)) AS remaining_matchable_milli
         FROM supplier_order_lines line WHERE line.supplier_order_id=? ORDER BY line.position,line.created_at",
        params![id],
    )?;
    Ok(json!({"order":order,"lines":lines,"idempotent":idempotent}))
}

fn supplier_receipt_bundle(tx: &Transaction<'_>, id: &str, idempotent: bool) -> AppResult<Value> {
    let receipt = query_record_tx(tx, "supplier_receipts", id)?;
    let lines = query_all(
        tx,
        "SELECT * FROM supplier_receipt_lines WHERE supplier_receipt_id=? ORDER BY position,created_at",
        params![id],
    )?;
    Ok(json!({"receipt":receipt,"lines":lines,"idempotent":idempotent}))
}

fn supplier_credit_bundle(tx: &Transaction<'_>, id: &str, idempotent: bool) -> AppResult<Value> {
    let credit_note = query_record_tx(tx, "supplier_credit_notes", id)?;
    let items = query_all(
        tx,
        "SELECT * FROM supplier_credit_note_items WHERE supplier_credit_note_id=? ORDER BY position,created_at",
        params![id],
    )?;
    let allocations = query_all(
        tx,
        "SELECT * FROM supplier_credit_allocations WHERE supplier_credit_note_id=? ORDER BY created_at,id",
        params![id],
    )?;
    Ok(
        json!({"credit_note":credit_note,"items":items,"allocations":allocations,"idempotent":idempotent}),
    )
}

fn replay_operation(
    tx: &Transaction<'_>,
    operation: &str,
    entity_type: &str,
    entity_id: &str,
    stored_response: &Value,
) -> AppResult<Value> {
    match (operation, entity_type) {
        ("confirm_supplier_order" | "cancel_supplier_order_remainder", "supplier_order") => {
            supplier_order_bundle(tx, entity_id, true)
        }
        ("issue_supplier_receipt" | "reverse_supplier_receipt", "supplier_receipt") => {
            supplier_receipt_bundle(tx, entity_id, true)
        }
        ("save_supplier_invoice_match", "supplier_invoice") => {
            let order_id = stored_response
                .pointer("/context/supplier_order_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Validation(
                        "Le contexte compact du rapprochement idempotent est incomplet.".into(),
                    )
                })?;
            Ok(json!({
                "invoice":query_record_tx(tx,"supplier_invoices",entity_id)?,
                "items":query_all(tx,"SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id=? ORDER BY position,rowid",params![entity_id])?,
                "matches":query_all(tx,"SELECT * FROM supplier_invoice_matches WHERE supplier_invoice_id=? ORDER BY supplier_invoice_item_id,created_at,id",params![entity_id])?,
                "order":supplier_order_bundle(tx,order_id,false)?,
                "idempotent":true
            }))
        }
        ("validate_supplier_credit_note", "supplier_credit_note") => {
            supplier_credit_bundle(tx, entity_id, true)
        }
        (
            "apply_supplier_credit" | "reverse_supplier_credit_allocation",
            "supplier_credit_allocation",
        ) => {
            let allocation = query_record_tx(tx, "supplier_credit_allocations", entity_id)?;
            let credit_id = allocation["supplier_credit_note_id"]
                .as_str()
                .ok_or_else(|| AppError::Validation("L’imputation n’a plus d’avoir lié.".into()))?
                .to_owned();
            let invoice_id = allocation["supplier_invoice_id"]
                .as_str()
                .ok_or_else(|| {
                    AppError::Validation("L’imputation n’a plus de facture liée.".into())
                })?
                .to_owned();
            Ok(json!({
                "allocation":allocation,
                "credit":supplier_credit_bundle(tx,&credit_id,false)?,
                "invoice":query_record_tx(tx,"supplier_invoices",&invoice_id)?,
                "idempotent":true
            }))
        }
        ("reclassify_supplier_invoice_expense", "supplier_expense_reclassification") => {
            let reclassification =
                query_record_tx(tx, "supplier_expense_reclassifications", entity_id)?;
            let journal_id = reclassification["journal_entry_id"]
                .as_str()
                .ok_or_else(|| {
                    AppError::Validation("La reclassification n’a plus d’écriture liée.".into())
                })?
                .to_owned();
            let journal = json!({
                "entry":query_record_tx(tx,"journal_entries",&journal_id)?,
                "lines":query_all(tx,"SELECT line.*,account.code AS account_code,account.name AS account_name FROM journal_lines line JOIN accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? ORDER BY line.rowid",params![journal_id])?,
                "id":journal_id
            });
            Ok(json!({
                "reclassification":reclassification,
                "lines":query_all(tx,"SELECT * FROM supplier_expense_reclassification_lines WHERE reclassification_id=? ORDER BY created_at,id",params![entity_id])?,
                "journal":journal,
                "idempotent":true
            }))
        }
        _ => Err(AppError::Validation(format!(
            "L’opération fournisseur idempotente {operation} ne peut pas être reconstruite."
        ))),
    }
}

pub(crate) fn close_supplier_order_if_complete(
    tx: &Transaction<'_>,
    order_id: &str,
) -> AppResult<()> {
    let remaining: i64 = tx.query_row(
        "SELECT COUNT(*) FROM supplier_order_lines line WHERE line.supplier_order_id=? AND
          COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row JOIN supplier_invoices invoice ON invoice.id=match_row.supplier_invoice_id WHERE match_row.supplier_order_line_id=line.id AND invoice.status='validated'),0)
          < line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0)",
        params![order_id],
        |row| row.get(0),
    )?;
    if remaining == 0 {
        let now = now_iso();
        tx.execute(
            "UPDATE supplier_orders SET status='closed',closed_at=?,updated_at=? WHERE id=? AND status='confirmed'",
            params![now, now, order_id],
        )?;
    }
    Ok(())
}

impl LocalStore {
    pub fn save_supplier_order_draft(
        &self,
        input: SaveSupplierOrderDraftInput,
    ) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Une commande fournisseur doit contenir entre 1 et {MAX_LINES} lignes."
            )));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let supplier_id = required_text(&input.order.supplier_id, "supplier_id", 255)?;
        require_supplier(&tx, &supplier_id, false)?;
        let project_id = optional_id(input.order.project_id);
        require_project(&tx, project_id.as_deref())?;
        let title = required_text(&input.order.title, "title", 300)?;
        let order_date = valid_date(&input.order.order_date, "order_date")?;
        if input.order.currency.trim().to_uppercase() != "CHF" {
            return Err(AppError::Validation("La devise doit être CHF.".into()));
        }
        let notes = optional_text(input.order.notes, "notes", 20_000)?;
        let terms = optional_text(input.order.terms, "terms", 20_000)?;
        let mut prepared = Vec::with_capacity(input.lines.len());
        let mut ids = HashSet::new();
        for line in input.lines {
            let line = prepare_order_line(&tx, line)?;
            if !ids.insert(line.id.clone()) {
                return Err(AppError::Validation(
                    "Deux lignes utilisent le même identifiant.".into(),
                ));
            }
            prepared.push(line);
        }
        let subtotal = checked_sum(prepared.iter().map(|line| line.amounts.gross), "Sous-total")?;
        let net = checked_sum(prepared.iter().map(|line| line.amounts.net), "Total net")?;
        let discount = subtotal
            .checked_sub(net)
            .ok_or_else(|| AppError::Validation("Remise totale invalide.".into()))?;
        let vat = checked_sum(prepared.iter().map(|line| line.amounts.vat), "TVA")?;
        let total = checked_sum(prepared.iter().map(|line| line.amounts.total), "Total")?;
        let id = input
            .order
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let id = normalized_uuid(&id, "order.id")?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT status FROM supplier_orders WHERE id=?",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let now = now_iso();
        if let Some(status) = existing {
            if status != "draft" {
                return Err(AppError::Validation(
                    "Seule une commande brouillon est modifiable.".into(),
                ));
            }
            tx.execute(
                "UPDATE supplier_orders SET supplier_id=?,project_id=?,title=?,order_date=?,currency='CHF',subtotal_cents=?,discount_cents=?,vat_cents=?,total_cents=?,notes=?,terms=?,updated_at=? WHERE id=?",
                params![supplier_id,project_id,title,order_date,subtotal,discount,vat,total,notes,terms,now,id],
            )?;
            tx.execute(
                "DELETE FROM supplier_order_lines WHERE supplier_order_id=?",
                params![id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO supplier_orders(id,supplier_id,project_id,title,status,order_date,currency,subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,created_at,updated_at) VALUES(?,?,?,?,'draft',?,'CHF',?,?,?,?,?,?,?,?)",
                params![id,supplier_id,project_id,title,order_date,subtotal,discount,vat,total,notes,terms,now,now],
            )?;
        }
        for line in prepared {
            tx.execute(
                "INSERT INTO supplier_order_lines(id,supplier_order_id,catalog_item_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,category,expense_account_id,project_id,fulfillment_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![line.id,id,line.catalog_item_id,line.position,line.description,line.quantity_milli,line.unit,line.unit_price_cents,line.discount_bp,line.vat_bp,line.amounts.net,line.amounts.vat,line.amounts.total,line.category,line.expense_account_id,line.project_id,line.fulfillment_mode,now,now],
            )?;
        }
        let result = supplier_order_bundle(&tx, &id, false)?;
        append_audit(&tx, "save_draft", "supplier_order", &id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn confirm_supplier_order(&self, input: ConfirmSupplierOrderInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(&tx, &input.request_id, "confirm_supplier_order", &input)?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let id = required_text(&input.supplier_order_id, "supplier_order_id", 255)?;
        let order = query_record_tx(&tx, "supplier_orders", &id)?;
        if order["status"] != "draft" {
            return Err(AppError::Validation(
                "Seule une commande brouillon peut être confirmée.".into(),
            ));
        }
        let lines = query_all(&tx, "SELECT * FROM supplier_order_lines WHERE supplier_order_id=? ORDER BY position,created_at", params![id])?;
        if lines.is_empty() {
            return Err(AppError::Validation(
                "La commande ne contient aucune ligne.".into(),
            ));
        }
        require_supplier(&tx, order["supplier_id"].as_str().unwrap_or_default(), true)?;
        let date = order["order_date"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La date de commande est absente.".into()))?;
        let number = assign_document_number(&tx, "supplier_orders", &id, "supplier_order", date)?;
        let snapshot = serde_json::to_string(&json!({
            "schema":"elyko.supplier_order_snapshot.v1",
            "captured_at":now_iso(),
            "order":order,
            "lines":lines,
            "supplier":query_all(&tx,"SELECT * FROM suppliers WHERE id=?",params![order["supplier_id"].as_str().unwrap_or_default()])?.into_iter().next()
        }))?;
        let now = now_iso();
        tx.execute(
            "UPDATE supplier_orders SET number=?,status='confirmed',snapshot_json=?,confirmed_at=?,updated_at=? WHERE id=? AND status='draft'",
            params![number,snapshot,now,now,id],
        )?;
        let result = supplier_order_bundle(&tx, &id, false)?;
        finish_operation(
            &tx,
            &operation,
            "confirm_supplier_order",
            "supplier_order",
            &id,
            &result,
        )?;
        append_audit(&tx, "confirm", "supplier_order", &id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn cancel_supplier_order_remainder(
        &self,
        input: CancelSupplierOrderRemainderInput,
    ) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(
                "Sélectionnez au moins un reliquat à annuler.".into(),
            ));
        }
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(
            &tx,
            &input.request_id,
            "cancel_supplier_order_remainder",
            &input,
        )?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let order_id = required_text(&input.supplier_order_id, "supplier_order_id", 255)?;
        let status: String = tx
            .query_row(
                "SELECT status FROM supplier_orders WHERE id=?",
                params![order_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("supplier_orders/{order_id}")))?;
        if status != "confirmed" {
            return Err(AppError::Validation(
                "Le reliquat exige une commande confirmée et ouverte.".into(),
            ));
        }
        let mut seen = HashSet::new();
        let now = now_iso();
        for line in input.lines {
            let line_id =
                required_text(&line.supplier_order_line_id, "supplier_order_line_id", 255)?;
            if !seen.insert(line_id.clone()) {
                return Err(AppError::Validation(
                    "Une ligne ne peut être annulée qu’une fois par opération.".into(),
                ));
            }
            let quantity = validate_quantity(line.quantity_milli, "quantity_milli")?;
            tx.execute(
                "INSERT INTO supplier_order_cancellation_lines(id,request_id,supplier_order_id,supplier_order_line_id,quantity_milli,reason,created_at) VALUES(?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),operation.request_id,order_id,line_id,quantity,reason,now],
            )?;
        }
        let (effective, received, matched): (i64, i64, i64) = tx.query_row(
            "SELECT
              COALESCE(SUM(line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0)),0),
              COALESCE(SUM((SELECT COALESCE(SUM(receipt_line.quantity_milli),0) FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.supplier_order_line_id=line.id AND receipt.status='issued')),0),
              COALESCE(SUM((SELECT COALESCE(SUM(match_row.quantity_milli),0) FROM supplier_invoice_matches match_row WHERE match_row.supplier_order_line_id=line.id)),0)
             FROM supplier_order_lines line WHERE line.supplier_order_id=?",
            params![order_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        )?;
        if effective == 0 && received == 0 && matched == 0 {
            tx.execute(
                "UPDATE supplier_orders SET status='cancelled',cancelled_at=?,cancellation_reason=?,updated_at=? WHERE id=? AND status='confirmed'",
                params![now,reason,now,order_id],
            )?;
        } else {
            close_supplier_order_if_complete(&tx, &order_id)?;
        }
        let result = supplier_order_bundle(&tx, &order_id, false)?;
        finish_operation(
            &tx,
            &operation,
            "cancel_supplier_order_remainder",
            "supplier_order",
            &order_id,
            &result,
        )?;
        append_audit(
            &tx,
            "cancel_remainder",
            "supplier_order",
            &order_id,
            &json!({"reason":reason,"result":result}),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn save_supplier_receipt_draft(
        &self,
        input: SaveSupplierReceiptDraftInput,
    ) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Une réception doit contenir entre 1 et {MAX_LINES} lignes."
            )));
        }
        let order_id = required_text(&input.receipt.supplier_order_id, "supplier_order_id", 255)?;
        let receipt_date = valid_date(&input.receipt.receipt_date, "receipt_date")?;
        let reference = optional_text(input.receipt.reference, "reference", 200)?;
        let notes = optional_text(input.receipt.notes, "notes", 20_000)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let order_context: (String, String) = tx
            .query_row(
                "SELECT status,order_date FROM supplier_orders WHERE id=?",
                params![order_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("supplier_orders/{order_id}")))?;
        if order_context.0 != "confirmed" {
            return Err(AppError::Validation(
                "Une réception exige une commande fournisseur confirmée et ouverte.".into(),
            ));
        }
        if receipt_date < order_context.1 {
            return Err(AppError::Validation(
                "La date de réception ne peut pas précéder la date de commande.".into(),
            ));
        }
        let receipt_id = input
            .receipt
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let receipt_id = normalized_uuid(&receipt_id, "receipt.id")?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT status,supplier_order_id FROM supplier_receipts WHERE id=?",
                params![receipt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let now = now_iso();
        if let Some((status, existing_order)) = existing {
            if status != "draft" || existing_order != order_id {
                return Err(AppError::Validation(
                    "Cette réception n’est plus modifiable ou appartient à une autre commande."
                        .into(),
                ));
            }
            tx.execute(
                "UPDATE supplier_receipts SET receipt_date=?,reference=?,notes=?,updated_at=? WHERE id=?",
                params![receipt_date,reference,notes,now,receipt_id],
            )?;
            tx.execute(
                "DELETE FROM supplier_receipt_lines WHERE supplier_receipt_id=?",
                params![receipt_id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO supplier_receipts(id,supplier_order_id,status,receipt_date,reference,notes,created_at,updated_at) VALUES(?,?,'draft',?,?,?,?,?)",
                params![receipt_id,order_id,receipt_date,reference,notes,now,now],
            )?;
        }
        let mut seen = HashSet::new();
        for line in input.lines {
            let line_id =
                required_text(&line.supplier_order_line_id, "supplier_order_line_id", 255)?;
            if !seen.insert(line_id.clone()) {
                return Err(AppError::Validation(
                    "Une ligne de commande ne peut figurer qu’une fois dans une réception.".into(),
                ));
            }
            let quantity = validate_quantity(line.quantity_milli, "quantity_milli")?;
            let context: Option<(i64, String, String, String)> = tx
                .query_row(
                    "SELECT quantity_milli,fulfillment_mode,description,unit FROM supplier_order_lines WHERE id=? AND supplier_order_id=?",
                    params![line_id,order_id],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
                )
                .optional()?;
            let (ordered, mode, description, unit) = context.ok_or_else(|| {
                AppError::Validation(
                    "Une ligne de réception n’appartient pas à cette commande.".into(),
                )
            })?;
            if mode == "direct" {
                return Err(AppError::Validation(
                    "Une ligne directe ne passe pas par une réception.".into(),
                ));
            }
            let (cancelled, received): (i64, i64) = tx.query_row(
                "SELECT
                   COALESCE((SELECT SUM(quantity_milli) FROM supplier_order_cancellation_lines WHERE supplier_order_line_id=?),0),
                   COALESCE((SELECT SUM(receipt_line.quantity_milli) FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.supplier_order_line_id=? AND receipt.status='issued'),0)",
                params![line_id,line_id],
                |row| Ok((row.get(0)?,row.get(1)?)),
            )?;
            let remaining = ordered
                .checked_sub(cancelled)
                .and_then(|value| value.checked_sub(received))
                .filter(|value| *value >= 0)
                .ok_or_else(|| {
                    AppError::Validation("Le suivi de réception est incohérent.".into())
                })?;
            if quantity > remaining {
                return Err(AppError::Validation(format!(
                    "La quantité réceptionnable restante de la ligne {line_id} est {remaining}."
                )));
            }
            tx.execute(
                "INSERT INTO supplier_receipt_lines(id,supplier_receipt_id,supplier_order_line_id,position,quantity_milli,description,unit,created_at) VALUES(?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),receipt_id,line_id,seen.len() as i64-1,quantity,description,unit,now],
            )?;
        }
        let result = supplier_receipt_bundle(&tx, &receipt_id, false)?;
        append_audit(&tx, "save_draft", "supplier_receipt", &receipt_id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn issue_supplier_receipt(&self, input: IssueSupplierReceiptInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(&tx, &input.request_id, "issue_supplier_receipt", &input)?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let receipt_id = required_text(&input.supplier_receipt_id, "supplier_receipt_id", 255)?;
        let receipt = query_record_tx(&tx, "supplier_receipts", &receipt_id)?;
        if receipt["status"] != "draft" {
            return Err(AppError::Validation(
                "Seule une réception brouillon peut être émise.".into(),
            ));
        }
        let order_id = receipt["supplier_order_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La commande liée est absente.".into()))?;
        let order_status: String = tx.query_row(
            "SELECT status FROM supplier_orders WHERE id=?",
            params![order_id],
            |row| row.get(0),
        )?;
        if order_status != "confirmed" {
            return Err(AppError::Validation(
                "La commande doit être confirmée et ouverte.".into(),
            ));
        }
        let receipt_date = receipt["receipt_date"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La date de réception est absente.".into()))?;
        ensure_accounting_date_open(&tx, receipt_date)?;
        let lines = {
            let mut statement = tx.prepare(
                "SELECT receipt_line.id,receipt_line.supplier_order_line_id,receipt_line.quantity_milli,order_line.catalog_item_id,order_line.fulfillment_mode
                 FROM supplier_receipt_lines receipt_line JOIN supplier_order_lines order_line ON order_line.id=receipt_line.supplier_order_line_id
                 WHERE receipt_line.supplier_receipt_id=? ORDER BY receipt_line.position,receipt_line.created_at",
            )?;
            let rows = statement
                .query_map(params![receipt_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if lines.is_empty() {
            return Err(AppError::Validation(
                "La réception ne contient aucune ligne.".into(),
            ));
        }
        let number = assign_document_number(
            &tx,
            "supplier_receipts",
            &receipt_id,
            "supplier_receipt",
            receipt_date,
        )?;
        let snapshot = serde_json::to_string(&json!({
            "schema":"elyko.supplier_receipt_snapshot.v1",
            "captured_at":now_iso(),
            "receipt":receipt,
            "lines":query_all(&tx,"SELECT * FROM supplier_receipt_lines WHERE supplier_receipt_id=? ORDER BY position,created_at",params![receipt_id])?,
            "order":query_record_tx(&tx,"supplier_orders",order_id)?
        }))?;
        let now = now_iso();
        tx.execute(
            "UPDATE supplier_receipts SET number=?,status='issuing',snapshot_json=?,issued_at=?,updated_at=? WHERE id=? AND status='draft'",
            params![number,snapshot,now,now,receipt_id],
        )?;
        for (line_id, _, quantity, catalog_id, mode) in lines {
            if mode != "stocked_receipt" {
                continue;
            }
            let catalog_id = catalog_id.ok_or_else(|| {
                AppError::Validation("Une réception stockée n’a pas d’article.".into())
            })?;
            let balance: i64 = tx.query_row(
                "SELECT stock_quantity_milli FROM catalog_items WHERE id=? AND kind='product' AND track_stock=1",
                params![catalog_id],
                |row| row.get(0),
            )?;
            let balance_after = balance
                .checked_add(quantity)
                .filter(|value| *value <= MAX_QUANTITY_MILLI)
                .ok_or_else(|| {
                    AppError::Validation("Le stock dépasserait la limite autorisée.".into())
                })?;
            tx.execute(
                "INSERT INTO stock_movements(id,source_key,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,reference,movement_date,source_type,supplier_receipt_id,supplier_receipt_line_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'supplier_receipt',?,?,?)",
                params![Uuid::new_v4().to_string(),format!("supplier-receipt:{line_id}"),catalog_id,"entry",quantity,balance_after,format!("Entrée sur réception fournisseur {number}"),number,receipt_date,receipt_id,line_id,now],
            )?;
        }
        tx.execute(
            "UPDATE supplier_receipts SET status='issued',updated_at=? WHERE id=? AND status='issuing'",
            params![now,receipt_id],
        )?;
        let result = supplier_receipt_bundle(&tx, &receipt_id, false)?;
        finish_operation(
            &tx,
            &operation,
            "issue_supplier_receipt",
            "supplier_receipt",
            &receipt_id,
            &result,
        )?;
        append_audit(&tx, "issue", "supplier_receipt", &receipt_id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn reverse_supplier_receipt(&self, input: ReverseSupplierReceiptInput) -> AppResult<Value> {
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation =
            begin_operation(&tx, &input.request_id, "reverse_supplier_receipt", &input)?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let receipt_id = required_text(&input.supplier_receipt_id, "supplier_receipt_id", 255)?;
        let receipt = query_record_tx(&tx, "supplier_receipts", &receipt_id)?;
        if receipt["status"] != "issued" {
            return Err(AppError::Validation(
                "Seule une réception émise peut être extournée.".into(),
            ));
        }
        let receipt_date = receipt["receipt_date"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La date de réception est absente.".into()))?;
        ensure_accounting_date_open(&tx, receipt_date)?;
        let allocated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM supplier_invoice_matches match_row JOIN supplier_receipt_lines line ON line.id=match_row.supplier_receipt_line_id WHERE line.supplier_receipt_id=?)",
            params![receipt_id],
            |row| row.get(0),
        )?;
        if allocated {
            return Err(AppError::Validation(
                "Cette réception est rapprochée d’une facture; retirez le rapprochement brouillon avant l’extourne.".into(),
            ));
        }
        let movements = {
            let mut statement = tx.prepare(
                "SELECT receipt_line.id,movement.id,movement.catalog_item_id,movement.quantity_delta_milli
                 FROM supplier_receipt_lines receipt_line JOIN stock_movements movement ON movement.supplier_receipt_line_id=receipt_line.id AND movement.source_type='supplier_receipt' AND movement.movement_type='entry'
                 WHERE receipt_line.supplier_receipt_id=? ORDER BY movement.sequence",
            )?;
            let rows = statement
                .query_map(params![receipt_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut reversal_quantity_by_catalog = HashMap::<String, i64>::new();
        for (_, _, catalog_id, quantity) in &movements {
            let total = reversal_quantity_by_catalog
                .entry(catalog_id.clone())
                .or_default();
            *total = total
                .checked_add(*quantity)
                .filter(|value| *value <= MAX_QUANTITY_MILLI)
                .ok_or_else(|| {
                    AppError::Validation(
                        "La quantité totale à extourner dépasse la limite autorisée.".into(),
                    )
                })?;
        }
        for (catalog_id, quantity) in reversal_quantity_by_catalog {
            let on_hand: i64 = tx.query_row(
                "SELECT stock_quantity_milli FROM catalog_items WHERE id=?",
                params![catalog_id],
                |row| row.get(0),
            )?;
            let balance_after = on_hand.checked_sub(quantity).filter(|value| *value >= 0);
            if balance_after.is_none() {
                return Err(AppError::Validation(format!(
                    "Le stock actuel de {catalog_id} ne permet pas d’extourner cette réception."
                )));
            }
        }
        let now = now_iso();
        tx.execute(
            "UPDATE supplier_receipts SET status='reversing',reversed_at=?,reversal_reason=?,updated_at=? WHERE id=? AND status='issued'",
            params![now,reason,now,receipt_id],
        )?;
        let number = receipt["number"].as_str().unwrap_or("RF");
        for (line_id, original_id, catalog_id, quantity) in movements {
            let balance: i64 = tx.query_row(
                "SELECT stock_quantity_milli FROM catalog_items WHERE id=?",
                params![catalog_id],
                |row| row.get(0),
            )?;
            let balance_after = balance
                .checked_sub(quantity)
                .ok_or_else(|| AppError::Validation("Le stock deviendrait négatif.".into()))?;
            tx.execute(
                "INSERT INTO stock_movements(id,source_key,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,reference,movement_date,source_type,supplier_receipt_id,supplier_receipt_line_id,reverses_stock_movement_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'supplier_receipt',?,?,?,?)",
                params![Uuid::new_v4().to_string(),format!("supplier-receipt-reversal:{line_id}"),catalog_id,"exit",-quantity,balance_after,reason,number,receipt_date,receipt_id,line_id,original_id,now],
            )?;
        }
        tx.execute(
            "UPDATE supplier_receipts SET status='reversed',updated_at=? WHERE id=? AND status='reversing'",
            params![now,receipt_id],
        )?;
        let result = supplier_receipt_bundle(&tx, &receipt_id, false)?;
        finish_operation(
            &tx,
            &operation,
            "reverse_supplier_receipt",
            "supplier_receipt",
            &receipt_id,
            &result,
        )?;
        append_audit(
            &tx,
            "reverse",
            "supplier_receipt",
            &receipt_id,
            &json!({"reason":reason,"result":result}),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn save_supplier_invoice_match(
        &self,
        input: SaveSupplierInvoiceMatchInput,
    ) -> AppResult<Value> {
        if input.allocations.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Le rapprochement ne peut pas dépasser {MAX_LINES} allocations."
            )));
        }
        let clearing = input.allocations.is_empty();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(
            &tx,
            &input.request_id,
            "save_supplier_invoice_match",
            &input,
        )?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let invoice_id = required_text(&input.supplier_invoice_id, "supplier_invoice_id", 255)?;
        let order_id = required_text(&input.supplier_order_id, "supplier_order_id", 255)?;
        let invoice_context: Option<(String, String, String)> = tx
            .query_row(
                "SELECT status,supplier_id,currency FROM supplier_invoices WHERE id=?",
                params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (invoice_status, invoice_supplier, invoice_currency) = invoice_context
            .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{invoice_id}")))?;
        if invoice_status != "draft" {
            return Err(AppError::Validation(
                "Le rapprochement doit être finalisé avant la validation de la facture fournisseur.".into(),
            ));
        }
        let order_context: Option<(String, String, String)> = tx
            .query_row(
                "SELECT status,supplier_id,currency FROM supplier_orders WHERE id=?",
                params![order_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (order_status, order_supplier, order_currency) = order_context
            .ok_or_else(|| AppError::NotFound(format!("supplier_orders/{order_id}")))?;
        if order_status != "confirmed" {
            return Err(AppError::Validation(
                "La commande fournisseur doit être confirmée et ouverte.".into(),
            ));
        }
        if invoice_supplier != order_supplier || invoice_currency != order_currency {
            return Err(AppError::Validation(
                "La facture et la commande doivent avoir le même fournisseur et la même devise."
                    .into(),
            ));
        }

        let (existing_match_count, foreign_order_match_count): (i64, i64) = tx.query_row(
            "SELECT COUNT(*),COALESCE(SUM(CASE WHEN supplier_order_id<>? THEN 1 ELSE 0 END),0) FROM supplier_invoice_matches WHERE supplier_invoice_id=?",
            params![order_id,invoice_id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        )?;
        if foreign_order_match_count != 0 {
            return Err(AppError::Validation(
                "Cette facture est déjà rapprochée avec une autre commande. Retirez explicitement ce rapprochement avant d’en choisir une autre."
                    .into(),
            ));
        }
        if clearing && existing_match_count == 0 {
            return Err(AppError::Validation(
                "Aucun rapprochement brouillon n’existe pour cette facture.".into(),
            ));
        }

        // `save` remplace (ou retire explicitement) le rapprochement encore
        // brouillon dans une seule transaction. Les liens d'une facture
        // validée sont protégés par SQL.
        tx.execute(
            "DELETE FROM supplier_invoice_matches WHERE supplier_invoice_id=?",
            params![invoice_id],
        )?;

        #[derive(Debug)]
        struct PendingMatch {
            invoice_item_id: String,
            order_line_id: String,
            receipt_line_id: Option<String>,
            quantity: i64,
            invoice_quantity: i64,
            invoice_net: i64,
            invoice_vat: i64,
        }
        let mut pending = Vec::with_capacity(input.allocations.len());
        let mut seen = HashSet::new();
        let mut by_invoice_item: HashMap<String, i64> = HashMap::new();
        let mut by_order_line: HashMap<String, i64> = HashMap::new();
        let mut by_receipt_line: HashMap<String, i64> = HashMap::new();
        for allocation in input.allocations {
            let invoice_item_id = required_text(
                &allocation.supplier_invoice_item_id,
                "supplier_invoice_item_id",
                255,
            )?;
            let order_line_id = required_text(
                &allocation.supplier_order_line_id,
                "supplier_order_line_id",
                255,
            )?;
            let receipt_line_id = optional_id(allocation.supplier_receipt_line_id);
            let quantity = validate_quantity(allocation.quantity_milli, "quantity_milli")?;
            let key = format!(
                "{invoice_item_id}\0{order_line_id}\0{}",
                receipt_line_id.as_deref().unwrap_or("")
            );
            if !seen.insert(key) {
                return Err(AppError::Validation(
                    "Une allocation identique apparaît deux fois.".into(),
                ));
            }
            let invoice_line: Option<(i64, i64, i64)> = tx
                .query_row(
                    "SELECT quantity_milli,line_net_cents,line_vat_cents FROM supplier_invoice_items WHERE id=? AND supplier_invoice_id=?",
                    params![invoice_item_id,invoice_id],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                )
                .optional()?;
            let (invoice_quantity, invoice_net, invoice_vat) = invoice_line.ok_or_else(|| {
                AppError::Validation(
                    "Une ligne rapprochée n’appartient pas à cette facture.".into(),
                )
            })?;
            let order_line: Option<(i64, String)> = tx
                .query_row(
                    "SELECT quantity_milli,fulfillment_mode FROM supplier_order_lines WHERE id=? AND supplier_order_id=?",
                    params![order_line_id,order_id],
                    |row| Ok((row.get(0)?,row.get(1)?)),
                )
                .optional()?;
            let (ordered, mode) = order_line.ok_or_else(|| {
                AppError::Validation(
                    "Une ligne rapprochée n’appartient pas à cette commande.".into(),
                )
            })?;
            let cancelled: i64 = tx.query_row(
                "SELECT COALESCE(SUM(quantity_milli),0) FROM supplier_order_cancellation_lines WHERE supplier_order_line_id=?",
                params![order_line_id],
                |row| row.get(0),
            )?;
            let already_order_matched: i64 = tx.query_row(
                "SELECT COALESCE(SUM(quantity_milli),0) FROM supplier_invoice_matches WHERE supplier_order_line_id=?",
                params![order_line_id],
                |row| row.get(0),
            )?;
            let requested_order = by_order_line.entry(order_line_id.clone()).or_default();
            *requested_order = requested_order
                .checked_add(quantity)
                .ok_or_else(|| AppError::Validation("Quantité rapprochée trop élevée.".into()))?;
            if already_order_matched + *requested_order > ordered - cancelled {
                return Err(AppError::Validation(format!(
                    "Le rapprochement dépasse le reliquat de la ligne {order_line_id}."
                )));
            }
            let requested_item = by_invoice_item.entry(invoice_item_id.clone()).or_default();
            *requested_item = requested_item
                .checked_add(quantity)
                .ok_or_else(|| AppError::Validation("Quantité rapprochée trop élevée.".into()))?;
            if *requested_item > invoice_quantity {
                return Err(AppError::Validation(format!(
                    "Le rapprochement dépasse la quantité de la ligne de facture {invoice_item_id}."
                )));
            }
            match mode.as_str() {
                "direct" if receipt_line_id.is_none() => {}
                "stocked_receipt" | "untracked_receipt" => {
                    let receipt_id = receipt_line_id.as_deref().ok_or_else(|| {
                        AppError::Validation(
                            "Une ligne réceptionnable doit pointer vers une réception émise."
                                .into(),
                        )
                    })?;
                    let received: Option<i64> = tx
                        .query_row(
                            "SELECT receipt_line.quantity_milli FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.id=? AND receipt_line.supplier_order_line_id=? AND receipt.supplier_order_id=? AND receipt.status='issued'",
                            params![receipt_id,order_line_id,order_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    let received = received.ok_or_else(|| {
                        AppError::Validation(
                            "La réception liée est absente, extournée ou incohérente.".into(),
                        )
                    })?;
                    let already_receipt_matched: i64 = tx.query_row(
                        "SELECT COALESCE(SUM(quantity_milli),0) FROM supplier_invoice_matches WHERE supplier_receipt_line_id=?",
                        params![receipt_id],
                        |row| row.get(0),
                    )?;
                    let requested_receipt =
                        by_receipt_line.entry(receipt_id.to_owned()).or_default();
                    *requested_receipt =
                        requested_receipt.checked_add(quantity).ok_or_else(|| {
                            AppError::Validation("Quantité rapprochée trop élevée.".into())
                        })?;
                    if already_receipt_matched + *requested_receipt > received {
                        return Err(AppError::Validation(
                            "Le rapprochement dépasse la quantité de la réception liée.".into(),
                        ));
                    }
                }
                _ => {
                    return Err(AppError::Validation(
                        "Le lien de réception ne correspond pas au mode de la ligne de commande."
                            .into(),
                    ));
                }
            }
            pending.push(PendingMatch {
                invoice_item_id,
                order_line_id,
                receipt_line_id,
                quantity,
                invoice_quantity,
                invoice_net,
                invoice_vat,
            });
        }
        pending.sort_by(|left, right| {
            left.invoice_item_id
                .cmp(&right.invoice_item_id)
                .then_with(|| left.order_line_id.cmp(&right.order_line_id))
                .then_with(|| left.receipt_line_id.cmp(&right.receipt_line_id))
        });
        let mut allocated_quantity_by_item = HashMap::<String, i64>::new();
        let now = now_iso();
        for match_row in pending {
            let previous_quantity = *allocated_quantity_by_item
                .get(&match_row.invoice_item_id)
                .unwrap_or(&0);
            let cumulative_quantity = previous_quantity
                .checked_add(match_row.quantity)
                .ok_or_else(|| AppError::Validation("Quantité rapprochée trop élevée.".into()))?;
            let previous_net = rounded_div(
                i128::from(match_row.invoice_net) * i128::from(previous_quantity),
                i128::from(match_row.invoice_quantity),
                "part nette rapprochée",
            )?;
            let cumulative_net = rounded_div(
                i128::from(match_row.invoice_net) * i128::from(cumulative_quantity),
                i128::from(match_row.invoice_quantity),
                "cumul net rapproché",
            )?;
            let previous_vat = rounded_div(
                i128::from(match_row.invoice_vat) * i128::from(previous_quantity),
                i128::from(match_row.invoice_quantity),
                "part TVA rapprochée",
            )?;
            let cumulative_vat = rounded_div(
                i128::from(match_row.invoice_vat) * i128::from(cumulative_quantity),
                i128::from(match_row.invoice_quantity),
                "cumul TVA rapproché",
            )?;
            let net = cumulative_net - previous_net;
            let vat = cumulative_vat - previous_vat;
            let total = net
                .checked_add(vat)
                .ok_or_else(|| AppError::Validation("Montant rapproché trop élevé.".into()))?;
            tx.execute(
                "INSERT INTO supplier_invoice_matches(id,request_id,supplier_invoice_id,supplier_invoice_item_id,supplier_order_id,supplier_order_line_id,supplier_receipt_line_id,quantity_milli,net_cents,vat_cents,total_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),operation.request_id,invoice_id,match_row.invoice_item_id,order_id,match_row.order_line_id,match_row.receipt_line_id,match_row.quantity,net,vat,total,now],
            )?;
            allocated_quantity_by_item.insert(match_row.invoice_item_id, cumulative_quantity);
        }
        let matches = query_all(
            &tx,
            "SELECT * FROM supplier_invoice_matches WHERE supplier_invoice_id=? ORDER BY supplier_invoice_item_id,created_at,id",
            params![invoice_id],
        )?;
        let result = json!({
            "invoice":query_record_tx(&tx,"supplier_invoices",&invoice_id)?,
            "items":query_all(&tx,"SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id=? ORDER BY position,rowid",params![invoice_id])?,
            "matches":matches,
            "order":supplier_order_bundle(&tx,&order_id,false)?,
            "idempotent":false
        });
        finish_operation(
            &tx,
            &operation,
            "save_supplier_invoice_match",
            "supplier_invoice",
            &invoice_id,
            &result,
        )?;
        append_audit(
            &tx,
            if clearing { "clear_match" } else { "match" },
            "supplier_invoice",
            &invoice_id,
            &result,
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn save_supplier_credit_note_draft(
        &self,
        input: SaveSupplierCreditNoteDraftInput,
    ) -> AppResult<Value> {
        if input.items.is_empty() || input.items.len() > MAX_LINES {
            return Err(AppError::Validation(format!(
                "Un avoir fournisseur doit contenir entre 1 et {MAX_LINES} lignes."
            )));
        }
        let supplier_id = required_text(&input.supplier_id, "supplier_id", 255)?;
        let document_date = valid_date(&input.document_date, "document_date")?;
        let reference = optional_text(input.reference, "reference", 200)?;
        let note = optional_text(input.note, "note", 10_000)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = input
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let id = normalized_uuid(&id, "credit.id")?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT status,supplier_id FROM supplier_credit_notes WHERE id=?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let supplier_name = require_supplier(
            &tx,
            &supplier_id,
            existing
                .as_ref()
                .is_some_and(|(_, existing_supplier)| existing_supplier == &supplier_id),
        )?;
        let mut prepared = Vec::with_capacity(input.items.len());
        let mut line_ids = HashSet::new();
        for item in input.items {
            let line = prepare_credit_line(&tx, item)?;
            if !line_ids.insert(line.id.clone()) {
                return Err(AppError::Validation(
                    "Deux lignes d’avoir utilisent le même identifiant.".into(),
                ));
            }
            prepared.push(line);
        }
        let net = checked_sum(prepared.iter().map(|line| line.amounts.net), "Total net")?;
        let vat = checked_sum(prepared.iter().map(|line| line.amounts.vat), "TVA")?;
        let total = checked_sum(prepared.iter().map(|line| line.amounts.total), "Total")?;
        if total <= 0 {
            return Err(AppError::Validation(
                "Le total de l’avoir doit être supérieur à zéro.".into(),
            ));
        }
        let allocated = checked_sum(
            input
                .allocations
                .iter()
                .map(|allocation| allocation.amount_cents),
            "Total imputé",
        )?;
        if input
            .allocations
            .iter()
            .any(|allocation| allocation.amount_cents <= 0)
            || allocated > total
        {
            return Err(AppError::Validation(
                "Les imputations doivent être positives et ne pas dépasser l’avoir.".into(),
            ));
        }
        let mut allocation_invoices = HashSet::new();
        for allocation in &input.allocations {
            if !allocation_invoices.insert(allocation.supplier_invoice_id.trim().to_owned()) {
                return Err(AppError::Validation(
                    "Une facture ne peut être imputée qu’une fois dans cet avoir.".into(),
                ));
            }
            let invoice: Option<(String, String, String, i64, i64, i64)> = tx
                .query_row(
                    "SELECT status,supplier_id,currency,total_cents,paid_cents,credited_cents FROM supplier_invoices WHERE id=?",
                    params![allocation.supplier_invoice_id],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
                )
                .optional()?;
            let (status, invoice_supplier, currency, invoice_total, paid, credited) = invoice
                .ok_or_else(|| {
                    AppError::NotFound(format!(
                        "supplier_invoices/{}",
                        allocation.supplier_invoice_id
                    ))
                })?;
            if status != "validated" || invoice_supplier != supplier_id || currency != "CHF" {
                return Err(AppError::Validation(
                    "Une imputation exige une facture validée du même fournisseur en CHF.".into(),
                ));
            }
            let open = invoice_total
                .checked_sub(paid)
                .and_then(|value| value.checked_sub(credited))
                .ok_or_else(|| {
                    AppError::Validation("Le solde fournisseur est incohérent.".into())
                })?;
            if allocation.amount_cents > open {
                return Err(AppError::Validation(format!(
                    "L’imputation dépasse le solde de la facture {} ({:.2} CHF).",
                    allocation.supplier_invoice_id,
                    open as f64 / 100.0
                )));
            }
        }
        let now = now_iso();
        if let Some((status, _)) = existing {
            if status != "draft" {
                return Err(AppError::Validation("Un avoir validé est immuable.".into()));
            }
            tx.execute(
                "DELETE FROM supplier_credit_allocations WHERE supplier_credit_note_id=?",
                params![id],
            )?;
            tx.execute(
                "DELETE FROM supplier_credit_note_items WHERE supplier_credit_note_id=?",
                params![id],
            )?;
            tx.execute(
                "UPDATE supplier_credit_notes SET supplier_id=?,document_date=?,supplier_name=?,reference=?,reference_normalized=?,currency='CHF',net_cents=?,vat_cents=?,total_cents=?,note=?,updated_at=? WHERE id=? AND status='draft'",
                params![supplier_id,document_date,supplier_name,reference,normalize_reference(reference.as_deref()),net,vat,total,note,now,id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO supplier_credit_notes(id,supplier_id,status,document_date,supplier_name,reference,reference_normalized,currency,net_cents,vat_cents,total_cents,note,created_at,updated_at) VALUES(?,?,'draft',?,?,?,?, 'CHF',?,?,?,?,?,?)",
                params![id,supplier_id,document_date,supplier_name,reference,normalize_reference(reference.as_deref()),net,vat,total,note,now,now],
            )?;
        }
        for (position, line) in prepared.into_iter().enumerate() {
            tx.execute(
                "INSERT INTO supplier_credit_note_items(id,supplier_credit_note_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,category,expense_account_id,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![line.id,id,position as i64,line.description,line.quantity_milli,line.unit,line.unit_price_cents,line.discount_bp,line.vat_bp,line.amounts.net,line.amounts.vat,line.amounts.total,line.category,line.expense_account_id,line.project_id,now,now],
            )?;
        }
        for allocation in input.allocations {
            tx.execute(
                "INSERT INTO supplier_credit_allocations(id,supplier_credit_note_id,supplier_invoice_id,amount_cents,created_at) VALUES(?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),id,allocation.supplier_invoice_id,allocation.amount_cents,now],
            )?;
        }
        let result = supplier_credit_bundle(&tx, &id, false)?;
        append_audit(&tx, "save_draft", "supplier_credit_note", &id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn validate_supplier_credit_note(
        &self,
        input: ValidateSupplierCreditNoteInput,
    ) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(
            &tx,
            &input.request_id,
            "validate_supplier_credit_note",
            &input,
        )?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let id = required_text(
            &input.supplier_credit_note_id,
            "supplier_credit_note_id",
            255,
        )?;
        let credit = query_record_tx(&tx, "supplier_credit_notes", &id)?;
        if credit["status"] != "draft" {
            return Err(AppError::Validation(
                "Seul un avoir brouillon peut être validé.".into(),
            ));
        }
        let date = credit["document_date"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La date de l’avoir est absente.".into()))?;
        ensure_accounting_date_open(&tx, date)?;
        let (enabled, default_expense, vat_account, payable_account): (bool, Option<String>, Option<String>, Option<String>) = tx.query_row(
            "SELECT enabled,expense_account_id,vat_receivable_account_id,supplier_payable_account_id FROM accounting_settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        )?;
        if !enabled {
            return Err(AppError::Validation(
                "Activez la comptabilité avant de valider un avoir fournisseur.".into(),
            ));
        }
        let default_expense = default_expense
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation("Configurez le compte de charges fournisseur.".into())
            })?;
        let vat_account = vat_account
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Validation("Configurez le compte de TVA préalable.".into()))?;
        let payable_account = payable_account
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation("Configurez le compte de dettes fournisseurs.".into())
            })?;
        require_account(&tx, &default_expense, "expense")?;
        require_account(&tx, &vat_account, "asset")?;
        require_account(&tx, &payable_account, "liability")?;
        let items = query_all(&tx, "SELECT * FROM supplier_credit_note_items WHERE supplier_credit_note_id=? ORDER BY position,created_at", params![id])?;
        if items.is_empty() {
            return Err(AppError::Validation(
                "L’avoir ne contient aucune ligne.".into(),
            ));
        }
        let allocations = query_all(&tx, "SELECT * FROM supplier_credit_allocations WHERE supplier_credit_note_id=? ORDER BY created_at,id", params![id])?;
        let total = credit["total_cents"].as_i64().unwrap_or(0);
        let vat = credit["vat_cents"].as_i64().unwrap_or(0);
        let mut journal_lines = vec![EntryLine {
            account_id: payable_account,
            debit_cents: total,
            credit_cents: 0,
            currency: "CHF".into(),
            memo: Some("Avoir sur dette fournisseur".into()),
            project_id: None,
            client_id: None,
            employee_id: None,
        }];
        for item in &items {
            let amount = item["line_net_cents"].as_i64().unwrap_or(0);
            if amount == 0 {
                continue;
            }
            let account_id = item["expense_account_id"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&default_expense)
                .to_owned();
            require_account(&tx, &account_id, "expense")?;
            journal_lines.push(EntryLine {
                account_id,
                debit_cents: 0,
                credit_cents: amount,
                currency: "CHF".into(),
                memo: item["description"].as_str().map(ToOwned::to_owned),
                project_id: item["project_id"].as_str().map(ToOwned::to_owned),
                client_id: None,
                employee_id: None,
            });
        }
        if vat > 0 {
            journal_lines.push(EntryLine {
                account_id: vat_account,
                debit_cents: 0,
                credit_cents: vat,
                currency: "CHF".into(),
                memo: Some("Correction TVA préalable fournisseur".into()),
                project_id: None,
                client_id: None,
                employee_id: None,
            });
        }
        let number = assign_document_number(
            &tx,
            "supplier_credit_notes",
            &id,
            "supplier_credit_note",
            date,
        )?;
        let snapshot = serde_json::to_string(&json!({
            "schema":"elyko.supplier_credit_note_snapshot.v1",
            "captured_at":now_iso(),"credit_note":credit,"items":items,"allocations":allocations
        }))?;
        let journal = post_entry(
            &tx,
            date,
            &format!("Avoir fournisseur {number}"),
            "supplier_credit_note",
            &id,
            "validate",
            journal_lines,
        )?;
        let journal_id = journal["id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("L’écriture d’avoir est invalide.".into()))?;
        let now = now_iso();
        tx.execute(
            "UPDATE supplier_credit_notes SET number=?,status='validated',snapshot_json=?,validation_journal_entry_id=?,validated_at=?,updated_at=? WHERE id=? AND status='draft'",
            params![number,snapshot,journal_id,now,now,id],
        )?;
        let result = supplier_credit_bundle(&tx, &id, false)?;
        finish_operation(
            &tx,
            &operation,
            "validate_supplier_credit_note",
            "supplier_credit_note",
            &id,
            &result,
        )?;
        append_audit(
            &tx,
            "validate",
            "supplier_credit_note",
            &id,
            &json!({"journal":journal,"result":result}),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn apply_supplier_credit(&self, input: ApplySupplierCreditInput) -> AppResult<Value> {
        if input.amount_cents <= 0 {
            return Err(AppError::Validation(
                "Le montant imputé doit être supérieur à zéro.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(&tx, &input.request_id, "apply_supplier_credit", &input)?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let credit_id = required_text(
            &input.supplier_credit_note_id,
            "supplier_credit_note_id",
            255,
        )?;
        let invoice_id = required_text(&input.supplier_invoice_id, "supplier_invoice_id", 255)?;
        let allocation_id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute(
            "INSERT INTO supplier_credit_allocations(id,request_id,supplier_credit_note_id,supplier_invoice_id,event_type,amount_cents,created_at) VALUES(?,?,?,?, 'apply',?,?)",
            params![allocation_id,operation.request_id,credit_id,invoice_id,input.amount_cents,now],
        )?;
        let result = json!({
            "allocation":query_record_tx(&tx,"supplier_credit_allocations",&allocation_id)?,
            "credit":supplier_credit_bundle(&tx,&credit_id,false)?,
            "invoice":query_record_tx(&tx,"supplier_invoices",&invoice_id)?,
            "idempotent":false
        });
        finish_operation(
            &tx,
            &operation,
            "apply_supplier_credit",
            "supplier_credit_allocation",
            &allocation_id,
            &result,
        )?;
        append_audit(
            &tx,
            "apply",
            "supplier_credit_allocation",
            &allocation_id,
            &result,
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn reverse_supplier_credit_allocation(
        &self,
        input: ReverseSupplierCreditAllocationInput,
    ) -> AppResult<Value> {
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(
            &tx,
            &input.request_id,
            "reverse_supplier_credit_allocation",
            &input,
        )?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let original_id = required_text(
            &input.supplier_credit_allocation_id,
            "supplier_credit_allocation_id",
            255,
        )?;
        let original: Option<(String, String, String, i64)> = tx
            .query_row(
                "SELECT event_type,supplier_credit_note_id,supplier_invoice_id,amount_cents FROM supplier_credit_allocations WHERE id=?",
                params![original_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            )
            .optional()?;
        let (event_type, credit_id, invoice_id, amount) = original.ok_or_else(|| {
            AppError::NotFound(format!("supplier_credit_allocations/{original_id}"))
        })?;
        if event_type != "apply" {
            return Err(AppError::Validation(
                "Seule une imputation positive peut être extournée.".into(),
            ));
        }
        let reversal_id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute(
            "INSERT INTO supplier_credit_allocations(id,request_id,supplier_credit_note_id,supplier_invoice_id,event_type,amount_cents,reverses_allocation_id,reason,created_at) VALUES(?,?,?,?, 'reverse',?,?,?,?)",
            params![reversal_id,operation.request_id,credit_id,invoice_id,amount,original_id,reason,now],
        )?;
        let result = json!({
            "allocation":query_record_tx(&tx,"supplier_credit_allocations",&reversal_id)?,
            "credit":supplier_credit_bundle(&tx,&credit_id,false)?,
            "invoice":query_record_tx(&tx,"supplier_invoices",&invoice_id)?,
            "idempotent":false
        });
        finish_operation(
            &tx,
            &operation,
            "reverse_supplier_credit_allocation",
            "supplier_credit_allocation",
            &reversal_id,
            &result,
        )?;
        append_audit(
            &tx,
            "reverse",
            "supplier_credit_allocation",
            &reversal_id,
            &json!({"reason":reason,"result":result}),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn delete_supplier_credit_note_draft(&self, id: &str) -> AppResult<Value> {
        let id = required_text(id, "supplier_credit_note_id", 255)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let before = supplier_credit_bundle(&tx, &id, false)?;
        if before["credit_note"]["status"] != "draft" {
            return Err(AppError::Validation(
                "Seul un avoir brouillon peut être supprimé.".into(),
            ));
        }
        tx.execute(
            "DELETE FROM supplier_credit_allocations WHERE supplier_credit_note_id=?",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM supplier_credit_note_items WHERE supplier_credit_note_id=?",
            params![id],
        )?;
        tx.execute("DELETE FROM supplier_credit_notes WHERE id=?", params![id])?;
        append_audit(&tx, "delete", "supplier_credit_note_draft", &id, &before)?;
        tx.commit()?;
        Ok(json!({"deleted":true,"id":id}))
    }

    pub fn reclassify_supplier_invoice_expense(
        &self,
        input: ReclassifySupplierInvoiceExpenseInput,
    ) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(AppError::Validation(
                "Sélectionnez au moins une ligne à reclasser.".into(),
            ));
        }
        let invoice_id = required_text(&input.supplier_invoice_id, "supplier_invoice_id", 255)?;
        let effective_date = valid_date(&input.effective_date, "effective_date")?;
        let reason = required_text(&input.reason, "reason", 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(
            &tx,
            &input.request_id,
            "reclassify_supplier_invoice_expense",
            &input,
        )?;
        if let Some(result) = operation.replay.clone() {
            tx.commit()?;
            return Ok(result);
        }
        let invoice: Option<(String, String, String)> = tx
            .query_row(
                "SELECT status,document_date,currency FROM supplier_invoices WHERE id=?",
                params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (status, invoice_date, currency) =
            invoice.ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{invoice_id}")))?;
        if status != "validated" {
            return Err(AppError::Validation(
                "Seule une facture fournisseur validée peut être reclassée.".into(),
            ));
        }
        if effective_date < invoice_date {
            return Err(AppError::Validation(
                "La reclassification ne peut pas précéder la facture.".into(),
            ));
        }
        ensure_accounting_date_open(&tx, &effective_date)?;
        let reclassification_id = Uuid::new_v4().to_string();
        let mut seen = HashSet::new();
        let mut prepared = Vec::new();
        let mut journal_lines = Vec::new();
        for input_line in input.lines {
            let item_id = required_text(
                &input_line.supplier_invoice_item_id,
                "supplier_invoice_item_id",
                255,
            )?;
            if !seen.insert(item_id.clone()) {
                return Err(AppError::Validation(
                    "Une ligne ne peut être reclassée qu’une fois par opération.".into(),
                ));
            }
            let new_account = required_text(
                &input_line.new_expense_account_id,
                "new_expense_account_id",
                255,
            )?;
            require_account(&tx, &new_account, "expense")?;
            let item: Option<(i64, Option<String>, Option<String>, String)> = tx
                .query_row(
                    "SELECT line_net_cents,project_id,posted_expense_account_id,description FROM supplier_invoice_items WHERE id=? AND supplier_invoice_id=?",
                    params![item_id,invoice_id],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
                )
                .optional()?;
            let (amount, project_id, posted_account, description) = item.ok_or_else(|| {
                AppError::Validation("La ligne n’appartient pas à cette facture.".into())
            })?;
            if amount <= 0 {
                return Err(AppError::Validation(
                    "Une ligne sans montant net ne peut pas être reclassée.".into(),
                ));
            }
            let current_account: Option<String> = tx
                .query_row(
                    "SELECT line.new_expense_account_id FROM supplier_expense_reclassification_lines line JOIN supplier_expense_reclassifications header ON header.id=line.reclassification_id WHERE line.supplier_invoice_item_id=? ORDER BY header.created_at DESC,header.id DESC LIMIT 1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?;
            let old_account = current_account.or(posted_account).ok_or_else(|| AppError::Validation(
                "Le compte de charge historiquement comptabilisé n’est pas identifiable; cette ancienne facture ne peut pas être reclassée automatiquement.".into(),
            ))?;
            require_account(&tx, &old_account, "expense")?;
            if old_account == new_account {
                return Err(AppError::Validation(
                    "Le nouveau compte doit différer du compte actuel.".into(),
                ));
            }
            journal_lines.push(EntryLine {
                account_id: old_account.clone(),
                debit_cents: 0,
                credit_cents: amount,
                currency: currency.clone(),
                memo: Some(format!("Contre-imputation · {description}")),
                project_id: project_id.clone(),
                client_id: None,
                employee_id: None,
            });
            journal_lines.push(EntryLine {
                account_id: new_account.clone(),
                debit_cents: amount,
                credit_cents: 0,
                currency: currency.clone(),
                memo: Some(format!("Nouvelle imputation · {description}")),
                project_id: project_id.clone(),
                client_id: None,
                employee_id: None,
            });
            prepared.push((item_id, old_account, new_account, amount, project_id));
        }
        let journal = post_entry(
            &tx,
            &effective_date,
            &format!("Reclassification facture fournisseur · {reason}"),
            "supplier_expense_reclassification",
            &reclassification_id,
            "post",
            journal_lines,
        )?;
        let journal_id = journal["id"].as_str().ok_or_else(|| {
            AppError::Validation("L’écriture de reclassification est invalide.".into())
        })?;
        let now = now_iso();
        tx.execute(
            "INSERT INTO supplier_expense_reclassifications(id,request_id,supplier_invoice_id,effective_date,reason,journal_entry_id,created_at) VALUES(?,?,?,?,?,?,?)",
            params![reclassification_id,operation.request_id,invoice_id,effective_date,reason,journal_id,now],
        )?;
        for (item_id, old_account, new_account, amount, project_id) in prepared {
            tx.execute(
                "INSERT INTO supplier_expense_reclassification_lines(id,reclassification_id,supplier_invoice_item_id,old_expense_account_id,new_expense_account_id,amount_cents,project_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(),reclassification_id,item_id,old_account,new_account,amount,project_id,now],
            )?;
        }
        let result = json!({
            "reclassification":query_record_tx(&tx,"supplier_expense_reclassifications",&reclassification_id)?,
            "lines":query_all(&tx,"SELECT * FROM supplier_expense_reclassification_lines WHERE reclassification_id=? ORDER BY created_at,id",params![reclassification_id])?,
            "journal":journal,
            "idempotent":false
        });
        finish_operation(
            &tx,
            &operation,
            "reclassify_supplier_invoice_expense",
            "supplier_expense_reclassification",
            &reclassification_id,
            &result,
        )?;
        append_audit(&tx, "reclassify", "supplier_invoice", &invoice_id, &result)?;
        tx.commit()?;
        Ok(result)
    }
}

fn normalize_reference(value: Option<&str>) -> Option<String> {
    let normalized = value
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect::<String>();
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod operation_storage_tests {
    use super::*;

    #[test]
    fn max_match_payload_and_large_result_use_compact_idempotence_storage() {
        let input = SaveSupplierInvoiceMatchInput {
            request_id: "11111111-1111-4111-8111-111111111111".into(),
            supplier_invoice_id: "22222222-2222-4222-8222-222222222222".into(),
            supplier_order_id: "33333333-3333-4333-8333-333333333333".into(),
            allocations: (0..MAX_LINES)
                .map(
                    |position| crate::models::SupplierInvoiceMatchAllocationInput {
                        supplier_invoice_item_id: format!("invoice-item-{position:05}"),
                        supplier_order_line_id: format!("order-line-{position:05}"),
                        supplier_receipt_line_id: None,
                        quantity_milli: 1,
                    },
                )
                .collect(),
        };
        assert!(serde_json::to_vec(&input).unwrap().len() > 100_000);
        let (_, stored_payload) = payload_sha256(&input).unwrap();
        assert!(stored_payload.len() < 1_000);

        let large_response = json!({
            "order":{"order":{"id":input.supplier_order_id.clone()}},
            "matches":vec![json!({"description":"x".repeat(10_000)});100]
        });
        assert!(serde_json::to_vec(&large_response).unwrap().len() > 500_000);
        let stored_response =
            compact_operation_response("save_supplier_invoice_match", &large_response).unwrap();
        assert!(stored_response.len() < 1_000);
        assert_eq!(
            serde_json::from_str::<Value>(&stored_response).unwrap()["context"]
                ["supplier_order_id"],
            input.supplier_order_id
        );
    }
}

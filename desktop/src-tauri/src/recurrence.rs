use std::collections::HashSet;

use chrono::{Datelike, Days, NaiveDate};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{
        CreateRecurrenceScheduleInput, GenerateRecurrenceOccurrencesInput,
        UpdateRecurrenceScheduleInput,
    },
};

const MAX_CATCH_UP: usize = 12;
const MAX_PAYLOAD_BYTES: usize = 100_000;
const MAX_RESPONSE_BYTES: usize = 4_000_000;
const MAX_SNAPSHOT_BYTES: usize = 4_000_000;
const MAX_MONEY_CENTS: i64 = 9_000_000_000_000_000;

#[derive(Debug)]
struct OperationState {
    request_id: String,
    payload_sha256: String,
    payload_json: String,
    replay: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct FrozenOrder {
    id: String,
    client_id: String,
    project_id: Option<String>,
    number: String,
    title: String,
    status: String,
    order_date: String,
    currency: String,
    subtotal_cents: i64,
    discount_cents: i64,
    vat_cents: i64,
    total_cents: i64,
    notes: Option<String>,
    terms: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct FrozenLine {
    id: String,
    position: i64,
    description: String,
    quantity_milli: i64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    line_net_cents: i64,
    line_vat_cents: i64,
    line_total_cents: i64,
    fulfillment_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FrozenSourceSnapshot {
    schema: String,
    order: FrozenOrder,
    lines: Vec<FrozenLine>,
}

#[derive(Debug, Clone, Deserialize)]
struct FrozenRecurrenceTemplate {
    schema: String,
    frequency: String,
    start_date: String,
    payment_terms_days: i64,
    source_order_snapshot_sha256: String,
    source_order_snapshot_json: String,
}

#[derive(Debug)]
struct ValidatedSource {
    snapshot_json: String,
    snapshot_sha256: String,
    snapshot: FrozenSourceSnapshot,
}

#[derive(Debug)]
struct ScheduleRow {
    id: String,
    source_sales_order_id: String,
    frequency: String,
    anchor_date: String,
    anchor_day: u32,
    anchor_is_month_end: bool,
    payment_terms_days: i64,
    next_scheduled_for: String,
    end_date: Option<String>,
    status: String,
    source_order_snapshot_sha256: String,
    source_snapshot_sha256: String,
    source_snapshot_json: String,
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

fn normalized_uuid(value: &str, field: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|value| value.to_string())
        .map_err(|_| AppError::Validation(format!("{field} doit être un UUID valide.")))
}

fn valid_date(value: &str, field: &str) -> AppResult<String> {
    let value = required_text(value, field, 10)?;
    let date = NaiveDate::parse_from_str(&value, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(format!(
            "{field} doit être une date valide au format AAAA-MM-JJ."
        ))
    })?;
    if !(1900..=9999).contains(&date.year()) {
        return Err(AppError::Validation(format!(
            "{field} doit être comprise entre 1900 et 9999."
        )));
    }
    Ok(value)
}

fn optional_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(|value| valid_date(&value, field))
        .transpose()
}

fn normalized_frequency(value: &str) -> AppResult<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "monthly" => Ok("monthly".into()),
        "quarterly" => Ok("quarterly".into()),
        "yearly" | "annual" => Ok("yearly".into()),
        _ => Err(AppError::Validation(
            "frequency doit valoir monthly, quarterly ou yearly.".into(),
        )),
    }
}

fn sha256_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn begin_operation<T: Serialize>(
    tx: &Transaction<'_>,
    request_id: &str,
    operation: &str,
    payload: &T,
) -> AppResult<OperationState> {
    let request_id = normalized_uuid(request_id, "request_id")?;
    let mut payload_value = serde_json::to_value(payload)?;
    let payload_object = payload_value.as_object_mut().ok_or_else(|| {
        AppError::Validation("La requête de récurrence doit être un objet JSON.".into())
    })?;
    // request_id est la clé de déduplication, pas une donnée métier du payload.
    // Son empreinte reste donc stable sur le contenu canonique de l'opération.
    payload_object.remove("request_id");
    let payload_json = serde_json::to_string(&payload_value)?;
    if payload_json.len() > MAX_PAYLOAD_BYTES {
        return Err(AppError::Validation(
            "La requête de récurrence dépasse la taille autorisée.".into(),
        ));
    }
    let payload_sha256 = sha256_text(&payload_json);
    let existing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT operation,payload_sha256,response_json FROM recurrence_operation_requests WHERE request_id=?",
            params![request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((stored_operation, stored_hash, stored_response)) = existing {
        if stored_operation != operation || stored_hash != payload_sha256 {
            return Err(AppError::Validation(
                "Ce request_id a déjà été utilisé avec une autre opération de récurrence.".into(),
            ));
        }
        let stored: Value = serde_json::from_str(&stored_response)?;
        let schedule_id = stored["schedule_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("La relecture récurrente est invalide.".into()))?;
        let occurrence_ids = stored["occurrence_ids"]
            .as_array()
            .ok_or_else(|| AppError::Validation("La relecture récurrente est invalide.".into()))?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_owned).ok_or_else(|| {
                    AppError::Validation("La relecture récurrente est invalide.".into())
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let mut response = schedule_result(
            tx,
            schedule_id,
            &occurrence_ids,
            stored["backlog_remaining"].as_bool().unwrap_or(false),
            stored["remaining_due"].as_i64().unwrap_or(0),
        )?;
        if let Some(object) = response.as_object_mut() {
            object.insert("idempotent".into(), Value::Bool(true));
        }
        return Ok(OperationState {
            request_id,
            payload_sha256,
            payload_json,
            replay: Some(response),
        });
    }
    Ok(OperationState {
        request_id,
        payload_sha256,
        payload_json,
        replay: None,
    })
}

fn finish_operation(
    tx: &Transaction<'_>,
    state: &OperationState,
    operation: &str,
    response: &Value,
) -> AppResult<()> {
    let schedule_id = response
        .pointer("/schedule/id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation("La réponse récurrente est invalide.".into()))?;
    let occurrence_ids = response["occurrences"]
        .as_array()
        .ok_or_else(|| AppError::Validation("La réponse récurrente est invalide.".into()))?
        .iter()
        .map(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| AppError::Validation("La réponse récurrente est invalide.".into()))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let response_json = serde_json::to_string(&json!({
        "schema":"helvichantier.recurrence_operation_replay.v1",
        "schedule_id":schedule_id,
        "occurrence_ids":occurrence_ids,
        "backlog_remaining":response["backlog_remaining"].as_bool().unwrap_or(false),
        "remaining_due":response["remaining_due"].as_i64().unwrap_or(0)
    }))?;
    if response_json.len() > MAX_RESPONSE_BYTES {
        return Err(AppError::Validation(
            "La réponse de récurrence dépasse la taille autorisée.".into(),
        ));
    }
    tx.execute(
        "INSERT INTO recurrence_operation_requests(request_id,operation,payload_sha256,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?)",
        params![state.request_id,operation,state.payload_sha256,state.payload_json,response_json,now_iso()],
    )?;
    Ok(())
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

fn checked_sum(values: impl IntoIterator<Item = i64>, field: &str) -> AppResult<i64> {
    values
        .into_iter()
        .try_fold(0_i64, |sum, value| sum.checked_add(value))
        .filter(|value| *value <= MAX_MONEY_CENTS)
        .ok_or_else(|| AppError::Validation(format!("{field} dépasse la limite autorisée.")))
}

fn validate_snapshot(snapshot_json: &str, sales_order_id: &str) -> AppResult<FrozenSourceSnapshot> {
    if !(2..=MAX_SNAPSHOT_BYTES).contains(&snapshot_json.len()) {
        return Err(AppError::Validation(
            "Le snapshot de la commande est absent ou dépasse la taille autorisée.".into(),
        ));
    }
    let snapshot: FrozenSourceSnapshot = serde_json::from_str(snapshot_json).map_err(|_| {
        AppError::Validation("Le snapshot figé de la commande est illisible.".into())
    })?;
    if snapshot.schema != "helvichantier.sales_order_snapshot.v1"
        || snapshot.order.id != sales_order_id
        || snapshot.order.status != "confirmed"
        || snapshot.order.currency != "CHF"
    {
        return Err(AppError::Validation(
            "Le snapshot figé ne correspond pas à une commande confirmée en CHF.".into(),
        ));
    }
    if snapshot.lines.is_empty() || snapshot.lines.len() > 10_000 {
        return Err(AppError::Validation(
            "La commande modèle doit contenir entre 1 et 10000 lignes.".into(),
        ));
    }
    if snapshot
        .lines
        .iter()
        .any(|line| line.fulfillment_mode != "direct")
    {
        return Err(AppError::Validation(
            "La récurrence accepte uniquement des lignes en facturation directe.".into(),
        ));
    }
    let mut gross_values = Vec::with_capacity(snapshot.lines.len());
    let mut net_values = Vec::with_capacity(snapshot.lines.len());
    let mut vat_values = Vec::with_capacity(snapshot.lines.len());
    let mut total_values = Vec::with_capacity(snapshot.lines.len());
    let mut positions = HashSet::with_capacity(snapshot.lines.len());
    for line in &snapshot.lines {
        if line.id.trim().is_empty()
            || line.description.trim().is_empty()
            || line.unit.trim().is_empty()
            || line.quantity_milli <= 0
            || line.unit_price_cents < 0
            || !(0..=10_000).contains(&line.discount_bp)
            || !(0..=10_000).contains(&line.vat_bp)
            || !(0..=1_000_000).contains(&line.position)
            || !positions.insert(line.position)
        {
            return Err(AppError::Validation(
                "Une ligne figée de la commande est invalide.".into(),
            ));
        }
        let gross = rounded_div(
            i128::from(line.quantity_milli) * i128::from(line.unit_price_cents),
            1_000,
            "montant brut récurrent",
        )?;
        let discount = rounded_div(
            i128::from(gross) * i128::from(line.discount_bp),
            10_000,
            "remise récurrente",
        )?;
        let net = gross.checked_sub(discount).ok_or_else(|| {
            AppError::Validation("Le montant net récurrent est incohérent.".into())
        })?;
        let vat = rounded_div(
            i128::from(net) * i128::from(line.vat_bp),
            10_000,
            "TVA récurrente",
        )?;
        let total = net
            .checked_add(vat)
            .ok_or_else(|| AppError::Validation("Le total récurrent dépasse la limite.".into()))?;
        if line.line_net_cents != net
            || line.line_vat_cents != vat
            || line.line_total_cents != total
        {
            return Err(AppError::Validation(
                "Les montants d'une ligne figée sont incohérents.".into(),
            ));
        }
        gross_values.push(gross);
        net_values.push(net);
        vat_values.push(vat);
        total_values.push(total);
    }
    let subtotal = checked_sum(gross_values, "Sous-total récurrent")?;
    let net = checked_sum(net_values, "Total net récurrent")?;
    let vat = checked_sum(vat_values, "TVA récurrente")?;
    let total = checked_sum(total_values, "Total récurrent")?;
    if snapshot.order.subtotal_cents != subtotal
        || snapshot.order.discount_cents != subtotal - net
        || snapshot.order.vat_cents != vat
        || snapshot.order.total_cents != total
        || total != net + vat
    {
        return Err(AppError::Validation(
            "Les totaux figés de la commande sont incohérents.".into(),
        ));
    }
    valid_date(&snapshot.order.order_date, "order_date du snapshot")?;
    if snapshot.order.client_id.trim().is_empty()
        || snapshot.order.number.trim().is_empty()
        || snapshot.order.title.trim().is_empty()
    {
        return Err(AppError::Validation(
            "L'en-tête figé de la commande est incomplet.".into(),
        ));
    }
    Ok(snapshot)
}

fn validate_template_snapshot(schedule: &ScheduleRow) -> AppResult<FrozenRecurrenceTemplate> {
    if sha256_text(&schedule.source_snapshot_json) != schedule.source_snapshot_sha256 {
        return Err(AppError::Validation(
            "L'empreinte du modèle récurrent figé est invalide.".into(),
        ));
    }
    let template: FrozenRecurrenceTemplate =
        serde_json::from_str(&schedule.source_snapshot_json)
            .map_err(|_| AppError::Validation("Le modèle récurrent figé est illisible.".into()))?;
    if template.schema != "helvichantier.recurrence_template.v1"
        || template.frequency != schedule.frequency
        || template.start_date != schedule.anchor_date
        || template.payment_terms_days != schedule.payment_terms_days
        || template.source_order_snapshot_sha256 != schedule.source_order_snapshot_sha256
    {
        return Err(AppError::Validation(
            "Le modèle récurrent figé ne correspond pas à sa planification.".into(),
        ));
    }
    if sha256_text(&template.source_order_snapshot_json) != schedule.source_order_snapshot_sha256 {
        return Err(AppError::Validation(
            "L'empreinte de la commande source figée est invalide.".into(),
        ));
    }
    // Rejoue également toutes les validations financières sur la valeur figée.
    validate_snapshot(
        &template.source_order_snapshot_json,
        &schedule.source_sales_order_id,
    )?;
    Ok(template)
}

fn validate_current_source(
    tx: &Transaction<'_>,
    sales_order_id: &str,
) -> AppResult<ValidatedSource> {
    let source: Option<(String, String, Option<String>)> = tx
        .query_row(
            "SELECT status,currency,snapshot_json FROM sales_orders WHERE id=?",
            params![sales_order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((status, currency, snapshot_json)) = source else {
        return Err(AppError::Validation(
            "La commande source n'existe plus; la planification exige une revue.".into(),
        ));
    };
    if status != "confirmed" {
        return Err(AppError::Validation(
            "La commande source n'est plus confirmée et ouverte; la planification exige une revue."
                .into(),
        ));
    }
    if currency != "CHF" {
        return Err(AppError::Validation(
            "La commande source n'est plus en CHF; la planification exige une revue.".into(),
        ));
    }
    let invalid_line_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sales_order_lines line
         LEFT JOIN catalog_items item ON item.id=line.catalog_item_id
         WHERE line.sales_order_id=? AND (
           line.fulfillment_mode<>'direct' OR COALESCE(item.track_stock,0)=1
         )",
        params![sales_order_id],
        |row| row.get(0),
    )?;
    let line_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sales_order_lines WHERE sales_order_id=?",
        params![sales_order_id],
        |row| row.get(0),
    )?;
    if line_count == 0 || invalid_line_count != 0 {
        return Err(AppError::Validation(
            "La commande source ne contient plus uniquement des lignes directes sans stock; la planification exige une revue."
                .into(),
        ));
    }
    let standard_activity: bool = tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM delivery_notes WHERE sales_order_id=?
           UNION ALL
           SELECT 1 FROM sales_order_invoice_batches WHERE sales_order_id=?
           UNION ALL
           SELECT 1 FROM sales_order_cancellation_lines WHERE sales_order_id=?
         )",
        params![sales_order_id, sales_order_id, sales_order_id],
        |row| row.get(0),
    )?;
    if standard_activity {
        return Err(AppError::Validation(
            "La commande source a déjà suivi un flux de livraison, facturation finale ou annulation; la planification exige une revue."
                .into(),
        ));
    }
    let snapshot_json = snapshot_json.ok_or_else(|| {
        AppError::Validation(
            "La commande source ne possède pas de snapshot figé; la planification exige une revue."
                .into(),
        )
    })?;
    let snapshot = validate_snapshot(&snapshot_json, sales_order_id)?;
    let snapshot_sha256 = sha256_text(&snapshot_json);
    Ok(ValidatedSource {
        snapshot_json,
        snapshot_sha256,
        snapshot,
    })
}

fn days_in_month(year: i32, month: u32) -> AppResult<u32> {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .ok_or_else(|| AppError::Validation("La date récurrente dépasse 9999.".into()))?;
    Ok(first_next
        .pred_opt()
        .ok_or_else(|| AppError::Validation("La date récurrente est invalide.".into()))?
        .day())
}

fn next_period_date(
    current: NaiveDate,
    frequency: &str,
    anchor_day: u32,
    anchor_is_month_end: bool,
) -> AppResult<NaiveDate> {
    let months = match frequency {
        "monthly" => 1_i32,
        "quarterly" => 3,
        "yearly" => 12,
        _ => {
            return Err(AppError::Validation(
                "La fréquence enregistrée est invalide.".into(),
            ))
        }
    };
    let month_index = current
        .year()
        .checked_mul(12)
        .and_then(|value| value.checked_add(current.month0() as i32))
        .and_then(|value| value.checked_add(months))
        .ok_or_else(|| AppError::Validation("La date récurrente dépasse 9999.".into()))?;
    let year = month_index.div_euclid(12);
    let month = month_index.rem_euclid(12) as u32 + 1;
    if !(1900..=9999).contains(&year) {
        return Err(AppError::Validation(
            "La prochaine date récurrente dépasse la plage autorisée.".into(),
        ));
    }
    let last_day = days_in_month(year, month)?;
    let day = if anchor_is_month_end {
        last_day
    } else {
        anchor_day.min(last_day)
    };
    NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| AppError::Validation("La prochaine date récurrente est invalide.".into()))
}

fn count_due_occurrences(
    mut next: NaiveDate,
    through: NaiveDate,
    end: Option<NaiveDate>,
    frequency: &str,
    anchor_day: u32,
    anchor_is_month_end: bool,
) -> AppResult<i64> {
    let mut count = 0_i64;
    while next <= through && end.is_none_or(|end| next <= end) {
        count = count.checked_add(1).ok_or_else(|| {
            AppError::Validation("Le nombre d'occurrences dues dépasse la limite.".into())
        })?;
        next = next_period_date(next, frequency, anchor_day, anchor_is_month_end)?;
    }
    Ok(count)
}

fn load_schedule(tx: &Transaction<'_>, schedule_id: &str) -> AppResult<ScheduleRow> {
    tx.query_row(
        "SELECT id,source_sales_order_id,frequency,anchor_date,anchor_day,anchor_is_month_end,payment_terms_days,next_scheduled_for,end_date,status,source_order_snapshot_sha256,source_snapshot_sha256,source_snapshot_json
         FROM recurrence_schedules WHERE id=?",
        params![schedule_id],
        |row| {
            Ok(ScheduleRow {
                id: row.get(0)?,
                source_sales_order_id: row.get(1)?,
                frequency: row.get(2)?,
                anchor_date: row.get(3)?,
                anchor_day: row.get::<_, i64>(4)? as u32,
                anchor_is_month_end: row.get::<_, i64>(5)? == 1,
                payment_terms_days: row.get(6)?,
                next_scheduled_for: row.get(7)?,
                end_date: row.get(8)?,
                status: row.get(9)?,
                source_order_snapshot_sha256: row.get(10)?,
                source_snapshot_sha256: row.get(11)?,
                source_snapshot_json: row.get(12)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("recurrence_schedules/{schedule_id}")))
}

fn schedule_record(tx: &Transaction<'_>, schedule_id: &str) -> AppResult<Value> {
    let mut record = query_record_tx(tx, "recurrence_schedules", schedule_id)?;
    if let Some(object) = record.as_object_mut() {
        object.remove("source_snapshot_json");
    }
    Ok(record)
}

fn occurrence_result(tx: &Transaction<'_>, occurrence_id: &str) -> AppResult<Value> {
    query_record_tx(tx, "recurrence_occurrences", occurrence_id)
}

fn schedule_result(
    tx: &Transaction<'_>,
    schedule_id: &str,
    occurrence_ids: &[String],
    backlog_remaining: bool,
    remaining_due: i64,
) -> AppResult<Value> {
    let occurrences = occurrence_ids
        .iter()
        .map(|id| occurrence_result(tx, id))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(json!({
        "schedule":schedule_record(tx,schedule_id)?,
        "occurrences":occurrences,
        "created_count":occurrence_ids.len(),
        "backlog_remaining":backlog_remaining,
        "remaining_due":remaining_due,
        "idempotent":false
    }))
}

fn create_draft_invoice(
    tx: &Transaction<'_>,
    schedule: &ScheduleRow,
    snapshot: &FrozenSourceSnapshot,
    scheduled_for: &str,
    request_id: &str,
    payload_sha256: &str,
) -> AppResult<String> {
    let scheduled_date = NaiveDate::parse_from_str(scheduled_for, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("La date d'occurrence est invalide.".into()))?;
    let due_date = scheduled_date
        .checked_add_days(Days::new(schedule.payment_terms_days as u64))
        .ok_or_else(|| AppError::Validation("L'échéance de facture dépasse 9999.".into()))?
        .format("%Y-%m-%d")
        .to_string();
    let invoice_id = Uuid::new_v4().to_string();
    let occurrence_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let provenance = serde_json::to_string(&json!({
        "schema":"helvichantier.recurrence_invoice_draft.v1",
        "generated_at":now,
        "schedule_id":schedule.id,
        "scheduled_for":scheduled_for,
        "source_sales_order_id":schedule.source_sales_order_id,
        "source_snapshot_sha256":schedule.source_snapshot_sha256,
        "payment_terms_days":schedule.payment_terms_days
    }))?;
    tx.execute(
        "INSERT INTO invoices(
           id,client_id,project_id,number,title,type,status,issue_date,due_date,
           service_date_from,service_date_to,currency,subtotal_cents,discount_cents,
           vat_cents,total_cents,paid_cents,notes,terms,snapshot_json,created_at,updated_at
         ) VALUES(?,?,?,NULL,?,'standard','brouillon',?,?,?,?,'CHF',?,?,?,?,0,?,?,?,?,?)",
        params![
            invoice_id,
            snapshot.order.client_id,
            snapshot.order.project_id,
            format!("Facture récurrente — {}", snapshot.order.title),
            scheduled_for,
            due_date,
            scheduled_for,
            scheduled_for,
            snapshot.order.subtotal_cents,
            snapshot.order.discount_cents,
            snapshot.order.vat_cents,
            snapshot.order.total_cents,
            snapshot.order.notes,
            snapshot.order.terms,
            provenance,
            now,
            now
        ],
    )?;
    for line in &snapshot.lines {
        tx.execute(
            "INSERT INTO invoice_items(
               id,invoice_id,catalog_item_id,position,description,quantity,unit,
               unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,
               line_total_cents,created_at,updated_at
             ) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                Uuid::new_v4().to_string(),
                invoice_id,
                line.position,
                line.description,
                line.quantity_milli as f64 / 1_000.0,
                line.unit,
                line.unit_price_cents,
                line.discount_bp,
                line.vat_bp,
                line.line_net_cents,
                line.line_vat_cents,
                line.line_total_cents,
                now,
                now
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO recurrence_occurrences(
           id,schedule_id,scheduled_for,invoice_id,request_id,payload_sha256,
           source_snapshot_sha256,created_at
         ) VALUES(?,?,?,?,?,?,?,?)",
        params![
            occurrence_id,
            schedule.id,
            scheduled_for,
            invoice_id,
            request_id,
            payload_sha256,
            schedule.source_snapshot_sha256,
            now
        ],
    )?;
    Ok(occurrence_id)
}

fn review_reason(error: AppError) -> Result<String, AppError> {
    match error {
        AppError::Validation(message) => Ok(message),
        AppError::NotFound(path) => Ok(format!(
            "La source {path} est introuvable; la planification exige une revue."
        )),
        other => Err(other),
    }
}

impl LocalStore {
    pub fn create_recurrence_schedule(
        &self,
        input: CreateRecurrenceScheduleInput,
    ) -> AppResult<Value> {
        let normalized = CreateRecurrenceScheduleInput {
            request_id: normalized_uuid(&input.request_id, "request_id")?,
            source_sales_order_id: required_text(
                &input.source_sales_order_id,
                "source_sales_order_id",
                255,
            )?,
            frequency: normalized_frequency(&input.frequency)?,
            start_date: valid_date(&input.start_date, "start_date")?,
            end_date: optional_date(input.end_date, "end_date")?,
            payment_terms_days: input.payment_terms_days,
        };
        if !(0..=365).contains(&normalized.payment_terms_days) {
            return Err(AppError::Validation(
                "payment_terms_days doit être compris entre 0 et 365.".into(),
            ));
        }
        if normalized
            .end_date
            .as_deref()
            .is_some_and(|end| end < normalized.start_date.as_str())
        {
            return Err(AppError::Validation(
                "end_date ne peut pas précéder start_date.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation =
            begin_operation(&tx, &normalized.request_id, "create_schedule", &normalized)?;
        if let Some(replay) = operation.replay.clone() {
            tx.commit()?;
            return Ok(replay);
        }
        if let Some(existing_id) = tx
            .query_row(
                "SELECT id FROM recurrence_schedules WHERE source_sales_order_id=?",
                params![normalized.source_sales_order_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Err(AppError::Validation(format!(
                "Cette commande possède déjà la planification {existing_id}; modifiez, mettez en pause ou reprenez cette planification au lieu d'en créer une autre."
            )));
        }
        let source = validate_current_source(&tx, &normalized.source_sales_order_id)?;
        if normalized.start_date < source.snapshot.order.order_date {
            return Err(AppError::Validation(
                "start_date ne peut pas précéder la date de la commande modèle.".into(),
            ));
        }
        let anchor =
            NaiveDate::parse_from_str(&normalized.start_date, "%Y-%m-%d").expect("validated date");
        let anchor_is_month_end = anchor.day() == days_in_month(anchor.year(), anchor.month())?;
        let source_snapshot_json = serde_json::to_string(&json!({
            "schema":"helvichantier.recurrence_template.v1",
            "frequency":normalized.frequency,
            "start_date":normalized.start_date,
            "payment_terms_days":normalized.payment_terms_days,
            "source_order_snapshot_sha256":source.snapshot_sha256,
            "source_order_snapshot_json":source.snapshot_json
        }))?;
        if source_snapshot_json.len() > MAX_SNAPSHOT_BYTES {
            return Err(AppError::Validation(
                "Le modèle récurrent figé dépasse la taille autorisée.".into(),
            ));
        }
        let source_snapshot_sha256 = sha256_text(&source_snapshot_json);
        let schedule_id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute(
            "INSERT INTO recurrence_schedules(
               id,source_sales_order_id,frequency,anchor_date,anchor_day,
               anchor_is_month_end,payment_terms_days,next_scheduled_for,end_date,status,
               source_order_snapshot_sha256,source_snapshot_sha256,source_snapshot_json,
               created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)",
            params![
                schedule_id,
                normalized.source_sales_order_id,
                normalized.frequency,
                normalized.start_date,
                i64::from(anchor.day()),
                i64::from(anchor_is_month_end),
                normalized.payment_terms_days,
                normalized.start_date,
                normalized.end_date,
                source.snapshot_sha256,
                source_snapshot_sha256,
                source_snapshot_json,
                now,
                now
            ],
        )?;
        let response = schedule_result(&tx, &schedule_id, &[], false, 0)?;
        finish_operation(&tx, &operation, "create_schedule", &response)?;
        append_audit(
            &tx,
            "create_recurrence_schedule",
            "sales_order",
            &normalized.source_sales_order_id,
            &json!({"schedule_id":schedule_id,"frequency":normalized.frequency,"start_date":normalized.start_date,"end_date":normalized.end_date,"payment_terms_days":normalized.payment_terms_days,"source_snapshot_sha256":source_snapshot_sha256,"source_order_snapshot_sha256":source.snapshot_sha256}),
        )?;
        tx.commit()?;
        Ok(response)
    }

    pub fn update_recurrence_schedule(
        &self,
        input: UpdateRecurrenceScheduleInput,
    ) -> AppResult<Value> {
        let status = match input.status.trim().to_ascii_lowercase().as_str() {
            "active" => "active".to_owned(),
            "paused" => "paused".to_owned(),
            "completed" => "completed".to_owned(),
            _ => {
                return Err(AppError::Validation(
                    "status doit valoir active, paused ou completed.".into(),
                ))
            }
        };
        let normalized = UpdateRecurrenceScheduleInput {
            request_id: normalized_uuid(&input.request_id, "request_id")?,
            schedule_id: normalized_uuid(&input.schedule_id, "schedule_id")?,
            status,
            end_date: optional_date(input.end_date, "end_date")?,
        };
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation =
            begin_operation(&tx, &normalized.request_id, "update_schedule", &normalized)?;
        if let Some(replay) = operation.replay.clone() {
            tx.commit()?;
            return Ok(replay);
        }
        let schedule = load_schedule(&tx, &normalized.schedule_id)?;
        if schedule.status == "completed" {
            return Err(AppError::Validation(
                "Cette planification est terminée et ne peut pas être réactivée.".into(),
            ));
        }
        if normalized
            .end_date
            .as_deref()
            .is_some_and(|end| end < schedule.anchor_date.as_str())
        {
            return Err(AppError::Validation(
                "end_date ne peut pas précéder la date de départ.".into(),
            ));
        }
        if let Some(end_date) = normalized.end_date.as_deref() {
            let occurrence_after_end: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM recurrence_occurrences WHERE schedule_id=? AND scheduled_for>?)",
                params![schedule.id, end_date],
                |row| row.get(0),
            )?;
            if occurrence_after_end {
                return Err(AppError::Validation(
                    "end_date ne peut pas précéder une occurrence déjà créée.".into(),
                ));
            }
        }
        if normalized.status == "active" {
            let source = validate_current_source(&tx, &schedule.source_sales_order_id)?;
            if source.snapshot_sha256 != schedule.source_order_snapshot_sha256 {
                return Err(AppError::Validation(
                    "Le snapshot de la commande ne correspond plus au modèle figé; la reprise est bloquée."
                        .into(),
                ));
            }
        }
        let completed = normalized.status == "completed"
            || normalized
                .end_date
                .as_deref()
                .is_some_and(|end| schedule.next_scheduled_for.as_str() > end);
        let now = now_iso();
        tx.execute(
            "UPDATE recurrence_schedules SET status=?,end_date=?,review_reason=NULL,completed_at=?,updated_at=? WHERE id=?",
            params![
                if completed { "completed" } else { normalized.status.as_str() },
                normalized.end_date,
                completed.then_some(now.as_str()),
                now,
                normalized.schedule_id
            ],
        )?;
        let response = schedule_result(&tx, &normalized.schedule_id, &[], false, 0)?;
        finish_operation(&tx, &operation, "update_schedule", &response)?;
        append_audit(
            &tx,
            "update_recurrence_schedule",
            "recurrence_schedule",
            &normalized.schedule_id,
            &json!({"requested_status":normalized.status,"end_date":normalized.end_date,"completed":completed}),
        )?;
        tx.commit()?;
        Ok(response)
    }

    pub fn generate_recurrence_occurrences(
        &self,
        input: GenerateRecurrenceOccurrencesInput,
    ) -> AppResult<Value> {
        let normalized = GenerateRecurrenceOccurrencesInput {
            request_id: normalized_uuid(&input.request_id, "request_id")?,
            schedule_id: normalized_uuid(&input.schedule_id, "schedule_id")?,
            through_date: valid_date(&input.through_date, "through_date")?,
        };
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(
            &tx,
            &normalized.request_id,
            "generate_occurrences",
            &normalized,
        )?;
        if let Some(replay) = operation.replay.clone() {
            tx.commit()?;
            return Ok(replay);
        }
        let schedule = load_schedule(&tx, &normalized.schedule_id)?;
        if schedule.status != "active" {
            let through = NaiveDate::parse_from_str(&normalized.through_date, "%Y-%m-%d")
                .expect("validated date");
            let next = NaiveDate::parse_from_str(&schedule.next_scheduled_for, "%Y-%m-%d")
                .map_err(|_| {
                    AppError::Validation("La prochaine occurrence est invalide.".into())
                })?;
            let end = schedule
                .end_date
                .as_deref()
                .map(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d"))
                .transpose()
                .map_err(|_| {
                    AppError::Validation("La date de fin enregistrée est invalide.".into())
                })?;
            let remaining_due = if schedule.status == "completed" {
                0
            } else {
                count_due_occurrences(
                    next,
                    through,
                    end,
                    &schedule.frequency,
                    schedule.anchor_day,
                    schedule.anchor_is_month_end,
                )?
            };
            let response =
                schedule_result(&tx, &schedule.id, &[], remaining_due > 0, remaining_due)?;
            finish_operation(&tx, &operation, "generate_occurrences", &response)?;
            tx.commit()?;
            return Ok(response);
        }
        let source = match validate_current_source(&tx, &schedule.source_sales_order_id) {
            Ok(source) if source.snapshot_sha256 == schedule.source_order_snapshot_sha256 => source,
            Ok(_) => {
                let reason = "Le snapshot de la commande source ne correspond plus au modèle figé; une revue manuelle est requise.".to_owned();
                let now = now_iso();
                tx.execute(
                    "UPDATE recurrence_schedules SET status='review_required',review_reason=?,updated_at=? WHERE id=?",
                    params![reason, now, schedule.id],
                )?;
                let response = schedule_result(&tx, &schedule.id, &[], false, 0)?;
                finish_operation(&tx, &operation, "generate_occurrences", &response)?;
                append_audit(
                    &tx,
                    "review_recurrence_schedule",
                    "recurrence_schedule",
                    &schedule.id,
                    &json!({"reason":reason}),
                )?;
                tx.commit()?;
                return Ok(response);
            }
            Err(error) => {
                let reason = review_reason(error)?;
                let now = now_iso();
                tx.execute(
                    "UPDATE recurrence_schedules SET status='review_required',review_reason=?,updated_at=? WHERE id=?",
                    params![reason, now, schedule.id],
                )?;
                let response = schedule_result(&tx, &schedule.id, &[], false, 0)?;
                finish_operation(&tx, &operation, "generate_occurrences", &response)?;
                append_audit(
                    &tx,
                    "review_recurrence_schedule",
                    "recurrence_schedule",
                    &schedule.id,
                    &json!({"reason":reason}),
                )?;
                tx.commit()?;
                return Ok(response);
            }
        };
        let template = validate_template_snapshot(&schedule)?;
        let stored_snapshot = validate_snapshot(
            &template.source_order_snapshot_json,
            &schedule.source_sales_order_id,
        )?;
        let through = NaiveDate::parse_from_str(&normalized.through_date, "%Y-%m-%d")
            .expect("validated date");
        let mut next = NaiveDate::parse_from_str(&schedule.next_scheduled_for, "%Y-%m-%d")
            .map_err(|_| AppError::Validation("La prochaine occurrence est invalide.".into()))?;
        let end = schedule
            .end_date
            .as_deref()
            .map(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d"))
            .transpose()
            .map_err(|_| AppError::Validation("La date de fin enregistrée est invalide.".into()))?;
        let mut occurrence_ids = Vec::new();
        while occurrence_ids.len() < MAX_CATCH_UP
            && next <= through
            && end.is_none_or(|end| next <= end)
        {
            let scheduled_for = next.format("%Y-%m-%d").to_string();
            let duplicate: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM recurrence_occurrences WHERE schedule_id=? AND scheduled_for=?)",
                params![schedule.id, scheduled_for],
                |row| row.get(0),
            )?;
            if duplicate {
                return Err(AppError::Validation(
                    "Une occurrence existe déjà pour la prochaine date; la planification exige une revue."
                        .into(),
                ));
            }
            occurrence_ids.push(create_draft_invoice(
                &tx,
                &schedule,
                &stored_snapshot,
                &scheduled_for,
                &operation.request_id,
                &operation.payload_sha256,
            )?);
            next = next_period_date(
                next,
                &schedule.frequency,
                schedule.anchor_day,
                schedule.anchor_is_month_end,
            )?;
        }
        let completed = end.is_some_and(|end| next > end);
        let remaining_due = if completed {
            0
        } else {
            count_due_occurrences(
                next,
                through,
                end,
                &schedule.frequency,
                schedule.anchor_day,
                schedule.anchor_is_month_end,
            )?
        };
        let backlog_remaining = remaining_due > 0;
        let next_status = if completed {
            "completed"
        } else if backlog_remaining {
            "review_required"
        } else {
            "active"
        };
        let review_reason = backlog_remaining.then(|| {
            format!(
                "Le rattrapage est limité à {MAX_CATCH_UP} factures par lancement; {remaining_due} occurrence(s) restent dues. Reprenez explicitement la planification avant le prochain lot."
            )
        });
        let now = now_iso();
        tx.execute(
            "UPDATE recurrence_schedules SET next_scheduled_for=?,status=?,review_reason=?,completed_at=?,updated_at=? WHERE id=?",
            params![
                next.format("%Y-%m-%d").to_string(),
                next_status,
                review_reason,
                completed.then_some(now.as_str()),
                now,
                schedule.id
            ],
        )?;
        let response = schedule_result(
            &tx,
            &schedule.id,
            &occurrence_ids,
            backlog_remaining,
            remaining_due,
        )?;
        finish_operation(&tx, &operation, "generate_occurrences", &response)?;
        append_audit(
            &tx,
            "generate_recurrence_occurrences",
            "recurrence_schedule",
            &schedule.id,
            &json!({
                "request_id":operation.request_id,
                "through_date":normalized.through_date,
                "occurrence_ids":occurrence_ids,
                "created_count":response["created_count"],
                "backlog_remaining":backlog_remaining,
                "completed":completed,
                "remaining_due":remaining_due,
                "source_snapshot_sha256":schedule.source_snapshot_sha256,
                "source_order_snapshot_sha256":source.snapshot_sha256
            }),
        )?;
        tx.commit()?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, OptionalExtension};
    use serde_json::{json, Value};

    use super::*;
    use crate::{
        models::{
            CancelSalesOrderInput, CancelSalesOrderRemainderInput,
            CancelSalesOrderRemainderLineInput, ConfirmSalesOrderInput,
            ConvertQuoteToSalesOrderInput, CreateSalesOrderInvoiceInput, DeliveryNoteDraftInput,
            DeliveryNoteLineInput, PreviewSalesOrderInvoiceInput, SalesOrderDraftInput,
            SalesOrderInvoiceAllocationInput, SalesOrderLineInput, SaveDeliveryNoteDraftInput,
            SaveSalesOrderDraftInput,
        },
        schema::SCHEMA_VERSION,
    };

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO settings(
                   id,onboarding_completed,company_name,iban,address_line1,postal_code,city,country,
                   noga_section,noga_division,activity_description,created_at,updated_at
                 ) VALUES(1,1,'Entreprise récurrente','CH9300762011623852957',
                          'Rue du Test 1','1000','Lausanne','CH','F','43',
                          'Services spécialisés de construction',?,?)",
                params![now, now],
            )
            .unwrap();
        drop(connection);
        (temporary, store)
    }

    fn id(record: &Value) -> String {
        record["id"].as_str().unwrap().to_owned()
    }

    fn confirmed_order(
        store: &LocalStore,
        order_date: &str,
        fulfillment_mode: &str,
    ) -> (String, String) {
        let client_id = id(&store
            .create_record(
                "clients",
                json!({
                    "name":"Client abonnement",
                    "address_line1":"Route du Client 2",
                    "postal_code":"1200",
                    "city":"Genève",
                    "country":"CH"
                }),
            )
            .unwrap());
        let draft = store
            .save_sales_order_draft(SaveSalesOrderDraftInput {
                order: SalesOrderDraftInput {
                    id: None,
                    client_id,
                    project_id: None,
                    title: "Maintenance mensuelle".into(),
                    order_date: order_date.into(),
                    currency: "CHF".into(),
                    notes: Some("Intervention planifiée".into()),
                    terms: Some("Selon contrat-cadre".into()),
                },
                lines: vec![SalesOrderLineInput {
                    id: None,
                    catalog_item_id: None,
                    position: 0,
                    description: "Forfait de maintenance".into(),
                    quantity_milli: 1_500,
                    unit: "heure".into(),
                    unit_price_cents: 20_000,
                    discount_bp: 500,
                    vat_bp: 810,
                    fulfillment_mode: fulfillment_mode.into(),
                }],
            })
            .unwrap();
        let order_id = draft["order"]["id"].as_str().unwrap().to_owned();
        let line_id = draft["lines"][0]["id"].as_str().unwrap().to_owned();
        store
            .confirm_sales_order(crate::models::ConfirmSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
            })
            .unwrap();
        (order_id, line_id)
    }

    fn create_schedule(
        store: &LocalStore,
        order_id: &str,
        frequency: &str,
        start_date: &str,
        end_date: Option<&str>,
        payment_terms_days: i64,
    ) -> (CreateRecurrenceScheduleInput, Value) {
        let input = CreateRecurrenceScheduleInput {
            request_id: Uuid::new_v4().to_string(),
            source_sales_order_id: order_id.into(),
            frequency: frequency.into(),
            start_date: start_date.into(),
            end_date: end_date.map(str::to_owned),
            payment_terms_days,
        };
        let result = store.create_recurrence_schedule(input.clone()).unwrap();
        (input, result)
    }

    #[test]
    fn accepted_service_quote_reaches_a_supervised_recurring_draft() {
        let (_temporary, store) = initialized_store();
        let client_id = id(&store
            .create_record(
                "clients",
                json!({
                    "name":"Client du contrat",
                    "address_line1":"Rue du Service 8",
                    "postal_code":"1000",
                    "city":"Lausanne",
                    "country":"CH"
                }),
            )
            .unwrap());
        let quote_id = id(&store
            .create_record(
                "quotes",
                json!({
                    "client_id":client_id,
                    "title":"Contrat de maintenance récurrent"
                }),
            )
            .unwrap());
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":quote_id,
                    "description":"Maintenance mensuelle",
                    "quantity":1.0,
                    "unit":"forfait",
                    "unit_price_cents":25_000,
                    "discount_bp":0,
                    "vat_bp":810
                }),
            )
            .unwrap();
        store
            .issue_quote(
                &quote_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();
        store.update_quote_status(&quote_id, "accepted").unwrap();

        let converted = store
            .convert_quote_to_sales_order(ConvertQuoteToSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                quote_id: quote_id.clone(),
            })
            .unwrap();
        let order_id = converted["order"]["id"].as_str().unwrap().to_owned();
        assert_eq!(converted["order"]["quote_id"], quote_id);
        assert_eq!(converted["lines"][0]["fulfillment_mode"], "direct");
        store
            .confirm_sales_order(ConfirmSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
            })
            .unwrap();
        let (_, schedule) = create_schedule(&store, &order_id, "monthly", "2026-09-30", None, 30);
        let generated = store
            .generate_recurrence_occurrences(GenerateRecurrenceOccurrencesInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule["schedule"]["id"].as_str().unwrap().to_owned(),
                through_date: "2026-09-30".into(),
            })
            .unwrap();
        assert_eq!(generated["created_count"], 1);
        let invoice_id = generated["occurrences"][0]["invoice_id"].as_str().unwrap();
        let connection = store.connect().unwrap();
        let (status, number): (String, Option<String>) = connection
            .query_row(
                "SELECT status,number FROM invoices WHERE id=?",
                params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "brouillon");
        assert!(number.is_none());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM invoice_qr_bills WHERE invoice_id=?",
                    params![invoice_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn end_of_month_and_leap_year_are_deterministic() {
        let january_end = NaiveDate::from_ymd_opt(2024, 1, 31).unwrap();
        let february_end = next_period_date(january_end, "monthly", 31, true).unwrap();
        assert_eq!(february_end, NaiveDate::from_ymd_opt(2024, 2, 29).unwrap());
        assert_eq!(
            next_period_date(february_end, "monthly", 31, true).unwrap(),
            NaiveDate::from_ymd_opt(2024, 3, 31).unwrap()
        );

        let january_thirtieth = NaiveDate::from_ymd_opt(2024, 1, 30).unwrap();
        let clamped = next_period_date(january_thirtieth, "monthly", 30, false).unwrap();
        assert_eq!(clamped, NaiveDate::from_ymd_opt(2024, 2, 29).unwrap());
        assert_eq!(
            next_period_date(clamped, "monthly", 30, false).unwrap(),
            NaiveDate::from_ymd_opt(2024, 3, 30).unwrap()
        );

        assert_eq!(
            next_period_date(january_end, "quarterly", 31, true).unwrap(),
            NaiveDate::from_ymd_opt(2024, 4, 30).unwrap()
        );
        assert_eq!(
            next_period_date(
                NaiveDate::from_ymd_opt(2024, 2, 29).unwrap(),
                "yearly",
                29,
                true,
            )
            .unwrap(),
            NaiveDate::from_ymd_opt(2025, 2, 28).unwrap()
        );
    }

    #[test]
    fn catch_up_is_capped_replayable_and_creates_only_isolated_drafts() {
        let (_temporary, store) = initialized_store();
        let (order_id, _) = confirmed_order(&store, "2024-01-01", "direct");
        let (create_input, created_schedule) =
            create_schedule(&store, &order_id, "monthly", "2024-01-31", None, 10);
        let schedule_id = created_schedule["schedule"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(created_schedule["schedule"]["frequency"], "monthly");
        assert_eq!(created_schedule["schedule"]["payment_terms_days"], 10);
        assert!(created_schedule["schedule"]
            .get("source_snapshot_json")
            .is_none());

        let generate = GenerateRecurrenceOccurrencesInput {
            request_id: Uuid::new_v4().to_string(),
            schedule_id: schedule_id.clone(),
            through_date: "2025-03-31".into(),
        };
        let first = store
            .generate_recurrence_occurrences(generate.clone())
            .unwrap();
        assert_eq!(first["created_count"], 12);
        assert_eq!(first["backlog_remaining"], true);
        assert_eq!(first["remaining_due"], 3);
        assert_eq!(first["schedule"]["status"], "review_required");
        assert_eq!(first["schedule"]["next_scheduled_for"], "2025-01-31");
        assert_eq!(first["occurrences"].as_array().unwrap().len(), 12);
        assert!(first["occurrences"][0].get("invoice").is_none());

        let connection = store.connect().unwrap();
        let scheduled: Vec<String> = connection
            .prepare(
                "SELECT scheduled_for FROM recurrence_occurrences WHERE schedule_id=? ORDER BY scheduled_for",
            )
            .unwrap()
            .query_map(params![schedule_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            scheduled,
            vec![
                "2024-01-31",
                "2024-02-29",
                "2024-03-31",
                "2024-04-30",
                "2024-05-31",
                "2024-06-30",
                "2024-07-31",
                "2024-08-31",
                "2024-09-30",
                "2024-10-31",
                "2024-11-30",
                "2024-12-31",
            ]
        );
        let first_invoice: (String, String, String, Option<String>, i64) = connection
            .query_row(
                "SELECT invoice.issue_date,invoice.due_date,invoice.status,invoice.number,invoice.paid_cents
                 FROM recurrence_occurrences occurrence
                 JOIN invoices invoice ON invoice.id=occurrence.invoice_id
                 WHERE occurrence.schedule_id=? ORDER BY occurrence.scheduled_for LIMIT 1",
                params![schedule_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            first_invoice,
            (
                "2024-01-31".into(),
                "2024-02-10".into(),
                "brouillon".into(),
                None,
                0,
            )
        );
        let isolation: (i64, i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM recurrence_occurrences WHERE schedule_id=?),
                   (SELECT COUNT(*) FROM sales_order_invoice_batches WHERE sales_order_id=?),
                   (SELECT COUNT(*) FROM invoice_qr_bills qr JOIN recurrence_occurrences occurrence ON occurrence.invoice_id=qr.invoice_id WHERE occurrence.schedule_id=?),
                   (SELECT COUNT(*) FROM stock_movements movement JOIN recurrence_occurrences occurrence ON occurrence.invoice_id=movement.invoice_id WHERE occurrence.schedule_id=?),
                   (SELECT COUNT(*) FROM journal_entries entry JOIN recurrence_occurrences occurrence ON occurrence.invoice_id=entry.source_id WHERE occurrence.schedule_id=?),
                   (SELECT COUNT(*) FROM invoice_items item JOIN recurrence_occurrences occurrence ON occurrence.invoice_id=item.invoice_id WHERE occurrence.schedule_id=? AND item.catalog_item_id IS NOT NULL)",
                params![schedule_id, order_id, schedule_id, schedule_id, schedule_id, schedule_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )
            .unwrap();
        assert_eq!(isolation, (12, 0, 0, 0, 0, 0));
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM sales_orders WHERE id=?",
                    params![&order_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "confirmed"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT json_extract(payload_json,'$.request_id') FROM recurrence_operation_requests WHERE request_id=?",
                    params![generate.request_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None
        );
        drop(connection);

        let replay = store
            .generate_recurrence_occurrences(generate.clone())
            .unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["created_count"], 12);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM recurrence_occurrences", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            12
        );
        let mut conflicting_generate = generate.clone();
        conflicting_generate.through_date = "2025-04-30".into();
        assert!(store
            .generate_recurrence_occurrences(conflicting_generate)
            .unwrap_err()
            .to_string()
            .contains("request_id"));

        let paused_tick = store
            .generate_recurrence_occurrences(GenerateRecurrenceOccurrencesInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                through_date: "2025-03-31".into(),
            })
            .unwrap();
        assert_eq!(paused_tick["created_count"], 0);
        assert_eq!(paused_tick["schedule"]["status"], "review_required");
        assert_eq!(paused_tick["remaining_due"], 3);

        let resume = UpdateRecurrenceScheduleInput {
            request_id: Uuid::new_v4().to_string(),
            schedule_id: schedule_id.clone(),
            status: "active".into(),
            end_date: None,
        };
        let resumed = store.update_recurrence_schedule(resume.clone()).unwrap();
        assert_eq!(resumed["schedule"]["status"], "active");
        assert_eq!(
            store.update_recurrence_schedule(resume.clone()).unwrap()["idempotent"],
            true
        );
        let mut conflicting_resume = resume;
        conflicting_resume.status = "paused".into();
        assert!(store
            .update_recurrence_schedule(conflicting_resume)
            .unwrap_err()
            .to_string()
            .contains("request_id"));

        let second = store
            .generate_recurrence_occurrences(GenerateRecurrenceOccurrencesInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                through_date: "2025-03-31".into(),
            })
            .unwrap();
        assert_eq!(second["created_count"], 3);
        assert_eq!(second["remaining_due"], 0);
        assert_eq!(second["schedule"]["status"], "active");

        let double_tick = store
            .generate_recurrence_occurrences(GenerateRecurrenceOccurrencesInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                through_date: "2025-03-31".into(),
            })
            .unwrap();
        assert_eq!(double_tick["created_count"], 0);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM recurrence_occurrences", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            15
        );

        let duplicate = CreateRecurrenceScheduleInput {
            request_id: Uuid::new_v4().to_string(),
            ..create_input
        };
        assert!(store
            .create_recurrence_schedule(duplicate)
            .unwrap_err()
            .to_string()
            .contains("déjà la planification"));

        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE recurrence_operation_requests SET payload_json='{}' WHERE request_id=?",
                params![generate.request_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM recurrence_operation_requests WHERE request_id=?",
                params![generate.request_id],
            )
            .is_err());
    }

    #[test]
    fn pause_resume_end_date_and_completed_state_are_supervised() {
        let (_temporary, store) = initialized_store();
        let (order_id, _) = confirmed_order(&store, "2024-01-01", "direct");
        let (_, created) = create_schedule(
            &store,
            &order_id,
            "quarterly",
            "2024-01-31",
            Some("2024-04-30"),
            30,
        );
        let schedule_id = created["schedule"]["id"].as_str().unwrap().to_owned();

        let pause = UpdateRecurrenceScheduleInput {
            request_id: Uuid::new_v4().to_string(),
            schedule_id: schedule_id.clone(),
            status: "paused".into(),
            end_date: Some("2024-04-30".into()),
        };
        assert_eq!(
            store.update_recurrence_schedule(pause.clone()).unwrap()["schedule"]["status"],
            "paused"
        );
        let paused_generate = GenerateRecurrenceOccurrencesInput {
            request_id: Uuid::new_v4().to_string(),
            schedule_id: schedule_id.clone(),
            through_date: "2025-12-31".into(),
        };
        let paused = store
            .generate_recurrence_occurrences(paused_generate.clone())
            .unwrap();
        assert_eq!(paused["created_count"], 0);
        assert_eq!(paused["schedule"]["status"], "paused");
        assert_eq!(paused["remaining_due"], 2);
        assert_eq!(
            store
                .generate_recurrence_occurrences(paused_generate)
                .unwrap()["idempotent"],
            true
        );

        store
            .update_recurrence_schedule(UpdateRecurrenceScheduleInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                status: "active".into(),
                end_date: Some("2024-04-30".into()),
            })
            .unwrap();
        let generated = store
            .generate_recurrence_occurrences(GenerateRecurrenceOccurrencesInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                through_date: "2025-12-31".into(),
            })
            .unwrap();
        assert_eq!(generated["created_count"], 2);
        assert_eq!(generated["schedule"]["status"], "completed");
        assert!(generated["schedule"]["completed_at"].is_string());
        assert_eq!(generated["schedule"]["next_scheduled_for"], "2024-07-31");
        assert!(store
            .update_recurrence_schedule(UpdateRecurrenceScheduleInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                status: "active".into(),
                end_date: Some("2024-04-30".into()),
            })
            .unwrap_err()
            .to_string()
            .contains("terminée"));

        let workspace = store.get_workspace().unwrap();
        let schedule = workspace["recurrence_schedules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == schedule_id)
            .unwrap();
        assert_eq!(schedule["status"], "completed");
        assert!(schedule.get("source_snapshot_json").is_none());
        assert_eq!(
            workspace["recurrence_occurrences"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["schedule_id"] == schedule_id)
                .count(),
            2
        );

        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE recurrence_schedules SET status='active',completed_at=NULL WHERE id=?",
                params![schedule_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE recurrence_schedules SET end_date='2024-01-01' WHERE id=?",
                params![schedule_id],
            )
            .is_err());
    }

    #[test]
    fn recurrence_model_blocks_standard_flow_and_invalid_source_requires_review() {
        let (_temporary, store) = initialized_store();
        let (order_id, line_id) = confirmed_order(&store, "2024-01-01", "direct");
        let (_, created) = create_schedule(&store, &order_id, "annual", "2024-01-31", None, 0);
        let schedule_id = created["schedule"]["id"].as_str().unwrap().to_owned();
        assert_eq!(created["schedule"]["frequency"], "yearly");

        let allocations = vec![SalesOrderInvoiceAllocationInput {
            sales_order_line_id: line_id.clone(),
            delivery_note_line_id: None,
            quantity_milli: 1_500,
        }];
        let preview_error = store
            .preview_sales_order_invoice(PreviewSalesOrderInvoiceInput {
                sales_order_id: order_id.clone(),
                allocations: allocations.clone(),
            })
            .unwrap_err();
        assert!(preview_error.to_string().contains("modèle récurrent"));
        assert!(preview_error
            .to_string()
            .contains("bloqué pour éviter une double facturation"));
        assert!(store
            .create_sales_order_invoice(CreateSalesOrderInvoiceInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
                issue_date: Some("2024-02-01".into()),
                due_date: Some("2024-03-01".into()),
                service_date_from: "2024-01-01".into(),
                service_date_to: "2024-01-31".into(),
                allocations,
            })
            .unwrap_err()
            .to_string()
            .contains("modèle récurrent"));
        assert!(store
            .save_delivery_note_draft(SaveDeliveryNoteDraftInput {
                delivery_note: DeliveryNoteDraftInput {
                    id: None,
                    sales_order_id: order_id.clone(),
                    delivery_date: "2024-01-31".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![DeliveryNoteLineInput {
                    sales_order_line_id: line_id.clone(),
                    quantity_milli: 1_500,
                }],
            })
            .unwrap_err()
            .to_string()
            .contains("modèle récurrent"));

        let blocked_cancellation = store
            .cancel_sales_order(CancelSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
                reason: "Contrat client résilié".into(),
            })
            .unwrap_err();
        assert!(blocked_cancellation
            .to_string()
            .contains("terminez définitivement la planification avant d’annuler"));

        let blocked_remainder = store
            .cancel_sales_order_remainder(CancelSalesOrderRemainderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: order_id.clone(),
                reason: "Périmètre réduit avant revue".into(),
                lines: vec![CancelSalesOrderRemainderLineInput {
                    sales_order_line_id: line_id.clone(),
                    quantity_milli: 500,
                }],
            })
            .unwrap_err();
        assert!(blocked_remainder
            .to_string()
            .contains("terminez définitivement la planification avant d’annuler"));
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM sales_order_cancellation_lines WHERE sales_order_id=?",
                    params![order_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        let tampered = store.connect().unwrap();
        let sql_guard = tampered
            .execute(
                "INSERT INTO sales_order_cancellation_lines(id,request_id,sales_order_id,sales_order_line_id,quantity_milli,reason,created_at) VALUES(?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    &order_id,
                    &line_id,
                    500,
                    "Tentative directe bloquée",
                    now_iso()
                ],
            )
            .unwrap_err();
        assert!(sql_guard
            .to_string()
            .contains("active recurrence model cannot be partially cancelled"));

        // Une base locale altérée doit encore échouer fermée : on retire ici
        // volontairement la dernière barrière SQL pour simuler cette altération.
        tampered
            .execute_batch("DROP TRIGGER sales_order_cancellation_lines_recurrence_model_guard;")
            .unwrap();
        tampered
            .execute(
                "INSERT INTO sales_order_cancellation_lines(id,request_id,sales_order_id,sales_order_line_id,quantity_milli,reason,created_at) VALUES(?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    &order_id,
                    &line_id,
                    500,
                    "Altération locale simulée",
                    now_iso()
                ],
            )
            .unwrap();
        let reviewed = store
            .generate_recurrence_occurrences(GenerateRecurrenceOccurrencesInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                through_date: "2024-01-31".into(),
            })
            .unwrap();
        assert_eq!(reviewed["created_count"], 0);
        assert_eq!(reviewed["schedule"]["status"], "review_required");
        assert!(reviewed["schedule"]["review_reason"]
            .as_str()
            .unwrap()
            .contains("annulation"));
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM recurrence_occurrences", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert!(store
            .update_recurrence_schedule(UpdateRecurrenceScheduleInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: schedule_id.clone(),
                status: "active".into(),
                end_date: None,
            })
            .unwrap_err()
            .to_string()
            .contains("annulation"));
        let complete_input = UpdateRecurrenceScheduleInput {
            request_id: Uuid::new_v4().to_string(),
            schedule_id: schedule_id.clone(),
            status: "completed".into(),
            end_date: None,
        };
        let manually_completed = store
            .update_recurrence_schedule(complete_input.clone())
            .unwrap();
        assert_eq!(manually_completed["schedule"]["status"], "completed");
        assert_eq!(manually_completed["schedule"]["end_date"], Value::Null);
        assert!(manually_completed["schedule"]["completed_at"].is_string());
        assert_eq!(
            store.update_recurrence_schedule(complete_input).unwrap()["idempotent"],
            true
        );
        assert!(store
            .preview_sales_order_invoice(PreviewSalesOrderInvoiceInput {
                sales_order_id: order_id,
                allocations: vec![],
            })
            .unwrap_err()
            .to_string()
            .contains("modèle récurrent"));
        assert!(store
            .update_recurrence_schedule(UpdateRecurrenceScheduleInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id,
                status: "active".into(),
                end_date: None,
            })
            .unwrap_err()
            .to_string()
            .contains("terminée"));

        let (closable_order_id, _) = confirmed_order(&store, "2024-01-01", "direct");
        let (_, closable_schedule) = create_schedule(
            &store,
            &closable_order_id,
            "monthly",
            "2024-01-31",
            None,
            30,
        );
        store
            .update_recurrence_schedule(UpdateRecurrenceScheduleInput {
                request_id: Uuid::new_v4().to_string(),
                schedule_id: closable_schedule["schedule"]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                status: "completed".into(),
                end_date: None,
            })
            .unwrap();
        let cancelled = store
            .cancel_sales_order(CancelSalesOrderInput {
                request_id: Uuid::new_v4().to_string(),
                sales_order_id: closable_order_id,
                reason: "Planification terminée".into(),
            })
            .unwrap();
        assert_eq!(cancelled["order"]["status"], "cancelled");

        let (delivery_order_id, _) = confirmed_order(&store, "2024-01-01", "untracked_delivery");
        assert!(store
            .create_recurrence_schedule(CreateRecurrenceScheduleInput {
                request_id: Uuid::new_v4().to_string(),
                source_sales_order_id: delivery_order_id,
                frequency: "monthly".into(),
                start_date: "2024-01-31".into(),
                end_date: None,
                payment_terms_days: 30,
            })
            .unwrap_err()
            .to_string()
            .contains("uniquement des lignes directes"));
    }

    #[test]
    fn migration_v22_to_v23_preserves_data_and_installs_empty_recurrence_ledgers() {
        let (temporary, store) = initialized_store();
        let client_id = id(&store
            .create_record("clients", json!({"name":"Client historique V22"}))
            .unwrap());
        let connection = store.connect().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER IF EXISTS delivery_notes_recurrence_model_guard;
                 DROP TRIGGER IF EXISTS sales_order_invoice_batches_recurrence_model_guard;
                 DROP TABLE recurrence_operation_requests;
                 DROP TABLE recurrence_occurrences;
                 DROP TABLE recurrence_schedules;
                 PRAGMA user_version=22;",
            )
            .unwrap();
        drop(connection);
        drop(store);

        let migrated = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = migrated.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM clients WHERE id=?",
                    params![client_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Client historique V22"
        );
        for table in [
            "recurrence_schedules",
            "recurrence_occurrences",
            "recurrence_operation_requests",
        ] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
                        params![table],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1
            );
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
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
}

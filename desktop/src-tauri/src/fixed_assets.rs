//! The immutable registration lives in the existing audited event journal.
//! Its accounting entries travel in the same company snapshot on every platform;
//! no private register or incompatible database extension is introduced.
use crate::{
    accounting::{post_entry, EntryLine},
    audit::append_audit,
    database::{query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetInput {
    pub id: String,
    pub name: String,
    pub date: String,
    pub reference: String,
    pub cost_cents: i64,
    pub residual_cents: i64,
    pub rate_bp: i64,
    pub method: String,
    pub asset_account_id: String,
    pub depreciation_account_id: String,
    pub counterpart_account_id: String,
    pub mode: String,
}
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn access(store: &LocalStore, write: bool) -> AppResult<()> {
    if write {
        store.require_write_access()?;
    }
    let db = store.connect()?;
    store.require_onboarding(&db)?;
    let role: Option<String> = db
        .query_row(
            "SELECT role FROM company_local_identity WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if write && role.as_deref() == Some("read_only") {
        return Err(invalid("Votre rôle permet la consultation uniquement."));
    }
    Ok(())
}
fn entry_line(account: &str, debit: i64, credit: i64) -> EntryLine {
    EntryLine {
        account_id: account.into(),
        debit_cents: debit,
        credit_cents: credit,
        currency: "CHF".into(),
        memo: None,
        project_id: None,
        client_id: None,
        employee_id: None,
    }
}
fn registration(db: &Connection, id: &str) -> AppResult<AssetInput> {
    let mut q=db.prepare("SELECT payload_json FROM audit_log WHERE entity_type='fixed_asset' AND entity_id=? AND action='fixed_asset_registered'")?;
    let rows = q
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() != 1 {
        return Err(invalid(
            "Cette immobilisation doit être vérifiée. Actualisez la comptabilité.",
        ));
    }
    Ok(serde_json::from_str(&rows[0])?)
}
fn posted(db: &Connection, id: &str, event: &str) -> AppResult<Option<Value>> {
    let rows=query_all(db,"SELECT * FROM journal_entries WHERE source_type='fixed_asset' AND source_id=? AND source_event=?",params![id,event])?;
    Ok(rows.into_iter().next())
}
fn assert_intact(db: &Connection, asset: &AssetInput) -> AppResult<()> {
    let reversed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries a JOIN journal_entries b ON b.reversal_of=a.id WHERE a.source_type='fixed_asset' AND a.source_id=?)",[&asset.id],|r|r.get(0))?;
    if reversed {
        return Err(invalid("Une écriture de cette immobilisation a été extournée. Faites vérifier son journal avant de continuer."));
    }
    if posted(db, &asset.id, "acquired")?.is_none() {
        return Err(invalid(
            "L’écriture d’acquisition de cette immobilisation est absente.",
        ));
    }
    Ok(())
}
fn depreciation_rows(db: &Connection, id: &str) -> AppResult<Vec<Value>> {
    query_all(db,"SELECT j.id,j.entry_date,j.source_event,SUM(l.debit_cents) AS amount_cents FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.source_type='fixed_asset' AND j.source_id=? AND j.source_event LIKE 'depreciation:%' GROUP BY j.id ORDER BY j.entry_date,j.id",[id])
}
pub(crate) fn annual_amount(asset: &AssetInput, year: i32, already: i64) -> AppResult<i64> {
    let date = NaiveDate::parse_from_str(&asset.date, "%Y-%m-%d")
        .map_err(|_| invalid("Vérifiez la date d’acquisition."))?;
    if year < date.year() || already < 0 || already > asset.cost_cents - asset.residual_cents {
        return Err(invalid(
            "La période ou la valeur du bien doit être vérifiée.",
        ));
    }
    let start = NaiveDate::from_ymd_opt(year, 1, 1)
        .ok_or_else(|| invalid("Choisissez une année valide."))?;
    let end = NaiveDate::from_ymd_opt(year + 1, 1, 1)
        .ok_or_else(|| invalid("Choisissez une année valide."))?;
    let days = (end - if year == date.year() { date } else { start }).num_days() as i128;
    let base = if asset.method == "declining" {
        asset.cost_cents - already
    } else {
        asset.cost_cents
    };
    let divisor = 10000i128 * (end - start).num_days() as i128;
    let value = (i128::from(base) * i128::from(asset.rate_bp) * days + divisor / 2) / divisor;
    Ok((value as i64).min(asset.cost_cents - asset.residual_cents - already))
}
pub(crate) fn list(store: &LocalStore) -> AppResult<Value> {
    let db = store.connect()?;
    let records=query_all(&db,"SELECT entity_id FROM audit_log WHERE action='fixed_asset_registered' AND entity_type='fixed_asset' ORDER BY occurred_at DESC,rowid DESC",[])?;
    let mut items = Vec::new();
    for record in records {
        let asset = registration(&db, record["entity_id"].as_str().unwrap_or_default())?;
        let history = depreciation_rows(&db, &asset.id)?;
        let total = history
            .iter()
            .map(|r| r["amount_cents"].as_i64().unwrap_or(0))
            .sum::<i64>();
        let cancelled = posted(&db, &asset.id, "cancelled")?.is_some();
        let blocker = assert_intact(&db, &asset).err().map(|e| e.to_string());
        let acquired = NaiveDate::parse_from_str(&asset.date, "%Y-%m-%d")
            .map_err(|_| invalid("Date d’immobilisation invalide."))?;
        let next_year = acquired.year() + history.len() as i32;
        let remaining = (asset.cost_cents - total).max(0);
        let next = if cancelled
            || blocker.is_some()
            || remaining <= asset.residual_cents
            || next_year > chrono::Local::now().year()
        {
            0
        } else {
            annual_amount(&asset, next_year, total)?
        };
        items.push(json!({"asset":asset,"depreciatedCents":total,"bookValueCents":if cancelled {0}else{remaining},"cancelled":cancelled,"history":history,"nextYear":next_year,"nextAmountCents":next,"blocker":blocker}));
    }
    Ok(json!({"items":items}))
}
pub(crate) fn register(store: &LocalStore, input: AssetInput) -> AppResult<Value> {
    if uuid::Uuid::parse_str(&input.id).is_err()
        || input.name.trim().is_empty()
        || input.name.chars().count() > 160
        || input.reference.trim().is_empty()
        || input.reference.chars().count() > 200
    {
        return Err(invalid(
            "Indiquez le nom du bien et la référence de son achat.",
        ));
    }
    let date = NaiveDate::parse_from_str(&input.date, "%Y-%m-%d")
        .map_err(|_| invalid("Choisissez la date réelle de l’acquisition."))?;
    if date > chrono::Local::now().date_naive()
        || date.year() < 1900
        || input.cost_cents <= 0
        || input.cost_cents > 1_000_000_000
        || input.residual_cents < 0
        || input.residual_cents >= input.cost_cents
        || !(1..=10000).contains(&input.rate_bp)
        || !["linear", "declining"].contains(&input.method.as_str())
        || !["purchase", "reclassify"].contains(&input.mode.as_str())
    {
        return Err(invalid(
            "Vérifiez le montant, la date et la méthode d’amortissement du bien.",
        ));
    }
    let mut db = store.connect()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let enabled: bool = tx.query_row(
        "SELECT enabled FROM accounting_settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    if !enabled {
        return Err(invalid(
            "Activez la comptabilité dans Plan et liaisons avant d’ajouter un bien.",
        ));
    }
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM audit_log WHERE action='fixed_asset_registered' AND entity_type='fixed_asset' AND entity_id=?)",[&input.id],|r|r.get(0))?;
    if exists {
        if registration(&tx, &input.id)? != input {
            return Err(invalid(
                "Cette demande a déjà été enregistrée avec d’autres informations.",
            ));
        }
        tx.commit()?;
        return list(store);
    }
    let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM audit_log a WHERE a.entity_type='fixed_asset' AND a.action='fixed_asset_registered' AND lower(trim(json_extract(a.payload_json,'$.reference')))=lower(trim(?)) AND lower(trim(json_extract(a.payload_json,'$.name')))=lower(trim(?)) AND NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.source_type='fixed_asset' AND j.source_id=a.entity_id AND j.source_event='cancelled'))",params![input.reference,input.name],|r|r.get(0))?;
    if duplicate {
        return Err(invalid(
            "Un bien avec ce nom et cette référence est déjà enregistré. Consultez le registre.",
        ));
    }
    for (id, kind, section, label) in [
        (
            &input.asset_account_id,
            "asset",
            "fixed_assets",
            "immobilisation",
        ),
        (
            &input.depreciation_account_id,
            "expense",
            "depreciation",
            "amortissement",
        ),
    ] {
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type=? AND report_section=? AND active=1)",params![id,kind,section],|r|r.get(0))?;
        if !valid {
            return Err(invalid(&format!(
                "Choisissez un compte d’{label} actif dans le plan comptable."
            )));
        }
    }
    let counterpart_valid: bool = if input.mode == "purchase" {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts a JOIN accounting_settings s ON s.bank_account_id=a.id WHERE a.id=? AND a.active=1 AND a.account_type='asset' AND a.report_section='current_assets')",[&input.counterpart_account_id],|r|r.get(0))?
    } else {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=1 AND account_type='expense' AND report_section<>'depreciation')",[&input.counterpart_account_id],|r|r.get(0))?
    };
    if !counterpart_valid {
        return Err(invalid(
            "Choisissez le compte bancaire de liaison ou la charge de l’achat déjà comptabilisé.",
        ));
    }
    post_entry(
        &tx,
        &input.date,
        &format!("Immobilisation · {} · {}", input.name, input.reference),
        "fixed_asset",
        &input.id,
        "acquired",
        vec![
            entry_line(&input.asset_account_id, input.cost_cents, 0),
            entry_line(&input.counterpart_account_id, 0, input.cost_cents),
        ],
    )?;
    append_audit(
        &tx,
        "fixed_asset_registered",
        "fixed_asset",
        &input.id,
        &serde_json::to_value(&input)?,
    )?;
    tx.commit()?;
    list(store)
}
pub(crate) fn depreciate(
    store: &LocalStore,
    id: &str,
    year: i32,
    expected: i64,
) -> AppResult<Value> {
    let mut db = store.connect()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let asset = registration(&tx, id)?;
    assert_intact(&tx, &asset)?;
    if posted(&tx, id, "cancelled")?.is_some() {
        return Err(invalid("Ce bien a été annulé."));
    }
    let event = format!("depreciation:{year}");
    let history = depreciation_rows(&tx, id)?;
    if let Some(row) = history.iter().find(|r| r["source_event"] == event) {
        if row["amount_cents"].as_i64() != Some(expected) {
            return Err(invalid("Le montant de cette demande a changé."));
        }
        tx.commit()?;
        return list(store);
    }
    let acquired = NaiveDate::parse_from_str(&asset.date, "%Y-%m-%d")
        .map_err(|_| invalid("Vérifiez la date du bien."))?;
    if year != acquired.year() + history.len() as i32 || year > chrono::Local::now().year() {
        return Err(invalid(
            "Comptabilisez les amortissements dans l’ordre des années.",
        ));
    }
    let total = history
        .iter()
        .map(|r| r["amount_cents"].as_i64().unwrap_or(0))
        .sum();
    let amount = annual_amount(&asset, year, total)?;
    if amount <= 0 || amount != expected {
        return Err(invalid(
            "Le montant a changé ou le bien est entièrement amorti. Actualisez le registre.",
        ));
    }
    post_entry(
        &tx,
        &format!("{year}-12-31"),
        &format!("Amortissement {year} · {}", asset.name),
        "fixed_asset",
        id,
        &event,
        vec![
            entry_line(&asset.depreciation_account_id, amount, 0),
            entry_line(&asset.asset_account_id, 0, amount),
        ],
    )?;
    append_audit(
        &tx,
        "fixed_asset_depreciated",
        "fixed_asset",
        id,
        &json!({"year":year,"amountCents":amount}),
    )?;
    tx.commit()?;
    list(store)
}
pub(crate) fn cancel(store: &LocalStore, id: &str, date: &str) -> AppResult<Value> {
    let mut db = store.connect()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let asset = registration(&tx, id)?;
    assert_intact(&tx, &asset)?;
    if let Some(previous) = posted(&tx, id, "cancelled")? {
        if previous["entry_date"] != date {
            return Err(invalid(
                "L’annulation a déjà été enregistrée à une autre date.",
            ));
        }
        tx.commit()?;
        return list(store);
    }
    if !depreciation_rows(&tx, id)?.is_empty() {
        return Err(invalid("Ce bien a déjà été amorti. Faites préparer sa correction comptable avant de le retirer du registre."));
    }
    if date < asset.date.as_str() || date > chrono::Local::now().date_naive().to_string().as_str() {
        return Err(invalid(
            "Choisissez une date entre l’acquisition et aujourd’hui.",
        ));
    }
    post_entry(
        &tx,
        date,
        &format!("Annulation d’immobilisation · {}", asset.name),
        "fixed_asset",
        id,
        "cancelled",
        vec![
            entry_line(&asset.counterpart_account_id, asset.cost_cents, 0),
            entry_line(&asset.asset_account_id, 0, asset.cost_cents),
        ],
    )?;
    append_audit(
        &tx,
        "fixed_asset_cancelled",
        "fixed_asset",
        id,
        &json!({"date":date}),
    )?;
    tx.commit()?;
    list(store)
}
#[tauri::command]
pub fn list_fixed_assets(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    access(&state, false).map_err(command_error)?;
    list(&state).map_err(command_error)
}
#[tauri::command]
pub fn register_fixed_asset(
    state: State<'_, LocalStore>,
    input: AssetInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    access(&state, true).map_err(command_error)?;
    register(&state, input).map_err(command_error)
}
#[tauri::command]
pub fn depreciate_fixed_asset(
    state: State<'_, LocalStore>,
    id: String,
    year: i32,
    expected: i64,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    access(&state, true).map_err(command_error)?;
    depreciate(&state, &id, year, expected).map_err(command_error)
}
#[tauri::command]
pub fn cancel_fixed_asset(
    state: State<'_, LocalStore>,
    id: String,
    date: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    access(&state, true).map_err(command_error)?;
    cancel(&state, &id, &date).map_err(command_error)
}

#[cfg(test)]
#[path = "fixed_assets_tests.rs"]
mod tests;

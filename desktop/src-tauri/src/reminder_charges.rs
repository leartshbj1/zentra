//! Frais de rappel par niveau, intérêts moratoires et réquisition de
//! poursuite préparée. Tout est calculé ici, de façon déterministe ; rien
//! n'est envoyé à l'office des poursuites par l'app.

use std::{collections::BTreeMap, io::Write};

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChargeSettings {
    pub interest_enabled: bool,
    pub interest_rate_bp: i64,
    /// Frais par niveau de relance, en centimes.
    pub fees: BTreeMap<i64, i64>,
}

impl Default for ChargeSettings {
    fn default() -> Self {
        // Taux légal suisse (art. 104 CO) proposé, mais rien n'est réclamé sans choix explicite.
        Self { interest_enabled: false, interest_rate_bp: 500, fees: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Charges {
    pub fee_cents: i64,
    pub interest_cents: i64,
    pub interest_rate_bp: i64,
    pub interest_days: i64,
    pub interest_from: Option<String>,
    pub total_due_cents: i64,
}

/// Intérêt simple sur le solde, jours exacts sur 365, arrondi au centime
/// (demi supérieur). Les intérêts courent dès le lendemain de l'échéance.
pub(crate) fn late_interest_cents(balance_cents: i64, rate_bp: i64, days: i64) -> i64 {
    if balance_cents <= 0 || rate_bp <= 0 || days <= 0 {
        return 0;
    }
    let numerator = i128::from(balance_cents) * i128::from(rate_bp) * i128::from(days);
    let denominator = 10_000_i128 * 365;
    ((numerator + denominator / 2) / denominator) as i64
}

pub(crate) fn compute_charges(settings: &ChargeSettings, level: i64, balance_cents: i64, due_date: NaiveDate, as_of: NaiveDate) -> Charges {
    let fee_cents = settings.fees.get(&level).copied().unwrap_or(0).max(0);
    let days = if settings.interest_enabled { (as_of - due_date).num_days().max(0) } else { 0 };
    let interest_cents = late_interest_cents(balance_cents, settings.interest_rate_bp, days);
    let interest_from = (days > 0).then(|| due_date.succ_opt().unwrap_or(due_date).format("%Y-%m-%d").to_string());
    Charges {
        fee_cents,
        interest_cents,
        interest_rate_bp: if settings.interest_enabled { settings.interest_rate_bp } else { 0 },
        interest_days: days,
        interest_from,
        total_due_cents: balance_cents.max(0) + fee_cents + interest_cents,
    }
}

pub(crate) fn charges_json(charges: &Charges) -> Value {
    json!({
        "fee_cents": charges.fee_cents,
        "interest_cents": charges.interest_cents,
        "interest_rate_bp": charges.interest_rate_bp,
        "interest_days": charges.interest_days,
        "interest_from": charges.interest_from,
        "total_due_cents": charges.total_due_cents,
    })
}

/// Paragraphe ajouté à la relance quand des frais ou intérêts sont réclamés.
pub(crate) fn charges_text(charges: &Charges, currency: &str, money: impl Fn(i64, &str) -> String) -> String {
    if charges.fee_cents == 0 && charges.interest_cents == 0 {
        return String::new();
    }
    let mut parts = Vec::new();
    if charges.fee_cents > 0 {
        parts.push(format!("Frais de rappel : {}", money(charges.fee_cents, currency)));
    }
    if charges.interest_cents > 0 {
        let rate = charges.interest_rate_bp as f64 / 100.0;
        parts.push(format!(
            "Intérêts moratoires de {} % sur {} jours : {}",
            format!("{rate}").replace('.', ","),
            charges.interest_days,
            money(charges.interest_cents, currency)
        ));
    }
    parts.push(format!("Total dû : {}", money(charges.total_due_cents, currency)));
    parts.join("\n")
}

pub(crate) fn load_settings(connection: &Connection) -> AppResult<ChargeSettings> {
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminder_charge_settings')",
        [],
        |row| row.get(0),
    )?;
    if !present {
        return Ok(ChargeSettings::default());
    }
    let row: Option<(bool, i64, String)> = connection
        .query_row(
            "SELECT interest_enabled,interest_rate_bp,fees_json FROM reminder_charge_settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((interest_enabled, interest_rate_bp, fees_json)) = row else {
        return Ok(ChargeSettings::default());
    };
    let raw: BTreeMap<String, i64> = serde_json::from_str(&fees_json).unwrap_or_default();
    let fees = raw
        .into_iter()
        .filter_map(|(level, cents)| level.parse::<i64>().ok().filter(|level| (1..=10).contains(level)).map(|level| (level, cents.clamp(0, 100_000))))
        .collect();
    Ok(ChargeSettings { interest_enabled, interest_rate_bp, fees })
}

fn settings_json(settings: &ChargeSettings) -> Value {
    json!({
        "interest_enabled": settings.interest_enabled,
        "interest_rate_bp": settings.interest_rate_bp,
        "fees": settings.fees.iter().map(|(level, cents)| json!({"level": level, "fee_cents": cents})).collect::<Vec<_>>(),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReminderFeeInput {
    pub level: i64,
    pub fee_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReminderChargeSettingsInput {
    pub interest_enabled: bool,
    pub interest_rate_bp: i64,
    pub fees: Vec<ReminderFeeInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportDebtCollectionInput {
    pub invoice_id: String,
    pub destination: String,
    pub xml: String,
    pub claim_cents: i64,
    pub interest_rate_bp: i64,
    #[serde(default)]
    pub interest_from: Option<String>,
    #[serde(default)]
    pub fees_cents: i64,
}

impl LocalStore {
    pub fn get_reminder_charge_settings(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(settings_json(&load_settings(&connection)?))
    }

    pub fn save_reminder_charge_settings(&self, input: ReminderChargeSettingsInput) -> AppResult<Value> {
        if !(0..=2000).contains(&input.interest_rate_bp) {
            return Err(invalid("Le taux d'intérêt doit être compris entre 0 et 20 %."));
        }
        let mut fees = BTreeMap::new();
        for fee in &input.fees {
            if !(1..=10).contains(&fee.level) || !(0..=100_000).contains(&fee.fee_cents) || fees.insert(fee.level, fee.fee_cents).is_some() {
                return Err(invalid("Les frais de rappel doivent être compris entre 0 et 1000 francs, un montant par niveau."));
            }
        }
        let fees_json = serde_json::to_string(&fees.iter().map(|(level, cents)| (level.to_string(), *cents)).collect::<BTreeMap<_, _>>())?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        tx.execute(
            "INSERT INTO reminder_charge_settings(id,interest_enabled,interest_rate_bp,fees_json,created_at,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET interest_enabled=excluded.interest_enabled,interest_rate_bp=excluded.interest_rate_bp,fees_json=excluded.fees_json,updated_at=excluded.updated_at",
            params![input.interest_enabled, input.interest_rate_bp, fees_json, now, now],
        )?;
        let saved = settings_json(&load_settings(&tx)?);
        append_audit(&tx, "update", "reminder_charge_settings", "1", &saved)?;
        tx.commit()?;
        Ok(saved)
    }

    /// Écrit la réquisition préparée dans le fichier choisi et garde sa trace.
    /// Seule une facture émise, avec un solde, dont la dernière relance a été
    /// envoyée, peut faire l'objet d'une réquisition.
    pub fn export_debt_collection_request(&self, input: ExportDebtCollectionInput) -> AppResult<Value> {
        let path = std::path::PathBuf::from(input.destination.trim());
        if input.destination.trim().is_empty() || !path.is_absolute() || path.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("xml")) {
            return Err(invalid("Choisissez un fichier .xml pour la réquisition."));
        }
        let parent = path.parent().filter(|parent| parent.is_dir()).ok_or_else(|| invalid("Le dossier de destination n'existe pas."))?;
        if input.xml.len() > 1_000_000 || !input.xml.starts_with("<?xml") {
            return Err(invalid("Le fichier de réquisition est invalide."));
        }
        if !(0..=2000).contains(&input.interest_rate_bp) || input.fees_cents < 0 {
            return Err(invalid("Les intérêts ou frais de la réquisition sont invalides."));
        }
        if let Some(from) = &input.interest_from {
            NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|_| invalid("La date de départ des intérêts est invalide."))?;
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, Option<String>, i64, i64)> = tx
            .query_row(
                "SELECT status,number,total_cents,paid_cents FROM invoices WHERE id=? AND type<>'credit_note'",
                params![input.invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((status, number, total, paid)) = row else {
            return Err(AppError::NotFound(format!("invoices/{}", input.invoice_id)));
        };
        let credited: i64 = tx.query_row(
            "SELECT COALESCE(SUM(amount_cents),0) FROM customer_invoice_credit_movements WHERE invoice_id=?",
            params![input.invoice_id],
            |row| row.get(0),
        )?;
        let balance = (total - paid - credited).max(0);
        if number.is_none() || matches!(status.as_str(), "brouillon" | "annulee" | "payee") || balance <= 0 {
            return Err(invalid("Seule une facture émise avec un solde ouvert peut faire l'objet d'une poursuite."));
        }
        if input.claim_cents != balance {
            return Err(invalid("Le montant de la réquisition doit être le solde ouvert de la facture."));
        }
        let last_reminder_sent: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM reminders WHERE invoice_id=? AND status='completed' AND level=(SELECT MAX(level) FROM reminder_templates WHERE active=1))",
            params![input.invoice_id],
            |row| row.get(0),
        )?;
        if !last_reminder_sent {
            return Err(invalid("Envoyez d'abord la dernière relance prévue avant de préparer une poursuite."));
        }
        let sha = format!("{:x}", Sha256::digest(input.xml.as_bytes()));
        let id = Uuid::new_v4().to_string();
        let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or("requisition.xml").chars().take(200).collect::<String>();
        let now = now_iso();
        tx.execute(
            "INSERT INTO debt_collection_requests(id,invoice_id,claim_cents,interest_rate_bp,interest_from,fees_cents,file_name,file_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            params![id, input.invoice_id, input.claim_cents, input.interest_rate_bp, input.interest_from, input.fees_cents, file_name, sha, now],
        )?;
        append_audit(&tx, "prepared", "debt_collection_request", &id, &json!({"invoice_id": input.invoice_id, "claim_cents": input.claim_cents, "file_sha256": sha}))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(input.xml.as_bytes())?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path).map_err(|error| AppError::Io(error.error))?;
        tx.commit()?;
        Ok(json!({"id": id, "path": path.to_string_lossy(), "fileSha256": sha}))
    }
}

#[tauri::command]
pub fn get_reminder_charge_settings(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_reminder_charge_settings().map_err(command_error)
}

#[tauri::command]
pub fn save_reminder_charge_settings(state: tauri::State<'_, LocalStore>, input: ReminderChargeSettingsInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_reminder_charge_settings(input).map_err(command_error)
}

#[tauri::command]
pub fn export_debt_collection_request(state: tauri::State<'_, LocalStore>, input: ExportDebtCollectionInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.export_debt_collection_request(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn late_interest_is_simple_daily_interest_rounded_to_the_centime() {
        // CHF 1 000.00 à 5 % pendant 365 jours : CHF 50.00.
        assert_eq!(late_interest_cents(100_000, 500, 365), 5_000);
        // 30 jours : 1000 × 5 % × 30 / 365 = 4.1095… → 4.11.
        assert_eq!(late_interest_cents(100_000, 500, 30), 411);
        assert_eq!(late_interest_cents(100_000, 500, 0), 0);
        assert_eq!(late_interest_cents(0, 500, 30), 0);
        assert_eq!(late_interest_cents(i64::MAX / 1_000, 2_000, 3_650) > 0, true);
    }

    #[test]
    fn charges_follow_the_level_fee_and_the_enabled_interest() {
        let mut settings = ChargeSettings::default();
        settings.fees.insert(2, 2_000);
        let disabled = compute_charges(&settings, 2, 178_000, date("2026-09-30"), date("2026-10-30"));
        assert_eq!(disabled, Charges { fee_cents: 2_000, interest_cents: 0, interest_rate_bp: 0, interest_days: 0, interest_from: None, total_due_cents: 180_000 });
        settings.interest_enabled = true;
        let enabled = compute_charges(&settings, 2, 178_000, date("2026-09-30"), date("2026-10-30"));
        assert_eq!(enabled.interest_days, 30);
        assert_eq!(enabled.interest_cents, 732);
        assert_eq!(enabled.interest_from.as_deref(), Some("2026-10-01"));
        assert_eq!(enabled.total_due_cents, 178_000 + 2_000 + 732);
        let level_one = compute_charges(&settings, 1, 178_000, date("2026-09-30"), date("2026-09-20"));
        assert_eq!((level_one.fee_cents, level_one.interest_cents), (0, 0));
        let text = charges_text(&enabled, "CHF", |cents, currency| format!("{currency} {}.{:02}", cents / 100, cents % 100));
        assert_eq!(text, "Frais de rappel : CHF 20.00\nIntérêts moratoires de 5 % sur 30 jours : CHF 7.32\nTotal dû : CHF 1807.32");
        assert_eq!(charges_text(&level_one, "CHF", |_, _| String::new()), "");
    }
}

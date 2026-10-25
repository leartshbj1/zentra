//! Réglages client de l'entreprise : lien vers sa fiche d'avis Google,
//! période pendant laquelle un client n'est pas sollicité deux fois, prise de
//! rendez-vous en ligne et acompte demandé à l'acceptation d'un devis.
//! Chaque demande d'avis est notée une fois, quel que soit le canal.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngagementInput {
    pub review_url: Option<String>,
    pub review_cooldown_days: i64,
    pub review_auto: bool,
    pub booking_enabled: bool,
    pub booking_days: i64,
    pub booking_start: String,
    pub booking_end: String,
    pub booking_minutes: i64,
    pub booking_weeks: i64,
    pub deposit_percent_bp: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRequestInput {
    pub client_id: String,
    pub invoice_id: Option<String>,
    pub channel: String,
    pub origin: String,
}

/// Lien d'avis : https seulement, sans espace ni identifiant dans l'adresse.
pub(crate) fn valid_review_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some_and(|host| host.contains('.')) && url.username().is_empty() && url.password().is_none())
        && (12..=500).contains(&value.len())
        && !value.chars().any(char::is_whitespace)
}

fn valid_time(value: &str) -> bool {
    value.len() == 5 && chrono::NaiveTime::parse_from_str(value, "%H:%M").is_ok()
}

fn defaults() -> Value {
    json!({ "review_url": null, "review_cooldown_days": 365, "review_auto": false, "booking_enabled": false, "booking_days": 31,
        "booking_start": "08:00", "booking_end": "17:00", "booking_minutes": 60, "booking_weeks": 3, "deposit_percent_bp": 0 })
}

impl LocalStore {
    pub fn get_customer_engagement_settings(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let row = connection
            .query_row(
                "SELECT review_url,review_cooldown_days,review_auto,booking_enabled,booking_days,booking_start,booking_end,booking_minutes,booking_weeks,deposit_percent_bp
                 FROM customer_engagement_settings WHERE id=1",
                [],
                |row| {
                    Ok(json!({ "review_url": row.get::<_, Option<String>>(0)?, "review_cooldown_days": row.get::<_, i64>(1)?, "review_auto": row.get::<_, bool>(2)?,
                        "booking_enabled": row.get::<_, bool>(3)?, "booking_days": row.get::<_, i64>(4)?, "booking_start": row.get::<_, String>(5)?,
                        "booking_end": row.get::<_, String>(6)?, "booking_minutes": row.get::<_, i64>(7)?, "booking_weeks": row.get::<_, i64>(8)?,
                        "deposit_percent_bp": row.get::<_, i64>(9)? }))
                },
            )
            .optional()?;
        Ok(row.unwrap_or_else(defaults))
    }

    pub fn save_customer_engagement_settings(&self, input: EngagementInput) -> AppResult<Value> {
        let review_url = input.review_url.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
        if review_url.as_deref().is_some_and(|value| !valid_review_url(value)) {
            return Err(invalid("Collez le lien https de votre fiche d’avis, par exemple celui que Google donne sous « Demander des avis »."));
        }
        if !(30..=1095).contains(&input.review_cooldown_days) {
            return Err(invalid("Un client est sollicité au plus une fois tous les 30 jours à 3 ans."));
        }
        if !(1..=127).contains(&input.booking_days) || !valid_time(&input.booking_start) || !valid_time(&input.booking_end) || input.booking_end <= input.booking_start
            || ![30, 45, 60, 90, 120].contains(&input.booking_minutes) || !(1..=8).contains(&input.booking_weeks)
        {
            return Err(invalid("Vérifiez les jours, les heures et la durée des rendez-vous en ligne."));
        }
        if !(0..=10_000).contains(&input.deposit_percent_bp) {
            return Err(invalid("L’acompte va de 0 à 100 % du devis."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        tx.execute(
            "INSERT INTO customer_engagement_settings(id,review_url,review_cooldown_days,review_auto,booking_enabled,booking_days,booking_start,booking_end,booking_minutes,booking_weeks,deposit_percent_bp,updated_at)
             VALUES(1,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET review_url=excluded.review_url,review_cooldown_days=excluded.review_cooldown_days,review_auto=excluded.review_auto,
               booking_enabled=excluded.booking_enabled,booking_days=excluded.booking_days,booking_start=excluded.booking_start,booking_end=excluded.booking_end,
               booking_minutes=excluded.booking_minutes,booking_weeks=excluded.booking_weeks,deposit_percent_bp=excluded.deposit_percent_bp,updated_at=excluded.updated_at",
            params![review_url, input.review_cooldown_days, input.review_auto, input.booking_enabled, input.booking_days, input.booking_start, input.booking_end,
                input.booking_minutes, input.booking_weeks, input.deposit_percent_bp, now],
        )?;
        append_audit(&tx, "configure", "customer_engagement_settings", "1", &json!({ "review_url_set": review_url.is_some(), "review_auto": input.review_auto,
            "booking_enabled": input.booking_enabled, "deposit_percent_bp": input.deposit_percent_bp }))?;
        tx.commit()?;
        self.get_customer_engagement_settings()
    }

    /// Note une demande d'avis ; une deuxième demande au même client pendant la période est refusée.
    pub fn record_review_request(&self, input: ReviewRequestInput) -> AppResult<Value> {
        if !matches!(input.channel.as_str(), "email" | "sms" | "copy") || !matches!(input.origin.as_str(), "validated" | "rule") {
            return Err(invalid("Canal de demande d’avis inconnu."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let client: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?)", [&input.client_id], |row| row.get(0))?;
        if !client {
            return Err(invalid("Client introuvable."));
        }
        let cooldown: i64 = tx
            .query_row("SELECT review_cooldown_days FROM customer_engagement_settings WHERE id=1", [], |row| row.get(0))
            .optional()?
            .unwrap_or(365);
        let recent: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM review_requests WHERE client_id=? AND julianday('now')-julianday(created_at)<?)",
            params![input.client_id, cooldown],
            |row| row.get(0),
        )?;
        if recent {
            return Err(invalid("Ce client a déjà reçu une demande d’avis pendant cette période."));
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO review_requests(id,client_id,invoice_id,channel,origin,created_at) VALUES(?,?,?,?,?,?)",
            params![id, input.client_id, input.invoice_id, input.channel, input.origin, now_iso()],
        )?;
        append_audit(&tx, "create", "review_request", &id, &json!({ "client_id": input.client_id, "channel": input.channel, "origin": input.origin }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }
}

#[tauri::command]
pub fn get_customer_engagement_settings(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_customer_engagement_settings().map_err(command_error)
}

#[tauri::command]
pub fn save_customer_engagement_settings(state: tauri::State<'_, LocalStore>, input: EngagementInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_customer_engagement_settings(input).map_err(command_error)
}

#[tauri::command]
pub fn record_review_request(state: tauri::State<'_, LocalStore>, input: ReviewRequestInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_review_request(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "customer-engagement-test").unwrap();
        store
            .connect()
            .unwrap()
            .execute("INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('c1','Keller','Rue du Lac 4','1260','Nyon','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])
            .unwrap();
        (temporary, store)
    }

    fn input() -> EngagementInput {
        EngagementInput { review_url: Some("https://g.page/r/CQx-atelier/review".into()), review_cooldown_days: 365, review_auto: false, booking_enabled: true, booking_days: 31,
            booking_start: "08:00".into(), booking_end: "17:00".into(), booking_minutes: 60, booking_weeks: 3, deposit_percent_bp: 3_000 }
    }

    #[test]
    fn settings_are_validated_and_read_back() {
        let (_temporary, store) = store();
        assert_eq!(store.get_customer_engagement_settings().unwrap()["review_cooldown_days"], 365);
        assert!(store.save_customer_engagement_settings(EngagementInput { review_url: Some("http://g.page/r/x".into()), ..input() }).is_err());
        assert!(store.save_customer_engagement_settings(EngagementInput { review_url: Some("https://user:pw@g.page/r/x".into()), ..input() }).is_err());
        assert!(store.save_customer_engagement_settings(EngagementInput { booking_end: "07:00".into(), ..input() }).is_err());
        assert!(store.save_customer_engagement_settings(EngagementInput { booking_minutes: 50, ..input() }).is_err());
        assert!(store.save_customer_engagement_settings(EngagementInput { deposit_percent_bp: 10_001, ..input() }).is_err());
        let saved = store.save_customer_engagement_settings(input()).unwrap();
        assert_eq!(saved["deposit_percent_bp"], 3_000);
        assert_eq!(saved["review_url"], "https://g.page/r/CQx-atelier/review");
        assert!(store.get_workspace().unwrap()["customer_engagement_settings"][0]["booking_enabled"] == 1);
    }

    #[test]
    fn a_client_is_asked_once_per_period() {
        let (_temporary, store) = store();
        let request = || ReviewRequestInput { client_id: "c1".into(), invoice_id: None, channel: "email".into(), origin: "validated".into() };
        assert!(store.record_review_request(ReviewRequestInput { channel: "fax".into(), ..request() }).is_err());
        store.record_review_request(request()).unwrap();
        assert!(store.record_review_request(ReviewRequestInput { channel: "sms".into(), ..request() }).unwrap_err().to_string().contains("déjà reçu"));
    }
}

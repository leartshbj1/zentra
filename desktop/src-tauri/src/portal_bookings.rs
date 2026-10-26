//! Demandes de rendez-vous reçues du portail client. Elles sont gardées telles
//! quelles, en attente ; accepter crée le rendez-vous d'agenda (côté
//! interface, par la commande d'agenda habituelle) puis note le lien ici.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};

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
pub struct BookingRequestInput {
    pub booking_id: String,
    pub client_key: String,
    pub start: String,
    pub minutes: i64,
    pub contact_name: String,
    pub phone: String,
    pub message: String,
    pub at: i64,
}

fn valid(input: &BookingRequestInput) -> bool {
    (1..=80).contains(&input.booking_id.len())
        && input.booking_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        && input.start.len() == 16
        && chrono::NaiveDateTime::parse_from_str(&input.start, "%Y-%m-%dT%H:%M").is_ok()
        && (15..=240).contains(&input.minutes)
        && !input.contact_name.trim().is_empty()
        && input.contact_name.chars().count() <= 200
        && input.phone.chars().count() <= 40
        && input.message.chars().count() <= 2000
        && input.at > 0
}

impl LocalStore {
    /// Garde les nouvelles demandes ; une demande déjà connue ne change pas.
    pub fn save_portal_booking_requests(&self, items: Vec<BookingRequestInput>) -> AppResult<Value> {
        if items.len() > 100 || !items.iter().all(valid) {
            return Err(invalid("Demande de rendez-vous illisible."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut added = 0;
        for item in items {
            let client: Option<String> = tx.query_row("SELECT id FROM clients WHERE id=?", [&item.client_key], |row| row.get(0)).optional()?;
            let received = chrono::DateTime::from_timestamp(item.at, 0).map(|at| at.to_rfc3339()).unwrap_or_else(now_iso);
            added += tx.execute(
                "INSERT INTO portal_booking_requests(id,client_id,start_at,minutes,contact_name,phone,message,status,agenda_event_id,received_at,decided_at)
                 VALUES(?,?,?,?,?,?,?,'pending',NULL,?,NULL) ON CONFLICT(id) DO NOTHING",
                params![item.booking_id, client, item.start, item.minutes, item.contact_name.trim(), item.phone.trim(), item.message.trim(), received],
            )?;
        }
        if added > 0 {
            append_audit(&tx, "receive", "portal_booking_requests", "batch", &json!({ "added": added }))?;
        }
        tx.commit()?;
        Ok(json!({ "added": added }))
    }

    /// Accepte (avec le rendez-vous créé dans l'agenda) ou refuse une demande en attente.
    pub fn decide_portal_booking(&self, id: &str, decision: &str, agenda_event_id: Option<&str>) -> AppResult<Value> {
        if !matches!(decision, "accepted" | "declined") || (decision == "accepted") != agenda_event_id.is_some() {
            return Err(invalid("Décision de rendez-vous inconnue."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(event) = agenda_event_id {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agenda_events WHERE id=?)", [event], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Le rendez-vous d’agenda n’existe pas."));
            }
        }
        let changed = tx.execute(
            "UPDATE portal_booking_requests SET status=?,agenda_event_id=?,decided_at=? WHERE id=? AND status='pending'",
            params![decision, agenda_event_id, now_iso(), id],
        )?;
        if changed == 0 {
            return Err(invalid("Cette demande a déjà été traitée."));
        }
        append_audit(&tx, decision, "portal_booking_request", id, &json!({ "agenda_event_id": agenda_event_id }))?;
        tx.commit()?;
        Ok(json!({ "id": id, "status": decision }))
    }
}

#[tauri::command]
pub fn save_portal_booking_requests(state: tauri::State<'_, LocalStore>, items: Vec<BookingRequestInput>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_portal_booking_requests(items).map_err(command_error)
}

#[tauri::command]
pub fn decide_portal_booking(state: tauri::State<'_, LocalStore>, id: String, decision: String, agenda_event_id: Option<String>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.decide_portal_booking(&id, &decision, agenda_event_id.as_deref()).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> BookingRequestInput {
        BookingRequestInput { booking_id: id.into(), client_key: "c1".into(), start: "2026-11-03T09:00".into(), minutes: 60, contact_name: "Marc Keller".into(),
            phone: "079 555 01 12".into(), message: "Plutôt le matin.".into(), at: 1_793_000_000 }
    }

    #[test]
    fn requests_are_kept_once_and_decided_once() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "portal-bookings-test").unwrap();
        store
            .connect()
            .unwrap()
            .execute("INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('c1','Keller','Rue du Lac 4','1260','Nyon','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])
            .unwrap();
        assert!(store.save_portal_booking_requests(vec![BookingRequestInput { start: "2026-11-31T09:00".into(), ..request("pb1") }]).is_err());
        assert_eq!(store.save_portal_booking_requests(vec![request("pb1"), request("pb2")]).unwrap()["added"], 2);
        assert_eq!(store.save_portal_booking_requests(vec![request("pb1")]).unwrap()["added"], 0);
        assert!(store.decide_portal_booking("pb1", "accepted", None).is_err());
        assert!(store.decide_portal_booking("pb1", "accepted", Some("missing-event")).is_err());
        store.decide_portal_booking("pb2", "declined", None).unwrap();
        assert!(store.decide_portal_booking("pb2", "declined", None).is_err());
        let client: Option<String> = store.connect().unwrap().query_row("SELECT client_id FROM portal_booking_requests WHERE id='pb1'", [], |row| row.get(0)).unwrap();
        assert_eq!(client.as_deref(), Some("c1"));
    }
}

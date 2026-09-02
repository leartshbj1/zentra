use chrono::{NaiveDate, NaiveTime};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{DeleteResult, SaveAgendaEventInput},
};

const EVENT_KINDS: &[&str] = &["appointment", "visit", "deadline", "other"];
const EVENT_STATUSES: &[&str] = &["scheduled", "completed", "cancelled"];

impl LocalStore {
    pub fn save_agenda_event(&self, input: SaveAgendaEventInput) -> AppResult<Value> {
        let id = optional_uuid(input.id, "id")?;
        let title = required_text(&input.title, "title", 200)?;
        let start_date = canonical_date(&input.start_date, "start_date")?;
        let end_date = canonical_date(&input.end_date, "end_date")?;
        if end_date < start_date {
            return Err(AppError::Validation(
                "La date de fin doit être identique ou postérieure à la date de début.".into(),
            ));
        }

        let (start_time, end_time) = if input.all_day {
            (None, None)
        } else {
            let start = canonical_time(input.start_time, "start_time")?;
            let end = canonical_time(input.end_time, "end_time")?;
            if end_date == start_date && end <= start {
                return Err(AppError::Validation(
                    "L’heure de fin doit être postérieure à l’heure de début.".into(),
                ));
            }
            (Some(start), Some(end))
        };
        let kind = normalized_choice(
            input.kind.as_deref().unwrap_or("appointment"),
            "kind",
            EVENT_KINDS,
        )?;
        let status = normalized_choice(
            input.status.as_deref().unwrap_or("scheduled"),
            "status",
            EVENT_STATUSES,
        )?;
        let location = optional_text(input.location, "location", 500)?;
        let notes = optional_text(input.notes, "notes", 20_000)?;
        let project_id = optional_uuid(input.project_id, "project_id")?;
        let employee_id = optional_uuid(input.employee_id, "employee_id")?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(value) = project_id.as_deref() {
            ensure_exists(&transaction, "projects", value, "projet")?;
        }
        if let Some(value) = employee_id.as_deref() {
            ensure_exists(&transaction, "employees", value, "collaborateur")?;
        }

        let now = now_iso();
        let (id, previous, created_at, action) = match id {
            Some(id) => {
                let previous = query_record_tx(&transaction, "agenda_events", &id)?;
                let created_at = previous["created_at"]
                    .as_str()
                    .ok_or_else(|| AppError::Validation("Événement local incomplet.".into()))?
                    .to_owned();
                (id, previous, created_at, "update")
            }
            None => (
                Uuid::new_v4().to_string(),
                Value::Null,
                now.clone(),
                "create",
            ),
        };
        transaction.execute(
            "INSERT INTO agenda_events
             (id,title,start_date,end_date,all_day,start_time,end_time,kind,status,location,notes,project_id,employee_id,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title,start_date=excluded.start_date,end_date=excluded.end_date,
               all_day=excluded.all_day,start_time=excluded.start_time,end_time=excluded.end_time,
               kind=excluded.kind,status=excluded.status,location=excluded.location,notes=excluded.notes,
               project_id=excluded.project_id,employee_id=excluded.employee_id,updated_at=excluded.updated_at",
            params![
                id,
                title,
                start_date,
                end_date,
                input.all_day as i64,
                start_time,
                end_time,
                kind,
                status,
                location,
                notes,
                project_id,
                employee_id,
                created_at,
                now,
            ],
        )?;
        let record = query_record_tx(&transaction, "agenda_events", &id)?;
        append_audit(
            &transaction,
            action,
            "agenda_event",
            &id,
            &json!({"before":previous,"after":record.clone()}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn delete_agenda_event(&self, id: &str) -> AppResult<DeleteResult> {
        let id = required_uuid(id, "id")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, "agenda_events", &id)?;
        let deleted =
            transaction.execute("DELETE FROM agenda_events WHERE id=?", params![id])? == 1;
        append_audit(&transaction, "delete", "agenda_event", &id, &previous)?;
        transaction.commit()?;
        Ok(DeleteResult { deleted, id })
    }
}

fn ensure_exists(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    id: &str,
    label: &str,
) -> AppResult<()> {
    let exists = transaction
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id=?"),
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(AppError::NotFound(format!("{label}/{id}")));
    }
    Ok(())
}

fn canonical_date(value: &str, field: &str) -> AppResult<String> {
    let value = value.trim();
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(format!("{field} doit être une date AAAA-MM-JJ valide."))
    })?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(AppError::Validation(format!(
            "{field} doit utiliser le format canonique AAAA-MM-JJ."
        )));
    }
    Ok(value.to_owned())
}

fn canonical_time(value: Option<String>, field: &str) -> AppResult<String> {
    let value = value.unwrap_or_default();
    let value = value.trim();
    let parsed = NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| AppError::Validation(format!("{field} doit être une heure HH:MM valide.")))?;
    if parsed.format("%H:%M").to_string() != value {
        return Err(AppError::Validation(format!(
            "{field} doit utiliser le format canonique HH:MM."
        )));
    }
    Ok(value.to_owned())
}

fn required_text(value: &str, field: &str, max: usize) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} est obligatoire et ne peut pas dépasser {max} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn optional_text(value: Option<String>, field: &str, max: usize) -> AppResult<Option<String>> {
    let value = value
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty());
    if value
        .as_ref()
        .is_some_and(|item| item.chars().count() > max)
    {
        return Err(AppError::Validation(format!(
            "{field} ne peut pas dépasser {max} caractères."
        )));
    }
    Ok(value)
}

fn normalized_choice(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    if !allowed.contains(&value.as_str()) {
        return Err(AppError::Validation(format!(
            "{field} contient une valeur inconnue."
        )));
    }
    Ok(value)
}

fn optional_uuid(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    value.map(|item| required_uuid(&item, field)).transpose()
}

fn required_uuid(value: &str, field: &str) -> AppResult<String> {
    let value = value.trim();
    Uuid::parse_str(value).map_err(|_| {
        AppError::Validation(format!("{field} doit être un identifiant UUID valide."))
    })?;
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at)
                 VALUES(1,1,'Entreprise agenda',?,?)",
                params![now, now],
            )
            .unwrap();
        drop(connection);
        (temporary, store)
    }

    fn event(id: Option<String>) -> SaveAgendaEventInput {
        SaveAgendaEventInput {
            id,
            title: "Visite client".into(),
            start_date: "2026-09-08".into(),
            end_date: "2026-09-08".into(),
            all_day: false,
            start_time: Some("09:00".into()),
            end_time: Some("10:30".into()),
            kind: Some("visit".into()),
            status: Some("scheduled".into()),
            location: Some("Lausanne".into()),
            notes: Some("Prendre les mesures".into()),
            project_id: None,
            employee_id: None,
        }
    }

    #[test]
    fn canonical_date_rejects_impossible_day() {
        assert!(canonical_date("2026-02-29", "start_date").is_err());
        assert_eq!(
            canonical_date("2028-02-29", "start_date").unwrap(),
            "2028-02-29"
        );
    }

    #[test]
    fn canonical_time_is_strict_and_minute_based() {
        assert!(canonical_time(Some("9:30".into()), "start_time").is_err());
        assert_eq!(
            canonical_time(Some("09:30".into()), "start_time").unwrap(),
            "09:30"
        );
    }

    #[test]
    fn event_crud_is_local_audited_and_visible_in_workspace() {
        let (_temporary, store) = initialized_store();
        let created = store.save_agenda_event(event(None)).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["kind"], "visit");
        assert_eq!(created["all_day"], false);

        let mut updated_input = event(Some(id.clone()));
        updated_input.status = Some("completed".into());
        let updated = store.save_agenda_event(updated_input).unwrap();
        assert_eq!(updated["status"], "completed");

        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["agenda_events"].as_array().unwrap().len(), 1);
        let audit_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='agenda_event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 2);

        assert!(store.delete_agenda_event(&id).unwrap().deleted);
        assert!(store.get_workspace().unwrap()["agenda_events"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}

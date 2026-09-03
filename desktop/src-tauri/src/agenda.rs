use chrono::{NaiveDate, NaiveTime};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{DeleteResult, SaveAgendaEventInput},
};

const EVENT_KINDS: &[&str] = &["appointment", "visit", "deadline", "other"];
const EVENT_STATUSES: &[&str] = &["scheduled", "completed", "cancelled"];

impl LocalStore {
    pub fn save_agenda_event(&self, input: SaveAgendaEventInput) -> AppResult<Value> {
        let id = optional_uuid(input.id, "id")?;
        if input.create_only && id.is_none() {
            return Err(AppError::Validation(
                "Une création d'agenda doit conserver un identifiant technique stable.".into(),
            ));
        }
        let title = required_text(&input.title, "title", 200)?;
        let expected_updated_at =
            optional_text(input.expected_updated_at, "expected_updated_at", 64)?;
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

        let previous = if let Some(id) = id.as_deref() {
            query_all(
                &transaction,
                "SELECT * FROM agenda_events WHERE id=?",
                params![id],
            )?
            .into_iter()
            .next()
        } else {
            None
        };
        if let Some(previous) = previous.as_ref() {
            if agenda_event_matches(
                previous,
                &title,
                &start_date,
                &end_date,
                input.all_day,
                start_time.as_deref(),
                end_time.as_deref(),
                &kind,
                &status,
                location.as_deref(),
                notes.as_deref(),
                project_id.as_deref(),
                employee_id.as_deref(),
            ) {
                transaction.commit()?;
                return Ok(previous.clone());
            }
            if input.create_only {
                return Err(AppError::Validation(
                    "Ce rendez-vous a déjà été créé avec d'autres données. Rechargez l'agenda avant de continuer."
                        .into(),
                ));
            }
            if expected_updated_at
                .as_deref()
                .is_some_and(|expected| previous["updated_at"].as_str() != Some(expected))
            {
                return Err(AppError::Validation(
                    "Ce rendez-vous a été modifié dans une autre fenêtre. Rechargez l'agenda avant d'enregistrer vos changements."
                        .into(),
                ));
            }
        }

        let now = now_iso();
        let (id, previous, created_at, action) = match (id, previous) {
            (Some(id), Some(previous)) => {
                let created_at = previous["created_at"]
                    .as_str()
                    .ok_or_else(|| AppError::Validation("Événement local incomplet.".into()))?
                    .to_owned();
                (id, previous, created_at, "update")
            }
            (Some(id), None) if input.create_only => (id, Value::Null, now.clone(), "create"),
            (Some(id), None) => {
                return Err(AppError::NotFound(format!("agenda_events/{id}")));
            }
            (None, None) => (
                Uuid::new_v4().to_string(),
                Value::Null,
                now.clone(),
                "create",
            ),
            (None, Some(_)) => unreachable!("un événement sans identifiant ne peut pas exister"),
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

    pub fn delete_agenda_event(
        &self,
        id: &str,
        expected_updated_at: Option<&str>,
    ) -> AppResult<DeleteResult> {
        let id = required_uuid(id, "id")?;
        let expected_updated_at = optional_text(
            expected_updated_at.map(str::to_owned),
            "expected_updated_at",
            64,
        )?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_all(
            &transaction,
            "SELECT * FROM agenda_events WHERE id=?",
            params![id],
        )?
        .into_iter()
        .next();
        let Some(previous) = previous else {
            transaction.commit()?;
            return Ok(DeleteResult { deleted: false, id });
        };
        if expected_updated_at
            .as_deref()
            .is_some_and(|expected| previous["updated_at"].as_str() != Some(expected))
        {
            return Err(AppError::Validation(
                "Ce rendez-vous a été modifié dans une autre fenêtre. Rechargez l'agenda avant de le supprimer."
                    .into(),
            ));
        }
        let deleted =
            transaction.execute("DELETE FROM agenda_events WHERE id=?", params![id])? == 1;
        append_audit(&transaction, "delete", "agenda_event", &id, &previous)?;
        transaction.commit()?;
        Ok(DeleteResult { deleted, id })
    }
}

#[allow(clippy::too_many_arguments)]
fn agenda_event_matches(
    previous: &Value,
    title: &str,
    start_date: &str,
    end_date: &str,
    all_day: bool,
    start_time: Option<&str>,
    end_time: Option<&str>,
    kind: &str,
    status: &str,
    location: Option<&str>,
    notes: Option<&str>,
    project_id: Option<&str>,
    employee_id: Option<&str>,
) -> bool {
    previous["title"].as_str() == Some(title)
        && previous["start_date"].as_str() == Some(start_date)
        && previous["end_date"].as_str() == Some(end_date)
        && previous["all_day"].as_bool() == Some(all_day)
        && optional_string_matches(&previous["start_time"], start_time)
        && optional_string_matches(&previous["end_time"], end_time)
        && previous["kind"].as_str() == Some(kind)
        && previous["status"].as_str() == Some(status)
        && optional_string_matches(&previous["location"], location)
        && optional_string_matches(&previous["notes"], notes)
        && optional_string_matches(&previous["project_id"], project_id)
        && optional_string_matches(&previous["employee_id"], employee_id)
}

fn optional_string_matches(value: &Value, expected: Option<&str>) -> bool {
    match expected {
        Some(expected) => value.as_str() == Some(expected),
        None => value.is_null(),
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
            create_only: false,
            expected_updated_at: None,
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

        let updated_at = updated["updated_at"].as_str().unwrap();
        assert!(
            store
                .delete_agenda_event(&id, Some(updated_at))
                .unwrap()
                .deleted
        );
        assert!(
            !store
                .delete_agenda_event(&id, Some(updated_at))
                .unwrap()
                .deleted
        );
        assert!(store.get_workspace().unwrap()["agenda_events"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn stable_creation_id_prevents_duplicates_and_conflicting_retries() {
        let (_temporary, store) = initialized_store();
        let stable_id = "d70fb973-2e6e-4f0a-acd4-c2ef3915a498";
        let mut first = event(Some(stable_id.into()));
        first.create_only = true;
        let created = store.save_agenda_event(first.clone()).unwrap();
        let repeated = store.save_agenda_event(first).unwrap();
        assert_eq!(created["id"], stable_id);
        assert_eq!(repeated["id"], stable_id);

        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agenda_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let audit_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='agenda_event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1, "une reprise identique reste sans effet");

        let mut conflict = event(Some(stable_id.into()));
        conflict.create_only = true;
        conflict.title = "Autre rendez-vous".into();
        assert!(store.save_agenda_event(conflict).is_err());
        assert_eq!(
            store.get_workspace().unwrap()["agenda_events"][0]["title"],
            "Visite client"
        );
    }

    #[test]
    fn update_retry_is_idempotent_and_stale_changes_are_rejected() {
        let (_temporary, store) = initialized_store();
        let created = store.save_agenda_event(event(None)).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        let original_updated_at = created["updated_at"].as_str().unwrap().to_owned();

        let mut first_update = event(Some(id.clone()));
        first_update.expected_updated_at = Some(original_updated_at.clone());
        first_update.title = "Visite déplacée".into();
        let updated = store.save_agenda_event(first_update.clone()).unwrap();
        assert_ne!(updated["updated_at"], original_updated_at);

        let repeated = store.save_agenda_event(first_update).unwrap();
        assert_eq!(repeated, updated, "un rejeu identique reste sans effet");

        assert!(matches!(
            store.delete_agenda_event(&id, Some(&original_updated_at)),
            Err(AppError::Validation(message)) if message.contains("autre fenêtre")
        ));

        let mut stale = event(Some(id));
        stale.expected_updated_at = Some(original_updated_at);
        stale.notes = Some("Modification depuis une autre fenêtre".into());
        assert!(matches!(
            store.save_agenda_event(stale),
            Err(AppError::Validation(message)) if message.contains("autre fenêtre")
        ));

        let audit_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='agenda_event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 2, "création et mise à jour seulement");
    }
}

use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{DeleteResult, SaveProjectMilestoneInput, SaveProjectTaskInput},
};

const STATUSES: &[&str] = &["todo", "in_progress", "done", "cancelled"];
const PRIORITIES: &[&str] = &["low", "normal", "high", "urgent"];

impl LocalStore {
    pub fn save_project_milestone(&self, input: SaveProjectMilestoneInput) -> AppResult<Value> {
        let id = optional_id(input.id, "id")?;
        let project_id = required_id(&input.project_id, "project_id")?;
        let title = normalized_title(&input.title)?;
        let description = normalized_optional_text(input.description, "description", 20_000)?;
        let due_date = normalized_optional_date(input.due_date, "due_date")?;
        let requested_status = input
            .status
            .map(|value| normalized_status(&value))
            .transpose()?;
        let priority = input
            .priority
            .map(|value| normalized_priority(&value))
            .transpose()?;
        let sort_order = normalized_sort_order(input.sort_order)?;
        let employee_id = optional_id(input.employee_id, "employee_id")?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_exists(&transaction, "projects", &project_id, "projects")?;
        if let Some(employee_id) = employee_id.as_deref() {
            ensure_exists(&transaction, "employees", employee_id, "employees")?;
        }

        let (id, previous, status, priority, sort_order, completed_at, action) = match id {
            Some(id) => {
                let previous = query_record_tx(&transaction, "project_milestones", &id)?;
                let previous_project_id = record_str(&previous, "project_id")?;
                if previous_project_id != project_id {
                    return Err(AppError::Validation(
                        "Un jalon ne peut pas être déplacé vers un autre projet.".into(),
                    ));
                }
                let current_status = record_str(&previous, "status")?;
                let status = requested_status.unwrap_or_else(|| current_status.to_owned());
                ensure_status_transition(current_status, &status, "jalon")?;
                if matches!(current_status, "done" | "cancelled") && status == current_status {
                    return Err(AppError::Validation(
                        "Rouvrez le jalon avant de modifier son contenu.".into(),
                    ));
                }
                ensure_milestone_can_close(&transaction, &id, &status)?;
                ensure_milestone_due_date(&transaction, &id, due_date.as_deref())?;
                let priority = priority.unwrap_or_else(|| {
                    record_str(&previous, "priority").unwrap_or("normal").into()
                });
                let sort_order = sort_order
                    .unwrap_or_else(|| previous["sort_order"].as_i64().unwrap_or_default());
                let completed_at = completed_at_for_status(&status, Some(&previous));
                (
                    id,
                    previous,
                    status,
                    priority,
                    sort_order,
                    completed_at,
                    "update",
                )
            }
            None => {
                let status = requested_status.unwrap_or_else(|| "todo".into());
                let completed_at = completed_at_for_status(&status, None);
                (
                    Uuid::new_v4().to_string(),
                    Value::Null,
                    status,
                    priority.unwrap_or_else(|| "normal".into()),
                    sort_order.unwrap_or_default(),
                    completed_at,
                    "create",
                )
            }
        };

        let now = now_iso();
        if action == "create" {
            transaction.execute(
                "INSERT INTO project_milestones
                 (id,project_id,title,description,due_date,status,priority,sort_order,employee_id,completed_at,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    id,
                    project_id,
                    title,
                    description,
                    due_date,
                    status,
                    priority,
                    sort_order,
                    employee_id,
                    completed_at,
                    now,
                    now,
                ],
            )?;
        } else {
            transaction.execute(
                "UPDATE project_milestones
                 SET title=?,description=?,due_date=?,status=?,priority=?,sort_order=?,employee_id=?,completed_at=?,updated_at=?
                 WHERE id=?",
                params![
                    title,
                    description,
                    due_date,
                    status,
                    priority,
                    sort_order,
                    employee_id,
                    completed_at,
                    now,
                    id,
                ],
            )?;
        }
        let record = query_record_tx(&transaction, "project_milestones", &id)?;
        append_audit(
            &transaction,
            action,
            "project_milestone",
            &id,
            &json!({"before":previous,"after":record.clone()}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn delete_project_milestone(&self, id: &str) -> AppResult<DeleteResult> {
        let id = required_id(id, "id")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, "project_milestones", &id)?;
        if previous["status"] != "todo" {
            return Err(AppError::Validation(
                "Seul un jalon au statut todo peut être supprimé.".into(),
            ));
        }
        let task_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM project_tasks WHERE milestone_id=?",
            params![id],
            |row| row.get(0),
        )?;
        if task_count != 0 {
            return Err(AppError::Validation(
                "Retirez ou réaffectez les tâches du jalon avant de le supprimer.".into(),
            ));
        }
        let deleted =
            transaction.execute("DELETE FROM project_milestones WHERE id=?", params![id])? == 1;
        append_audit(&transaction, "delete", "project_milestone", &id, &previous)?;
        transaction.commit()?;
        Ok(DeleteResult { deleted, id })
    }

    pub fn save_project_task(&self, input: SaveProjectTaskInput) -> AppResult<Value> {
        let id = optional_id(input.id, "id")?;
        let project_id = required_id(&input.project_id, "project_id")?;
        let milestone_id = optional_id(input.milestone_id, "milestone_id")?;
        let title = normalized_title(&input.title)?;
        let description = normalized_optional_text(input.description, "description", 20_000)?;
        let due_date = normalized_optional_date(input.due_date, "due_date")?;
        let priority = input
            .priority
            .map(|value| normalized_priority(&value))
            .transpose()?;
        let sort_order = normalized_sort_order(input.sort_order)?;
        let employee_id = optional_id(input.employee_id, "employee_id")?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_exists(&transaction, "projects", &project_id, "projects")?;
        if let Some(employee_id) = employee_id.as_deref() {
            ensure_exists(&transaction, "employees", employee_id, "employees")?;
        }
        if let Some(milestone_id) = milestone_id.as_deref() {
            ensure_task_milestone(&transaction, milestone_id, &project_id, due_date.as_deref())?;
        }

        let (id, previous, priority, sort_order, action) = match id {
            Some(id) => {
                let previous = query_record_tx(&transaction, "project_tasks", &id)?;
                if record_str(&previous, "project_id")? != project_id {
                    return Err(AppError::Validation(
                        "Une tâche ne peut pas être déplacée vers un autre projet.".into(),
                    ));
                }
                if matches!(record_str(&previous, "status")?, "done" | "cancelled") {
                    return Err(AppError::Validation(
                        "Rouvrez la tâche avant de modifier son contenu.".into(),
                    ));
                }
                let priority = priority.unwrap_or_else(|| {
                    record_str(&previous, "priority").unwrap_or("normal").into()
                });
                let sort_order = sort_order
                    .unwrap_or_else(|| previous["sort_order"].as_i64().unwrap_or_default());
                (id, previous, priority, sort_order, "update")
            }
            None => (
                Uuid::new_v4().to_string(),
                Value::Null,
                priority.unwrap_or_else(|| "normal".into()),
                sort_order.unwrap_or_default(),
                "create",
            ),
        };

        let now = now_iso();
        if action == "create" {
            transaction.execute(
                "INSERT INTO project_tasks
                 (id,project_id,milestone_id,title,description,due_date,status,priority,sort_order,employee_id,completed_at,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,'todo',?,?,?,NULL,?,?)",
                params![
                    id,
                    project_id,
                    milestone_id,
                    title,
                    description,
                    due_date,
                    priority,
                    sort_order,
                    employee_id,
                    now,
                    now,
                ],
            )?;
        } else {
            transaction.execute(
                "UPDATE project_tasks
                 SET milestone_id=?,title=?,description=?,due_date=?,priority=?,sort_order=?,employee_id=?,updated_at=?
                 WHERE id=?",
                params![
                    milestone_id,
                    title,
                    description,
                    due_date,
                    priority,
                    sort_order,
                    employee_id,
                    now,
                    id,
                ],
            )?;
        }
        let record = query_record_tx(&transaction, "project_tasks", &id)?;
        append_audit(
            &transaction,
            action,
            "project_task",
            &id,
            &json!({"before":previous,"after":record.clone()}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn set_project_task_status(&self, id: &str, status: &str) -> AppResult<Value> {
        let id = required_id(id, "id")?;
        let status = normalized_status(status)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, "project_tasks", &id)?;
        let current = record_str(&previous, "status")?;
        if current == status {
            transaction.commit()?;
            return Ok(previous);
        }
        ensure_status_transition(current, &status, "tâche")?;
        if matches!(status.as_str(), "done" | "cancelled") {
            let timer_active: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM active_timers WHERE task_id=?)",
                params![id],
                |row| row.get(0),
            )?;
            if timer_active {
                return Err(AppError::Validation(
                    "Arrêtez ou annulez le chronomètre actif avant de fermer la tâche.".into(),
                ));
            }
        }
        if matches!(status.as_str(), "todo" | "in_progress") {
            if let Some(milestone_id) = previous["milestone_id"].as_str() {
                ensure_task_milestone(
                    &transaction,
                    milestone_id,
                    record_str(&previous, "project_id")?,
                    previous["due_date"].as_str(),
                )?;
            }
        }
        let completed_at = completed_at_for_status(&status, Some(&previous));
        transaction.execute(
            "UPDATE project_tasks SET status=?,completed_at=?,updated_at=? WHERE id=?",
            params![status, completed_at, now_iso(), id],
        )?;
        let record = query_record_tx(&transaction, "project_tasks", &id)?;
        append_audit(
            &transaction,
            "status",
            "project_task",
            &id,
            &json!({"from":current,"to":status,"before":previous,"after":record.clone()}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn delete_project_task(&self, id: &str) -> AppResult<DeleteResult> {
        let id = required_id(id, "id")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, "project_tasks", &id)?;
        if previous["status"] != "todo" {
            return Err(AppError::Validation(
                "Seule une tâche au statut todo peut être supprimée.".into(),
            ));
        }
        let time_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM time_entries WHERE task_id=?",
            params![id],
            |row| row.get(0),
        )?;
        if time_count != 0 {
            return Err(AppError::Validation(
                "Une tâche liée à des temps saisis ne peut pas être supprimée.".into(),
            ));
        }
        let timer_active: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM active_timers WHERE task_id=?)",
            params![id],
            |row| row.get(0),
        )?;
        if timer_active {
            return Err(AppError::Validation(
                "Arrêtez ou annulez le chronomètre actif avant de supprimer la tâche.".into(),
            ));
        }
        let deleted =
            transaction.execute("DELETE FROM project_tasks WHERE id=?", params![id])? == 1;
        append_audit(&transaction, "delete", "project_task", &id, &previous)?;
        transaction.commit()?;
        Ok(DeleteResult { deleted, id })
    }
}

fn ensure_exists(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    entity: &str,
) -> AppResult<()> {
    let exists: bool = transaction.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?)"),
        params![id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("{entity}/{id}")))
    }
}

fn ensure_task_milestone(
    transaction: &Transaction<'_>,
    milestone_id: &str,
    project_id: &str,
    task_due_date: Option<&str>,
) -> AppResult<()> {
    let milestone: Option<(String, String, Option<String>)> = transaction
        .query_row(
            "SELECT project_id,status,due_date FROM project_milestones WHERE id=?",
            params![milestone_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((milestone_project_id, status, milestone_due_date)) = milestone else {
        return Err(AppError::NotFound(format!(
            "project_milestones/{milestone_id}"
        )));
    };
    if milestone_project_id != project_id {
        return Err(AppError::Validation(
            "Le jalon sélectionné appartient à un autre projet.".into(),
        ));
    }
    if !matches!(status.as_str(), "todo" | "in_progress") {
        return Err(AppError::Validation(
            "Une tâche active ne peut pas être affectée à un jalon terminé ou annulé.".into(),
        ));
    }
    if let (Some(task_due_date), Some(milestone_due_date)) =
        (task_due_date, milestone_due_date.as_deref())
    {
        if task_due_date > milestone_due_date {
            return Err(AppError::Validation(
                "L'échéance de la tâche ne peut pas dépasser celle du jalon.".into(),
            ));
        }
    }
    Ok(())
}

fn ensure_milestone_can_close(
    transaction: &Transaction<'_>,
    milestone_id: &str,
    status: &str,
) -> AppResult<()> {
    if !matches!(status, "done" | "cancelled") {
        return Ok(());
    }
    let active_count: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM project_tasks
         WHERE milestone_id=? AND status NOT IN ('done','cancelled')",
        params![milestone_id],
        |row| row.get(0),
    )?;
    if active_count == 0 {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Terminez ou annulez toutes les tâches actives avant de fermer le jalon.".into(),
        ))
    }
}

fn ensure_milestone_due_date(
    transaction: &Transaction<'_>,
    milestone_id: &str,
    due_date: Option<&str>,
) -> AppResult<()> {
    let Some(due_date) = due_date else {
        return Ok(());
    };
    let later_task: Option<String> = transaction
        .query_row(
            "SELECT id FROM project_tasks
             WHERE milestone_id=? AND due_date IS NOT NULL AND due_date>?
             ORDER BY due_date DESC LIMIT 1",
            params![milestone_id, due_date],
            |row| row.get(0),
        )
        .optional()?;
    if later_task.is_some() {
        Err(AppError::Validation(
            "L'échéance du jalon ne peut pas précéder celle d'une de ses tâches.".into(),
        ))
    } else {
        Ok(())
    }
}

fn completed_at_for_status(status: &str, previous: Option<&Value>) -> Option<String> {
    if status != "done" {
        return None;
    }
    previous
        .and_then(|record| record["completed_at"].as_str().map(ToOwned::to_owned))
        .or_else(|| Some(now_iso()))
}

fn ensure_status_transition(current: &str, next: &str, entity: &str) -> AppResult<()> {
    let allowed = current == next
        || matches!(
            (current, next),
            ("todo", "in_progress" | "done" | "cancelled")
                | ("in_progress", "todo" | "done" | "cancelled")
                | ("done", "in_progress")
                | ("cancelled", "todo")
        );
    if allowed {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Transition de statut interdite pour le {entity} : {current} vers {next}."
        )))
    }
}

fn normalized_status(value: &str) -> AppResult<String> {
    let value = value.trim();
    if STATUSES.contains(&value) {
        Ok(value.into())
    } else {
        Err(AppError::Validation(
            "status doit être todo, in_progress, done ou cancelled.".into(),
        ))
    }
}

fn normalized_priority(value: &str) -> AppResult<String> {
    let value = value.trim();
    if PRIORITIES.contains(&value) {
        Ok(value.into())
    } else {
        Err(AppError::Validation(
            "priority doit être low, normal, high ou urgent.".into(),
        ))
    }
}

fn normalized_sort_order(value: Option<i64>) -> AppResult<Option<i64>> {
    match value {
        Some(value) if !(0..=1_000_000).contains(&value) => Err(AppError::Validation(
            "sort_order doit être compris entre 0 et 1000000.".into(),
        )),
        value => Ok(value),
    }
}

fn normalized_title(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 200 {
        Err(AppError::Validation(
            "title doit contenir entre 1 et 200 caractères.".into(),
        ))
    } else {
        Ok(value.into())
    }
}

fn normalized_optional_text(
    value: Option<String>,
    field: &str,
    max: usize,
) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        Ok(None)
    } else if value.chars().count() > max {
        Err(AppError::Validation(format!(
            "{field} ne peut pas dépasser {max} caractères."
        )))
    } else {
        Ok(Some(value.into()))
    }
}

fn normalized_optional_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| Some(date.format("%Y-%m-%d").to_string()))
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))
}

fn required_id(value: &str, field: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 {
        Err(AppError::Validation(format!(
            "{field} doit contenir entre 1 et 80 caractères."
        )))
    } else {
        Ok(value.into())
    }
}

fn optional_id(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    value.map(|value| required_id(&value, field)).transpose()
}

fn record_str<'a>(record: &'a Value, field: &str) -> AppResult<&'a str> {
    record[field]
        .as_str()
        .ok_or_else(|| AppError::Validation(format!("{field} enregistré est invalide.")))
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use serde_json::json;

    use super::*;
    use crate::schema::SCHEMA_VERSION;

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at)
                 VALUES(1,1,'Entreprise de planification',?,?)",
                params![now, now],
            )
            .unwrap();
        drop(connection);
        (temporary, store)
    }

    fn record_id(record: &Value) -> String {
        record["id"].as_str().unwrap().to_owned()
    }

    fn project(store: &LocalStore, name: &str) -> String {
        record_id(
            &store
                .create_record("projects", json!({"name":name}))
                .unwrap(),
        )
    }

    fn employee(store: &LocalStore) -> String {
        record_id(
            &store
                .create_record("employees", json!({"name":"Responsable projet"}))
                .unwrap(),
        )
    }

    fn milestone_input(
        id: Option<String>,
        project_id: &str,
        employee_id: Option<String>,
        status: Option<&str>,
    ) -> SaveProjectMilestoneInput {
        SaveProjectMilestoneInput {
            id,
            project_id: project_id.into(),
            title: "Préparation".into(),
            description: Some("Préparer le dossier".into()),
            due_date: Some("2026-06-30".into()),
            status: status.map(str::to_owned),
            priority: Some("high".into()),
            sort_order: Some(10),
            employee_id,
        }
    }

    fn task_input(
        id: Option<String>,
        project_id: &str,
        milestone_id: Option<String>,
        employee_id: Option<String>,
    ) -> SaveProjectTaskInput {
        SaveProjectTaskInput {
            id,
            project_id: project_id.into(),
            milestone_id,
            title: "Commander le matériel".into(),
            description: Some("Commande locale".into()),
            due_date: Some("2026-06-20".into()),
            priority: Some("urgent".into()),
            sort_order: Some(20),
            employee_id,
        }
    }

    #[test]
    fn migration_v18_to_v19_is_idempotent() {
        let (_temporary, store) = initialized_store();
        let connection = store.connect().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER IF EXISTS time_entries_task_insert_guard;
                 DROP TRIGGER IF EXISTS time_entries_task_update_guard;
                 DROP TRIGGER IF EXISTS active_timers_task_insert_guard;
                 DROP TRIGGER IF EXISTS active_timers_task_update_guard;
                 DROP TRIGGER IF EXISTS project_tasks_active_timer_close_guard;
                 DROP INDEX IF EXISTS idx_time_entries_task_date;
                 ALTER TABLE time_entries DROP COLUMN task_id;
                 ALTER TABLE active_timers DROP COLUMN task_id;
                 DROP TABLE project_tasks;
                 DROP TABLE project_milestones;
                 PRAGMA user_version=18;",
            )
            .unwrap();
        drop(connection);

        store.migrate().unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let task_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('time_entries') WHERE name='task_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_column_count, 1);
        let active_timer_task_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('active_timers') WHERE name='task_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_timer_task_column_count, 1);
        connection.pragma_update(None, "user_version", 18).unwrap();
        drop(connection);

        store.migrate().unwrap();
        let connection = store.connect().unwrap();
        let task_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('time_entries') WHERE name='task_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_column_count, 1);
        let active_timer_task_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('active_timers') WHERE name='task_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_timer_task_column_count, 1);
        let foreign_key_errors: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(foreign_key_errors, 0);
    }

    #[test]
    fn planning_crud_status_and_delete_rules_are_audited() {
        let (_temporary, store) = initialized_store();
        let project_id = project(&store, "Projet principal");
        let employee_id = employee(&store);
        let milestone = store
            .save_project_milestone(milestone_input(
                None,
                &project_id,
                Some(employee_id.clone()),
                None,
            ))
            .unwrap();
        let milestone_id = record_id(&milestone);
        let task = store
            .save_project_task(task_input(
                None,
                &project_id,
                Some(milestone_id.clone()),
                Some(employee_id.clone()),
            ))
            .unwrap();
        let task_id = record_id(&task);

        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["project_milestones"].as_array().unwrap().len(), 1);
        assert_eq!(workspace["project_tasks"].as_array().unwrap().len(), 1);
        assert!(store
            .save_project_milestone(milestone_input(
                Some(milestone_id.clone()),
                &project_id,
                Some(employee_id.clone()),
                Some("done"),
            ))
            .is_err());

        let in_progress = store
            .set_project_task_status(&task_id, "in_progress")
            .unwrap();
        assert_eq!(in_progress["status"], "in_progress");
        assert!(in_progress["completed_at"].is_null());
        let done = store.set_project_task_status(&task_id, "done").unwrap();
        assert_eq!(done["status"], "done");
        assert!(done["completed_at"].as_str().is_some());
        assert!(store
            .save_project_task(task_input(
                Some(task_id.clone()),
                &project_id,
                Some(milestone_id.clone()),
                Some(employee_id.clone()),
            ))
            .is_err());
        assert!(store.delete_project_task(&task_id).is_err());

        let completed_milestone = store
            .save_project_milestone(milestone_input(
                Some(milestone_id.clone()),
                &project_id,
                Some(employee_id),
                Some("done"),
            ))
            .unwrap();
        assert_eq!(completed_milestone["status"], "done");
        assert!(completed_milestone["completed_at"].as_str().is_some());
        assert!(store.delete_project_milestone(&milestone_id).is_err());

        let audit_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type IN ('project_milestone','project_task')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 5);

        let disposable_milestone = store
            .save_project_milestone(milestone_input(None, &project_id, None, None))
            .unwrap();
        let disposable_milestone_id = record_id(&disposable_milestone);
        let disposable_task = store
            .save_project_task(task_input(
                None,
                &project_id,
                Some(disposable_milestone_id.clone()),
                None,
            ))
            .unwrap();
        let disposable_task_id = record_id(&disposable_task);
        assert!(store
            .delete_project_milestone(&disposable_milestone_id)
            .is_err());
        assert!(
            store
                .delete_project_task(&disposable_task_id)
                .unwrap()
                .deleted
        );
        assert!(
            store
                .delete_project_milestone(&disposable_milestone_id)
                .unwrap()
                .deleted
        );
    }

    #[test]
    fn invalid_dates_links_priorities_and_time_task_project_are_rejected() {
        let (_temporary, store) = initialized_store();
        let first_project = project(&store, "Projet A");
        let second_project = project(&store, "Projet B");
        let mut invalid_date = milestone_input(None, &first_project, None, None);
        invalid_date.due_date = Some("2026-02-30".into());
        assert!(store.save_project_milestone(invalid_date).is_err());

        let milestone = store
            .save_project_milestone(milestone_input(None, &first_project, None, None))
            .unwrap();
        let milestone_id = record_id(&milestone);
        let mut wrong_priority = task_input(None, &first_project, Some(milestone_id.clone()), None);
        wrong_priority.priority = Some("critical".into());
        assert!(store.save_project_task(wrong_priority).is_err());

        let mut too_late = task_input(None, &first_project, Some(milestone_id.clone()), None);
        too_late.due_date = Some("2026-07-01".into());
        assert!(store.save_project_task(too_late).is_err());
        assert!(store
            .save_project_task(task_input(
                None,
                &second_project,
                Some(milestone_id.clone()),
                None,
            ))
            .is_err());

        let task = store
            .save_project_task(task_input(None, &first_project, Some(milestone_id), None))
            .unwrap();
        let task_id = record_id(&task);
        assert!(store
            .create_record(
                "time_entries",
                json!({
                    "project_id":second_project,
                    "task_id":task_id,
                    "date":"2026-06-01",
                    "minutes":60
                }),
            )
            .is_err());
        let time = store
            .create_record(
                "time_entries",
                json!({
                    "project_id":first_project,
                    "task_id":task_id,
                    "date":"2026-06-01",
                    "minutes":60
                }),
            )
            .unwrap();
        assert_eq!(time["task_id"], task_id);
        assert!(store.delete_project_task(&task_id).is_err());
        assert!(store.set_project_task_status(&task_id, "waiting").is_err());
    }

    #[test]
    fn timer_keeps_an_optional_open_task_from_start_to_time_entry() {
        let (_temporary, store) = initialized_store();
        let first_project = project(&store, "Projet chronométré");
        let second_project = project(&store, "Autre projet");
        let task = store
            .save_project_task(task_input(None, &first_project, None, None))
            .unwrap();
        let task_id = record_id(&task);
        let timer_input = |project_id: &str, task_id: Option<String>| crate::models::TimerInput {
            project_id: project_id.into(),
            task_id,
            employee_id: None,
            note: Some("Travail sur la tâche".into()),
            billable: true,
            billing_rate_cents: 12_000,
            cost_rate_cents: 8_000,
        };

        assert!(store
            .start_timer(timer_input(&second_project, Some(task_id.clone())))
            .is_err());
        store.set_project_task_status(&task_id, "done").unwrap();
        assert!(store
            .start_timer(timer_input(&first_project, Some(task_id.clone())))
            .is_err());
        store
            .set_project_task_status(&task_id, "in_progress")
            .unwrap();

        let timer = store
            .start_timer(timer_input(&first_project, Some(task_id.clone())))
            .unwrap();
        assert_eq!(timer["project_id"], first_project);
        assert_eq!(timer["task_id"], task_id);
        assert_eq!(store.get_active_timer().unwrap()["task_id"], task_id);
        assert!(store.set_project_task_status(&task_id, "done").is_err());
        assert!(store.delete_project_task(&task_id).is_err());

        let time_entry = store.stop_timer().unwrap();
        assert_eq!(time_entry["project_id"], first_project);
        assert_eq!(time_entry["task_id"], task_id);
        assert!(store.get_active_timer().unwrap().is_null());
        assert_eq!(
            store.set_project_task_status(&task_id, "done").unwrap()["status"],
            "done"
        );
    }

    #[test]
    fn generic_project_delete_refuses_links_and_allows_only_an_empty_project() {
        let (_temporary, store) = initialized_store();
        let linked_project = project(&store, "Projet avec données");
        let milestone = store
            .save_project_milestone(milestone_input(None, &linked_project, None, None))
            .unwrap();
        let error = store
            .delete_record("projects", &linked_project)
            .unwrap_err()
            .to_string();
        assert!(error.contains("jalons (1)"));
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["schema_version"], SCHEMA_VERSION);
        assert_eq!(workspace["project_milestones"][0]["id"], milestone["id"]);

        let empty_project = project(&store, "Projet réellement vide");
        let deleted = store.delete_record("projects", &empty_project).unwrap();
        assert!(deleted.deleted);
        assert_eq!(deleted.id, empty_project);
    }

    #[test]
    fn backup_restore_keeps_planning_records() {
        let (_temporary, store) = initialized_store();
        let project_id = project(&store, "Projet sauvegardé");
        let milestone = store
            .save_project_milestone(milestone_input(None, &project_id, None, None))
            .unwrap();
        store
            .save_project_task(task_input(
                None,
                &project_id,
                Some(record_id(&milestone)),
                None,
            ))
            .unwrap();
        let backup = store.create_backup(None, "1.5.0").unwrap();
        store
            .save_project_task(task_input(None, &project_id, None, None))
            .unwrap();
        assert_eq!(
            store.get_workspace().unwrap()["project_tasks"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        store.restore_backup(&backup, "1.5.0").unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["project_milestones"].as_array().unwrap().len(), 1);
        assert_eq!(workspace["project_tasks"].as_array().unwrap().len(), 1);
        let counts = store.business_row_counts().unwrap();
        assert_eq!(counts["project_milestones"], 1);
        assert_eq!(counts["project_tasks"], 1);
    }
}

//! Small plain-text company notes, committed locally before any network work.
//! The existing company clock, archive and CAS merge carry edits and tombstones.
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{query_all, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::DeleteResult,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveWorkNoteInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub expected_updated_at: Option<String>,
    #[serde(default)]
    pub expected_workspace_scope: Option<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn canonical_id(id: &str) -> AppResult<String> {
    Uuid::parse_str(id.trim())
        .map(|id| id.to_string())
        .map_err(|_| invalid("L’identifiant de la note ou du projet est invalide."))
}
fn text(value: &str, title: bool) -> AppResult<String> {
    let value = if title {
        value.trim().to_owned()
    } else {
        value.replace("\r\n", "\n").replace('\r', "\n")
    };
    if value.chars().count() > if title { 200 } else { 100_000 }
        || value
            .chars()
            .any(|c| c.is_control() && (title || !matches!(c, '\n' | '\t')))
    {
        return Err(invalid(if title {
            "Le titre doit tenir sur une ligne de 200 caractères maximum."
        } else {
            "La note doit contenir au maximum 100 000 caractères de texte."
        }));
    }
    Ok(value)
}

/// A strictly advancing timestamp is the optimistic revision token, even when
/// two autosaves happen in the same clock tick or the device clock moves back.
fn next_timestamp(previous: Option<&str>) -> AppResult<String> {
    let mut now = Utc::now();
    if let Some(previous) = previous {
        let previous = DateTime::parse_from_rfc3339(previous)
            .map_err(|_| invalid("La version de cette note est invalide. Rechargez les notes."))?
            .with_timezone(&Utc);
        if now <= previous {
            now = previous
                .checked_add_signed(Duration::nanoseconds(1))
                .ok_or_else(|| invalid("La date de cette note dépasse la plage autorisée."))?;
        }
    }
    Ok(now.to_rfc3339())
}

fn require_member_write(connection: &Connection) -> AppResult<()> {
    let role: Option<String> = connection
        .query_row(
            "SELECT role FROM company_local_identity WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if role.as_deref() == Some("read_only") {
        return Err(invalid(
            "Votre rôle Zentra permet de consulter les notes, mais pas de les modifier.",
        ));
    }
    Ok(())
}

fn require_workspace_scope(connection: &Connection, expected: Option<&str>) -> AppResult<()> {
    if let Some(expected) = expected {
        if workspace_scope(connection)? != expected {
            return Err(invalid("L’entreprise ouverte a changé. Ce brouillon appartient à l’espace précédent et y reste conservé."));
        }
    }
    Ok(())
}

fn matches(record: &Value, title: &str, body: &str, project: Option<&str>, pinned: bool) -> bool {
    record["title"].as_str() == Some(title)
        && record["body"].as_str() == Some(body)
        && record["project_id"].as_str() == project
        && record["pinned"].as_bool() == Some(pinned)
}

pub(crate) fn workspace_notes(connection: &Connection) -> AppResult<Vec<Value>> {
    query_all(connection,
        "SELECT id,title,body,project_id,pinned,created_by_member_id,author_name,created_at,updated_at FROM work_notes WHERE deleted_at IS NULL ORDER BY pinned DESC,updated_at DESC,id", [])
}

pub(crate) fn ensure_workspace_scope(connection: &Connection) -> AppResult<()> {
    connection.execute(
        "INSERT OR IGNORE INTO company_local_notes_scope(id,scope) VALUES(1,?)",
        [Uuid::new_v4().to_string()],
    )?;
    Ok(())
}

pub(crate) fn workspace_scope(connection: &Connection) -> AppResult<String> {
    connection
        .query_row(
            "SELECT scope FROM company_local_notes_scope WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(Into::into)
}

impl LocalStore {
    pub fn save_work_note(&self, input: SaveWorkNoteInput) -> AppResult<Value> {
        let id = input
            .id
            .as_deref()
            .map(canonical_id)
            .transpose()?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let title = text(&input.title, true)?;
        let body = text(&input.body, false)?;
        let project = input.project_id.as_deref().map(canonical_id).transpose()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_workspace_scope(&tx, input.expected_workspace_scope.as_deref())?;
        require_member_write(&tx)?;
        if let Some(project) = &project {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
                [project],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(invalid(
                    "Le projet de cette note n’existe plus. Choisissez un autre projet.",
                ));
            }
        }
        let previous = query_all(&tx, "SELECT * FROM work_notes WHERE id=?", [&id])?
            .into_iter()
            .next();
        if let Some(previous) = &previous {
            if !previous["deleted_at"].is_null() {
                return Err(invalid("Cette note a été supprimée. Votre texte est conservé dans l’éditeur ; créez une nouvelle note."));
            }
            // Stable client UUIDs make a retried creation idempotent, but an
            // update always needs the version read before editing.
            if input.expected_updated_at.is_none()
                && matches(previous, &title, &body, project.as_deref(), input.pinned)
            {
                let mut record = previous.clone();
                record.as_object_mut().unwrap().remove("deleted_at");
                tx.commit()?;
                return Ok(record);
            }
            if input.expected_updated_at.as_deref() != previous["updated_at"].as_str() {
                return Err(invalid("Cette note a été modifiée sur un autre appareil ou dans une autre fenêtre. Votre texte est conservé ; rechargez la note avant de réessayer."));
            }
            if matches(previous, &title, &body, project.as_deref(), input.pinned) {
                let mut record = previous.clone();
                record.as_object_mut().unwrap().remove("deleted_at");
                tx.commit()?;
                return Ok(record);
            }
        } else if input.expected_updated_at.is_some() {
            return Err(invalid(
                "Cette note n’existe plus. Votre texte est conservé ; créez une nouvelle note.",
            ));
        }
        let now = next_timestamp(previous.as_ref().and_then(|p| p["updated_at"].as_str()))?;
        let action = if previous.is_some() {
            "update"
        } else {
            "create"
        };
        if previous.is_some() {
            tx.execute("UPDATE work_notes SET title=?,body=?,project_id=?,pinned=?,updated_at=? WHERE id=?",
                params![title,body,project,input.pinned,now,id])?;
        } else {
            tx.execute("INSERT INTO work_notes(id,title,body,project_id,pinned,created_by_member_id,author_name,created_at,updated_at) VALUES(?,?,?,?,?,(SELECT user_id FROM company_local_identity WHERE id=1),COALESCE((SELECT display_name FROM company_local_identity WHERE id=1),'Créé sur cet appareil'),?,?)",
                params![id,title,body,project,input.pinned,now,now])?;
        }
        let mut record = query_record_tx(&tx, "work_notes", &id)?;
        record.as_object_mut().unwrap().remove("deleted_at");
        append_audit(
            &tx,
            action,
            "work_note",
            &id,
            &json!({"before":previous,"after":record}),
        )?;
        tx.commit()?;
        Ok(record)
    }

    #[cfg(test)]
    pub fn delete_work_note(
        &self,
        id: &str,
        expected_updated_at: Option<&str>,
    ) -> AppResult<DeleteResult> {
        self.delete_work_note_scoped(id, expected_updated_at, None)
    }

    pub fn delete_work_note_scoped(
        &self,
        id: &str,
        expected_updated_at: Option<&str>,
        expected_workspace_scope: Option<&str>,
    ) -> AppResult<DeleteResult> {
        let id = canonical_id(id)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_workspace_scope(&tx, expected_workspace_scope)?;
        require_member_write(&tx)?;
        let previous = query_all(&tx, "SELECT * FROM work_notes WHERE id=?", [&id])?
            .into_iter()
            .next();
        let Some(previous) = previous.filter(|p| p["deleted_at"].is_null()) else {
            tx.commit()?;
            return Ok(DeleteResult { deleted: false, id });
        };
        if expected_updated_at != previous["updated_at"].as_str() {
            return Err(invalid(
                "Cette note a été modifiée. Rechargez les notes avant de la supprimer.",
            ));
        }
        let now = next_timestamp(previous["updated_at"].as_str())?;
        tx.execute(
            "UPDATE work_notes SET deleted_at=?,updated_at=? WHERE id=?",
            params![now, now, id],
        )?;
        append_audit(&tx, "delete", "work_note", &id, &previous)?;
        tx.commit()?;
        Ok(DeleteResult { deleted: true, id })
    }
}

#[cfg(test)]
#[path = "work_notes_tests.rs"]
mod tests;

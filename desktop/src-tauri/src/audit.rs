use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    database::now_iso,
    error::{AppError, AppResult},
};

/// Ajoute une entrée à une chaîne SHA-256 locale. Les déclencheurs SQLite rendent
/// ensuite chaque ligne non modifiable et non supprimable.
pub(crate) fn append_audit(
    transaction: &Transaction<'_>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: &Value,
) -> AppResult<()> {
    let previous_hash: Option<String> = transaction
        .query_row(
            "SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let id = Uuid::new_v4().to_string();
    let occurred_at = now_iso();
    let actor = "local_user";
    let payload_json = serde_json::to_string(payload)?;
    let material = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}",
        previous_hash.as_deref().unwrap_or(""),
        id,
        occurred_at,
        actor,
        action,
        entity_type,
        entity_id
    );
    let mut hasher = Sha256::new();
    hasher.update(material.as_bytes());
    hasher.update(b"\n");
    hasher.update(payload_json.as_bytes());
    let entry_hash = format!("{:x}", hasher.finalize());
    transaction.execute(
        "INSERT INTO audit_log (id,occurred_at,actor,action,entity_type,entity_id,payload_json,previous_hash,entry_hash) VALUES (?,?,?,?,?,?,?,?,?)",
        params![id, occurred_at, actor, action, entity_type, entity_id, payload_json, previous_hash, entry_hash],
    )?;
    Ok(())
}

pub(crate) fn verify_audit_chain(connection: &rusqlite::Connection) -> AppResult<Value> {
    let mut statement = connection.prepare(
        "SELECT id,occurred_at,actor,action,entity_type,entity_id,payload_json,previous_hash,entry_hash FROM audit_log ORDER BY rowid",
    )?;
    let mut rows = statement.query([])?;
    let mut expected_previous: Option<String> = None;
    let mut count = 0_i64;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let occurred_at: String = row.get(1)?;
        let actor: String = row.get(2)?;
        let action: String = row.get(3)?;
        let entity_type: String = row.get(4)?;
        let entity_id: String = row.get(5)?;
        let payload_json: String = row.get(6)?;
        let previous_hash: Option<String> = row.get(7)?;
        let entry_hash: String = row.get(8)?;
        if previous_hash != expected_previous {
            return Err(AppError::Validation(format!(
                "La chaîne d'audit est rompue à l'entrée {id}."
            )));
        }
        let material = format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}",
            previous_hash.as_deref().unwrap_or(""),
            id,
            occurred_at,
            actor,
            action,
            entity_type,
            entity_id
        );
        let mut hasher = Sha256::new();
        hasher.update(material.as_bytes());
        hasher.update(b"\n");
        hasher.update(payload_json.as_bytes());
        let computed = format!("{:x}", hasher.finalize());
        if computed != entry_hash {
            return Err(AppError::Validation(format!(
                "Le contenu d'audit de l'entrée {id} ne correspond pas à son empreinte."
            )));
        }
        expected_previous = Some(entry_hash);
        count += 1;
    }
    Ok(serde_json::json!({"valid": true, "entries": count, "last_hash": expected_previous}))
}

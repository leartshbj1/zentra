use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
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

/// Verify every original hash and predecessor, retaining branches produced by
/// offline collaborators. None denotes the common empty history. Canonical
/// receipt/state hashes separately bind the complete set and order of entries.
pub(crate) fn verify_audit_chain(connection: &rusqlite::Connection) -> AppResult<Value> {
    let mut statement = connection.prepare(
        "SELECT id,occurred_at,actor,action,entity_type,entity_id,payload_json,previous_hash,entry_hash FROM audit_log ORDER BY rowid",
    )?;
    let mut rows = statement.query([])?;
    let mut last_hash: Option<String> = None;
    let mut heads: HashMap<[u8; 32], bool> = HashMap::new();
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
        if let Some(previous) = &previous_hash {
            let parent = audit_hash_bytes(previous).and_then(|key| heads.get_mut(&key));
            match parent {
                Some(head) => *head = false,
                None => {
                    return Err(AppError::Validation(format!(
                        "La référence d'audit est absente ou postérieure à l'entrée {id}."
                    )))
                }
            }
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
        let computed = hasher.finalize();
        if format!("{computed:x}") != entry_hash {
            return Err(AppError::Validation(format!(
                "Le contenu d'audit de l'entrée {id} ne correspond pas à son empreinte."
            )));
        }
        if heads.insert(computed.into(), true).is_some() {
            return Err(AppError::Validation(format!(
                "L'empreinte d'audit de l'entrée {id} est répétée."
            )));
        }
        last_hash = Some(entry_hash);
        count += 1;
    }
    Ok(
        serde_json::json!({"valid": true, "entries": count, "last_hash": last_hash, "heads": heads.values().filter(|head| **head).count()}),
    )
}

fn audit_hash_bytes(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{backup::Backup, params_from_iter, types::Value as SqlValue, Connection};
    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE audit_log(id TEXT PRIMARY KEY,occurred_at TEXT,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,payload_json TEXT,previous_hash TEXT,entry_hash TEXT)").unwrap();
        c
    }
    fn append(c: &mut Connection, id: &str) {
        let tx = c.transaction().unwrap();
        append_audit(&tx, "create", "client", id, &serde_json::json!({"name":id})).unwrap();
        tx.commit().unwrap();
    }
    fn branches(with_root: bool) -> Connection {
        let mut first = database();
        if with_root {
            append(&mut first, "base");
        }
        let mut second = database();
        Backup::new(&first, &mut second)
            .unwrap()
            .run_to_completion(100, std::time::Duration::from_millis(1), None)
            .unwrap();
        append(&mut first, "author");
        append(&mut second, "colleague");
        let row: Vec<SqlValue> = second
            .query_row(
                "SELECT * FROM audit_log ORDER BY rowid DESC LIMIT 1",
                [],
                |r| (0..9).map(|i| r.get(i)).collect(),
            )
            .unwrap();
        first
            .execute(
                "INSERT INTO audit_log VALUES(?,?,?,?,?,?,?,?,?)",
                params_from_iter(row),
            )
            .unwrap();
        first
    }
    #[test]
    fn preserves_every_offline_branch_and_appends_from_the_received_head() {
        for rooted in [false, true] {
            let mut c = branches(rooted);
            let before = verify_audit_chain(&c).unwrap();
            assert_eq!(before["entries"], if rooted { 3 } else { 2 });
            assert_eq!(before["heads"], 2);
            append(&mut c, "after-receive");
            let after = verify_audit_chain(&c).unwrap();
            assert_eq!(after["entries"], if rooted { 4 } else { 3 });
            assert_eq!(after["heads"], 2);
            let previous: String = c
                .query_row(
                    "SELECT previous_hash FROM audit_log ORDER BY rowid DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(before["last_hash"], previous);
        }
    }
    #[test]
    fn branch_verification_rejects_changed_content_missing_parents_and_cycles() {
        for mutation in [
            "UPDATE audit_log SET payload_json='{}' WHERE entity_id='author'",
            "DELETE FROM audit_log WHERE entity_id='base'",
            "UPDATE audit_log SET rowid=99 WHERE entity_id='base'",
            "UPDATE audit_log SET previous_hash=entry_hash WHERE entity_id='author'",
        ] {
            let c = branches(true);
            c.execute_batch(mutation).unwrap();
            assert!(verify_audit_chain(&c).is_err(), "{mutation}");
        }
    }
}

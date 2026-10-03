//! A private local connection-context generation, not a server authorization.
//! It deliberately does not participate in a person's persistent draft key.
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use uuid::Uuid;

pub(crate) fn ensure(connection: &Connection) -> AppResult<()> {
    connection.execute(
        "INSERT OR IGNORE INTO company_local_member_context(id,nonce) VALUES(1,?)",
        [Uuid::new_v4().simple().to_string()],
    )?;
    Ok(())
}

pub(crate) fn migrate(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS company_local_member_context(
        id INTEGER PRIMARY KEY CHECK(id=1),nonce TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS company_member_context_insert AFTER INSERT ON company_local_identity BEGIN
        INSERT INTO company_local_member_context VALUES(1,lower(hex(randomblob(16))))
          ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce;
      END;
      CREATE TRIGGER IF NOT EXISTS company_member_context_delete AFTER DELETE ON company_local_identity BEGIN
        INSERT INTO company_local_member_context VALUES(1,lower(hex(randomblob(16))))
          ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce;
      END;
      CREATE TRIGGER IF NOT EXISTS company_member_context_update AFTER UPDATE ON company_local_identity
        WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.user_id IS NOT NEW.user_id OR OLD.role IS NOT NEW.role BEGIN
        INSERT INTO company_local_member_context VALUES(1,lower(hex(randomblob(16))))
          ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce;
      END;
    "#)?;
    ensure(connection)
}

pub(crate) fn rotate(connection: &Connection) -> AppResult<()> {
    connection.execute(
        "INSERT INTO company_local_member_context(id,nonce) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce",
        [Uuid::new_v4().simple().to_string()],
    )?;
    Ok(())
}

/// Strip a disposable connection context from a transport/manual archive.
/// The next local migration gives it a new generation; normal company receiving
/// subsequently restores this installation's existing private row.
pub(crate) fn strip(connection: &Connection) -> AppResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_local_member_context')",
        [], |row| row.get(0),
    )?;
    if exists {
        connection.execute("DELETE FROM company_local_member_context", [])?;
    }
    Ok(())
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn read(connection: &Connection) -> AppResult<String> {
    let nonce: String = connection.query_row(
        "SELECT nonce FROM company_local_member_context WHERE id=1", [], |row| row.get(0),
    )?;
    if !valid_nonce(&nonce) {
        return Err(AppError::Validation("Le contexte local du compte doit être vérifié. Rouvrez votre espace.".into()));
    }
    Ok(nonce)
}

/// The caller must hold LocalStore.lock through this check, require_write and
/// the entire business transaction. Identity installation/clearing shares it.
/// None preserves legacy IPC; this guard proves no remote identity or rights.
pub(crate) fn require_unchanged(connection: &Connection, expected: Option<&str>) -> AppResult<()> {
    if let Some(expected) = expected {
        if !valid_nonce(expected) || read(connection)? != expected {
            return Err(AppError::Validation("Le compte connecté a changé. Rouvrez cette action avec le bon compte.".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "member_context_tests.rs"]
mod tests;

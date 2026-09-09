//! Durable, transactional capture for the shared-business replication protocol.
//! Network activation is deliberately gated by the authoritative bootstrap.

/// Shared table and wire format, independent of the local migration counter.
/// Local V61 only tightens update guards; prepared V60 transfers stay compatible.
pub(crate) const DATA_SCHEMA_VERSION: u32 = 60;

pub(crate) mod files;
pub(crate) mod snapshot;
pub(crate) mod outgoing;
// Remove this expectation when canonical-receipt transport calls the builder.
#[cfg_attr(not(test), expect(dead_code, reason = "The native candidate builder cannot be installed before canonical transaction receipts are implemented"))]
pub(crate) mod replay;

#[cfg(test)]
mod schema_contract;
#[cfg(test)]
mod guard_contract;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use rusqlite::{functions::FunctionFlags, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
struct TablePolicy {
    key: Vec<String>,
    columns: Vec<String>,
    local_columns: Vec<String>,
}

#[derive(Deserialize)]
struct Policy {
    version: u32,
    tables: BTreeMap<String, TablePolicy>,
    local_tables: BTreeMap<String, String>,
}

fn policy() -> AppResult<Policy> {
    let policy: Policy = serde_json::from_str(include_str!("business_sync_tables.json"))?;
    if policy.version != 1
        || policy
            .tables
            .keys()
            .any(|key| policy.local_tables.contains_key(key))
    {
        return Err(AppError::Validation(
            "Le contrat de synchronisation métier est incohérent.".into(),
        ));
    }
    Ok(policy)
}

fn identifier(value: &str) -> AppResult<String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(AppError::Validation(
            "Identifiant de schéma de synchronisation invalide.".into(),
        ));
    }
    Ok(format!("\"{value}\""))
}

/// The UUID belongs to a SQL transaction, not to the connection or to a row.
/// Commit/rollback hooks only replace memory; they never execute reentrant SQL.
pub(crate) fn register_connection(
    connection: &Connection,
    data_dir: &std::path::Path,
) -> AppResult<()> {
    files::register(connection, data_dir)?;
    let transaction_id = Arc::new(Mutex::new(Uuid::new_v4()));
    let current = transaction_id.clone();
    connection.create_scalar_function(
        "zentra_sync_transaction_id",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS,
        move |_| {
            current.lock().map(|id| id.to_string()).map_err(|_| {
                rusqlite::Error::UserFunctionError(Box::new(std::io::Error::other(
                    "Contexte de transaction de synchronisation indisponible.",
                )))
            })
        },
    )?;
    let committed = transaction_id.clone();
    connection.commit_hook(Some(move || match committed.lock() {
        Ok(mut id) => {
            *id = Uuid::new_v4();
            false
        }
        Err(_) => true,
    }));
    connection.rollback_hook(Some(move || {
        if let Ok(mut id) = transaction_id.lock() {
            *id = Uuid::new_v4();
        }
    }));
    Ok(())
}

fn json_image(alias: &str, columns: &[String]) -> AppResult<String> {
    let values = columns
        .iter()
        .map(|column| Ok(format!("'{column}',{alias}.{}", identifier(column)?)))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(format!("json_object({})", values.join(",")))
}

fn json_key(alias: &str, keys: &[String]) -> AppResult<String> {
    let values = keys
        .iter()
        .map(|key| Ok(format!("{alias}.{}", identifier(key)?)))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(format!("json_array({})", values.join(",")))
}

fn invalid_key(alias: &str, keys: &[String]) -> AppResult<String> {
    let checks = keys.iter().map(|key| {
        let column = format!("{alias}.{}", identifier(key)?);
        Ok(format!(
            "({column} IS NULL OR typeof({column}) NOT IN ('text','integer') OR {column}='' \
             OR (typeof({column})='integer' AND {column} NOT BETWEEN -9007199254740991 AND 9007199254740991))"
        ))
    }).collect::<AppResult<Vec<_>>>()?;
    // Stable identifiers are normally UUIDs. Bound their encoded size locally
    // before they can make an otherwise durable transaction impossible to send.
    Ok(format!(
        "({} OR length(CAST({} AS BLOB))>1024)",
        checks.join(" OR "),
        json_key(alias, keys)?
    ))
}

fn ensure_unique_key(connection: &Connection, table: &str, rule: &TablePolicy) -> AppResult<()> {
    let expected = rule.key.iter().cloned().collect::<BTreeSet<_>>();
    if expected.is_empty()
        || expected.len() != rule.key.len()
        || !rule.key.iter().all(|key| rule.columns.contains(key))
    {
        return Err(AppError::Validation(format!(
            "La table {table} ne définit pas de référence métier stable."
        )));
    }
    let primary = connection
        .prepare("SELECT name FROM pragma_table_info(?) WHERE pk>0")?
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    if primary == expected {
        return Ok(());
    }
    // An index on extra columns, an expression, or only part of the rows does
    // not guarantee that the protocol key identifies exactly one whole row.
    let indexes = connection
        .prepare("SELECT name FROM pragma_index_list(?) WHERE \"unique\"=1 AND partial=0")?
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for index in indexes {
        let columns = connection
            .prepare("SELECT name FROM pragma_index_info(?)")?
            .query_map([index], |row| row.get::<_, Option<String>>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if columns.iter().all(Option::is_some)
            && columns.len() == expected.len()
            && columns.into_iter().flatten().collect::<BTreeSet<_>>() == expected
        {
            return Ok(());
        }
    }
    Err(AppError::Validation(format!(
        "La référence de la table {table} n'est pas protégée contre les doublons."
    )))
}

pub(crate) fn migrate(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(include_str!("business_sync_schema.sql"))?;
    transaction.execute_batch(include_str!("business_sync_baseline.sql"))?;
    // Persistent triggers are parsed every time SQLite opens a connection.
    // Keep ordinary profiles lean; the authoritative bootstrap must install
    // capture in the same transaction as its binding, before any local write.
    let enabled: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1)",
        [],
        |row| row.get(0),
    )?;
    if enabled {
        install_capture_triggers(transaction)?;
    }
    transaction.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS business_sync_changes_no_update BEFORE UPDATE ON business_sync_changes
         BEGIN SELECT RAISE(ABORT,'Le journal de synchronisation est immuable.'); END;
         CREATE TRIGGER IF NOT EXISTS business_sync_changes_no_delete BEFORE DELETE ON business_sync_changes
         BEGIN SELECT RAISE(ABORT,'Le journal de synchronisation est immuable.'); END;"
    )?;
    Ok(())
}

fn install_capture_triggers(transaction: &Transaction<'_>) -> AppResult<()> {
    let contract = policy()?;
    let present = transaction
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if present.iter().any(|table| {
        !contract.tables.contains_key(table)
            && !contract.local_tables.contains_key(table)
            && ![
                "business_sync_binding",
                "business_sync_changes",
                "business_sync_receipts",
                "business_sync_baseline",
                "business_sync_publication_intent",
                "business_sync_cursor",
            ]
            .contains(&table.as_str())
    }) {
        return Err(AppError::Validation(
            "La base comporte une table absente du contrat de synchronisation.".into(),
        ));
    }
    for (table, policy) in contract.tables {
        let table_sql = identifier(&table)?;
        let columns = transaction
            .prepare(&format!("PRAGMA table_info({table_sql})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !policy.columns.iter().all(|column| columns.contains(column)) {
            return Err(AppError::Validation(format!("La table {table} ne contient pas tous les champs nécessaires à la synchronisation.")));
        }
        if columns.iter().any(|column| {
            !policy.columns.contains(column) && !policy.local_columns.contains(column)
        }) {
            return Err(AppError::Validation(format!(
                "La table {table} comporte un champ absent du contrat de synchronisation."
            )));
        }
        ensure_unique_key(transaction, &table, &policy)?;
        let invalid_existing: bool = transaction.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {table_sql} r WHERE {})",
                invalid_key("r", &policy.key)?
            ),
            [],
            |row| row.get(0),
        )?;
        if invalid_existing {
            return Err(AppError::Validation(format!(
                "Une référence de la table {table} est absente ou incompatible avec la synchronisation. Aucune donnée n'a été envoyée."
            )));
        }
        let old_key = json_key("OLD", &policy.key)?;
        let new_key = json_key("NEW", &policy.key)?;
        let invalid_new_key = invalid_key("NEW", &policy.key)?;
        let old_image = json_image("OLD", &policy.columns)?;
        let new_image = json_image("NEW", &policy.columns)?;
        // Re-installing after migration must replace an older generated guard.
        // The caller's transaction preserves the old definitions on failure.
        for suffix in ["key", "insert", "update", "delete"] {
            transaction.execute_batch(&format!(
                "DROP TRIGGER IF EXISTS {}",
                identifier(&format!("zentra_sync_{table}_{suffix}"))?
            ))?;
        }
        transaction.execute_batch(&format!(
            "CREATE TRIGGER zentra_sync_{table}_key
             BEFORE UPDATE ON {table_sql}
             WHEN EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1)
               AND ({old_key}<>{new_key} OR {invalid_new_key} OR OLD.rowid<>NEW.rowid)
             BEGIN SELECT RAISE(ABORT,'Une référence métier partagée ne peut pas changer.'); END;"
        ))?;
        for (operation, before, after, key) in [
            ("insert", "NULL", new_image.as_str(), new_key.as_str()),
            (
                "update",
                old_image.as_str(),
                new_image.as_str(),
                new_key.as_str(),
            ),
            ("delete", old_image.as_str(), "NULL", old_key.as_str()),
        ] {
            let source = if operation == "delete" { "OLD" } else { "NEW" };
            let changed = if operation == "update" {
                format!(" AND {old_image}<>{new_image}")
            } else {
                String::new()
            };
            let key_guard = if operation == "insert" {
                format!("SELECT CASE WHEN {invalid_new_key} THEN RAISE(ABORT,'La référence métier est absente ou incompatible avec la synchronisation.') END;")
            } else {
                String::new()
            };
            let retain_files = if files::has_files(&table) {
                format!("SELECT zentra_sync_retain_files('{table}',{before}); SELECT zentra_sync_retain_files('{table}',{after});")
            } else {
                String::new()
            };
            transaction.execute_batch(&format!(
                "CREATE TRIGGER zentra_sync_{table}_{operation}
                 AFTER {operation} ON {table_sql}
                 WHEN EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1){changed}
                 BEGIN
                   {key_guard}
                   SELECT CASE WHEN EXISTS(SELECT 1 FROM business_sync_binding
                     WHERE installation_id<>zentra_installation_id())
                     THEN RAISE(ABORT,'La synchronisation de cette copie appartient à un autre appareil.') END;
                   {retain_files}
                   INSERT INTO business_sync_changes(generation,transaction_id,organization_id,installation_id,
                     table_name,row_key_json,operation,before_json,after_json,source_rowid,base_revision)
                   SELECT generation,zentra_sync_transaction_id(),organization_id,installation_id,
                     '{table}',{key},'{operation}',{before},{after},CAST({source}.rowid AS TEXT),
                     COALESCE((SELECT revision FROM business_sync_cursor WHERE id=1),
                       (SELECT json_extract(receipt_json,'$.revision') FROM business_sync_baseline WHERE id=1))
                     FROM business_sync_binding WHERE id=1;
                 END;"
            ))?;
        }
    }
    Ok(())
}

/// Schema 60 has not been distributed. Development profiles can nevertheless
/// contain the earlier trigger definitions. Upgrade them once; never invent
/// historical file evidence for changes captured by that earlier build.
pub(crate) fn upgrade_file_capture(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(include_str!("business_sync_baseline.sql"))?;
    let ordered: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('business_sync_changes') WHERE name='source_rowid')", [], |row| row.get(0))?;
    if !ordered {
        // Earlier development journals did not retain this evidence. Leave
        // their old positions unknown; reconstructing them from current rows
        // would invent positions for deleted or replaced historical rows.
        connection.execute_batch("ALTER TABLE business_sync_changes ADD COLUMN source_rowid TEXT")?;
    }
    let revision: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('business_sync_changes') WHERE name='base_revision')", [], |row| row.get(0))?;
    if !revision {
        connection.execute_batch("ALTER TABLE business_sync_changes ADD COLUMN base_revision INTEGER")?;
    }
    let enabled: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1)",
        [],
        |row| row.get(0),
    )?;
    if !enabled {
        return Ok(());
    }
    let current: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='zentra_sync_attachments_insert' AND instr(sql,'zentra_sync_retain_files')>0)", [], |row| row.get(0))?;
    let ordered_trigger: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='zentra_sync_attachments_insert' AND instr(sql,'source_rowid')>0 AND instr(sql,'base_revision')>0)", [], |row| row.get(0))?;
    if current && ordered_trigger {
        return Ok(());
    }
    // Exclude an old writer between the history check and trigger replacement.
    let transaction =
        Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    let enabled: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE capture_enabled=1)",
        [],
        |row| row.get(0),
    )?;
    if !enabled {
        return Ok(());
    }
    let historical_files: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_changes c JOIN business_sync_binding b ON c.generation=b.generation
         WHERE c.table_name IN ('attachments','company_brand_assets','payroll_document_imports','settings','vat_return_exports','closing_package_exports'))", [], |row| row.get(0))?;
    if !current && historical_files {
        detach_capture(&transaction)?;
    } else {
        install_capture_triggers(&transaction)?;
    }
    transaction.commit()?;
    Ok(())
}

fn detach_capture(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute("UPDATE business_sync_binding SET capture_enabled=0", [])?;
    let triggers = transaction
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'zentra_sync_*'",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for trigger in triggers {
        transaction.execute_batch(&format!("DROP TRIGGER {}", identifier(&trigger)?))?;
    }
    Ok(())
}

/// A backup preserves pending evidence, but cannot silently resume a historical
/// device generation. The bootstrap/rebase will reconcile it with server history.
pub(crate) fn detach_restored_copy(connection: &Connection) -> AppResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_sync_binding')",
        [], |row| row.get(0),
    )?;
    if exists {
        let transaction = connection.unchecked_transaction()?;
        detach_capture(&transaction)?;
        transaction.commit()?;
    }
    Ok(())
}

pub(crate) fn status(connection: &Connection) -> AppResult<Value> {
    let binding: Option<(String, bool)> = connection
        .query_row(
            "SELECT generation,capture_enabled FROM business_sync_binding WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((generation, enabled)) = binding else {
        return Ok(json!({"state":"not_initialized","pending_transactions":0}));
    };
    let pending: i64 = connection.query_row(
        "SELECT COUNT(DISTINCT transaction_id) FROM business_sync_changes c WHERE generation=?
         AND NOT EXISTS(SELECT 1 FROM business_sync_receipts r
           WHERE r.generation=c.generation AND r.transaction_id=c.transaction_id
             AND r.acknowledged_through>=c.sequence)",
        [generation],
        |row| row.get(0),
    )?;
    Ok(
        json!({"state":if enabled {"capturing"} else {"needs_reconciliation"},"pending_transactions":pending}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::LocalStore;
    use rusqlite::params;

    fn setup() -> (tempfile::TempDir, LocalStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
        (directory, store)
    }

    fn capture(store: &LocalStore) {
        let mut connection = store.connect().unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO business_sync_binding VALUES(1,'org-test',?,?,1,'2026-09-08')",
                params![store.installation_id, Uuid::new_v4().to_string()],
            )
            .unwrap();
        install_capture_triggers(&transaction).unwrap();
        transaction.commit().unwrap();
    }

    fn insert_client(connection: &Connection, id: &str) {
        connection.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,'Client fictif','2026-09-08','2026-09-08')", [id]).unwrap();
    }

    fn count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM business_sync_changes", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn complete_schema_has_explicit_policy_and_portable_stable_keys() {
        let (_directory, store) = setup();
        capture(&store);
        let connection = store.connect().unwrap();
        let policy = policy().unwrap();
        let tables = connection
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for table in &tables {
            assert!(
                policy.tables.contains_key(table)
                    || policy.local_tables.contains_key(table)
                    || [
                        "business_sync_binding",
                        "business_sync_changes",
                        "business_sync_receipts",
                        "business_sync_baseline",
                        "business_sync_publication_intent",
                        "business_sync_cursor"
                    ]
                    .contains(&table.as_str()),
                "Unclassified table: {table}"
            );
        }
        for (table, rule) in &policy.tables {
            assert!(tables.contains(table), "Missing protocol table: {table}");
            let columns = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                columns.len(),
                rule.columns.len() + rule.local_columns.len(),
                "{table}"
            );
            assert!(
                rule.columns
                    .iter()
                    .chain(&rule.local_columns)
                    .all(|column| columns.contains(column)),
                "{table}"
            );
            assert!(!rule.key.is_empty());
            assert!(rule.key.iter().all(|key| rule.columns.contains(key)));
            let triggers: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (?,?,?,?)",
                    params![
                        format!("zentra_sync_{table}_insert"),
                        format!("zentra_sync_{table}_update"),
                        format!("zentra_sync_{table}_delete"),
                        format!("zentra_sync_{table}_key")
                    ],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(triggers, 4, "{table}");
            if rule.local_columns.contains(&"sequence".into()) {
                assert_eq!(rule.key, vec!["id"]);
                assert!(!rule.columns.contains(&"sequence".into()));
            }
        }
        assert_eq!(policy.tables.len(), 106);
    }

    #[test]
    fn ordinary_account_connection_does_not_enable_or_fill_the_journal() {
        let (_directory, store) = setup();
        let connection = store.connect().unwrap();
        insert_client(&connection, "client");
        assert_eq!(count(&connection), 0);
        assert_eq!(status(&connection).unwrap()["state"], "not_initialized");
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'zentra_sync_*'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
    }

    #[test]
    fn unknown_schema_field_rolls_back_binding_and_every_partially_installed_trigger() {
        let (_directory, store) = setup();
        let mut connection = store.connect().unwrap();
        connection
            .execute(
                "ALTER TABLE clients ADD COLUMN unclassified_private_value TEXT",
                [],
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO business_sync_binding VALUES(1,'org-test',?,?,1,'2026-09-08')",
                params![store.installation_id, Uuid::new_v4().to_string()],
            )
            .unwrap();
        assert!(install_capture_triggers(&transaction).is_err());
        transaction.rollback().unwrap();
        assert_eq!(status(&connection).unwrap()["state"], "not_initialized");
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'zentra_sync_*'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        insert_client(&connection, "local-client");
        assert_eq!(count(&connection), 0);
    }

    #[test]
    fn stable_key_requires_a_complete_unique_constraint() {
        let connection = Connection::open_in_memory().unwrap();
        let rule = TablePolicy {
            key: vec!["id".into()],
            columns: vec!["id".into(), "scope".into()],
            local_columns: vec![],
        };
        for (name, definition, index, accepted) in [
            ("primary_key", "id TEXT PRIMARY KEY,scope TEXT", "", true),
            ("unique_key", "id TEXT UNIQUE,scope TEXT", "", true),
            ("no_key", "id TEXT,scope TEXT", "", false),
            (
                "wider_key",
                "id TEXT,scope TEXT,UNIQUE(id,scope)",
                "",
                false,
            ),
            (
                "partial_key",
                "id TEXT,scope TEXT",
                "CREATE UNIQUE INDEX partial_identity ON partial_key(id) WHERE scope IS NOT NULL",
                false,
            ),
            (
                "expression_key",
                "id TEXT,scope TEXT",
                "CREATE UNIQUE INDEX normalized_identity ON expression_key(lower(id))",
                false,
            ),
        ] {
            connection
                .execute_batch(&format!("CREATE TABLE {name}({definition});{index}"))
                .unwrap();
            assert_eq!(
                ensure_unique_key(&connection, name, &rule).is_ok(),
                accepted,
                "{name}"
            );
        }
        let composite = TablePolicy {
            key: vec!["scope".into(), "id".into()],
            ..rule
        };
        assert!(ensure_unique_key(&connection, "wider_key", &composite).is_ok());
    }

    #[test]
    fn legacy_invalid_keys_prevent_capture_without_rewriting_the_original_rows() {
        let (_directory, store) = setup();
        let mut connection = store.connect().unwrap();
        for invalid in [
            rusqlite::types::Value::Null,
            rusqlite::types::Value::Text(String::new()),
            rusqlite::types::Value::Blob(vec![1, 2, 3]),
            rusqlite::types::Value::Text("x".repeat(1025)),
        ] {
            connection.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,'Client fictif','2026-09-08','2026-09-08')", [&invalid]).unwrap();
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO business_sync_binding VALUES(1,'org-test',?,?,1,'2026-09-08')",
                    params![store.installation_id, Uuid::new_v4().to_string()],
                )
                .unwrap();
            let error = install_capture_triggers(&transaction)
                .unwrap_err()
                .to_string();
            assert!(error.contains("clients"), "{error}");
            transaction.rollback().unwrap();
            assert_eq!(status(&connection).unwrap()["state"], "not_initialized");
            assert_eq!(count(&connection), 0);
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM clients", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'zentra_sync_*'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            connection.execute("DELETE FROM clients", []).unwrap();
        }
    }

    #[test]
    fn active_capture_rejects_invalid_new_keys_and_rolls_back_the_business_transaction() {
        let (_directory, store) = setup();
        capture(&store);
        let mut connection = store.connect().unwrap();
        for invalid in [
            rusqlite::types::Value::Null,
            rusqlite::types::Value::Text(String::new()),
            rusqlite::types::Value::Blob(vec![1, 2, 3]),
            rusqlite::types::Value::Text("x".repeat(1025)),
        ] {
            let transaction = connection.transaction().unwrap();
            insert_client(&transaction, "also-rolled-back");
            assert!(transaction.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,'Client fictif','2026-09-08','2026-09-08')", [&invalid]).is_err());
            transaction.rollback().unwrap();
            assert_eq!(count(&connection), 0);
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM clients", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        insert_client(&connection, "valid-client");
        assert_eq!(count(&connection), 1);
        assert!(connection
            .execute("UPDATE clients SET id=NULL WHERE id='valid-client'", [])
            .is_err());
        assert_eq!(count(&connection), 1);
    }

    #[test]
    fn key_validation_preserves_safe_integers_and_rejects_ambiguous_scalar_types() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE key_cases(id)")
            .unwrap();
        let sql = format!(
            "SELECT {} FROM key_cases r",
            invalid_key("r", &["id".into()]).unwrap()
        );
        use rusqlite::types::Value::{Integer, Real, Text};
        for (value, invalid) in [
            (Integer(9_007_199_254_740_991), false),
            (Integer(-9_007_199_254_740_991), false),
            (Integer(0), false),
            (Integer(9_007_199_254_740_992), true),
            (Integer(i64::MIN), true),
            (Real(1.0), true),
            (Text("Référence \"œuvre\"\n2026".into()), false),
        ] {
            connection
                .execute("INSERT INTO key_cases VALUES(?)", [value])
                .unwrap();
            assert_eq!(
                connection
                    .query_row(&sql, [], |row| row.get::<_, bool>(0))
                    .unwrap(),
                invalid
            );
            connection.execute("DELETE FROM key_cases", []).unwrap();
        }
    }

    #[test]
    fn unclassified_tables_cannot_be_silently_omitted_from_a_shared_profile() {
        let (_directory, store) = setup();
        let mut connection = store.connect().unwrap();
        connection
            .execute_batch("CREATE TABLE sqliteextra_private_rows(id TEXT PRIMARY KEY)")
            .unwrap();
        let transaction = connection.transaction().unwrap();
        assert!(install_capture_triggers(&transaction)
            .unwrap_err()
            .to_string()
            .contains("table absente"));
        transaction.rollback().unwrap();
        assert_eq!(count(&connection), 0);
    }

    #[test]
    fn reinstall_replaces_old_generated_guards_without_touching_pending_evidence() {
        let (_directory, store) = setup();
        capture(&store);
        let mut connection = store.connect().unwrap();
        insert_client(&connection, "pending-client");
        let before = count(&connection);
        connection.execute_batch(
            "DROP TRIGGER zentra_sync_clients_insert;
             CREATE TRIGGER zentra_sync_clients_insert AFTER INSERT ON clients BEGIN SELECT 1; END;"
        ).unwrap();
        let transaction = connection.transaction().unwrap();
        install_capture_triggers(&transaction).unwrap();
        transaction.commit().unwrap();
        assert_eq!(count(&connection), before);
        assert!(connection.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES(NULL,'Client fictif','2026-09-08','2026-09-08')", []).is_err());
        insert_client(&connection, "next-client");
        assert_eq!(count(&connection), before + 1);
    }

    #[test]
    fn schema_59_startup_and_restart_preserve_business_rows_files_and_identity() {
        fn snapshot(connection: &Connection) -> BTreeMap<String, Vec<String>> {
            policy()
                .unwrap()
                .tables
                .into_iter()
                .map(|(table, rule)| {
                    let columns = [rule.columns, rule.local_columns].concat();
                    let rows = connection
                        .prepare(&format!(
                            "SELECT {} FROM {} r ORDER BY rowid",
                            json_image("r", &columns).unwrap(),
                            identifier(&table).unwrap()
                        ))
                        .unwrap()
                        .query_map([], |row| row.get(0))
                        .unwrap()
                        .collect::<Result<Vec<String>, _>>()
                        .unwrap();
                    (table, rows)
                })
                .collect()
        }
        let (_directory, store) = setup();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        let connection = store.connect().unwrap();
        insert_client(&connection, "historical-client");
        connection.execute_batch(
            "INSERT INTO projects(id,client_id,name,created_at,updated_at)
               VALUES('historical-project','historical-client','Projet fictif','2026-09-08','2026-09-08');
             INSERT INTO quotes(id,client_id,project_id,number,title,issue_date,total_cents,created_at,updated_at)
               VALUES('historical-quote','historical-client','historical-project','D-2026-000041','Devis fictif','2026-09-08',108100,'2026-09-08','2026-09-08');
             INSERT INTO invoices(id,client_id,project_id,quote_id,number,title,status,issue_date,total_cents,paid_cents,notes,created_at,updated_at)
               VALUES('historical-invoice','historical-client','historical-project','historical-quote','F-2026-000012','Facture fictive','partiellement_payee','2026-09-08',108100,30000,'Ligne 1\nLigne 2','2026-09-08','2026-09-08');
             INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at)
               VALUES('historical-payment','historical-invoice','2026-09-08',30000,'2026-09-08','2026-09-08');"
        ).unwrap();
        let before = snapshot(&connection);
        let document = store.attachments_dir.join("plan-fictif.txt");
        std::fs::write(&document, b"Document de recette hors ligne").unwrap();
        let triggers = connection
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'zentra_sync_%'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for trigger in triggers {
            connection
                .execute_batch(&format!("DROP TRIGGER {}", identifier(&trigger).unwrap()))
                .unwrap();
        }
        connection.execute_batch("DROP TABLE business_sync_receipts; DROP TABLE business_sync_changes; DROP TABLE business_sync_binding; PRAGMA user_version=59;").unwrap();
        let installation_id = store.installation_id.clone();
        let path = store.data_dir.clone();
        drop(connection);
        drop(store);
        for _ in 0..2 {
            let reopened = LocalStore::initialize(path.clone()).unwrap();
            assert_eq!(reopened.installation_id, installation_id);
            let connection = reopened.connect().unwrap();
            assert_eq!(snapshot(&connection), before);
            assert_eq!(
                std::fs::read(&document).unwrap(),
                b"Document de recette hors ligne"
            );
            assert_eq!(
                connection
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                crate::schema::SCHEMA_VERSION
            );
            assert_eq!(
                connection
                    .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
            assert_eq!(status(&connection).unwrap()["state"], "not_initialized");
        }
    }

    #[test]
    fn database_trigger_side_effects_and_cascades_belong_to_the_same_transaction() {
        let (_directory, store) = setup();
        capture(&store);
        let connection = store.connect().unwrap();
        // A representative database-owned side effect must not escape capture.
        // It is deliberately not a second call through the application layer.
        connection.execute_batch(
            "CREATE TRIGGER qa_client_creates_project AFTER INSERT ON clients
             BEGIN INSERT INTO projects(id,client_id,name,created_at,updated_at)
               VALUES(NEW.id||'-project',NEW.id,'Projet fictif',NEW.created_at,NEW.updated_at); END;"
        ).unwrap();
        insert_client(&connection, "client");
        assert_eq!(count(&connection), 2);
        assert_eq!(status(&connection).unwrap()["pending_transactions"], 1);
        // projects.client_id uses ON DELETE SET NULL. Capture the child change
        // too, otherwise another device would retain a dangling relationship.
        connection
            .execute("DELETE FROM clients WHERE id='client'", [])
            .unwrap();
        assert_eq!(count(&connection), 4);
        assert_eq!(status(&connection).unwrap()["pending_transactions"], 2);
        let images: (String,String) = connection.query_row(
            "SELECT before_json,after_json FROM business_sync_changes WHERE table_name='projects' AND operation='update'",
            [], |row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&images.0).unwrap()["client_id"],
            "client"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&images.1).unwrap()["client_id"],
            Value::Null
        );
    }

    #[test]
    fn captures_all_rows_of_an_invoice_payment_transaction_atomically() {
        let (_directory, store) = setup();
        capture(&store);
        let mut connection = store.connect().unwrap();
        let tx = connection.transaction().unwrap();
        insert_client(&tx, "client");
        tx.execute("INSERT INTO invoices(id,client_id,title,number,status,issue_date,total_cents,created_at,updated_at) VALUES('invoice','client','Facture fictive','F-2026-000001','emise','2026-09-08',108100,'2026-09-08','2026-09-08')", []).unwrap();
        tx.execute("INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at) VALUES('payment','invoice','2026-09-08',30000,'2026-09-08','2026-09-08')", []).unwrap();
        tx.execute(
            "UPDATE invoices SET paid_cents=30000 WHERE id='invoice'",
            [],
        )
        .unwrap();
        assert_eq!(
            count(&store.connect().unwrap()),
            0,
            "Uncommitted work must not be observable by the sender"
        );
        tx.commit().unwrap();
        assert_eq!(count(&connection), 4);
        assert_eq!(status(&connection).unwrap()["pending_transactions"], 1);
        let images: (String, String) = connection
            .query_row(
                "SELECT before_json,after_json FROM business_sync_changes WHERE operation='update'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&images.0).unwrap()["paid_cents"],
            0
        );
        assert_eq!(
            serde_json::from_str::<Value>(&images.1).unwrap()["paid_cents"],
            30000
        );
    }

    #[test]
    fn rollback_savepoint_and_failed_constraint_leave_no_phantom_changes() {
        let (_directory, store) = setup();
        capture(&store);
        let connection = store.connect().unwrap();
        connection.execute_batch("BEGIN; SAVEPOINT one;").unwrap();
        insert_client(&connection, "abandoned");
        connection
            .execute_batch("ROLLBACK TO one; RELEASE one;")
            .unwrap();
        insert_client(&connection, "kept");
        connection.execute_batch("COMMIT;").unwrap();
        assert_eq!(count(&connection), 1);
        connection.execute_batch("BEGIN;").unwrap();
        insert_client(&connection, "rolled-back");
        assert!(connection.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('kept','Duplicate','x','x')", []).is_err());
        connection.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(count(&connection), 1);
        insert_client(&connection, "next");
        assert_eq!(status(&connection).unwrap()["pending_transactions"], 2);
    }

    #[test]
    fn separate_transactions_and_restarts_keep_distinct_durable_ids() {
        let (_directory, store) = setup();
        capture(&store);
        let connection = store.connect().unwrap();
        insert_client(&connection, "one");
        insert_client(&connection, "two");
        let before: Vec<String> = connection
            .prepare("SELECT transaction_id FROM business_sync_changes ORDER BY sequence")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_ne!(before[0], before[1]);
        drop(connection);
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let connection = reopened.connect().unwrap();
        insert_client(&connection, "three");
        assert_eq!(status(&connection).unwrap()["pending_transactions"], 3);
        let after: Vec<String> = connection
            .prepare("SELECT transaction_id FROM business_sync_changes ORDER BY sequence")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(after[..2], before);
        assert_ne!(after[2], before[1]);
    }

    #[test]
    fn before_images_preserve_notes_and_deletions_and_ignore_noop_updates() {
        let (_directory, store) = setup();
        capture(&store);
        let connection = store.connect().unwrap();
        insert_client(&connection, "client");
        let notes = "Conditions : l’acompte\nDeuxième ligne 🏗️\n\"Guillemets\" et C:\\dossier";
        connection
            .execute("UPDATE clients SET notes=? WHERE id='client'", [notes])
            .unwrap();
        connection
            .execute("UPDATE clients SET notes=notes WHERE id='client'", [])
            .unwrap();
        connection
            .execute("DELETE FROM clients WHERE id='client'", [])
            .unwrap();
        assert_eq!(count(&connection), 3);
        let before: String = connection
            .query_row(
                "SELECT before_json FROM business_sync_changes WHERE operation='delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&before).unwrap()["notes"],
            notes
        );
        assert!(connection
            .execute("DELETE FROM business_sync_changes", [])
            .is_err());
        assert!(connection
            .execute(
                "UPDATE business_sync_changes SET transaction_id='rewritten'",
                []
            )
            .is_err());
    }

    #[test]
    fn foreign_installation_and_primary_key_replacement_are_rejected_before_commit() {
        let (_directory, store) = setup();
        capture(&store);
        let connection = store.connect().unwrap();
        insert_client(&connection, "client");
        assert!(connection
            .execute("UPDATE clients SET id='other' WHERE id='client'", [])
            .is_err());
        connection
            .execute(
                "UPDATE business_sync_binding SET installation_id='other-device'",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE clients SET name='Wrong device' WHERE id='client'",
                []
            )
            .is_err());
        assert_eq!(count(&connection), 1);
        let name: String = connection
            .query_row("SELECT name FROM clients WHERE id='client'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Client fictif");
    }

    #[test]
    fn copying_a_backup_detaches_capture_and_preserves_unsent_evidence() {
        let (directory, store) = setup();
        capture(&store);
        let source = store.connect().unwrap();
        insert_client(&source, "source");
        let mut target = Connection::open(directory.path().join("backup.sqlite3")).unwrap();
        let backup = rusqlite::backup::Backup::new(&source, &mut target).unwrap();
        backup
            .run_to_completion(16, std::time::Duration::from_millis(10), None)
            .unwrap();
        drop(backup);
        detach_restored_copy(&target).unwrap();
        assert_eq!(status(&target).unwrap()["state"], "needs_reconciliation");
        assert_eq!(count(&target), 1);
        assert_eq!(status(&source).unwrap()["state"], "capturing");
    }

    #[test]
    fn real_invoice_and_payment_capture_balanced_accounting_and_retry_once() {
        use crate::models::{RecordPaymentInput, SaveDocumentWithItemsInput};

        let (_directory, store) = setup();
        store
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        store.install_swiss_accounting_starter().unwrap();
        capture(&store);
        let client = store.create_record("clients", json!({
            "name":"Client de recette", "address_line1":"Rue du Client", "address_line2":"7",
            "postal_code":"1000", "city":"Lausanne", "country":"CH"
        })).unwrap();
        let saved = store
            .save_document_with_items(SaveDocumentWithItemsInput {
                entity: "invoices".into(),
                id: None,
                data: json!({"client_id":client["id"],"title":"Recette synchronisation",
                "service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),
                items: vec![
                    json!({"description":"Prestation fictive","quantity":1,"unit":"forfait",
                "unit_price_cents":100_000,"discount_bp":0,"vat_bp":0}),
                ],
            })
            .unwrap();
        let invoice_id = saved["document"]["id"].as_str().unwrap();
        store
            .issue_invoice(invoice_id, Some("2026-09-08".into()), None)
            .unwrap();
        let payment = RecordPaymentInput {
            request_id: Uuid::new_v4().to_string(),
            invoice_id: invoice_id.into(),
            amount_cents: 30_000,
            date: Some("2026-09-08".into()),
            method: Some("Banque".into()),
            reference: None,
            notes: None,
        };
        let paid = store.record_payment(payment.clone()).unwrap();
        let connection = store.connect().unwrap();
        let count_before_retry = count(&connection);
        let repeated = store.record_payment(payment).unwrap();
        assert_eq!(paid["id"], repeated["id"]);
        assert_eq!(
            count(&connection),
            count_before_retry,
            "A retry must not create another payment or sync change"
        );
        let transactions: Vec<(String,String)> = connection.prepare(
            "SELECT source_type,id FROM journal_entries WHERE source_type IN ('invoice','payment') ORDER BY source_type"
        ).unwrap().query_map([], |row| Ok((row.get(0)?,row.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(transactions.len(), 2);
        for (source_type, entry_id) in transactions {
            let transaction_id: String = connection.query_row(
                "SELECT transaction_id FROM business_sync_changes WHERE table_name='journal_entries' AND json_extract(after_json,'$.id')=?",
                [&entry_id], |row| row.get(0),
            ).unwrap();
            let tables: Vec<String> = connection
                .prepare(
                    "SELECT DISTINCT table_name FROM business_sync_changes WHERE transaction_id=?",
                )
                .unwrap()
                .query_map([&transaction_id], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            for required in ["invoices", "journal_entries", "journal_lines", "audit_log"] {
                assert!(
                    tables.iter().any(|table| table == required),
                    "{source_type} missing {required}: {tables:?}"
                );
            }
            assert!(tables.iter().any(|table| table
                == if source_type == "invoice" {
                    "invoice_qr_bills"
                } else {
                    "payments"
                }));
            let journal: (i64,i64,i64) = connection.query_row(
                "SELECT COUNT(*),SUM(json_extract(after_json,'$.debit_cents')),SUM(json_extract(after_json,'$.credit_cents'))
                 FROM business_sync_changes WHERE transaction_id=? AND table_name='journal_lines' AND operation='insert'",
                [&transaction_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).unwrap();
            assert_eq!(journal.0, 2);
            let expected = if source_type == "invoice" {
                100_000
            } else {
                30_000
            };
            assert_eq!((journal.1, journal.2), (expected, expected));
        }
        assert_eq!(
            store.get_accounting_continuity().unwrap()["total_missing"],
            0
        );
        crate::audit::verify_audit_chain(&connection).unwrap();
    }

    #[test]
    fn archive_restore_on_another_installation_preserves_evidence_without_reactivation() {
        let (_directory, source) = setup();
        source
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        capture(&source);
        insert_client(&source.connect().unwrap(), "shared-client");
        let archive = source
            .create_backup(None, env!("CARGO_PKG_VERSION"))
            .unwrap();
        let (_target_directory, target) = setup();
        let target_identity = target.installation_id.clone();
        assert_ne!(source.installation_id, target_identity);
        target
            .restore_backup(&archive, env!("CARGO_PKG_VERSION"))
            .unwrap();
        let restored = LocalStore::initialize(target.data_dir.clone()).unwrap();
        assert_eq!(restored.installation_id, target_identity);
        let connection = restored.connect().unwrap();
        assert_eq!(
            status(&connection).unwrap()["state"],
            "needs_reconciliation"
        );
        assert_eq!(count(&connection), 1);
        let pending_origin: String = connection
            .query_row(
                "SELECT installation_id FROM business_sync_changes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_origin, source.installation_id);
        insert_client(&connection, "local-after-restore");
        assert_eq!(
            count(&connection),
            1,
            "An old device generation must never be resumed after restore"
        );
        assert_eq!(
            status(&source.connect().unwrap()).unwrap()["state"],
            "capturing"
        );
        crate::audit::verify_audit_chain(&connection).unwrap();
    }
}

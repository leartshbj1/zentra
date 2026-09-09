//! Prepare a native database candidate without modifying the working database.
//! This is not a commit receipt, an acknowledgement, or an installation API.
use super::{identifier, json_image, json_key, policy, TablePolicy};
use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, time::Duration};

const MAX_ROWS: usize = 200_000;
const MAX_BYTES: usize = 512 * 1024 * 1024;
const MAX_ROW_BYTES: usize = 1024 * 1024;
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

/// The receiver must obtain these values from the verified canonical receipt.
/// Source-device rowids must not be substituted for canonical rowids.
pub(super) struct RowChange {
    pub table: String,
    pub key_json: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub canonical_rowid: i64,
}
pub(super) struct Context {
    pub organization: String,
    pub generation: String,
    pub base_revision: i64,
    pub source_state_sha256: String,
    pub target_state_sha256: String,
}
pub(super) struct Candidate {
    _directory: tempfile::TempDir,
    store: LocalStore,
    pub before_sha256: String,
    pub after_sha256: String,
    pub changes: usize,
    pub statements: usize,
    pub automatic: usize,
}
impl Candidate {
    pub(super) fn database_path(&self) -> &std::path::Path {
        &self.store.database_path
    }
}

fn predicate(rule: &TablePolicy) -> AppResult<String> {
    rule.key
        .iter()
        .enumerate()
        .map(|(i, c)| Ok(format!("r.{} IS json_extract(?1,'$[{i}]')", identifier(c)?)))
        .collect::<AppResult<Vec<_>>>()
        .map(|v| v.join(" AND "))
}
fn current(
    connection: &Connection,
    table: &str,
    rule: &TablePolicy,
    key: &str,
) -> AppResult<Option<(i64, String)>> {
    connection
        .query_row(
            &format!(
                "SELECT r.rowid,{} FROM {} r WHERE {}",
                json_image("r", &rule.columns)?,
                identifier(table)?,
                predicate(rule)?
            ),
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(Into::into)
}
fn normalize(
    connection: &Connection,
    rule: &TablePolicy,
    key: &str,
    raw: &str,
) -> AppResult<String> {
    if raw.len() > MAX_ROW_BYTES || key.len() > 1024 {
        return Err(invalid(
            "Une modification reçue dépasse les limites de taille.",
        ));
    }
    let value: Value = serde_json::from_str(raw)?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Une image reçue n'est pas une ligne métier."))?;
    let fields: i64 =
        connection.query_row("SELECT COUNT(*) FROM json_each(?1)", [raw], |r| r.get(0))?;
    if fields as usize != rule.columns.len()
        || object.keys().cloned().collect::<BTreeSet<_>>() != rule.columns.iter().cloned().collect()
        || object
            .values()
            .any(|v| !matches!(v, Value::Null | Value::String(_) | Value::Number(_)))
    {
        return Err(invalid(
            "Une image reçue contient une colonne absente, inconnue ou locale.",
        ));
    }
    let actual_key: String = connection.query_row(
        &format!(
            "SELECT json_array({})",
            rule.key
                .iter()
                .map(|c| format!("json_extract(?1,'$.{c}')"))
                .collect::<Vec<_>>()
                .join(",")
        ),
        [raw],
        |r| r.get(0),
    )?;
    if actual_key != key {
        return Err(invalid("La clé reçue ne correspond pas à la ligne."));
    }
    // SQLite keeps the original integer/real/string types, including i64 money.
    connection
        .query_row(
            &format!(
                "SELECT json_object({})",
                rule.columns
                    .iter()
                    .flat_map(|c| [format!("'{c}'"), format!("json_extract(?1,'$.{c}')")])
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            [raw],
            |r| r.get(0),
        )
        .map_err(Into::into)
}
fn frame(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
/// Remote cascades must not detach a running timer, alter a device licence or
/// overwrite local transport/numbering state. Check this independently of the
/// shared-state digest, which intentionally excludes these tables.
fn local_fingerprint(connection: &Connection) -> AppResult<String> {
    let mut hash = Sha256::new();
    hash.update(b"zentra-native-replay-local-state-v1\0");
    let mut count = 0usize;
    let mut bytes = 0usize;
    for table in policy()?.local_tables.keys() {
        let columns = connection
            .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")?
            .query_map([table], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if columns.is_empty() {
            return Err(invalid("Une table propre à cet appareil est absente."));
        }
        let mut statement = connection.prepare(&format!(
            "SELECT CAST(r.rowid AS TEXT),{} FROM {} r ORDER BY r.rowid",
            json_image("r", &columns)?,
            identifier(table)?
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let image: String = row.get(1)?;
            count += 1;
            bytes = bytes.checked_add(image.len()).ok_or_else(|| {
                invalid("Les données locales dépassent les limites de réception.")
            })?;
            if count > MAX_ROWS || bytes > MAX_BYTES || image.len() > MAX_ROW_BYTES {
                return Err(invalid(
                    "Les données locales dépassent les limites de réception.",
                ));
            }
            frame(&mut hash, table.as_bytes());
            frame(&mut hash, row.get::<_, String>(0)?.as_bytes());
            frame(&mut hash, image.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Content and canonical row order, independent of local-only tables. The
/// server receipt must bind this digest to the exact source/target revision.
pub(super) fn state_fingerprint(connection: &Connection) -> AppResult<String> {
    let mut hash = Sha256::new();
    hash.update(b"zentra-native-replay-state-v1\0");
    for (table, rule) in policy()?.tables {
        let mut statement = connection.prepare(&format!(
            "SELECT {},CAST(r.rowid AS TEXT),{} FROM {} r ORDER BY {}",
            json_key("r", &rule.key)?,
            json_image("r", &rule.columns)?,
            identifier(&table)?,
            json_key("r", &rule.key)?
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            frame(&mut hash, table.as_bytes());
            for i in 0..3 {
                frame(&mut hash, row.get::<_, String>(i)?.as_bytes());
            }
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn fingerprint(connection: &Connection, table: &str) -> AppResult<String> {
    let mut hash = Sha256::new();
    hash.update(b"zentra-native-replay-state-v1\0");
    let mut statement=connection.prepare(&format!("SELECT table_name,row_key_json,CAST(canonical_rowid AS TEXT),row_json FROM {table} ORDER BY table_name,row_key_json"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        for i in 0..4 {
            frame(&mut hash, row.get::<_, String>(i)?.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn snapshot(connection: &Connection, destination: &str) -> AppResult<()> {
    let contract = policy()?;
    let mut total = 0usize;
    let mut bytes = 0usize;
    for (table, rule) in contract.tables {
        let mut query = connection.prepare(&format!(
            "SELECT r.rowid,{},{} FROM {} r",
            json_key("r", &rule.key)?,
            json_image("r", &rule.columns)?,
            identifier(&table)?
        ))?;
        let mut rows = query.query([])?;
        let mut insert =
            connection.prepare(&format!("INSERT INTO {destination} VALUES(?1,?2,?3,?4)"))?;
        while let Some(row) = rows.next()? {
            let key: String = row.get(1)?;
            let image: String = row.get(2)?;
            total += 1;
            bytes = bytes
                .checked_add(image.len())
                .ok_or_else(|| invalid("Le dossier dépasse les limites de réception."))?;
            if total > MAX_ROWS || bytes > MAX_BYTES || image.len() > MAX_ROW_BYTES {
                return Err(invalid("Le dossier dépasse les limites de réception."));
            }
            insert.execute(params![table, key, row.get::<_, i64>(0)?, image])?;
        }
    }
    Ok(())
}
fn check_context(connection: &Connection, store: &LocalStore, context: &Context) -> AppResult<()> {
    if [&context.source_state_sha256, &context.target_state_sha256]
        .iter()
        .any(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
    {
        return Err(invalid(
            "Les empreintes de la révision partagée sont absentes ou invalides.",
        ));
    }
    let local:Option<(String,String,String,i64)>=connection.query_row(
        "SELECT b.organization_id,b.installation_id,h.server_generation,COALESCE(c.revision,1) FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id AND h.organization_id=b.organization_id LEFT JOIN business_sync_cursor c ON c.id=b.id WHERE b.id=1 AND b.capture_enabled=1 AND (c.id IS NULL OR (c.organization_id=b.organization_id AND c.generation=h.server_generation))",
        [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if local
        != Some((
            context.organization.clone(),
            store.installation_id.clone(),
            context.generation.clone(),
            context.base_revision,
        ))
        || context.base_revision < 1
    {
        return Err(invalid(
            "La transaction ne correspond pas à l'entreprise ou à la révision installée.",
        ));
    }
    let pending:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_changes c JOIN business_sync_binding b ON b.generation=c.generation LEFT JOIN business_sync_receipts r ON r.generation=c.generation AND r.transaction_id=c.transaction_id WHERE c.sequence>COALESCE(r.acknowledged_through,0)) OR EXISTS(SELECT 1 FROM business_sync_publication_intent)",[],|r|r.get(0))?;
    if pending {
        return Err(invalid("Des modifications locales attendent une réconciliation. La réception ne les a pas remplacées."));
    }
    Ok(())
}

/// The iterator comes from verified, bounded chunks. The caller remains
/// responsible for authentication, receipt/hash/file checks and installation.
pub(super) fn build(
    store: &LocalStore,
    context: &Context,
    input: impl IntoIterator<Item = AppResult<RowChange>>,
) -> AppResult<Candidate> {
    let directory = tempfile::Builder::new()
        .prefix("transaction-candidate-")
        .tempdir_in(&store.data_dir)?;
    let mut copied = store.clone();
    copied.data_dir = directory.path().to_path_buf();
    copied.database_path = directory.path().join("candidate.sqlite");
    copied.attachments_dir = directory.path().join("attachments");
    copied.exports_dir = directory.path().join("exports");
    copied.backups_dir = directory.path().join("backups");
    for path in [
        &copied.attachments_dir,
        &copied.exports_dir,
        &copied.backups_dir,
    ] {
        fs::create_dir(path)?;
    }
    {
        // Hold the ordinary writer lock only while taking the coherent backup.
        let _guard = store.lock()?;
        let source = store.connect()?;
        check_context(&source, store, context)?;
        let mut target = Connection::open(&copied.database_path)?;
        rusqlite::backup::Backup::new(&source, &mut target)?.run_to_completion(
            256,
            Duration::from_millis(1),
            None,
        )?;
    }
    let mut connection = copied.connect()?;
    check_context(&connection, &copied, context)?;
    connection.pragma_update(None, "temp_store", "FILE")?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TEMP TABLE receive_expected(table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(table_name,row_key_json),UNIQUE(table_name,canonical_rowid));
        CREATE TEMP TABLE receive_actual(table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(table_name,row_key_json),UNIQUE(table_name,canonical_rowid));
        CREATE TEMP TABLE receive_changes(position INTEGER PRIMARY KEY,table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,before_json TEXT,after_json TEXT);
        CREATE TEMP TABLE receive_document_queue AS SELECT rowid AS local_rowid,* FROM project_document_sync;")?;
    snapshot(&tx, "receive_expected")?;
    let local_before_sha256 = local_fingerprint(&tx)?;
    let before_sha256 = fingerprint(&tx, "receive_expected")?;
    if before_sha256 != context.source_state_sha256 {
        return Err(invalid(
            "La copie locale ne correspond pas à l'empreinte de la révision partagée.",
        ));
    }
    let contract = policy()?;
    let mut changes = 0;
    let mut bytes = 0usize;
    for row in input {
        let row = row?;
        changes += 1;
        bytes = bytes
            .checked_add(row.before_json.as_ref().map_or(0, String::len))
            .and_then(|n| n.checked_add(row.after_json.as_ref().map_or(0, String::len)))
            .ok_or_else(|| invalid("La transaction est trop volumineuse."))?;
        if changes > MAX_ROWS || bytes > MAX_BYTES {
            return Err(invalid("La transaction est trop volumineuse."));
        }
        let rule = contract
            .tables
            .get(&row.table)
            .ok_or_else(|| invalid("La transaction contient une table inconnue."))?;
        let before = row
            .before_json
            .as_deref()
            .map(|v| normalize(&tx, rule, &row.key_json, v))
            .transpose()?;
        let after = row
            .after_json
            .as_deref()
            .map(|v| normalize(&tx, rule, &row.key_json, v))
            .transpose()?;
        if before == after {
            return Err(invalid("La transaction contient une écriture vide."));
        }
        let previous:Option<(i64,String)>=tx.query_row("SELECT canonical_rowid,row_json FROM receive_expected WHERE table_name=?1 AND row_key_json=?2",params![row.table,row.key_json],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if previous.as_ref().map(|r| r.1.as_str()) != before.as_deref()
            || previous
                .as_ref()
                .is_some_and(|r| r.0 != row.canonical_rowid)
        {
            return Err(invalid("Une ligne locale diffère de la révision attendue. La base de travail est conservée."));
        }
        tx.execute(
            "INSERT INTO receive_changes VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                changes as i64,
                row.table,
                row.key_json,
                row.canonical_rowid,
                before,
                after
            ],
        )?;
        if let Some(after) = after {
            tx.execute("INSERT INTO receive_expected VALUES(?1,?2,?3,?4) ON CONFLICT(table_name,row_key_json) DO UPDATE SET canonical_rowid=excluded.canonical_rowid,row_json=excluded.row_json",params![row.table,row.key_json,row.canonical_rowid,after])?;
        } else {
            tx.execute(
                "DELETE FROM receive_expected WHERE table_name=?1 AND row_key_json=?2",
                params![row.table, row.key_json],
            )?;
        }
    }
    if changes == 0 {
        return Err(invalid("La transaction reçue est vide."));
    }
    if fingerprint(&tx, "receive_expected")? != context.target_state_sha256 {
        return Err(invalid(
            "Les changements reçus ne produisent pas la révision attendue.",
        ));
    }
    // Suppress only outgoing capture on the disposable copy. Native BEFORE,
    // AFTER, foreign keys and financial constraints remain enabled throughout.
    tx.execute(
        "UPDATE business_sync_binding SET capture_enabled=0 WHERE id=1",
        [],
    )?;
    let mut statements = 0;
    let mut automatic = 0;
    {
        let mut query=tx.prepare("SELECT table_name,row_key_json,canonical_rowid,before_json,after_json FROM receive_changes ORDER BY position")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let table: String = row.get(0)?;
            let key: String = row.get(1)?;
            let rowid: i64 = row.get(2)?;
            let before: Option<String> = row.get(3)?;
            let after: Option<String> = row.get(4)?;
            let rule = &contract.tables[&table];
            let actual = current(&tx, &table, rule, &key)?;
            if actual.as_ref().map(|r| r.1.as_str()) != before.as_deref() {
                if actual.as_ref().map(|r| r.1.as_str()) == after.as_deref()
                    && actual.as_ref().is_none_or(|r| r.0 == rowid)
                {
                    automatic += 1;
                    continue;
                }
                return Err(invalid("Un effet natif diffère des écritures reçues. La base de travail est conservée."));
            }
            let table_sql = identifier(&table)?;
            match (&before, &after) {
                (None, Some(after)) => {
                    let columns = rule
                        .columns
                        .iter()
                        .map(|c| identifier(c))
                        .collect::<AppResult<Vec<_>>>()?
                        .join(",");
                    let values = rule
                        .columns
                        .iter()
                        .map(|c| format!("json_extract(?2,'$.{c}')"))
                        .collect::<Vec<_>>()
                        .join(",");
                    tx.execute(
                        &format!("INSERT INTO {table_sql}(rowid,{columns}) SELECT ?1,{values}"),
                        params![rowid, after],
                    )?;
                }
                (Some(before), Some(after)) => {
                    // UPDATE OF guards must see the fields actually changed,
                    // not every immutable column included in the wire image.
                    let mut fields = Vec::new();
                    for column in &rule.columns {
                        let different:bool=tx.query_row(&format!("SELECT json_extract(?1,'$.{column}') IS NOT json_extract(?2,'$.{column}') OR json_type(?1,'$.{column}') IS NOT json_type(?2,'$.{column}')"),params![before,after],|r|r.get(0))?;
                        if different {
                            fields.push(format!(
                                "{}=json_extract(?2,'$.{column}')",
                                identifier(column)?
                            ));
                        }
                    }
                    if fields.is_empty() {
                        return Err(invalid(
                            "Une mise à jour reçue ne modifie aucun champ natif.",
                        ));
                    }
                    tx.execute(
                        &format!(
                            "UPDATE {table_sql} AS r SET {} WHERE {}",
                            fields.join(","),
                            predicate(rule)?
                        ),
                        params![key, after],
                    )?;
                }
                (Some(_), None) => {
                    tx.execute(
                        &format!("DELETE FROM {table_sql} AS r WHERE {}", predicate(rule)?),
                        [&key],
                    )?;
                }
                _ => return Err(invalid("L'écriture reçue est incomplète.")),
            }
            statements += 1;
            let actual = current(&tx, &table, rule, &key)?;
            if actual.as_ref().map(|r| r.1.as_str()) != after.as_deref()
                || actual.as_ref().is_some_and(|r| r.0 != rowid)
            {
                return Err(invalid(
                    "L'écriture native ne reproduit pas exactement les données reçues.",
                ));
            }
        }
    }
    snapshot(&tx, "receive_actual")?;
    let after_sha256 = fingerprint(&tx, "receive_actual")?;
    if after_sha256 != fingerprint(&tx, "receive_expected")? {
        return Err(invalid(
            "Le résultat natif contient une modification absente de la transaction reçue.",
        ));
    }
    // Suppress transport echo from the two native document-queue triggers, then
    // verify every local table and foreign key in the final candidate state.
    tx.execute_batch("DELETE FROM project_document_sync; INSERT INTO project_document_sync(rowid,document_id,project_id,state,last_error,attempts,updated_at) SELECT * FROM receive_document_queue; UPDATE business_sync_binding SET capture_enabled=1 WHERE id=1;")?;
    if local_fingerprint(&tx)? != local_before_sha256 {
        return Err(invalid("La réception modifierait des données propres à cet appareil. Le travail local est conservé."));
    }
    let foreign_keys: i64 =
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if foreign_keys != 0 {
        return Err(invalid(
            "Le résultat natif contient une relation incohérente.",
        ));
    }
    crate::audit::verify_audit_chain(&tx)?;
    tx.commit()?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(invalid(
            "La copie préparée n'a pas passé le contrôle d'intégrité.",
        ));
    }
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    drop(connection);
    Ok(Candidate {
        _directory: directory,
        store: copied,
        before_sha256,
        after_sha256,
        changes,
        statements,
        automatic,
    })
}

#[cfg(test)]
pub(super) mod tests;

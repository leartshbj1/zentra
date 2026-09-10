//! Only disposable copies enter this module. Shared import restores the exact
//! trigger catalogue before replaying remote and pending business transitions.
use super::*;
use std::{fs, time::Duration};

pub(in crate::business_sync::replay) struct Copy {
    pub store: LocalStore,
    _directory: crate::business_sync::workspace::Workspace,
}
fn columns(c: &Connection, table: &str) -> AppResult<Vec<String>> {
    c.prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")?
        .query_map([table], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}
// Neither canonical import nor guarded replay may change the original capture
// evidence, acknowledgements, installation binding or local sequence counters.
pub(in crate::business_sync::replay) fn internal_fingerprint(c: &Connection) -> AppResult<String> {
    let mut hash = Sha256::new();
    hash.update(b"zentra-reconciliation-internal-v1\0");
    for pragma in ["user_version", "application_id"] {
        frame(&mut hash, pragma.as_bytes());
        frame(
            &mut hash,
            c.pragma_query_value(None, pragma, |r| r.get::<_, i64>(0))?
                .to_string()
                .as_bytes(),
        );
    }
    for table in [
        "business_sync_binding",
        "business_sync_changes",
        "business_sync_receipts",
        "business_sync_baseline",
        "business_sync_publication_intent",
        "business_sync_installed_revisions",
        "business_sync_resolution_intent",
        "business_sync_resolutions",
        "business_sync_resolution_cancellations",
    ] {
        frame(&mut hash, table.as_bytes());
        let mut query = c.prepare(&format!(
            "SELECT CAST(r.rowid AS TEXT),{} FROM {} r ORDER BY r.rowid",
            json_image("r", &columns(c, table)?)?,
            identifier(table)?
        ))?;
        let mut rows = query.query([])?;
        while let Some(r) = rows.next()? {
            frame(&mut hash, r.get::<_, String>(0)?.as_bytes());
            frame(&mut hash, r.get::<_, String>(1)?.as_bytes());
        }
    }
    let shared = policy()?.tables;
    let mut query = c.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")?;
    let mut rows = query.query([])?;
    while let Some(r) = rows.next()? {
        let name: String = r.get(0)?;
        if !shared.contains_key(&name) {
            frame(&mut hash, name.as_bytes());
            frame(&mut hash, r.get::<_, i64>(1)?.to_string().as_bytes());
        }
    }
    let mut query = c.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name",
    )?;
    let mut rows = query.query([])?;
    while let Some(r) = rows.next()? {
        for i in 0..4 {
            frame(&mut hash, r.get::<_, String>(i)?.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(super) fn load_canonical(copy: &Copy, model: &model::Model) -> AppResult<()> {
    let mut c = copy.store.connect()?;
    c.pragma_update(None, "foreign_keys", false)?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let triggers = tx
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, _) in &triggers {
        tx.execute_batch(&format!("DROP TRIGGER {}", identifier(name)?))?;
    }
    let policy = policy()?;
    // Device-local rows may refer to projects created in the pending suffix.
    // Stash them during canonical validation and restore them after that suffix.
    for table in policy.local_tables.keys() {
        tx.execute_batch(&format!(
            "CREATE TABLE {} AS SELECT rowid AS original_rowid,* FROM {}; DELETE FROM {};",
            identifier(&format!("reconcile_local_{table}"))?,
            identifier(table)?,
            identifier(table)?
        ))?;
    }
    for table in policy.tables.keys() {
        tx.execute(&format!("DELETE FROM {}", identifier(table)?), [])?;
        tx.execute("DELETE FROM sqlite_sequence WHERE name=?1", [table])?;
    }
    let mut query=model.connection.prepare("SELECT table_name,row_key_json,canonical_rowid,row_json FROM source_rows ORDER BY table_name,row_key_json")?;
    let mut rows = query.query([])?;
    while let Some(r) = rows.next()? {
        let table: String = r.get(0)?;
        let rule = &policy.tables[&table];
        let fields = rule
            .columns
            .iter()
            .map(|v| identifier(v))
            .collect::<AppResult<Vec<_>>>()?
            .join(",");
        let values = rule
            .columns
            .iter()
            .map(|v| format!("json_extract(?2,'$.{v}')"))
            .collect::<Vec<_>>()
            .join(",");
        tx.execute(
            &format!(
                "INSERT INTO {}(rowid,{fields}) SELECT ?1,{values}",
                identifier(&table)?
            ),
            params![r.get::<_, i64>(2)?, r.get::<_, String>(3)?],
        )?;
    }
    if state_fingerprint(&tx)? != fingerprint(&model.connection, "source_rows")? {
        return Err(invalid(
            "La copie native ne reproduit pas la référence canonique.",
        ));
    }
    let foreign_keys: i64 =
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if foreign_keys != 0 {
        return Err(invalid(
            "La référence canonique contient une relation incohérente.",
        ));
    }
    crate::audit::verify_audit_chain(&tx)?;
    for (_, sql) in &triggers {
        tx.execute_batch(sql)?;
    }
    tx.commit()?;
    c.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}
fn mapped(r: &rusqlite::Row<'_>) -> rusqlite::Result<RowChange> {
    Ok(RowChange {
        table: r.get(0)?,
        key_json: r.get(1)?,
        canonical_rowid: r.get(2)?,
        before_json: r.get(3)?,
        after_json: r.get(4)?,
    })
}
pub(super) fn restore_local(copy: &Copy, expected: &str) -> AppResult<()> {
    let mut c = copy.store.connect()?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // This isolated Copy restores existing evidence, not a newly stopped timer.
    // The working-profile guard stays enabled. Restore the copy's guard before
    // checking its exact original private fingerprint and committing anything.
    let timer_guard: String = tx.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='timer_recoveries_insert_guard' AND tbl_name='timer_recoveries'", [], |r| r.get(0))?;
    tx.execute_batch("DROP TRIGGER timer_recoveries_insert_guard")?;
    for table in policy()?.local_tables.keys() {
        let columns = columns(&tx, table)?
            .iter()
            .map(|v| identifier(v))
            .collect::<AppResult<Vec<_>>>()?
            .join(",");
        let stash = identifier(&format!("reconcile_local_{table}"))?;
        tx.execute(
            &format!(
                "INSERT INTO {}(rowid,{columns}) SELECT original_rowid,{columns} FROM {stash}",
                identifier(table)?
            ),
            [],
        )?;
        tx.execute_batch(&format!("DROP TABLE {stash}"))?;
    }
    tx.execute_batch(&timer_guard)?;
    if local_fingerprint(&tx)? != expected {
        return Err(invalid(
            "La réconciliation modifierait des informations propres à cet appareil.",
        ));
    }
    let foreign_keys: i64 =
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if foreign_keys != 0 {
        return Err(invalid("Une donnée locale dépend d’une ligne supprimée à distance. Résolvez ce conflit avant l’installation."));
    }
    crate::audit::verify_audit_chain(&tx)?;
    tx.commit()?;
    Ok(())
}
pub(super) fn build(
    store: &LocalStore,
    source: &Connection,
    context: &Context,
    model: &model::Model,
    local_sha256: &str,
) -> AppResult<Copy> {
    let internal_sha256 = internal_fingerprint(source)?;
    let copy = copy_source(store, source)?;
    complete(&copy, context, model, local_sha256, &internal_sha256)?;
    Ok(copy)
}

pub(in crate::business_sync::replay) fn copy_source(
    store: &LocalStore,
    source: &Connection,
) -> AppResult<Copy> {
    let directory =
        crate::business_sync::workspace::Workspace::new(store, "reconciliation-native")?;
    let mut candidate = store.clone();
    candidate.data_dir = directory.path().to_path_buf();
    candidate.database_path = directory.path().join("candidate.sqlite");
    candidate.attachments_dir = directory.path().join("attachments");
    candidate.exports_dir = directory.path().join("exports");
    candidate.backups_dir = directory.path().join("backups");
    for path in [
        &candidate.attachments_dir,
        &candidate.exports_dir,
        &candidate.backups_dir,
    ] {
        fs::create_dir(path)?;
    }
    let mut destination = Connection::open(&candidate.database_path)?;
    rusqlite::backup::Backup::new(source, &mut destination)?.run_to_completion(
        256,
        Duration::from_millis(1),
        None,
    )?;
    drop(destination);
    Ok(Copy {
        store: candidate,
        _directory: directory,
    })
}

fn complete(
    copy: &Copy,
    context: &Context,
    model: &model::Model,
    local_sha256: &str,
    internal_sha256: &str,
) -> AppResult<()> {
    load_canonical(copy, model)?;
    let mut c = copy.store.connect()?;
    c.pragma_update(None, "temp_store", "FILE")?;
    {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut query=model.connection.prepare("SELECT table_name,row_key_json,canonical_rowid,before_json,after_json FROM remote_changes ORDER BY position")?;
        let changes = query.query_map([], mapped)?.map(|r| r.map_err(Into::into));
        apply_checked_rows(&tx, &copy.store, context, changes)?;
        tx.execute("INSERT INTO business_sync_cursor VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,generation=excluded.generation,revision=excluded.revision",params![context.organization,context.generation,context.base_revision+1])?;
        tx.commit()?;
    }
    let overlays=model.connection.prepare("SELECT transaction_id,source_sha256,target_sha256 FROM overlay_transactions ORDER BY position")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, source_sha256, target_sha256) in overlays {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut query=model.connection.prepare("SELECT p.table_name,p.row_key_json,p.canonical_rowid,p.before_json,p.after_json FROM planned_changes p JOIN pending_changes o ON o.sequence=p.position WHERE o.transaction_id=?1 ORDER BY p.position")?;
        let changes = query
            .query_map([&id], mapped)?
            .map(|r| r.map_err(Into::into));
        let local = Context {
            fingerprint_version: STATE_FINGERPRINT_VERSION,
            organization: context.organization.clone(),
            generation: context.generation.clone(),
            base_revision: context.base_revision + 1,
            source_state_sha256: source_sha256,
            target_state_sha256: target_sha256,
        };
        apply_checked_rows(&tx, &copy.store, &local, changes)?;
        tx.commit()?;
    }
    drop(c);
    restore_local(copy, local_sha256)?;
    let c = copy.store.connect()?;
    if internal_fingerprint(&c)? != internal_sha256 {
        return Err(invalid(
            "La préparation a modifié une preuve ou un réglage interne. La copie a été écartée.",
        ));
    }
    if Some(state_fingerprint(&c)?) != model.merged_sha256 {
        return Err(invalid(
            "La copie native ne reproduit pas la fusion attendue.",
        ));
    }
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(invalid(
            "La copie réconciliée n’a pas passé le contrôle d’intégrité.",
        ));
    }
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    drop(c);
    Ok(())
}

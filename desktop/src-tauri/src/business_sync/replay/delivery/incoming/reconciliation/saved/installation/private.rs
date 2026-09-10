//! Work only on an isolated Copy. Importing device-private rows here must not
//! erase changes made while a retirement request was waiting for the network.
use super::*;
use rusqlite::types::Value as SqlValue;

pub(super) struct Cutoff {
    state: String,
    private: String,
    internal: String,
}
impl Cutoff {
    pub fn read(c: &Connection) -> AppResult<Self> {
        Ok(Self {
            state: replay::state_fingerprint(c)?,
            private: replay::local_fingerprint(c)?,
            internal: merge::internal_fingerprint(c)?,
        })
    }
    pub fn verify(&self, c: &Connection) -> AppResult<()> {
        if self.state != replay::state_fingerprint(c)?
            || self.private != replay::local_fingerprint(c)?
            || self.internal != merge::internal_fingerprint(c)?
        {
            return Err(invalid("Le dossier ou les réglages de cet appareil ont changé. La résolution est conservée ; reprenez son installation."));
        }
        Ok(())
    }
}

fn columns(c: &Connection, table: &str) -> AppResult<Vec<String>> {
    c.prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")?
        .query_map([table], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}
fn table_hash(
    c: &Connection,
    table: &str,
    filter: &str,
    args: &[&dyn rusqlite::ToSql],
) -> AppResult<String> {
    let mut hash = Sha256::new();
    let sql = format!(
        "SELECT CAST(r.rowid AS TEXT),{} FROM {} r {filter} ORDER BY r.rowid",
        json_image("r", &columns(c, table)?)?,
        identifier(table)?
    );
    let mut q = c.prepare(&sql)?;
    let mut rows = q.query(args)?;
    while let Some(r) = rows.next()? {
        replay::frame(&mut hash, r.get::<_, String>(0)?.as_bytes());
        replay::frame(&mut hash, r.get::<_, String>(1)?.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn same(a: &Connection, b: &Connection, table: &str) -> AppResult<()> {
    if table_hash(a, table, "", &[])? != table_hash(b, table, "", &[])? {
        return Err(invalid(
            "Une preuve originale du dossier a changé depuis la proposition.",
        ));
    }
    Ok(())
}
fn schema(c: &Connection) -> AppResult<String> {
    let mut hash = Sha256::new();
    for pragma in ["user_version", "application_id"] {
        replay::frame(
            &mut hash,
            c.pragma_query_value(None, pragma, |r| r.get::<_, i64>(0))?
                .to_string()
                .as_bytes(),
        );
    }
    let mut q = c.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name",
    )?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        for i in 0..4 {
            replay::frame(&mut hash, r.get::<_, String>(i)?.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn sequence(c: &Connection, table: &str) -> AppResult<Option<i64>> {
    c.query_row(
        "SELECT seq FROM sqlite_sequence WHERE name=?1",
        [table],
        |r| r.get(0),
    )
    .optional()
    .map_err(Into::into)
}

pub(super) fn verify_originals(
    source: &Connection,
    original: &Connection,
    replacement: &Connection,
    ready: &Ready,
    intent: &Intent,
) -> AppResult<()> {
    if schema(source)? != schema(original)?
        || schema(source)? != schema(replacement)?
        || replay::state_fingerprint(source)? != replay::fingerprint(&ready.model, "current_rows")?
        || replay::state_fingerprint(replacement)? != ready.plan.replacement_state_sha256
        || sequence(source, "business_sync_changes")?
            != sequence(original, "business_sync_changes")?
    {
        return Err(invalid(
            "La proposition ne reproduit plus le dossier ou son schéma original.",
        ));
    }
    for table in [
        "business_sync_binding",
        "business_sync_changes",
        "business_sync_receipts",
        "business_sync_baseline",
        "business_sync_publication_intent",
        "business_sync_installed_revisions",
        "business_sync_resolutions",
    ] {
        same(source, original, table)?;
        if !matches!(table, "business_sync_binding" | "business_sync_changes") {
            same(source, replacement, table)?;
        }
    }
    if table_hash(source, "business_sync_changes", "", &[])?
        != table_hash(
            replacement,
            "business_sync_changes",
            "WHERE generation<>?1",
            &[&intent.replacement_capture_generation],
        )?
    {
        return Err(invalid(
            "Le journal des opérations originales a été modifié dans la copie.",
        ));
    }
    let actual: i64 = replacement.query_row(
        "SELECT COUNT(*) FROM business_sync_changes WHERE generation=?1",
        [&intent.replacement_capture_generation],
        |r| r.get(0),
    )?;
    let expected: usize = ready
        .plan
        .transactions
        .iter()
        .map(|t| t.changes.len())
        .sum();
    if actual != expected as i64 {
        return Err(invalid(
            "Le nombre d’opérations remplaçantes est incohérent.",
        ));
    }
    for transaction in &ready.plan.transactions {
        let first = integer(&transaction.first_sequence)?;
        let last = integer(&transaction.last_sequence)?;
        if last - first + 1 != transaction.changes.len() as i64 {
            return Err(invalid(
                "La plage des opérations remplaçantes est incohérente.",
            ));
        }
        for (offset, row) in transaction.changes.iter().enumerate() {
            let actual:(String,String,String,Option<String>,Option<String>,String,i64,String,String)=replacement.query_row(
                "SELECT transaction_id,table_name,row_key_json,before_json,after_json,source_rowid,base_revision,organization_id,installation_id FROM business_sync_changes WHERE generation=?1 AND sequence=?2",
                params![intent.replacement_capture_generation,first+offset as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)))?;
            if actual
                != (
                    transaction.transaction_id.clone(),
                    row.table.clone(),
                    row.key_json.clone(),
                    row.before_json.clone(),
                    row.after_json.clone(),
                    row.canonical_rowid.to_string(),
                    intent.base_revision,
                    intent.organization_id.clone(),
                    intent.installation_id.clone(),
                )
            {
                return Err(invalid(
                    "Le journal de remplacement diffère du plan sauvegardé.",
                ));
            }
        }
    }
    Ok(())
}

fn copy_table(source: &Connection, target: &Connection, table: &str) -> AppResult<()> {
    let cols = columns(source, table)?;
    if cols != columns(target, table)? {
        return Err(invalid("Le schéma des données privées a changé."));
    }
    let names = cols
        .iter()
        .map(|v| identifier(v))
        .collect::<AppResult<Vec<_>>>()?
        .join(",");
    target.execute(&format!("DELETE FROM {}", identifier(table)?), [])?;
    let mut q = source.prepare(&format!(
        "SELECT rowid,{names} FROM {} ORDER BY rowid",
        identifier(table)?
    ))?;
    let mut rows = q.query([])?;
    let sql = format!(
        "INSERT INTO {}(rowid,{names}) VALUES({})",
        identifier(table)?,
        (0..=cols.len()).map(|_| "?").collect::<Vec<_>>().join(",")
    );
    let mut insert = target.prepare(&sql)?;
    while let Some(row) = rows.next()? {
        let values = (0..=cols.len())
            .map(|i| row.get::<_, SqlValue>(i))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        insert.execute(rusqlite::params_from_iter(values))?;
    }
    target.execute("DELETE FROM sqlite_sequence WHERE name=?1", [table])?;
    if let Some(sequence) = sequence(source, table)? {
        target.execute(
            "INSERT INTO sqlite_sequence(name,seq) VALUES(?1,?2)",
            params![table, sequence],
        )?;
    }
    Ok(())
}

pub(super) fn refresh(
    copy: &merge::native::Copy,
    source: &Connection,
    frozen: &durable::Frozen,
    ready: &Ready,
) -> AppResult<()> {
    let mut c = copy.store.connect()?;
    c.pragma_update(None, "foreign_keys", false)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let triggers = tx
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // This connection belongs only to native::Copy; no working guard is disabled.
    for (name, _) in &triggers {
        tx.execute_batch(&format!("DROP TRIGGER {}", identifier(name)?))?;
    }
    for table in policy()?.local_tables.keys() {
        copy_table(source, &tx, table)?;
    }
    copy_table(source, &tx, "business_sync_resolution_intent")?;
    for (_, sql) in &triggers {
        tx.execute_batch(sql)?;
    }
    tx.commit()?;
    c.pragma_update(None, "foreign_keys", true)?;
    if schema(&c)? != schema(source)?
        || replay::local_fingerprint(&c)? != replay::local_fingerprint(source)?
        || replay::state_fingerprint(&c)? != ready.plan.replacement_state_sha256
    {
        return Err(invalid(
            "La préparation modifierait des données non prévues.",
        ));
    }
    let proof: (String, Option<String>) = c.query_row(
        "SELECT intent_json,retirement_json FROM business_sync_resolution_intent WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if proof != (frozen.raw_intent.clone(), frozen.retirement.clone()) {
        return Err(invalid("Les preuves privées n’ont pas été conservées."));
    }
    integrity(&c)
}
fn integrity(c: &Connection) -> AppResult<()> {
    let bad: i64 = c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if bad != 0 {
        return Err(invalid("Une donnée propre à cet appareil dépend d’un élément écarté. Elle a été conservée ; résolvez cette dépendance avant l’installation."));
    }
    crate::audit::verify_audit_chain(c)?;
    let result: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if result != "ok" {
        return Err(invalid(
            "La copie de résolution n’a pas passé le contrôle d’intégrité.",
        ));
    }
    Ok(())
}

pub(super) fn verify_final(
    candidate: &Connection,
    source: &Connection,
    ready: &Ready,
    frozen: &durable::Frozen,
    acknowledged: bool,
) -> AppResult<()> {
    let i = &frozen.intent;
    let mut expected = ready.header.binding.clone();
    expected.capture = i.replacement_capture_generation.clone();
    expected.revision = i.base_revision;
    let restored:Binding=candidate.query_row("SELECT b.organization_id,b.installation_id,b.generation,h.server_generation,h.source_transfer_id,c.revision FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id JOIN business_sync_cursor c ON c.id=b.id WHERE b.id=1 AND b.capture_enabled=1 AND c.organization_id=b.organization_id AND c.generation=h.server_generation",[],|r|Ok(Binding{organization:r.get(0)?,installation:r.get(1)?,capture:r.get(2)?,generation:r.get(3)?,bootstrap:r.get(4)?,revision:r.get(5)?}))?;
    if restored != expected
        || schema(candidate)? != schema(source)?
        || replay::local_fingerprint(candidate)? != replay::local_fingerprint(source)?
        || replay::state_fingerprint(candidate)? != ready.plan.replacement_state_sha256
    {
        return Err(invalid(
            "La base finalisée ne correspond pas aux choix et aux données de cet appareil.",
        ));
    }
    for table in policy()?.local_tables.keys() {
        if sequence(candidate, table)? != sequence(source, table)? {
            return Err(invalid("Un compteur privé a changé pendant la résolution."));
        }
    }
    for table in ["business_sync_baseline", "business_sync_publication_intent"] {
        same(source, candidate, table)?;
    }
    if table_hash(source, "business_sync_changes", "", &[])?
        != table_hash(
            candidate,
            "business_sync_changes",
            "WHERE generation<>?1",
            &[&i.replacement_capture_generation],
        )?
        || table_hash(source, "business_sync_installed_revisions", "", &[])?
            != table_hash(
                candidate,
                "business_sync_installed_revisions",
                "WHERE NOT (organization_id=?1 AND generation=?2 AND transaction_id=?3)",
                &[
                    &i.organization_id,
                    &i.generation,
                    &i.received_transaction_id,
                ],
            )?
        || table_hash(source, "business_sync_resolutions", "", &[])?
            != table_hash(
                candidate,
                "business_sync_resolutions",
                "WHERE resolution_id<>?1",
                &[&i.resolution_id],
            )?
    {
        return Err(invalid(
            "Une preuve originale a changé pendant l’installation de la résolution.",
        ));
    }
    if acknowledged {
        if table_hash(source, "business_sync_receipts", "", &[])?
            != table_hash(
                candidate,
                "business_sync_receipts",
                "WHERE NOT (generation=?1 AND transaction_id=?2)",
                &[&i.capture_generation, &i.received_transaction_id],
            )?
        {
            return Err(invalid(
                "La confirmation d’origine a modifié d’autres reçus.",
            ));
        }
    } else {
        same(source, candidate, "business_sync_receipts")?;
    }
    let active: i64 = candidate.query_row(
        "SELECT COUNT(*) FROM business_sync_resolution_intent",
        [],
        |r| r.get(0),
    )?;
    let (intent,proof,mapping):(String,String,String)=candidate.query_row("SELECT intent_json,retirement_json,mapping_json FROM business_sync_resolutions WHERE resolution_id=?1",[&i.resolution_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let receipt:String=candidate.query_row("SELECT receipt_json FROM business_sync_installed_revisions WHERE organization_id=?1 AND generation=?2 AND transaction_id=?3",params![i.organization_id,i.generation,i.received_transaction_id],|r|r.get(0))?;
    if active != 0
        || intent != frozen.raw_intent
        || Some(proof) != frozen.retirement
        || mapping != ready.mapping
        || receipt != ready.receipt
    {
        return Err(invalid(
            "Les preuves finales de résolution ne correspondent pas aux originaux.",
        ));
    }
    integrity(candidate)
}

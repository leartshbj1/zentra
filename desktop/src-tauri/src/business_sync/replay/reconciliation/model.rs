use super::*;
use serde::Serialize;

#[derive(Clone)]
pub(in crate::business_sync::replay) struct Acknowledgement {
    pub transaction_id: String,
    pub first_sequence: i64,
    pub last_sequence: i64,
    pub change_count: usize,
}
#[derive(Serialize)]
pub(super) struct Conflict {
    transaction_id: String,
    sequence: String,
    table: String,
    key_json: String,
    expected_sha256: Option<String>,
    current_sha256: Option<String>,
    incoming_sha256: Option<String>,
}
pub(super) struct Model {
    pub connection: Connection,
    pub current_sha256: String,
    pub canonical_sha256: String,
    pub merged_sha256: Option<String>,
    pub journal_sha256: String,
    pub pending_count: usize,
    pub conflict_count: usize,
    pub conflicts: Vec<Conflict>,
    _directory: crate::business_sync::workspace::Workspace,
}
#[derive(Clone)]
struct Event {
    sequence: i64,
    transaction_id: String,
    table: String,
    key: String,
    before: Option<String>,
    after: Option<String>,
    rowid: i64,
    sha: String,
}
fn digest(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
fn require(ok: bool, message: &str) -> AppResult<()> {
    if ok {
        Ok(())
    } else {
        Err(invalid(message))
    }
}
fn row_table(c: &Connection, name: &str) -> AppResult<()> {
    c.execute_batch(&format!("CREATE TABLE {name}(table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(table_name,row_key_json),UNIQUE(table_name,canonical_rowid))"))?;
    Ok(())
}
fn rows_from_native(source: &Connection, target: &Connection) -> AppResult<()> {
    let mut count = 0usize;
    let mut bytes = 0usize;
    for (table, rule) in policy()?.tables {
        let mut query = source.prepare(&format!(
            "SELECT r.rowid,{},{} FROM {} r",
            json_key("r", &rule.key)?,
            json_image("r", &rule.columns)?,
            identifier(&table)?
        ))?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let image: String = row.get(2)?;
            count += 1;
            bytes = bytes
                .checked_add(image.len())
                .ok_or_else(|| invalid("Le dossier est trop volumineux."))?;
            require(
                count <= MAX_ROWS && bytes <= MAX_BYTES && image.len() <= MAX_ROW_BYTES,
                "Le dossier dépasse les limites de réconciliation.",
            )?;
            target.execute(
                "INSERT INTO current_rows VALUES(?1,?2,?3,?4)",
                params![
                    table,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(0)?,
                    image
                ],
            )?;
        }
    }
    Ok(())
}
fn row(c: &Connection, name: &str, table: &str, key: &str) -> AppResult<Option<(i64, String)>> {
    c.query_row(
        &format!(
            "SELECT canonical_rowid,row_json FROM {name} WHERE table_name=?1 AND row_key_json=?2"
        ),
        params![table, key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(Into::into)
}
fn put(
    c: &Connection,
    name: &str,
    event: &Event,
    value: Option<&str>,
    rowid: i64,
) -> AppResult<()> {
    if let Some(value) = value {
        c.execute(&format!("INSERT INTO {name} VALUES(?1,?2,?3,?4) ON CONFLICT(table_name,row_key_json) DO UPDATE SET canonical_rowid=excluded.canonical_rowid,row_json=excluded.row_json"),params![event.table,event.key,rowid,value])?;
    } else {
        c.execute(
            &format!("DELETE FROM {name} WHERE table_name=?1 AND row_key_json=?2"),
            params![event.table, event.key],
        )?;
    }
    Ok(())
}
fn event(r: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        sequence: r.get(0)?,
        transaction_id: r.get(1)?,
        table: r.get(2)?,
        key: r.get(3)?,
        before: r.get(4)?,
        after: r.get(5)?,
        rowid: r.get(6)?,
        sha: r.get(7)?,
    })
}
fn load_pending(
    source: &Connection,
    model: &Connection,
    organization: &str,
    installation: &str,
    capture: &str,
    revision: i64,
) -> AppResult<(String, usize)> {
    let contract = policy()?;
    let mut query = source.prepare("SELECT c.sequence,c.transaction_id,c.table_name,c.row_key_json,c.before_json,c.after_json,c.source_rowid,c.base_revision,c.organization_id,c.installation_id,c.operation,r.transaction_id,json_array(c.sequence,c.generation,c.transaction_id,c.organization_id,c.installation_id,c.table_name,c.row_key_json,c.operation,c.before_json,c.after_json,c.source_rowid,c.base_revision) FROM business_sync_changes c LEFT JOIN business_sync_receipts r ON r.generation=c.generation AND r.transaction_id=c.transaction_id WHERE c.generation=?1 AND c.sequence>COALESCE(r.acknowledged_through,0) ORDER BY c.sequence")?;
    let mut rows = query.query([capture])?;
    let mut count = 0;
    let mut bytes = 0usize;
    let mut hash = Sha256::new();
    hash.update(b"zentra-reconciliation-pending-v1\0");
    let mut completed = BTreeSet::new();
    let mut previous_id = String::new();
    while let Some(r) = rows.next()? {
        let seq: i64 = r.get(0)?;
        let id: String = r.get(1)?;
        let table: String = r.get(2)?;
        let key: String = r.get(3)?;
        let before: Option<String> = r.get(4)?;
        let after: Option<String> = r.get(5)?;
        let order: Option<String> = r.get(6)?;
        let base: Option<i64> = r.get(7)?;
        let operation: String = r.get(10)?;
        let raw: String = r.get(12)?;
        count += 1;
        bytes = bytes
            .checked_add(raw.len())
            .ok_or_else(|| invalid("Le journal est trop volumineux."))?;
        require(
            count <= MAX_ROWS
                && bytes <= MAX_BYTES
                && seq > 0
                && base.is_some_and(|n| n >= 1 && n <= revision)
                && r.get::<_, String>(8)? == organization
                && r.get::<_, String>(9)? == installation
                && r.get::<_, Option<String>>(11)?.is_none(),
            "Le journal local est incomplet ou contient une confirmation partielle.",
        )?;
        require(
            uuid::Uuid::parse_str(&id).is_ok_and(|value| {
                value.to_string() == id
                    && value.get_version_num() == 4
                    && value.get_variant() == uuid::Variant::RFC4122
            }),
            "La transaction locale est invalide.",
        )?;
        if previous_id != id {
            require(
                !completed.contains(&id),
                "Les événements de plusieurs transactions locales sont entrelacés.",
            )?;
            completed.insert(id.clone());
            previous_id = id.clone();
        }
        let rule = contract
            .tables
            .get(&table)
            .ok_or_else(|| invalid("Une table du journal est inconnue."))?;
        require(
            matches!(
                (operation.as_str(), before.is_some(), after.is_some()),
                ("insert", false, true) | ("update", true, true) | ("delete", true, false)
            ),
            "L’opération du journal est incohérente.",
        )?;
        let before = before
            .map(|v| normalize(model, rule, &key, &v))
            .transpose()?;
        let after = after
            .map(|v| normalize(model, rule, &key, &v))
            .transpose()?;
        require(before != after, "Le journal contient une écriture vide.")?;
        let rowid = order
            .and_then(|s| s.parse::<i64>().ok().filter(|n| n.to_string() == s))
            .ok_or_else(|| invalid("Le journal ne conserve pas sa position exacte."))?;
        frame(&mut hash, raw.as_bytes());
        model.execute(
            "INSERT INTO pending_changes VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![seq, id, table, key, before, after, rowid, digest(&raw)],
        )?;
    }
    Ok((format!("{:x}", hash.finalize()), count))
}
fn reverse_pending(c: &Connection) -> AppResult<()> {
    c.execute("INSERT INTO source_rows SELECT * FROM current_rows", [])?;
    let mut query = c.prepare("SELECT * FROM pending_changes ORDER BY sequence DESC")?;
    let mut rows = query.query([])?;
    while let Some(r) = rows.next()? {
        let event = event(r)?;
        let actual = row(c, "source_rows", &event.table, &event.key)?;
        require(
            actual.as_ref().map(|r| r.1.as_str()) == event.after.as_deref()
                && actual.as_ref().is_none_or(|r| r.0 == event.rowid),
            "La copie locale ne correspond plus à son journal. Aucune donnée n’a été remplacée.",
        )?;
        put(
            c,
            "source_rows",
            &event,
            event.before.as_deref(),
            event.rowid,
        )?;
    }
    Ok(())
}
fn load_cache(c: &Connection, path: &Path, capture: &str) -> AppResult<()> {
    require(
        crate::business_sync::snapshot::regular_metadata(path)?.is_file(),
        "La référence canonique est indisponible.",
    )?;
    let cache = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query=cache.prepare("SELECT table_name,row_key_json,canonical_rowid,row_json FROM canonical_rows ORDER BY table_name,row_key_json")?;
    let contract = policy()?;
    let mut rows = query.query([])?;
    let mut count = 0;
    let mut bytes = 0usize;
    while let Some(r) = rows.next()? {
        let table: String = r.get(0)?;
        let key: String = r.get(1)?;
        let image: String = r.get(3)?;
        let rule = contract
            .tables
            .get(&table)
            .ok_or_else(|| invalid("La référence canonique contient une table inconnue."))?;
        count += 1;
        bytes = bytes
            .checked_add(image.len())
            .ok_or_else(|| invalid("La référence canonique est trop volumineuse."))?;
        require(
            count <= MAX_ROWS && bytes <= MAX_BYTES && normalize(c, rule, &key, &image)? == image,
            "La référence canonique est altérée.",
        )?;
        c.execute(
            "INSERT INTO source_rows VALUES(?1,?2,?3,?4)",
            params![table, key, r.get::<_, i64>(2)?, image],
        )?;
    }
    let mut aliases=cache.prepare("SELECT sequence,original_sha256,canonical_rowid FROM row_aliases WHERE capture_generation=?1 ORDER BY sequence")?;
    let mut rows = aliases.query([capture])?;
    let mut count = 0;
    while let Some(r) = rows.next()? {
        count += 1;
        require(
            count <= MAX_ROWS,
            "La référence contient trop de positions locales.",
        )?;
        let seq: i64 = r.get(0)?;
        let sha: String = r.get(1)?;
        let original: Option<String> = c
            .query_row(
                "SELECT original_sha256 FROM pending_changes WHERE sequence=?1",
                [seq],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(original) = original {
            require(
                original == sha,
                "Une position de reprise appartient à une autre écriture locale.",
            )?;
            c.execute(
                "INSERT INTO current_aliases VALUES(?1,?2)",
                params![seq, r.get::<_, i64>(2)?],
            )?;
        }
    }
    Ok(())
}

fn aliases_from_native(source: &Connection, model: &Connection) -> AppResult<()> {
    for (table, rule) in policy()?.tables {
        let primary = source
            .prepare("SELECT name,type FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk")?
            .query_map([&table], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if primary.len() == 1
            && primary[0].1.eq_ignore_ascii_case("INTEGER")
            && rule.columns.contains(&primary[0].0)
        {
            model.execute(
                "INSERT INTO shared_aliases VALUES(?1,?2)",
                params![table, primary[0].0],
            )?;
        }
    }
    Ok(())
}
fn shared_id(c: &Connection, table: &str, image: &str) -> AppResult<Option<i64>> {
    let column: Option<String> = c
        .query_row(
            "SELECT column_name FROM shared_aliases WHERE table_name=?1",
            [table],
            |r| r.get(0),
        )
        .optional()?;
    column
        .map(|column| {
            c.query_row(
                "SELECT json_extract(?1,?2)",
                params![image, format!("$.{column}")],
                |r| r.get::<_, i64>(0),
            )
            .map_err(Into::into)
        })
        .transpose()
}
fn apply_local(
    c: &Connection,
    event: &Event,
    verifying_current: bool,
) -> AppResult<Option<Conflict>> {
    let actual = row(c, "merged_rows", &event.table, &event.key)?;
    if actual.as_ref().map(|r| r.1.as_str()) != event.before.as_deref() {
        return Ok(Some(Conflict {
            transaction_id: event.transaction_id.clone(),
            sequence: event.sequence.to_string(),
            table: event.table.clone(),
            key_json: event.key.clone(),
            expected_sha256: event.before.as_deref().map(digest),
            current_sha256: actual.as_ref().map(|r| digest(&r.1)),
            incoming_sha256: event.after.as_deref().map(digest),
        }));
    }
    let rowid = if let Some((id, _)) = actual {
        id
    } else {
        let preferred: Option<i64> = c
            .query_row(
                if verifying_current {
                    "SELECT canonical_rowid FROM current_aliases WHERE sequence=?1"
                } else {
                    "SELECT canonical_rowid FROM verified_aliases WHERE sequence=?1"
                },
                [event.sequence],
                |r| r.get(0),
            )
            .optional()?;
        let preferred = preferred.unwrap_or(event.rowid);
        let alias = shared_id(
            c,
            &event.table,
            event
                .after
                .as_deref()
                .ok_or_else(|| invalid("L’insertion locale est absente."))?,
        )?;
        if verifying_current {
            require(
                alias.is_none_or(|id| id == preferred),
                "La séquence partagée ne correspond plus à la position locale.",
            )?;
            preferred
        } else if let Some(alias) = alias {
            alias
        } else {
            let maximum: i64 = c.query_row(
                "SELECT COALESCE(MAX(canonical_rowid),0) FROM merged_rows WHERE table_name=?1",
                [&event.table],
                |r| r.get(0),
            )?;
            if preferred > maximum {
                preferred
            } else {
                maximum.checked_add(1).ok_or_else(|| {
                    invalid("Les positions du dossier dépassent les limites SQLite.")
                })?
            }
        }
    };
    put(c, "merged_rows", event, event.after.as_deref(), rowid)?;
    if verifying_current {
        c.execute(
            "INSERT INTO verified_aliases VALUES(?1,?2)",
            params![event.sequence, rowid],
        )?;
    } else {
        c.execute(
            "INSERT INTO planned_changes VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                event.sequence,
                event.table,
                event.key,
                rowid,
                event.before,
                event.after
            ],
        )?;
    }
    Ok(None)
}
fn verify_working(c: &Connection, current_sha256: &str) -> AppResult<()> {
    c.execute("INSERT INTO merged_rows SELECT * FROM source_rows", [])?;
    let mut query = c.prepare("SELECT * FROM pending_changes ORDER BY sequence")?;
    let mut rows = query.query([])?;
    while let Some(r) = rows.next()? {
        require(
            apply_local(c, &event(r)?, true)?.is_none(),
            "Le dossier de travail ne correspond pas à sa référence et à son journal.",
        )?;
    }
    require(
        fingerprint(c, "merged_rows")? == current_sha256,
        "Le dossier local contient un changement non expliqué par son journal.",
    )?;
    c.execute("DELETE FROM merged_rows", [])?;
    Ok(())
}
fn apply_remote(
    c: &Connection,
    context: &Context,
    input: impl IntoIterator<Item = AppResult<RowChange>>,
) -> AppResult<()> {
    c.execute("INSERT INTO canonical_rows SELECT * FROM source_rows", [])?;
    let rules = policy()?;
    let mut count = 0usize;
    let mut bytes = 0usize;
    for change in input {
        let change = change?;
        let rule = rules
            .tables
            .get(&change.table)
            .ok_or_else(|| invalid("La révision comporte une table inconnue."))?;
        let before = change
            .before_json
            .map(|v| normalize(c, rule, &change.key_json, &v))
            .transpose()?;
        let after = change
            .after_json
            .map(|v| normalize(c, rule, &change.key_json, &v))
            .transpose()?;
        bytes = bytes
            .checked_add(before.as_ref().map_or(0, String::len))
            .and_then(|v| v.checked_add(after.as_ref().map_or(0, String::len)))
            .ok_or_else(|| invalid("La révision est trop volumineuse."))?;
        count += 1;
        require(
            count <= MAX_ROWS && bytes <= MAX_BYTES && before != after,
            "La révision dépasse les limites ou contient une écriture vide.",
        )?;
        let previous = row(c, "canonical_rows", &change.table, &change.key_json)?;
        require(
            previous.as_ref().map(|r| r.1.as_str()) == before.as_deref()
                && previous
                    .as_ref()
                    .is_none_or(|r| r.0 == change.canonical_rowid),
            "Une écriture reçue ne correspond pas à la référence canonique.",
        )?;
        if let Some(after) = &after {
            require(
                shared_id(c, &change.table, after)?.is_none_or(|id| id == change.canonical_rowid),
                "Une séquence reçue ne correspond pas à sa position partagée.",
            )?;
        }
        let e = Event {
            sequence: count as i64,
            transaction_id: String::new(),
            table: change.table,
            key: change.key_json,
            before,
            after,
            rowid: change.canonical_rowid,
            sha: String::new(),
        };
        c.execute(
            "INSERT INTO remote_changes VALUES(?1,?2,?3,?4,?5,?6)",
            params![e.sequence, e.table, e.key, e.rowid, e.before, e.after],
        )?;
        put(c, "canonical_rows", &e, e.after.as_deref(), e.rowid)?;
    }
    require(
        count > 0 && fingerprint(c, "canonical_rows")? == context.target_state_sha256,
        "Les écritures reçues ne produisent pas l’empreinte de la révision annoncée.",
    )
}
fn check_acknowledgement(c: &Connection, ack: &Acknowledgement) -> AppResult<()> {
    let first: Option<String> = c
        .query_row(
            "SELECT transaction_id FROM pending_changes ORDER BY sequence LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let range: (Option<i64>, Option<i64>, i64) = c.query_row(
        "SELECT MIN(sequence),MAX(sequence),COUNT(*) FROM pending_changes WHERE transaction_id=?1",
        [&ack.transaction_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    require(
        first.as_ref() == Some(&ack.transaction_id)
            && range
                == (
                    Some(ack.first_sequence),
                    Some(ack.last_sequence),
                    ack.change_count as i64,
                ),
        "Le reçu ne confirme pas la première transaction locale complète.",
    )
}
pub(super) fn prepare(
    store: &LocalStore,
    source: &Connection,
    context: &Context,
    capture: &str,
    cache: Option<&Path>,
    acknowledgement: Option<&Acknowledgement>,
    remote: impl IntoIterator<Item = AppResult<RowChange>>,
) -> AppResult<Model> {
    prepare_with_choices(
        store,
        source,
        context,
        capture,
        cache,
        acknowledgement,
        remote,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_with_choices(
    store: &LocalStore,
    source: &Connection,
    context: &Context,
    capture: &str,
    cache: Option<&Path>,
    acknowledgement: Option<&Acknowledgement>,
    remote: impl IntoIterator<Item = AppResult<RowChange>>,
    choices: Option<&std::collections::BTreeMap<String, super::resolution::Choice>>,
) -> AppResult<Model> {
    let directory = crate::business_sync::workspace::Workspace::new(store, "reconciliation-model")?;
    let mut c = Connection::open(directory.path().join("model.sqlite"))?;
    c.pragma_update(None, "temp_store", "FILE")?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for name in [
        "current_rows",
        "source_rows",
        "canonical_rows",
        "merged_rows",
    ] {
        row_table(&tx, name)?;
    }
    tx.execute_batch("CREATE TABLE pending_changes(sequence INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,before_json TEXT,after_json TEXT,source_rowid INTEGER NOT NULL,original_sha256 TEXT NOT NULL);
        CREATE TABLE current_aliases(sequence INTEGER PRIMARY KEY,canonical_rowid INTEGER NOT NULL);
        CREATE TABLE verified_aliases(sequence INTEGER PRIMARY KEY,canonical_rowid INTEGER NOT NULL);
        CREATE TABLE shared_aliases(table_name TEXT PRIMARY KEY,column_name TEXT NOT NULL);
        CREATE TABLE remote_changes(position INTEGER PRIMARY KEY,table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,before_json TEXT,after_json TEXT);
        CREATE TABLE planned_changes(position INTEGER PRIMARY KEY,table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,before_json TEXT,after_json TEXT);
        CREATE TABLE row_aliases(capture_generation TEXT NOT NULL,sequence INTEGER NOT NULL,original_sha256 TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,PRIMARY KEY(capture_generation,sequence));
        CREATE TABLE overlay_transactions(position INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL);
        CREATE TABLE conflicting_transactions(transaction_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,expected_json TEXT,current_json TEXT,incoming_json TEXT);")?;
    aliases_from_native(source, &tx)?;
    rows_from_native(source, &tx)?;
    let current_sha256 = fingerprint(&tx, "current_rows")?;
    let (journal_sha256, pending_count) = load_pending(
        source,
        &tx,
        &context.organization,
        &store.installation_id,
        capture,
        context.base_revision,
    )?;
    require(
        pending_count > 0,
        "Aucune modification locale n’attend de réconciliation.",
    )?;
    if let Some(cache) = cache {
        load_cache(&tx, cache, capture)?;
    } else {
        reverse_pending(&tx)?;
    }
    require(fingerprint(&tx,"source_rows")?==context.source_state_sha256,"La référence locale ne correspond pas au serveur. Il faut récupérer la révision canonique avant de continuer.")?;
    verify_working(&tx, &current_sha256)?;
    if let Some(ack) = acknowledgement {
        check_acknowledgement(&tx, ack)?;
    }
    apply_remote(&tx, context, remote)?;
    tx.execute("INSERT INTO merged_rows SELECT * FROM canonical_rows", [])?;
    let ids=tx.prepare("SELECT transaction_id FROM pending_changes GROUP BY transaction_id ORDER BY MIN(sequence)")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if let Some(choices) = choices {
        let pending_ids = ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
        require(
            choices.keys().all(|id| {
                pending_ids.contains(id.as_str())
                    && acknowledgement.is_none_or(|ack| ack.transaction_id != *id)
            }),
            "Un choix ne correspond plus à une transaction locale en attente.",
        )?;
    }
    let mut conflicts = Vec::new();
    let mut conflict_count = 0;
    for id in ids {
        if acknowledgement.is_some_and(|ack| ack.transaction_id == id) {
            continue;
        }
        if choices.and_then(|c| c.get(&id)) == Some(&super::resolution::Choice::Shared) {
            continue;
        }
        let before_sha256 = fingerprint(&tx, "merged_rows")?;
        tx.execute_batch("SAVEPOINT local_overlay")?;
        let mut query =
            tx.prepare("SELECT * FROM pending_changes WHERE transaction_id=?1 ORDER BY sequence")?;
        let mut rows = query.query([&id])?;
        let mut conflict = None;
        let mut applied = false;
        while let Some(r) = rows.next()? {
            let mut e = event(r)?;
            if choices.and_then(|c| c.get(&id)) == Some(&super::resolution::Choice::Local) {
                // The preview uses the selected local image against the actual
                // canonical row. Only this disposable model changes: journal
                // events and ordinary outgoing envelopes remain immutable.
                e.before = row(&tx, "merged_rows", &e.table, &e.key)?.map(|r| r.1);
                if e.before == e.after {
                    continue;
                }
            }
            if let Some(found) = apply_local(&tx, &e, false)? {
                let current = row(&tx, "merged_rows", &e.table, &e.key)?.map(|r| r.1);
                conflict = Some((found, e.before, current, e.after));
                break;
            }
            tx.execute("INSERT INTO row_aliases SELECT ?1,?2,?3,canonical_rowid FROM planned_changes WHERE position=?2",params![capture,e.sequence,e.sha])?;
            applied = true;
        }
        drop(rows);
        drop(query);
        if let Some((found, before, current, after)) = conflict {
            tx.execute_batch("ROLLBACK TO local_overlay")?;
            tx.execute(
                "INSERT INTO conflicting_transactions VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    found.transaction_id,
                    found.sequence,
                    found.table,
                    found.key_json,
                    before,
                    current,
                    after
                ],
            )?;
            conflict_count += 1;
            if conflicts.len() < 20 {
                conflicts.push(found);
            }
        } else if applied {
            tx.execute("INSERT INTO overlay_transactions(transaction_id,source_sha256,target_sha256) VALUES(?1,?2,?3)",params![id,before_sha256,fingerprint(&tx,"merged_rows")?])?;
        }
        tx.execute_batch("RELEASE local_overlay")?;
    }
    let merged_sha256 = if conflict_count == 0 {
        Some(fingerprint(&tx, "merged_rows")?)
    } else {
        None
    };
    tx.commit()?;
    Ok(Model {
        connection: c,
        current_sha256,
        canonical_sha256: context.target_state_sha256.clone(),
        merged_sha256,
        journal_sha256,
        pending_count,
        conflict_count,
        conflicts,
        _directory: directory,
    })
}

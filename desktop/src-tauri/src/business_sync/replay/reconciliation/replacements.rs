//! Build actual replacement journals in a disposable copy. Originals remain
//! byte-for-byte in business_sync_changes, under their old capture generation.
//! This does NOT retire server transactions, freeze or install the live profile.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::business_sync::replay) struct Original {
    pub transaction_id: String,
    pub first_sequence: String,
    pub last_sequence: String,
    pub original_sha256: String,
    pub choice: String,
    pub replacement_transaction_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::business_sync::replay) struct Transaction {
    pub transaction_id: String,
    pub original_transaction_id: String,
    pub first_sequence: String,
    pub last_sequence: String,
    pub changes: Vec<RowChange>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::business_sync::replay) struct Plan {
    pub version: u32,
    pub resolution_id: String,
    pub original_capture_generation: String,
    pub replacement_capture_generation: String,
    pub base_revision: i64,
    pub decision_sha256: String,
    pub occurred_at: String,
    pub original_journal_sha256: String,
    pub canonical_state_sha256: String,
    pub replacement_state_sha256: String,
    pub originals: Vec<Original>,
    pub transactions: Vec<Transaction>,
}

pub(in crate::business_sync::replay) struct Replacement {
    copy: native::Copy,
    pub plan: Plan,
}
impl Replacement {
    pub fn store(&self) -> &LocalStore {
        &self.copy.store
    }
}

// UUIDv4 input carries entropy; domain-separated hashes give stable, distinct
// UUIDs on recovery without storing or sending an authentication credential.
fn identity(resolution: &str, purpose: &str, original: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"zentra-business-replacement-identity-v1\0");
    for part in [resolution, purpose, original] {
        frame(&mut hash, part.as_bytes());
    }
    let digest = hash.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn apply_model(c: &Connection, row: &RowChange) -> AppResult<()> {
    let before: Option<(i64, String)> = c.query_row("SELECT canonical_rowid,row_json FROM replacement_rows WHERE table_name=?1 AND row_key_json=?2",
        params![row.table,row.key_json], |r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if before.as_ref().map(|r| r.1.as_str()) != row.before_json.as_deref()
        || before.as_ref().is_some_and(|r| r.0 != row.canonical_rowid)
    {
        return Err(invalid(
            "Les opérations de remplacement ne suivent plus les choix vérifiés.",
        ));
    }
    if let Some(after) = &row.after_json {
        c.execute("INSERT INTO replacement_rows VALUES(?1,?2,?3,?4) ON CONFLICT(table_name,row_key_json) DO UPDATE SET canonical_rowid=excluded.canonical_rowid,row_json=excluded.row_json", params![row.table,row.key_json,row.canonical_rowid,after])?;
    } else {
        c.execute(
            "DELETE FROM replacement_rows WHERE table_name=?1 AND row_key_json=?2",
            params![row.table, row.key_json],
        )?;
    }
    Ok(())
}

fn audit(
    c: &Connection,
    id: &str,
    occurred_at: &str,
    resolution: &str,
    payload: Value,
) -> AppResult<RowChange> {
    let previous: Option<String> = c.query_row("SELECT json_extract(row_json,'$.entry_hash') FROM replacement_rows WHERE table_name='audit_log' ORDER BY canonical_rowid DESC LIMIT 1",[],|r|r.get(0)).optional()?;
    let rowid: i64 = c.query_row("SELECT COALESCE(MAX(canonical_rowid),0)+1 FROM replacement_rows WHERE table_name='audit_log'",[],|r|r.get(0))?;
    let payload_json = serde_json::to_string(&payload)?;
    let material = format!("{}\n{id}\n{occurred_at}\nlocal_user\nsync.conflict_resolution\nbusiness_sync_resolution\n{resolution}\n{payload_json}", previous.as_deref().unwrap_or(""));
    let raw = serde_json::json!({"id":id,"occurred_at":occurred_at,"actor":"local_user","action":"sync.conflict_resolution","entity_type":"business_sync_resolution","entity_id":resolution,"payload_json":payload_json,"previous_hash":previous,"entry_hash":format!("{:x}",Sha256::digest(material.as_bytes()))}).to_string();
    let key = serde_json::json!([id]).to_string();
    let raw = normalize(c, &policy()?.tables["audit_log"], &key, &raw)?;
    Ok(RowChange {
        table: "audit_log".into(),
        key_json: key,
        canonical_rowid: rowid,
        before_json: None,
        after_json: Some(raw),
    })
}

pub(in crate::business_sync::replay) fn prepare(
    prepared: &Prepared,
    store: &LocalStore,
    resolution_id: &str,
    preview: &Value,
    occurred_at: &str,
) -> AppResult<Replacement> {
    build(prepared, store, resolution_id, preview, occurred_at, true)
}

pub(super) fn preview_copy(
    prepared: &mut Prepared,
    store: &LocalStore,
    preview: &Value,
) -> AppResult<native::Copy> {
    let id = identity(
        preview["review_id"].as_str().unwrap_or(""),
        "preview",
        preview["decision_sha256"].as_str().unwrap_or(""),
    );
    let occurred_at:String=prepared.rows().query_row("SELECT COALESCE(MAX(json_extract(row_json,'$.occurred_at')),'1970-01-01T00:00:00Z') FROM current_rows WHERE table_name='audit_log'",[],|r|r.get(0))?;
    let result = build(prepared, store, &id, preview, &occurred_at, false)?;
    prepared.model.connection.execute_batch("DELETE FROM merged_rows WHERE table_name='audit_log'; INSERT INTO merged_rows SELECT * FROM replacement_rows WHERE table_name='audit_log';")?;
    prepared.model.merged_sha256 = Some(result.plan.replacement_state_sha256);
    Ok(result.copy)
}

fn build(
    prepared: &Prepared,
    store: &LocalStore,
    resolution_id: &str,
    preview: &Value,
    occurred_at: &str,
    capture_journal: bool,
) -> AppResult<Replacement> {
    if uuid::Uuid::parse_str(resolution_id).is_err()
        || chrono::DateTime::parse_from_rfc3339(occurred_at).is_err()
        || preview["state"] != "resolution_preview"
    {
        return Err(invalid(
            "La proposition ne permet pas de préparer ses remplacements.",
        ));
    }
    let mut connection = store.connect()?;
    let source = connection.transaction()?;
    let (organization, capture, generation, revision):(String,String,String,i64) = source.query_row("SELECT b.organization_id,b.generation,h.server_generation,COALESCE(c.revision,1) FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id LEFT JOIN business_sync_cursor c ON c.id=b.id WHERE b.id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let context = Context {
        fingerprint_version: STATE_FINGERPRINT_VERSION,
        organization: organization.clone(),
        generation,
        base_revision: revision,
        source_state_sha256: fingerprint(&prepared.model.connection, "source_rows")?,
        target_state_sha256: prepared.model.canonical_sha256.clone(),
    };
    prepared.verify_live(&source, store, &context)?;
    let copy = native::copy_source(store, &source)?;
    native::load_canonical(&copy, &prepared.model)?;
    let mut native = copy.store.connect()?;
    {
        let tx = native.transaction()?;
        let mut q = prepared.rows().prepare("SELECT table_name,row_key_json,canonical_rowid,before_json,after_json FROM remote_changes ORDER BY position")?;
        let remote = q
            .query_map([], |r| {
                Ok(RowChange {
                    table: r.get(0)?,
                    key_json: r.get(1)?,
                    canonical_rowid: r.get(2)?,
                    before_json: r.get(3)?,
                    after_json: r.get(4)?,
                })
            })?
            .map(|r| r.map_err(Into::into));
        apply_checked_rows(&tx, &copy.store, &context, remote)?;
        tx.execute("INSERT INTO business_sync_cursor VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",params![context.organization,context.generation,revision+1])?;
        tx.commit()?;
    }
    let c = prepared.rows();
    c.execute_batch("DROP TABLE IF EXISTS temp.replacement_rows; CREATE TEMP TABLE replacement_rows(table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,canonical_rowid INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(table_name,row_key_json),UNIQUE(table_name,canonical_rowid)); INSERT INTO replacement_rows SELECT * FROM canonical_rows;")?;
    let mut plan = Plan {
        version: 1,
        resolution_id: resolution_id.into(),
        original_capture_generation: capture.clone(),
        replacement_capture_generation: identity(resolution_id, "capture", &capture),
        base_revision: revision + 1,
        decision_sha256: preview["decision_sha256"]
            .as_str()
            .ok_or_else(|| invalid("La preuve des choix est absente."))?
            .into(),
        occurred_at: occurred_at.into(),
        original_journal_sha256: prepared.model.journal_sha256.clone(),
        canonical_state_sha256: context.target_state_sha256.clone(),
        replacement_state_sha256: String::new(),
        originals: vec![],
        transactions: vec![],
    };
    let originals = c.prepare("SELECT transaction_id,MIN(sequence),MAX(sequence) FROM pending_changes GROUP BY transaction_id ORDER BY MIN(sequence)")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (original, first, last) in originals {
        if preview["confirmed_transaction_id"].as_str() == Some(&original) {
            continue;
        }
        let mut hash = Sha256::new();
        hash.update(b"zentra-business-original-transaction-v1\0");
        let mut q=c.prepare("SELECT sequence,original_sha256 FROM pending_changes WHERE transaction_id=?1 ORDER BY sequence")?;
        let mut rows = q.query([&original])?;
        while let Some(row) = rows.next()? {
            frame(&mut hash, row.get::<_, i64>(0)?.to_string().as_bytes());
            frame(&mut hash, row.get::<_, String>(1)?.as_bytes());
        }
        let original_sha256 = format!("{:x}", hash.finalize());
        let selected = preview["decisions"][&original]
            .as_str()
            .unwrap_or("automatic");
        let overlay: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM overlay_transactions WHERE transaction_id=?1)",
            [&original],
            |r| r.get(0),
        )?;
        let replacement_id = overlay.then(|| identity(resolution_id, "transaction", &original));
        plan.originals.push(Original {
            transaction_id: original.clone(),
            first_sequence: first.to_string(),
            last_sequence: last.to_string(),
            original_sha256: original_sha256.clone(),
            choice: selected.into(),
            replacement_transaction_id: replacement_id.clone(),
        });
        let Some(transaction_id) = replacement_id else {
            continue;
        };
        if selected == "shared" {
            return Err(invalid(
                "Une opération écartée figure encore dans les remplacements.",
            ));
        }
        let before = fingerprint(c, "replacement_rows")?;
        let mut changes=c.prepare("SELECT p.table_name,p.row_key_json,p.canonical_rowid,p.before_json,p.after_json FROM planned_changes p JOIN pending_changes o ON o.sequence=p.position WHERE o.transaction_id=?1 AND p.table_name<>'audit_log' ORDER BY p.position")?.query_map([&original],|r|Ok(RowChange {table:r.get(0)?,key_json:r.get(1)?,canonical_rowid:r.get(2)?,before_json:r.get(3)?,after_json:r.get(4)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let changes_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&changes)?));
        for row in &changes {
            apply_model(c, row)?;
        }
        let audit = audit(
            c,
            &identity(resolution_id, "audit", &original),
            occurred_at,
            resolution_id,
            serde_json::json!({"original_capture_generation":capture,"original_transaction_id":original,"original_first_sequence":first.to_string(),"original_last_sequence":last.to_string(),"original_sha256":original_sha256,"choice":selected,"decision_sha256":plan.decision_sha256,"changes_sha256":changes_sha256}),
        )?;
        apply_model(c, &audit)?;
        changes.push(audit);
        let local = Context {
            fingerprint_version: STATE_FINGERPRINT_VERSION,
            organization: organization.clone(),
            generation: context.generation.clone(),
            base_revision: revision + 1,
            source_state_sha256: before,
            target_state_sha256: fingerprint(c, "replacement_rows")?,
        };
        let tx = native.transaction()?;
        apply_checked_rows(&tx, &copy.store, &local, changes.iter().cloned().map(Ok))?;
        tx.commit()?;
        plan.transactions.push(Transaction {
            transaction_id,
            original_transaction_id: original,
            first_sequence: String::new(),
            last_sequence: String::new(),
            changes,
        });
    }
    let changed:i64=c.query_row("SELECT COUNT(*) FROM (SELECT table_name,row_key_json,canonical_rowid,row_json FROM merged_rows WHERE table_name<>'audit_log' EXCEPT SELECT table_name,row_key_json,canonical_rowid,row_json FROM replacement_rows WHERE table_name<>'audit_log')",[],|r|r.get(0))?;
    let extra:i64=c.query_row("SELECT COUNT(*) FROM (SELECT table_name,row_key_json,canonical_rowid,row_json FROM replacement_rows WHERE table_name<>'audit_log' EXCEPT SELECT table_name,row_key_json,canonical_rowid,row_json FROM merged_rows WHERE table_name<>'audit_log')",[],|r|r.get(0))?;
    if changed != 0 || extra != 0 {
        return Err(invalid(
            "Les remplacements modifieraient d’autres données que les choix vérifiés.",
        ));
    }
    drop(native);
    native::restore_local(&copy, &prepared.original_local_sha256)?;
    let mut native = copy.store.connect()?;
    if native::internal_fingerprint(&native)? != prepared.original_internal_sha256 {
        return Err(invalid(
            "Une preuve originale a changé pendant la préparation.",
        ));
    }
    let tx = native.transaction()?;
    if capture_journal {
        tx.execute(
            "UPDATE business_sync_binding SET generation=?1 WHERE id=1",
            [&plan.replacement_capture_generation],
        )?;
        for replacement in &mut plan.transactions {
            for (index, row) in replacement.changes.iter().enumerate() {
                let operation = if row.before_json.is_none() {
                    "insert"
                } else if row.after_json.is_none() {
                    "delete"
                } else {
                    "update"
                };
                tx.execute("INSERT INTO business_sync_changes(generation,transaction_id,organization_id,installation_id,table_name,row_key_json,operation,before_json,after_json,source_rowid,base_revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![plan.replacement_capture_generation,replacement.transaction_id,organization,store.installation_id,row.table,row.key_json,operation,row.before_json,row.after_json,row.canonical_rowid.to_string(),revision+1])?;
                let sequence = tx.last_insert_rowid().to_string();
                if index == 0 {
                    replacement.first_sequence = sequence.clone();
                }
                replacement.last_sequence = sequence;
            }
        }
    }
    plan.replacement_state_sha256 = state_fingerprint(&tx)?;
    if plan.replacement_state_sha256 != fingerprint(c, "replacement_rows")? {
        return Err(invalid("La copie ne reproduit pas les remplacements."));
    }
    crate::audit::verify_audit_chain(&tx)?;
    tx.commit()?;
    native.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(Replacement { copy, plan })
}

//! Private local transport journal, not business evidence or remote authority.
//! Callers already own LocalStore's mutex/origin gate. No IPC or network here.
use crate::{
    action_engine_quote::{frozen_quote_publication_matches, ActionEngineQuoteReceipt},
    cloud_backup::Manifest,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

const SQL: &str = include_str!("action_engine_quote_publication_schema.sql");
const TABLE: &str = "company_local_action_engine_quote_publications";
const MARKER: &str = "company_local_action_engine_publication_schema";
const MAX_CANDIDATES: usize = 1000;
const MAX_RETAINED_LINKS: usize = 10000;

fn invalid() -> AppError {
    AppError::Validation(
        "La publication du devis Automation doit être vérifiée. Vos données sont conservées."
            .into(),
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn identifier(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}

/// Private housekeeping only; works after installation and archive restore.
/// No shared schema/clock or PRAGMA user_version is changed.
pub(crate) fn ensure_schema(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(SQL)?;
    let version: i64 = connection.query_row(
        "SELECT version FROM company_local_action_engine_publication_schema WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    if version != 1 {
        return Err(invalid());
    }
    Ok(())
}

/// Called on outgoing snapshots and incoming archives, before private rows are
/// restored from THIS installation. Foreign/local recovery links never travel.
pub(crate) fn strip_private(connection: &Connection) -> AppResult<()> {
    for table in [TABLE, MARKER] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            [table],
            |row| row.get(0),
        )?;
        if exists {
            connection.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutboxPayload {
    organization_id: String,
    proposal_id: String,
    reservation_id: String,
    fingerprint: String,
    customer_id: String,
    quote_id: String,
    receipt_sha256: String,
}
#[derive(Debug, PartialEq, Eq)]
struct Outbox {
    organization: String,
    source: String,
    proposal: String,
    reservation: String,
    fingerprint: String,
    user: String,
    installation: String,
    customer: String,
    quote: String,
    receipt_sha: String,
    receipt_json: String,
    payload_json: String,
    payload_sha: String,
    plan_json: String,
    state: String,
}
fn outboxes(connection: &Connection, organization: &str) -> AppResult<Vec<Outbox>> {
    let mut q = connection.prepare(
        "SELECT o.organization_id,r.source_id,o.proposal_id,r.reservation_id,o.fingerprint,
          r.actor_user_id,r.installation_id,r.customer_id,o.quote_id,r.receipt_sha256,
          r.receipt_json,o.payload_json,o.payload_sha256,r.plan_json,o.state
         FROM company_local_action_engine_quote_outbox o
         JOIN action_engine_quote_receipts r ON r.organization_id=o.organization_id AND r.proposal_id=o.proposal_id
         WHERE o.organization_id=? AND o.state<>'confirmed' ORDER BY o.proposal_id COLLATE BINARY LIMIT 1001",
    )?;
    let rows = q
        .query_map([organization], |r| {
            Ok(Outbox {
                organization: r.get(0)?,
                source: r.get(1)?,
                proposal: r.get(2)?,
                reservation: r.get(3)?,
                fingerprint: r.get(4)?,
                user: r.get(5)?,
                installation: r.get(6)?,
                customer: r.get(7)?,
                quote: r.get(8)?,
                receipt_sha: r.get(9)?,
                receipt_json: r.get(10)?,
                payload_json: r.get(11)?,
                payload_sha: r.get(12)?,
                plan_json: r.get(13)?,
                state: r.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() > MAX_CANDIDATES {
        return Err(invalid());
    }
    // A missing receipt is corruption, never an absence fallback/no-op.
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM company_local_action_engine_quote_outbox WHERE organization_id=? AND state<>'confirmed'",
        [organization], |r| r.get(0),
    )?;
    if count != rows.len() as i64 {
        return Err(invalid());
    }
    for row in &rows {
        if row.payload_json.len() > 4096
            || row.receipt_json.len() > 4096
            || row.plan_json.len() > 65536
        {
            return Err(invalid());
        }
        let payload: OutboxPayload =
            serde_json::from_str(&row.payload_json).map_err(|_| invalid())?;
        let receipt: ActionEngineQuoteReceipt =
            serde_json::from_str(&row.receipt_json).map_err(|_| invalid())?;
        if hash(row.payload_json.as_bytes()) != row.payload_sha
            || hash(row.receipt_json.as_bytes()) != row.receipt_sha
            || hash(row.plan_json.as_bytes()) != row.fingerprint
            || payload.organization_id != row.organization
            || payload.proposal_id != row.proposal
            || payload.reservation_id != row.reservation
            || payload.fingerprint != row.fingerprint
            || payload.customer_id != row.customer
            || payload.quote_id != row.quote
            || payload.receipt_sha256 != row.receipt_sha
            || receipt.organization_id != row.organization
            || receipt.proposal_id != row.proposal
            || receipt.fingerprint != row.fingerprint
            || receipt.customer_id != row.customer
            || receipt.quote_id != row.quote
            || receipt.quote_number.is_some()
            || receipt.status != "draft"
            || !receipt.requires_human_validation
            || !matches!(row.state.as_str(), "pending" | "uncertain")
        {
            return Err(invalid());
        }
        for id in [
            &row.organization,
            &row.source,
            &row.proposal,
            &row.user,
            &row.customer,
        ] {
            identifier(id)?;
        }
        for id in [&row.reservation, &row.installation, &row.quote] {
            crate::cloud_backup::validate_id(id)?;
        }
    }
    Ok(rows)
}

fn same_archive(actual: &Manifest, expected: &Manifest) -> bool {
    actual.sha256 == expected.sha256
        && actual.size_bytes == expected.size_bytes
        && actual.chunks == expected.chunks
}
fn archive_path(store: &LocalStore, snapshot: &str) -> AppResult<std::path::PathBuf> {
    crate::cloud_backup::validate_id(snapshot)?;
    Ok(store
        .data_dir
        .join("company-sync")
        .join(format!("{snapshot}.zentra")))
}
fn validate_candidate(
    organization: &str,
    snapshot: &str,
    base: u64,
    clock: i64,
    manifest: &Manifest,
) -> AppResult<String> {
    identifier(organization)?;
    crate::cloud_backup::validate_id(snapshot)?;
    manifest.validate()?;
    if base > 9_007_199_254_740_990 || !(0..=9_007_199_254_740_991).contains(&clock) {
        return Err(invalid());
    }
    let encoded = serde_json::to_string(manifest)?;
    if encoded.len() > 65536 {
        return Err(invalid());
    }
    Ok(encoded)
}
fn require_archive(path: &Path, manifest: &Manifest) -> AppResult<()> {
    let actual = crate::cloud_backup::file_manifest(path)?;
    if !same_archive(&actual, manifest) {
        return Err(invalid());
    }
    Ok(())
}

fn current_publisher(connection: &Connection, organization: &str) -> AppResult<Option<String>> {
    let user: Option<String> = connection
        .query_row(
            "SELECT user_id FROM company_local_identity WHERE id=1 AND organization_id=?",
            [organization],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(user) = &user {
        identifier(user)?;
    }
    Ok(user)
}

/// Must complete before ANY prepare/upload/commit HTTP for this candidate.
/// Old pending without the receipt, or an already edited/issued draft, creates
/// no link. That is not absence of a business commit and grants no recreation.
pub(crate) fn link_prepared(
    store: &LocalStore,
    organization: &str,
    snapshot: &str,
    base: u64,
    clock: i64,
    manifest: &Manifest,
) -> AppResult<()> {
    let db = store.connect()?;
    let rows = outboxes(&db, organization)?;
    if rows.is_empty() {
        return Ok(());
    } // Ordinary sync stays compatible.
    let publisher = current_publisher(&db, organization)?;
    let Some(publisher) = publisher else {
        return Ok(());
    };
    let owned = rows
        .iter()
        .filter(|row| row.user == publisher && row.installation == store.installation_id)
        .collect::<Vec<_>>();
    if owned.is_empty() {
        return Ok(());
    }
    let manifest_json = validate_candidate(organization, snapshot, base, clock, manifest)?;
    let path = archive_path(store, snapshot)?;
    require_archive(&path, manifest)?;
    let extracted = tempfile::Builder::new()
        .prefix(".action-quote-publication-")
        .tempdir_in(&store.data_dir)?;
    store.extract_company_copy(&path, extracted.path())?;
    let frozen = Connection::open_with_flags(
        extracted.path().join("database.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut eligible = Vec::new();
    for row in owned {
        if frozen_quote_publication_matches(
            &frozen,
            &row.organization,
            &row.proposal,
            &row.reservation,
            &row.fingerprint,
            &row.quote,
            &row.receipt_sha,
        )? {
            eligible.push(row);
        }
    }
    require_archive(&path, manifest)?;
    let mut db = store.connect()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if outboxes(&tx, organization)? != rows
        || current_publisher(&tx, organization)?.as_deref() != Some(publisher.as_str())
    {
        return Err(invalid());
    }
    let manifest_sha = hash(manifest_json.as_bytes());
    for row in eligible {
        let expected = json!({"organization_id":row.organization,"source_id":row.source,"action_kind":"prepare_quote_draft",
            "proposal_id":row.proposal,"reservation_id":row.reservation,"fingerprint":row.fingerprint,
            "actor_user_id":row.user,"installation_id":row.installation,"customer_id":row.customer,"quote_id":row.quote,
            "receipt_sha256":row.receipt_sha,"snapshot_id":snapshot,"base_revision":base,"archive_sha256":manifest.sha256,
            "manifest_sha256":manifest_sha,"manifest_json":manifest_json,"size_bytes":manifest.size_bytes,"local_clock":clock});
        let existing = query_all(&tx,
            "SELECT organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,actor_user_id,installation_id,
             customer_id,quote_id,receipt_sha256,snapshot_id,base_revision,archive_sha256,manifest_sha256,manifest_json,size_bytes,local_clock
             FROM company_local_action_engine_quote_publications WHERE organization_id=? AND proposal_id=? AND snapshot_id=?",
            params![organization, row.proposal, snapshot])?;
        if !existing.is_empty() {
            if existing.as_slice() != std::slice::from_ref(&expected) {
                return Err(invalid());
            }
            continue;
        }
        tx.execute("INSERT INTO company_local_action_engine_quote_publications
            (organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,actor_user_id,installation_id,
             customer_id,quote_id,receipt_sha256,snapshot_id,base_revision,archive_sha256,manifest_sha256,manifest_json,size_bytes,local_clock,created_at)
            VALUES(?,?,'prepare_quote_draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![organization,row.source,row.proposal,row.reservation,row.fingerprint,row.user,row.installation,row.customer,row.quote,
                row.receipt_sha,snapshot,base as i64,manifest.sha256,manifest_sha,manifest_json,manifest.size_bytes as i64,clock,now_iso()])?;
    }
    tx.commit()?;
    Ok(())
}

/// Transport ACK only. It never confirms the Action Engine outbox or receipt.
/// Persist before clearing preferences/cleaning, so a crash replays the same ACK.
pub(crate) fn mark_published(
    store: &LocalStore,
    organization: &str,
    snapshot: &str,
    base: u64,
    manifest: &Manifest,
    revision: u64,
) -> AppResult<()> {
    let mut db = store.connect()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(publisher) = current_publisher(&tx, organization)? else {
        tx.commit()?;
        return Ok(());
    };
    let existing = query_all(&tx,
        "SELECT base_revision,manifest_json,manifest_sha256,archive_sha256,size_bytes,published_revision
         FROM company_local_action_engine_quote_publications WHERE organization_id=? AND snapshot_id=? AND actor_user_id=? AND installation_id=?",
        params![organization,snapshot,publisher,store.installation_id])?;
    if existing.is_empty() {
        tx.commit()?;
        return Ok(());
    }
    let manifest_json = validate_candidate(organization, snapshot, base, 0, manifest)?;
    if revision != base.checked_add(1).ok_or_else(invalid)? {
        return Err(invalid());
    }
    for row in &existing {
        if row["base_revision"].as_u64() != Some(base)
            || row["manifest_json"].as_str() != Some(&manifest_json)
            || row["manifest_sha256"].as_str() != Some(&hash(manifest_json.as_bytes()))
            || row["archive_sha256"].as_str() != Some(&manifest.sha256)
            || row["size_bytes"].as_u64() != Some(manifest.size_bytes)
            || (!row["published_revision"].is_null()
                && row["published_revision"].as_u64() != Some(revision))
        {
            return Err(invalid());
        }
    }
    tx.execute("UPDATE company_local_action_engine_quote_publications SET published_revision=?,published_at=?
        WHERE organization_id=? AND snapshot_id=? AND actor_user_id=? AND installation_id=? AND published_revision IS NULL",
        params![revision as i64,now_iso(),organization,snapshot,publisher,store.installation_id])?;
    tx.commit()?;
    Ok(())
}

/// Pin every exact candidate until canonical confirmation, regardless of which
/// snapshot preferences currently call pending or which newer head was received.
pub(crate) fn retained_snapshot_ids(connection: &Connection) -> AppResult<Vec<String>> {
    let mut q = connection.prepare("SELECT p.snapshot_id,o.state FROM company_local_action_engine_quote_publications p
        LEFT JOIN company_local_action_engine_quote_outbox o ON o.organization_id=p.organization_id AND o.proposal_id=p.proposal_id
        ORDER BY p.snapshot_id COLLATE BINARY LIMIT 10001")?;
    let rows = q
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() > MAX_RETAINED_LINKS {
        return Err(invalid());
    }
    let mut ids = BTreeSet::new();
    for (id, state) in rows {
        crate::cloud_backup::validate_id(&id)?;
        match state.as_deref() {
            Some("pending" | "uncertain") => {
                ids.insert(id);
            }
            Some("confirmed") => {}
            _ => return Err(invalid()), // An orphan/failure must never erase a pin.
        }
    }
    Ok(ids.into_iter().collect())
}

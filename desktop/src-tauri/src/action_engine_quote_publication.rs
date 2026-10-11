//! Private local transport journal, not business evidence or remote authority.
//! Preparation hooks already own LocalStore's mutex/origin gate. The A10 read
//! and confirmation methods below own their mutex and transaction. No IPC/net.
use crate::{
    action_engine_quote::{
        frozen_quote_publication_matches, recover_action_engine_quote_receipt_in_transaction,
        require_local_quote_origin, ActionEngineLocalQuoteOutboxState, ActionEngineQuoteActor,
        ActionEngineQuoteReceipt, ActionEngineQuoteRecoverySelection,
        ActionEngineRecoveredQuote,
    },
    cloud_backup::Manifest,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

const SQL: &str = include_str!("action_engine_quote_publication_schema.sql");
const CONFIRMATION_SQL: &str = include_str!("action_engine_quote_confirmation_schema.sql");
const TABLE: &str = "company_local_action_engine_quote_publications";
const CONFIRMATIONS: &str = "company_local_action_engine_quote_confirmations";
const MARKER: &str = "company_local_action_engine_publication_schema";
const MAX_CANDIDATES: usize = 1000;
const MAX_RETAINED_LINKS: usize = 10000;

// Do not INNER JOIN away an orphan, or filter an unexpected actor, installation
// or state into an apparent empty queue. Every selected row is verified below,
// including the extra row used only to signal that recovery must continue.
const RECOVERY_WORK_SQL: &str = r#"
SELECT o.organization_id,o.proposal_id,o.fingerprint,o.state,
       r.source_id,r.reservation_id,r.actor_user_id,r.installation_id
FROM company_local_action_engine_quote_outbox o
LEFT JOIN action_engine_quote_receipts r
  ON r.organization_id=o.organization_id AND r.proposal_id=o.proposal_id
WHERE o.organization_id=? AND o.state<>'confirmed'
ORDER BY o.proposal_id COLLATE BINARY LIMIT ?
"#;

// This is an installation/actor-local history, not the shared company feed.
// Do not join away missing receipt/outbox/candidate evidence: every selected
// marker, including lookahead, is corroborated in the same transaction below.
const ACTIVITY_SQL: &str = r#"
SELECT c.* FROM company_local_action_engine_quote_confirmations c
WHERE c.organization_id=?1 AND c.actor_user_id=?2 AND c.installation_id=?3
  AND c.proposal_id COLLATE BINARY > ?4
ORDER BY c.proposal_id COLLATE BINARY LIMIT ?5
"#;

/// Captured physical/account origin, not a remote admission or write input.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteRecoveryOrigin {
    pub(crate) actor: ActionEngineQuoteActor,
    pub(crate) installation_id: String,
    pub(crate) expected_workspace_scope: String,
    pub(crate) expected_member_context_nonce: String,
}

/// Historical selectors only. has_more means the local queue is not drained:
/// a consumer must continue recovery before discovering any new Support work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionEngineQuoteRecoveryWork {
    pub(crate) selections: Vec<ActionEngineQuoteRecoverySelection>,
    pub(crate) has_more: bool,
}

/// Original, canonically confirmed draft creation. This does not describe the
/// current quote status, grant execution, or assert activity on other devices.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionEngineQuoteActivity {
    pub(crate) organization_id: String,
    pub(crate) proposal_id: String,
    pub(crate) quote_id: String,
    pub(crate) confirmed_at: String,
    pub(crate) kind: &'static str,
    pub(crate) requires_human_validation: bool,
}

/// Keyset pagination is by proposal BINARY, not confirmation chronology. The
/// continuation is for this read only, never a durable notification watermark.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionEngineQuoteActivityPage {
    pub(crate) entries: Vec<ActionEngineQuoteActivity>,
    pub(crate) next_after_proposal_id: Option<String>,
}

fn validate_recovery_work_origin(origin: &ActionEngineQuoteRecoveryOrigin) -> AppResult<()> {
    let local_id = |value: &str| !value.is_empty() && value.len() <= 160
        && value.bytes().enumerate().all(|(index, byte)| byte.is_ascii_alphanumeric()
            || (index > 0 && matches!(byte, b'_' | b'.' | b':' | b'@' | b'-')));
    if !local_id(&origin.actor.organization_id) || !local_id(&origin.actor.user_id)
        || origin.expected_member_context_nonce.len() != 32
        || !origin.expected_member_context_nonce.bytes().all(|byte|
            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(invalid());
    }
    crate::cloud_backup::validate_id(&origin.installation_id).map_err(|_| invalid())?;
    crate::cloud_backup::validate_id(&origin.expected_workspace_scope).map_err(|_| invalid())?;
    Ok(())
}

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
    // Additive private housekeeping; A9's marker and shared schema stay put.
    connection.execute_batch(CONFIRMATION_SQL)?;
    Ok(())
}

/// Called on outgoing snapshots and incoming archives, before private rows are
/// restored from THIS installation. Foreign/local recovery links never travel.
pub(crate) fn strip_private(connection: &Connection) -> AppResult<()> {
    for table in [CONFIRMATIONS, TABLE, MARKER] {
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
    created_at: String,
}
fn outboxes(connection: &Connection, organization: &str) -> AppResult<Vec<Outbox>> {
    let mut q = connection.prepare(
        "SELECT o.organization_id,r.source_id,o.proposal_id,r.reservation_id,o.fingerprint,
          r.actor_user_id,r.installation_id,r.customer_id,o.quote_id,r.receipt_sha256,
          r.receipt_json,o.payload_json,o.payload_sha256,r.plan_json,o.state,o.created_at
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
                created_at: r.get(15)?,
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
            || row.created_at.len() > 40
        {
            return Err(invalid());
        }
        instant(&row.created_at)?;
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
        let mut expected = json!({"organization_id":row.organization,"source_id":row.source,"action_kind":"prepare_quote_draft",
            "proposal_id":row.proposal,"reservation_id":row.reservation,"fingerprint":row.fingerprint,
            "actor_user_id":row.user,"installation_id":row.installation,"customer_id":row.customer,"quote_id":row.quote,
            "receipt_sha256":row.receipt_sha,"snapshot_id":snapshot,"base_revision":base,"archive_sha256":manifest.sha256,
            "manifest_sha256":manifest_sha,"manifest_json":manifest_json,"size_bytes":manifest.size_bytes,"local_clock":clock});
        let existing = query_all(&tx,
            "SELECT organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,actor_user_id,installation_id,
             customer_id,quote_id,receipt_sha256,snapshot_id,base_revision,archive_sha256,manifest_sha256,manifest_json,size_bytes,local_clock,created_at
             FROM company_local_action_engine_quote_publications WHERE organization_id=? AND proposal_id=? AND snapshot_id=?",
            params![organization, row.proposal, snapshot])?;
        let created_at = if existing.is_empty() {
            now_iso()
        } else {
            let at = text(&existing[0], "created_at", 40)?.to_owned();
            expected["created_at"] = json!(at);
            if existing.as_slice() != std::slice::from_ref(&expected) {
                return Err(invalid());
            }
            at
        };
        // A clock rollback must not create or replay a link that the confirmed
        // activity reader will later reject as preceding its local creation.
        if instant(&created_at)? < instant(&row.created_at)? {
            return Err(invalid());
        }
        if !existing.is_empty() {
            continue;
        }
        tx.execute("INSERT INTO company_local_action_engine_quote_publications
            (organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,actor_user_id,installation_id,
             customer_id,quote_id,receipt_sha256,snapshot_id,base_revision,archive_sha256,manifest_sha256,manifest_json,size_bytes,local_clock,created_at)
            VALUES(?,?,'prepare_quote_draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![organization,row.source,row.proposal,row.reservation,row.fingerprint,row.user,row.installation,row.customer,row.quote,
                row.receipt_sha,snapshot,base as i64,manifest.sha256,manifest_sha,manifest_json,manifest.size_bytes as i64,clock,created_at])?;
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
        "SELECT base_revision,manifest_json,manifest_sha256,archive_sha256,size_bytes,published_revision,created_at,published_at
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
    let at = now_iso();
    let published_at = instant(&at)?;
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
        let created_at = instant(text(row, "created_at", 40)?)?;
        if row["published_revision"].is_null() {
            if !row["published_at"].is_null() || published_at < created_at { return Err(invalid()); }
        } else if instant(text(row, "published_at", 40)?)? < created_at {
            return Err(invalid());
        }
    }
    tx.execute("UPDATE company_local_action_engine_quote_publications SET published_revision=?,published_at=?
        WHERE organization_id=? AND snapshot_id=? AND actor_user_id=? AND installation_id=? AND published_revision IS NULL",
        params![revision as i64,at,organization,snapshot,publisher,store.installation_id])?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuotePublicationCandidate {
    pub(crate) snapshot_id: String,
    pub(crate) base_revision: u64,
    pub(crate) manifest_sha256: String,
    pub(crate) manifest: Manifest,
    pub(crate) local_clock: i64,
    pub(crate) published_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionEngineQuotePublicationRecovery {
    pub(crate) recovered: ActionEngineRecoveredQuote,
    pub(crate) candidates: Vec<ActionEngineQuotePublicationCandidate>,
    pub(crate) canonical_snapshot_id: Option<String>,
}

/// A successful, authenticated A7 response only; transport publication replies
/// have a different shape and cannot deserialize as this closed confirmation.
/// The private caller must corroborate the real server response, never a model,
/// IPC argument or local transport ACK. These functions establish no admission.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteConfirmation {
    pub(crate) schema_version: u32,
    pub(crate) state: String,
    pub(crate) source_id: String,
    pub(crate) proposal_id: String,
    pub(crate) reservation_id: String,
    pub(crate) publication_snapshot_id: String,
    #[serde(deserialize_with = "confirmation_receipt")]
    pub(crate) receipt: ActionEngineQuoteReceipt,
}

fn confirmation_receipt<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<ActionEngineQuoteReceipt, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RequiredReceipt {
        organization_id: String, proposal_id: String, fingerprint: String,
        customer_id: String, quote_id: String, quote_number: Value,
        status: String, requires_human_validation: bool,
    }
    let receipt = RequiredReceipt::deserialize(deserializer)?;
    if !receipt.quote_number.is_null() {
        return Err(serde::de::Error::custom("A7 draft receipt requires explicit null quoteNumber"));
    }
    Ok(ActionEngineQuoteReceipt {
        organization_id: receipt.organization_id, proposal_id: receipt.proposal_id,
        fingerprint: receipt.fingerprint, customer_id: receipt.customer_id,
        quote_id: receipt.quote_id, quote_number: None, status: receipt.status,
        requires_human_validation: receipt.requires_human_validation,
    })
}

fn text<'a>(row: &'a Value, key: &str, limit: usize) -> AppResult<&'a str> {
    let value = row.get(key).and_then(Value::as_str).ok_or_else(invalid)?;
    if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) { return Err(invalid()); }
    Ok(value)
}
fn integer(row: &Value, key: &str, maximum: u64) -> AppResult<u64> {
    let value = row.get(key).and_then(Value::as_u64).ok_or_else(invalid)?;
    if value > maximum { return Err(invalid()); }
    Ok(value)
}
fn sha_field<'a>(row: &'a Value, key: &str) -> AppResult<&'a str> {
    let value = text(row, key, 64)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(invalid());
    }
    Ok(value)
}
fn instant(value: &str) -> AppResult<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| invalid())
}
struct StoredCandidate {
    candidate: ActionEngineQuotePublicationCandidate,
    created_at: String,
}
fn bounded_record(raw: &rusqlite::Row<'_>) -> AppResult<Value> {
    let mut object = serde_json::Map::new();
    for (index, column) in raw.as_ref().column_names().iter().enumerate() {
        let value = match raw.get_ref(index)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(value) => json!(value),
            rusqlite::types::ValueRef::Text(value) => {
                if value.len() > 65536 { return Err(invalid()); }
                Value::String(std::str::from_utf8(value).map_err(|_| invalid())?.to_owned())
            },
            _ => return Err(invalid()),
        };
        object.insert((*column).to_owned(), value);
    }
    Ok(Value::Object(object))
}
fn retained_text(raw: &rusqlite::Row<'_>, index: usize, maximum: usize, nullable: bool) -> AppResult<Option<String>> {
    match raw.get_ref(index)? {
        rusqlite::types::ValueRef::Null if nullable => Ok(None),
        rusqlite::types::ValueRef::Text(value) if value.len() <= maximum =>
            Ok(Some(std::str::from_utf8(value).map_err(|_| invalid())?.to_owned())),
        _ => Err(invalid()),
    }
}
fn capture_candidate(row: &Value) -> AppResult<StoredCandidate> {
    if row.as_object().is_none_or(|fields| fields.len() != 21) { return Err(invalid()); }
    let snapshot = text(row,"snapshot_id",36)?;
    crate::cloud_backup::validate_id(snapshot)?;
    let base = integer(row,"base_revision",9_007_199_254_740_990)?;
    let local_clock = integer(row,"local_clock",9_007_199_254_740_991)?;
    let manifest_json = text(row,"manifest_json",65536)?;
    let manifest: Manifest = serde_json::from_str(manifest_json).map_err(|_| invalid())?;
    manifest.validate().map_err(|_| invalid())?;
    if serde_json::to_string(&manifest)? != manifest_json
        || hash(manifest_json.as_bytes()) != sha_field(row,"manifest_sha256")?
        || manifest.sha256 != sha_field(row,"archive_sha256")?
        || manifest.size_bytes != integer(row,"size_bytes",536_870_912)? {
        return Err(invalid());
    }
    let created_at = text(row,"created_at",40)?;
    let created = instant(created_at)?;
    let published_revision = if row["published_revision"].is_null() {
        if !row["published_at"].is_null() { return Err(invalid()); }
        None
    } else {
        let revision = integer(row,"published_revision",9_007_199_254_740_991)?;
        if revision != base + 1 || instant(text(row,"published_at",40)?)? < created { return Err(invalid()); }
        Some(revision)
    };
    Ok(StoredCandidate {
        candidate: ActionEngineQuotePublicationCandidate {
            snapshot_id: snapshot.to_owned(), base_revision: base,
            manifest_sha256: sha_field(row,"manifest_sha256")?.to_owned(), manifest,
            local_clock: local_clock as i64, published_revision,
        }, created_at: created_at.to_owned(),
    })
}
fn same_execution(row: &Value, selection: &ActionEngineQuoteRecoverySelection, recovered: &ActionEngineRecoveredQuote) -> AppResult<()> {
    for (key, expected) in [
        ("organization_id", selection.actor.organization_id.as_str()), ("source_id", selection.source_id.as_str()),
        ("action_kind", "prepare_quote_draft"), ("proposal_id", selection.proposal_id.as_str()),
        ("reservation_id", selection.reservation_id.as_str()), ("fingerprint", selection.fingerprint.as_str()),
        ("actor_user_id", selection.actor.user_id.as_str()), ("installation_id", selection.installation_id.as_str()),
        ("customer_id", recovered.receipt.customer_id.as_str()), ("quote_id", recovered.receipt.quote_id.as_str()),
        ("receipt_sha256", recovered.receipt_sha256.as_str()),
    ] {
        if text(row, key, 160)? != expected { return Err(invalid()); }
    }
    Ok(())
}
fn recovery_candidates(connection: &Connection, selection: &ActionEngineQuoteRecoverySelection, recovered: &ActionEngineRecoveredQuote) -> AppResult<Vec<StoredCandidate>> {
    let mut statement = connection.prepare("SELECT * FROM company_local_action_engine_quote_publications
        WHERE organization_id=? AND proposal_id=? ORDER BY snapshot_id COLLATE BINARY LIMIT 1001")?;
    let mut rows = statement.query(params![selection.actor.organization_id,selection.proposal_id])?;
    let mut result = Vec::new();
    let mut manifest_bytes = 0_usize;
    while let Some(raw) = rows.next()? {
        if result.len() >= MAX_CANDIDATES { return Err(invalid()); }
        // Capture only bounded, closed SQLite scalars before publishing facts.
        let row = bounded_record(raw)?;
        same_execution(&row, selection, recovered)?;
        let manifest_json = text(&row,"manifest_json",65536)?;
        manifest_bytes = manifest_bytes.checked_add(manifest_json.len()).ok_or_else(invalid)?;
        if manifest_bytes > 2 * 1024 * 1024 { return Err(invalid()); }
        result.push(capture_candidate(&row)?);
    }
    Ok(result)
}
fn canonical_snapshot(connection: &Connection, selection: &ActionEngineQuoteRecoverySelection, recovered: &ActionEngineRecoveredQuote, candidates: &[StoredCandidate]) -> AppResult<Option<String>> {
    let rows = query_all(connection,"SELECT * FROM company_local_action_engine_quote_confirmations WHERE organization_id=? AND proposal_id=? LIMIT 2",
        params![selection.actor.organization_id,selection.proposal_id])?;
    if rows.is_empty() {
        if recovered.local_outbox_state == ActionEngineLocalQuoteOutboxState::Confirmed { return Err(invalid()); }
        return Ok(None);
    }
    if rows.len() != 1 || rows[0].as_object().is_none_or(|fields| fields.len() != 13)
        || recovered.local_outbox_state != ActionEngineLocalQuoteOutboxState::Confirmed { return Err(invalid()); }
    let row = &rows[0];
    same_execution(row,selection,recovered)?;
    let id = text(row,"snapshot_id",36)?;
    let candidate = candidates.iter().find(|candidate| candidate.candidate.snapshot_id == id).ok_or_else(invalid)?;
    if instant(text(row,"confirmed_at",40)?)? < instant(&candidate.created_at)? { return Err(invalid()); }
    require_confirmed_candidate(connection,&selection.actor.organization_id,&selection.proposal_id,id)?;
    Ok(Some(id.to_owned()))
}

/// Cleanup is not an authenticated recovery read, but may release an archive
/// only after validating the same closed candidate and real timestamps. SQL's
/// structural/lexical guards alone are not a date or canonical-manifest parser.
fn require_confirmed_candidate(connection: &Connection, organization: &str, proposal: &str, snapshot: &str) -> AppResult<()> {
    let mut statement = connection.prepare("SELECT * FROM company_local_action_engine_quote_publications
        WHERE organization_id=? AND proposal_id=? AND snapshot_id=? LIMIT 2")?;
    let mut rows = statement.query(params![organization,proposal,snapshot])?;
    let row = bounded_record(rows.next()?.ok_or_else(invalid)?)?;
    if rows.next()?.is_some() { return Err(invalid()); }
    capture_candidate(&row)?;
    let mut statement = connection.prepare("SELECT p.* FROM company_local_action_engine_quote_publications p
        JOIN company_local_action_engine_quote_confirmations c ON c.organization_id=p.organization_id
          AND c.proposal_id=p.proposal_id AND c.snapshot_id=p.snapshot_id
        WHERE c.organization_id=? AND c.proposal_id=? LIMIT 2")?;
    let mut rows = statement.query(params![organization,proposal])?;
    let canonical = bounded_record(rows.next()?.ok_or_else(invalid)?)?;
    if rows.next()?.is_some() { return Err(invalid()); }
    let candidate = capture_candidate(&canonical)?;
    let mut statement = connection.prepare("SELECT c.*,o.created_at AS outbox_created_at,o.updated_at AS outbox_updated_at
        FROM company_local_action_engine_quote_confirmations c
        JOIN company_local_action_engine_quote_outbox o ON o.organization_id=c.organization_id AND o.proposal_id=c.proposal_id
        WHERE c.organization_id=? AND c.proposal_id=? AND o.state='confirmed' LIMIT 2")?;
    let mut rows = statement.query(params![organization,proposal])?;
    let confirmation = bounded_record(rows.next()?.ok_or_else(invalid)?)?;
    if rows.next()?.is_some() || confirmation.as_object().is_none_or(|fields| fields.len()!=15) { return Err(invalid()); }
    for key in ["organization_id","source_id","action_kind","proposal_id","reservation_id","fingerprint",
        "actor_user_id","installation_id","customer_id","quote_id","receipt_sha256"] {
        let expected = text(&canonical,key,160)?;
        if text(&row,key,160)? != expected || text(&confirmation,key,160)? != expected { return Err(invalid()); }
    }
    if text(&confirmation,"snapshot_id",36)? != candidate.candidate.snapshot_id { return Err(invalid()); }
    for key in ["reservation_id","installation_id","quote_id"] { crate::cloud_backup::validate_id(text(&canonical,key,36)?)?; }
    for key in ["fingerprint","receipt_sha256"] { sha_field(&canonical,key)?; }
    let created = instant(&candidate.created_at)?;
    let confirmed = instant(text(&confirmation,"confirmed_at",40)?)?;
    let outbox_created = instant(text(&confirmation,"outbox_created_at",40)?)?;
    let outbox_updated = instant(text(&confirmation,"outbox_updated_at",40)?)?;
    if created < outbox_created || confirmed < created || confirmed > outbox_updated || outbox_updated < outbox_created { return Err(invalid()); }
    Ok(())
}

impl LocalStore {
    /// Read only this current actor/installation's corroborated A10 markers.
    /// The real local origin is checked even when no marker is present. No
    /// catalogue/current quote, schema repair, remote request, badge or toast.
    pub(crate) fn read_action_engine_quote_activity(
        &self,
        origin: ActionEngineQuoteRecoveryOrigin,
        after_proposal_id: Option<String>,
        limit: usize,
    ) -> AppResult<ActionEngineQuoteActivityPage> {
        if !(1..=50).contains(&limit) { return Err(invalid()); }
        validate_recovery_work_origin(&origin)?;
        let valid_cursor = |value: &str| !value.is_empty() && value.len() <= 160
            && value.bytes().enumerate().all(|(index, byte)| byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'_' | b'.' | b':' | b'@' | b'-')));
        if after_proposal_id.as_deref().is_some_and(|value| !valid_cursor(value)) {
            return Err(invalid());
        }
        let after = after_proposal_id.as_deref().unwrap_or("");
        let _lock = self.lock()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_onboarding(&tx)?;
        require_local_quote_origin(&tx, self, &origin.actor, &origin.installation_id,
            &origin.expected_workspace_scope, &origin.expected_member_context_nonce)?;
        let mut entries = (|| -> AppResult<Vec<ActionEngineQuoteActivity>> {
            let mut statement = tx.prepare(ACTIVITY_SQL)?;
            let columns = [
                ("organization_id",160), ("source_id",160), ("action_kind",32),
                ("proposal_id",160), ("reservation_id",36), ("fingerprint",64),
                ("actor_user_id",160), ("installation_id",36), ("customer_id",160),
                ("quote_id",36), ("receipt_sha256",64), ("snapshot_id",36), ("confirmed_at",40),
            ];
            if !statement.column_names().iter().copied().eq(columns.iter().map(|(name,_)| *name)) {
                return Err(invalid());
            }
            let mut rows = statement.query(params![origin.actor.organization_id, origin.actor.user_id,
                origin.installation_id, after, (limit + 1) as i64])?;
            let mut entries = Vec::with_capacity(limit + 1);
            let mut previous = after.to_owned();
            while let Some(raw) = rows.next()? {
                if entries.len() >= limit + 1 { return Err(invalid()); }
                let mut fields = serde_json::Map::new();
                for (index,(name,maximum)) in columns.into_iter().enumerate() {
                    let value = retained_text(raw,index,maximum,false)?.ok_or_else(invalid)?;
                    if value.is_empty() || value.chars().any(char::is_control) { return Err(invalid()); }
                    fields.insert(name.to_owned(),Value::String(value));
                }
                let marker = Value::Object(fields);
                let proposal = text(&marker,"proposal_id",160)?;
                if !valid_cursor(proposal) || proposal <= previous.as_str()
                    || text(&marker,"organization_id",160)? != origin.actor.organization_id
                    || text(&marker,"actor_user_id",160)? != origin.actor.user_id
                    || text(&marker,"installation_id",36)? != origin.installation_id {
                    return Err(invalid());
                }
                let selection = ActionEngineQuoteRecoverySelection {
                    source_id: text(&marker,"source_id",160)?.to_owned(),
                    proposal_id: proposal.to_owned(),
                    reservation_id: text(&marker,"reservation_id",36)?.to_owned(),
                    fingerprint: text(&marker,"fingerprint",64)?.to_owned(),
                    actor: origin.actor.clone(), installation_id: origin.installation_id.clone(),
                    expected_workspace_scope: origin.expected_workspace_scope.clone(),
                    expected_member_context_nonce: origin.expected_member_context_nonce.clone(),
                };
                let recovered = recover_action_engine_quote_receipt_in_transaction(&tx,self,&selection)?;
                if recovered.local_outbox_state != ActionEngineLocalQuoteOutboxState::Confirmed {
                    return Err(invalid());
                }
                same_execution(&marker,&selection,&recovered)?;
                let snapshot = text(&marker,"snapshot_id",36)?;
                // Reuses the actual closed candidate/marker/time corroboration,
                // without loading every historical publication for this quote.
                require_confirmed_candidate(&tx,&origin.actor.organization_id,proposal,snapshot)?;
                entries.push(ActionEngineQuoteActivity {
                    organization_id: origin.actor.organization_id.clone(), proposal_id: proposal.to_owned(),
                    quote_id: recovered.receipt.quote_id, confirmed_at: text(&marker,"confirmed_at",40)?.to_owned(),
                    kind: "quote_draft_created", requires_human_validation: true,
                });
                previous = proposal.to_owned();
            }
            Ok(entries)
        })().map_err(|_| invalid())?;
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        let next_after_proposal_id = if has_more {
            Some(entries.last().ok_or_else(invalid)?.proposal_id.clone())
        } else { None };
        tx.commit()?;
        Ok(ActionEngineQuoteActivityPage { entries, next_after_proposal_id })
    }

    /// Read the real local recovery queue under one mutex/IMMEDIATE snapshot.
    /// No schema repair, remote request, current document/catalogue lookup or
    /// permission to execute is created. Corrupt/foreign rows fail the page;
    /// they must never disappear into an empty-success or be silently skipped.
    pub(crate) fn read_action_engine_quote_recovery_work(
        &self,
        origin: ActionEngineQuoteRecoveryOrigin,
        limit: usize,
    ) -> AppResult<ActionEngineQuoteRecoveryWork> {
        if !(1..=50).contains(&limit) { return Err(invalid()); }
        validate_recovery_work_origin(&origin)?;
        let _lock = self.lock()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_onboarding(&tx)?;
        require_local_quote_origin(&tx, self, &origin.actor, &origin.installation_id,
            &origin.expected_workspace_scope, &origin.expected_member_context_nonce)?;
        let mut selections = (|| -> AppResult<Vec<ActionEngineQuoteRecoverySelection>> {
            let mut statement = tx.prepare(RECOVERY_WORK_SQL)?;
            let mut rows = statement.query(params![origin.actor.organization_id, (limit + 1) as i64])?;
            let mut selections = Vec::with_capacity(limit + 1);
            let mut previous: Option<String> = None;
            while let Some(row) = rows.next()? {
                if selections.len() >= limit + 1 { return Err(invalid()); }
                let scalar = |index: usize, maximum: usize| -> AppResult<String> {
                    retained_text(row, index, maximum, false)?.ok_or_else(invalid)
                };
                let organization = scalar(0, 160)?;
                let proposal_id = scalar(1, 160)?;
                let fingerprint = scalar(2, 64)?;
                let state = scalar(3, 16)?;
                let source_id = scalar(4, 160)?;
                let reservation_id = scalar(5, 36)?;
                let user = scalar(6, 160)?;
                let installation = scalar(7, 36)?;
                if organization != origin.actor.organization_id || user != origin.actor.user_id
                    || installation != origin.installation_id
                    || !matches!(state.as_str(), "pending" | "uncertain")
                    || previous.as_ref().is_some_and(|id| proposal_id.as_str() <= id.as_str()) {
                    return Err(invalid());
                }
                let selection = ActionEngineQuoteRecoverySelection {
                    source_id, proposal_id, reservation_id, fingerprint,
                    actor: origin.actor.clone(), installation_id: origin.installation_id.clone(),
                    expected_workspace_scope: origin.expected_workspace_scope.clone(),
                    expected_member_context_nonce: origin.expected_member_context_nonce.clone(),
                };
                // Reuse the actual closed historical receipt/audit/outbox checks
                // in this transaction, not a reimplementation or a second lock.
                let recovered = recover_action_engine_quote_receipt_in_transaction(&tx, self, &selection)?;
                let expected_state = if state == "pending" {
                    ActionEngineLocalQuoteOutboxState::Pending
                } else { ActionEngineLocalQuoteOutboxState::Uncertain };
                if recovered.local_outbox_state != expected_state { return Err(invalid()); }
                previous = Some(selection.proposal_id.clone());
                selections.push(selection);
            }
            Ok(selections)
        })().map_err(|_| invalid())?;
        let has_more = selections.len() > limit;
        selections.truncate(limit);
        tx.commit()?;
        Ok(ActionEngineQuoteRecoveryWork { selections, has_more })
    }

    /// Historical, bounded candidate facts. No archive, current catalogue or
    /// current draft is needed; absence grants no permission to recreate.
    pub(crate) fn read_action_engine_quote_publication_candidates(&self, selection: ActionEngineQuoteRecoverySelection) -> AppResult<ActionEngineQuotePublicationRecovery> {
        let _lock = self.lock()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recovered = recover_action_engine_quote_receipt_in_transaction(&tx,self,&selection)?;
        let candidates = recovery_candidates(&tx,&selection,&recovered)?;
        let canonical_snapshot_id = canonical_snapshot(&tx,&selection,&recovered,&candidates)?;
        tx.commit()?;
        Ok(ActionEngineQuotePublicationRecovery { recovered,
            candidates: candidates.into_iter().map(|candidate| candidate.candidate).collect(), canonical_snapshot_id })
    }

    /// Only a private authenticated caller holding a real A7 success may use
    /// this method. It owns its mutex; callers must not already hold it. Receipt,
    /// exact candidate and immutable local marker are committed with outbox.
    pub(crate) fn acknowledge_action_engine_quote_confirmation(&self, selection: ActionEngineQuoteRecoverySelection, confirmation: ActionEngineQuoteConfirmation) -> AppResult<ActionEngineRecoveredQuote> {
        let _lock = self.lock()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recovered = recover_action_engine_quote_receipt_in_transaction(&tx,self,&selection)?;
        if confirmation.schema_version != 1 || confirmation.state != "confirmed"
            || confirmation.source_id != selection.source_id || confirmation.proposal_id != selection.proposal_id
            || confirmation.reservation_id != selection.reservation_id || confirmation.receipt != recovered.receipt {
            return Err(invalid());
        }
        crate::cloud_backup::validate_id(&confirmation.publication_snapshot_id).map_err(|_| invalid())?;
        let candidates = recovery_candidates(&tx,&selection,&recovered)?;
        let prior = canonical_snapshot(&tx,&selection,&recovered,&candidates)?;
        let candidate = candidates.iter().find(|candidate| candidate.candidate.snapshot_id == confirmation.publication_snapshot_id).ok_or_else(invalid)?;
        if let Some(prior) = prior {
            if prior != confirmation.publication_snapshot_id { return Err(invalid()); }
            tx.commit()?;
            return Ok(recovered);
        }
        let at = now_iso();
        if instant(&at)? < instant(&candidate.created_at)? { return Err(invalid()); }
        tx.execute("INSERT INTO company_local_action_engine_quote_confirmations
            (organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,actor_user_id,installation_id,customer_id,quote_id,receipt_sha256,snapshot_id,confirmed_at)
            VALUES(?,?,'prepare_quote_draft',?,?,?,?,?,?,?,?,?,?)",
            params![selection.actor.organization_id,selection.source_id,selection.proposal_id,selection.reservation_id,
                selection.fingerprint,selection.actor.user_id,selection.installation_id,recovered.receipt.customer_id,
                recovered.receipt.quote_id,recovered.receipt_sha256,confirmation.publication_snapshot_id,at])?;
        let changed = tx.execute("UPDATE company_local_action_engine_quote_outbox SET state='confirmed',updated_at=?
            WHERE organization_id=? AND proposal_id=? AND state IN ('pending','uncertain')",
            params![at,selection.actor.organization_id,selection.proposal_id])?;
        if changed != 1 { return Err(invalid()); }
        let confirmed = recover_action_engine_quote_receipt_in_transaction(&tx,self,&selection)?;
        if confirmed.local_outbox_state != ActionEngineLocalQuoteOutboxState::Confirmed { return Err(invalid()); }
        require_confirmed_candidate(&tx,&selection.actor.organization_id,&selection.proposal_id,&confirmation.publication_snapshot_id)?;
        tx.commit()?;
        Ok(confirmed)
    }
}

/// Pin every exact candidate until canonical confirmation, regardless of which
/// snapshot preferences currently call pending or which newer head was received.
pub(crate) fn retained_snapshot_ids(connection: &Connection) -> AppResult<Vec<String>> {
    let unlinked_confirmation: bool = connection.query_row("SELECT EXISTS(
        SELECT 1 FROM company_local_action_engine_quote_outbox o WHERE o.state='confirmed'
        AND NOT EXISTS(SELECT 1 FROM company_local_action_engine_quote_publications p
          WHERE p.organization_id=o.organization_id AND p.proposal_id=o.proposal_id))", [], |row| row.get(0))?;
    if unlinked_confirmation { return Err(invalid()); }
    let mut q = connection.prepare("SELECT p.snapshot_id,o.state,
        EXISTS(SELECT 1 FROM company_local_action_engine_quote_confirmations c
          JOIN company_local_action_engine_quote_publications cp ON cp.organization_id=c.organization_id AND cp.proposal_id=c.proposal_id AND cp.snapshot_id=c.snapshot_id
          JOIN action_engine_quote_receipts r ON r.organization_id=c.organization_id AND r.proposal_id=c.proposal_id
          WHERE c.organization_id=p.organization_id AND c.proposal_id=p.proposal_id
            AND c.source_id=p.source_id AND c.action_kind=p.action_kind AND c.reservation_id=p.reservation_id
            AND c.fingerprint=p.fingerprint AND c.actor_user_id=p.actor_user_id AND c.installation_id=p.installation_id
            AND c.customer_id=p.customer_id AND c.quote_id=p.quote_id AND c.receipt_sha256=p.receipt_sha256
            AND cp.source_id=c.source_id AND cp.action_kind=c.action_kind AND cp.reservation_id=c.reservation_id
            AND cp.fingerprint=c.fingerprint AND cp.actor_user_id=c.actor_user_id AND cp.installation_id=c.installation_id
            AND cp.customer_id=c.customer_id AND cp.quote_id=c.quote_id AND cp.receipt_sha256=c.receipt_sha256
            AND r.source_id=c.source_id AND r.action_kind=c.action_kind AND r.reservation_id=c.reservation_id
            AND r.fingerprint=c.fingerprint AND r.actor_user_id=c.actor_user_id AND r.installation_id=c.installation_id
            AND r.customer_id=c.customer_id AND r.quote_id=c.quote_id AND r.receipt_sha256=c.receipt_sha256
            AND o.quote_id=c.quote_id AND o.fingerprint=c.fingerprint
            AND json_extract(o.payload_json,'$.reservationId')=c.reservation_id
            AND json_extract(o.payload_json,'$.customerId')=c.customer_id
            AND json_extract(o.payload_json,'$.receiptSha256')=c.receipt_sha256
            AND c.confirmed_at>=cp.created_at AND c.confirmed_at<=o.updated_at),
        o.payload_json,o.payload_sha256,
        (SELECT receipt_json FROM action_engine_quote_receipts r WHERE r.organization_id=p.organization_id AND r.proposal_id=p.proposal_id),p.receipt_sha256,
        p.organization_id,p.proposal_id
        FROM company_local_action_engine_quote_publications p
        LEFT JOIN company_local_action_engine_quote_outbox o ON o.organization_id=p.organization_id AND o.proposal_id=p.proposal_id
        ORDER BY p.snapshot_id COLLATE BINARY LIMIT 10001")?;
    let mut pending = q.query([])?;
    let mut rows = Vec::new();
    while let Some(raw) = pending.next()? {
        if rows.len() >= MAX_RETAINED_LINKS { return Err(invalid()); }
        rows.push((retained_text(raw,0,36,false)?.ok_or_else(invalid)?,retained_text(raw,1,9,true)?,raw.get::<_,i64>(2)?,
            retained_text(raw,3,4096,true)?,retained_text(raw,4,64,true)?,retained_text(raw,5,4096,true)?,
            retained_text(raw,6,64,false)?.ok_or_else(invalid)?,retained_text(raw,7,160,false)?.ok_or_else(invalid)?,
            retained_text(raw,8,160,false)?.ok_or_else(invalid)?));
    }
    let mut ids = BTreeSet::new();
    for (id, state, valid_confirmation, payload, payload_sha, receipt, receipt_sha, organization, proposal) in rows {
        crate::cloud_backup::validate_id(&id)?;
        match state.as_deref() {
            Some("pending" | "uncertain") => {
                ids.insert(id);
            }
            Some("confirmed") => {
                let payload = payload.ok_or_else(invalid)?;
                let receipt = receipt.ok_or_else(invalid)?;
                if valid_confirmation != 1 || payload.len()>4096 || receipt.len()>4096
                    || Some(hash(payload.as_bytes())) != payload_sha || hash(receipt.as_bytes()) != receipt_sha {
                    return Err(invalid());
                }
                require_confirmed_candidate(connection,&organization,&proposal,&id)?;
            }
            _ => return Err(invalid()), // An orphan/failure must never erase a pin.
        }
    }
    Ok(ids.into_iter().collect())
}

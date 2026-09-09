//! Verified canonical positions accompany the original immutable transaction.
//! Decode them for guarded native replay; decoding never acknowledges a change.
#[cfg(test)]
use super::{build, Candidate};
use super::{
    invalid, Context, RowChange, MAX_BYTES, MAX_ROWS, MAX_ROW_BYTES,
    STATE_FINGERPRINT_VERSION,
};
use crate::{
    business_sync::{files::RetainedFile, outgoing::Manifest, policy, snapshot},
    database::LocalStore,
    error::AppResult,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use uuid::Uuid;
pub(crate) mod incoming;
const BUNDLE_BYTES: usize = 512 * 1024;
const POSITION_BYTES: usize = 512 * 1024;
const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Bound to the receipt obtained over authenticated HTTPS and to its discovery
/// entry. A transport hash alone is not a signature or an acknowledgement.
pub(super) struct Expected {
    receipt: Receipt,
}
pub(super) struct ReceiptRequest<'a> {
    pub organization: &'a str,
    pub generation: &'a str,
    pub transaction_id: &'a str,
    pub source_revision: i64,
    pub receipt_sha256: &'a str,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    format: String,
    version: u32,
    transaction_id: String,
    organization_id: String,
    generation: String,
    origin_installation_id: String,
    capture_generation: String,
    source_transfer_id: String,
    source_revision: i64,
    revision: i64,
    manifest_sha256: String,
    bundle_sha256: String,
    fingerprint_version: u32,
    fingerprint_contract_sha256: String,
    source_state_sha256: String,
    target_state_sha256: String,
    validation_sha256: String,
    committed_at: String,
}
impl Expected {
    pub(super) fn from_authenticated_receipt(
        raw: &[u8],
        request: ReceiptRequest<'_>,
    ) -> AppResult<Self> {
        if raw.len() > 16 * 1024
            || !hash(request.receipt_sha256)
            || digest(raw) != request.receipt_sha256
        {
            return Err(invalid(
                "Le reçu téléchargé ne correspond pas à la révision annoncée.",
            ));
        }
        let r: Receipt = serde_json::from_slice(raw)?;
        if r.format != "zentra-canonical-transaction-receipt"
            || r.version != 1
            || r.organization_id != request.organization
            || r.organization_id.is_empty()
            || r.generation != request.generation
            || r.transaction_id != request.transaction_id
            || r.source_revision != request.source_revision
            || r.source_revision < 1
            || r.source_revision >= 9_007_199_254_740_991
            || r.revision != r.source_revision + 1
            || r.fingerprint_version != STATE_FINGERPRINT_VERSION
            || r.fingerprint_contract_sha256 != fingerprint_contract()?
            || [
                &r.generation,
                &r.transaction_id,
                &r.origin_installation_id,
                &r.capture_generation,
                &r.source_transfer_id,
            ]
            .iter()
            .any(|v| !uuid(v))
            || [
                &r.manifest_sha256,
                &r.bundle_sha256,
                &r.source_state_sha256,
                &r.target_state_sha256,
                &r.validation_sha256,
            ]
            .iter()
            .any(|v| !hash(v))
            || !chrono::DateTime::parse_from_rfc3339(&r.committed_at).is_ok_and(|date| {
                date.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    == r.committed_at
            })
        {
            return Err(invalid(
                "Le reçu ne correspond pas à cette entreprise, révision ou version du logiciel.",
            ));
        }
        Ok(Self { receipt: r })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Part {
    source_sha256: String,
    source_bytes: usize,
    positions_sha256: String,
    positions_bytes: usize,
    change_count: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    format: String,
    version: u32,
    schema_version: u32,
    contract_sha256: String,
    organization_id: String,
    origin_installation_id: String,
    generation: String,
    capture_generation: String,
    transaction_id: String,
    source_transfer_id: String,
    source_revision: i64,
    original_manifest_sha256: String,
    review_attempt: String,
    review_validator_sha256: String,
    validation_sha256: String,
    fingerprint_version: u32,
    fingerprint_contract_sha256: String,
    source_state_sha256: String,
    target_state_sha256: String,
    source_rows: usize,
    target_rows: usize,
    parts: Vec<Part>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    table: String,
    key_json: String,
    canonical_rowid: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Positions {
    version: u32,
    part_index: usize,
    source_sha256: String,
    positions: Vec<Position>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    sequence: String,
    table: String,
    key_json: String,
    operation: String,
    before_json: Option<String>,
    after_json: Option<String>,
    source_rowid: String,
    files_before: Vec<RetainedFile>,
    files_after: Vec<RetainedFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Changes {
    version: u32,
    changes: Vec<Change>,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash(raw: &str) -> bool {
    raw.len() == 64
        && raw
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn uuid(raw: &str) -> bool {
    Uuid::parse_str(raw).is_ok_and(|id| {
        id.to_string() == raw
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
fn integer(raw: &str) -> AppResult<i64> {
    raw.parse::<i64>()
        .ok()
        .filter(|n| n.to_string() == raw)
        .ok_or_else(|| invalid("Une position reçue n'est pas un entier exact."))
}
fn fingerprint_contract() -> AppResult<String> {
    Ok(digest(&serde_json::to_vec(&serde_json::json!([
        "zentra-state-fingerprint",2,"zentra-business-state-v2\0","zentra-business-state-row-v2\0",
        "sqlite-json-object-policy-column-order;sqlite-binary-table-key-order;u64be-utf8-frames;signed64-decimal-rowid",snapshot::contract_hash()?
    ]))?))
}
struct Decoder {
    bundle: Bundle,
    manifest: Manifest,
    next: usize,
    changes: usize,
    previous: i64,
    files: BTreeMap<String, u64>,
}
impl Decoder {
    fn new(raw: &[u8], original: &[u8], expected: &Expected) -> AppResult<Self> {
        let receipt = &expected.receipt;
        if raw.len() > BUNDLE_BYTES
            || original.len() > 8 * 1024 * 1024
            || digest(raw) != receipt.bundle_sha256
            || digest(original) != receipt.manifest_sha256
        {
            return Err(invalid(
                "Le descriptif reçu ne correspond pas à la confirmation du serveur.",
            ));
        }
        let b: Bundle = serde_json::from_slice(raw)?;
        let m: Manifest = serde_json::from_slice(original)?;
        if b.format != "zentra-canonical-transaction-bundle"
            || b.version != 1
            || b.schema_version != 60
            || b.contract_sha256 != snapshot::contract_hash()?
            || b.organization_id != receipt.organization_id
            || b.generation != receipt.generation
            || b.source_revision != receipt.source_revision
            || b.transaction_id != receipt.transaction_id
            || b.origin_installation_id != receipt.origin_installation_id
            || b.capture_generation != receipt.capture_generation
            || b.source_transfer_id != receipt.source_transfer_id
            || b.validation_sha256 != receipt.validation_sha256
            || b.source_state_sha256 != receipt.source_state_sha256
            || b.target_state_sha256 != receipt.target_state_sha256
            || b.source_revision < 1
            || b.source_revision > 9_007_199_254_740_991
            || b.fingerprint_version != STATE_FINGERPRINT_VERSION
            || b.fingerprint_contract_sha256 != fingerprint_contract()?
            || b.source_rows > MAX_ROWS
            || b.target_rows > MAX_ROWS
            || b.parts.is_empty()
            || b.parts.len() > 1024
            || b.original_manifest_sha256 != digest(original)
            || [
                &b.original_manifest_sha256,
                &b.review_validator_sha256,
                &b.validation_sha256,
                &b.source_state_sha256,
                &b.target_state_sha256,
            ]
            .iter()
            .any(|v| !hash(v))
            || [
                &b.origin_installation_id,
                &b.generation,
                &b.capture_generation,
                &b.transaction_id,
                &b.source_transfer_id,
                &b.review_attempt,
            ]
            .iter()
            .any(|v| !uuid(v))
            || m.format != "zentra-business-transaction"
            || m.version != 1
            || m.schema_version != b.schema_version
            || m.contract_sha256 != b.contract_sha256
            || m.organization_id != b.organization_id
            || m.installation_id != b.origin_installation_id
            || m.generation != b.generation
            || m.capture_generation != b.capture_generation
            || m.transaction_id != b.transaction_id
            || !uuid(&m.bootstrap_transfer_id)
            || m.base_revision < 1
            || m.base_revision > b.source_revision
            || m.change_count == 0
            || m.change_count > MAX_ROWS
            || m.size_bytes > MAX_BYTES as u64
            || m.chunks.len() != b.parts.len()
            || m.files.len() > 50_000
        {
            return Err(invalid("Le descriptif de réception ne correspond pas à cette entreprise, révision ou version du logiciel."));
        }
        let (first, last) = (integer(&m.first_sequence)?, integer(&m.last_sequence)?);
        if first < 1 || last < first || (last - first + 1) < m.change_count as i64 {
            return Err(invalid("Les bornes du journal reçu sont incohérentes."));
        }
        let mut bytes = 0u64;
        let mut changes = 0usize;
        for (p, c) in b.parts.iter().zip(&m.chunks) {
            if p.source_sha256 != c.sha256
                || !hash(&p.source_sha256)
                || !hash(&p.positions_sha256)
                || p.source_bytes == 0
                || p.source_bytes > CHUNK_BYTES
                || p.source_bytes as u64 != c.size_bytes
                || p.positions_bytes == 0
                || p.positions_bytes > POSITION_BYTES
                || p.change_count == 0
                || p.change_count > 200
                || p.change_count != c.change_count
            {
                return Err(invalid(
                    "Un fragment de réception est absent ou incohérent.",
                ));
            }
            bytes += c.size_bytes;
            changes += c.change_count;
        }
        if bytes != m.size_bytes || changes != m.change_count {
            return Err(invalid(
                "Les fragments ne couvrent pas la transaction reçue.",
            ));
        }
        let mut files = BTreeMap::new();
        let mut total = 0u64;
        let mut previous = "";
        for f in &m.files {
            if !hash(&f.sha256) || f.sha256.as_str() <= previous || f.size_bytes > MAX_BYTES as u64
            {
                return Err(invalid("Le catalogue des fichiers reçus est invalide."));
            }
            previous = &f.sha256;
            total += f.size_bytes;
            files.insert(f.sha256.clone(), f.size_bytes);
        }
        if total > 10 * 1024 * 1024 * 1024 {
            return Err(invalid("Les fichiers reçus dépassent la limite autorisée."));
        }
        Ok(Self {
            bundle: b,
            manifest: m,
            next: 0,
            changes: 0,
            previous: 0,
            files,
        })
    }
    fn context(&self) -> Context {
        Context {
            fingerprint_version: self.bundle.fingerprint_version,
            organization: self.bundle.organization_id.clone(),
            generation: self.bundle.generation.clone(),
            base_revision: self.bundle.source_revision,
            source_state_sha256: self.bundle.source_state_sha256.clone(),
            target_state_sha256: self.bundle.target_state_sha256.clone(),
        }
    }
    fn part(&mut self, original: &[u8], positions: &[u8]) -> AppResult<Vec<RowChange>> {
        let p = self
            .bundle
            .parts
            .get(self.next)
            .ok_or_else(|| invalid("Un fragment reçu dépasse le descriptif."))?;
        if original.len() != p.source_bytes
            || digest(original) != p.source_sha256
            || positions.len() != p.positions_bytes
            || digest(positions) != p.positions_sha256
        {
            return Err(invalid(
                "Les octets reçus ne correspondent pas aux empreintes attendues.",
            ));
        }
        let rows: Changes = serde_json::from_slice(original)?;
        let positions: Positions = serde_json::from_slice(positions)?;
        if rows.version != 1
            || positions.version != 1
            || positions.part_index != self.next
            || positions.source_sha256 != p.source_sha256
            || rows.changes.len() != p.change_count
            || positions.positions.len() != p.change_count
        {
            return Err(invalid(
                "Les positions reçues ne couvrent pas le fragment original.",
            ));
        }
        let contract = policy()?;
        let mut result = Vec::with_capacity(rows.changes.len());
        for (c, pos) in rows.changes.into_iter().zip(positions.positions) {
            let sequence = integer(&c.sequence)?;
            integer(&c.source_rowid)?;
            if sequence < 1
                || sequence <= self.previous
                || sequence > integer(&self.manifest.last_sequence)?
                || (self.changes == 0 && c.sequence != self.manifest.first_sequence)
                || c.table != pos.table
                || c.key_json != pos.key_json
                || c.key_json.len() > 1024
                || !contract.tables.contains_key(&c.table)
                || c.before_json
                    .as_ref()
                    .is_some_and(|v| v.len() > MAX_ROW_BYTES)
                || c.after_json
                    .as_ref()
                    .is_some_and(|v| v.len() > MAX_ROW_BYTES)
                || !matches!(
                    (
                        c.operation.as_str(),
                        c.before_json.is_some(),
                        c.after_json.is_some()
                    ),
                    ("insert", false, true) | ("update", true, true) | ("delete", true, false)
                )
            {
                return Err(invalid(
                    "Une position canonique ne correspond pas à la modification reçue.",
                ));
            }
            for file in c.files_before.iter().chain(&c.files_after) {
                if self.files.get(&file.sha256) != Some(&file.size_bytes)
                    || !matches!(file.root.as_str(), "attachments" | "exports")
                    || snapshot::safe_relative(&file.path).is_err()
                {
                    return Err(invalid("Une pièce reçue manque dans le catalogue vérifié."));
                }
            }
            self.previous = sequence;
            self.changes += 1;
            result.push(RowChange {
                table: c.table,
                key_json: c.key_json,
                before_json: c.before_json,
                after_json: c.after_json,
                canonical_rowid: integer(&pos.canonical_rowid)?,
            });
        }
        self.next += 1;
        Ok(result)
    }
    fn finish(&self) -> AppResult<()> {
        if self.next != self.bundle.parts.len()
            || self.changes != self.manifest.change_count
            || self.previous != integer(&self.manifest.last_sequence)?
        {
            return Err(invalid(
                "La réception de la transaction n'est pas complète.",
            ));
        }
        Ok(())
    }
}
#[cfg(test)]
pub(super) fn prepare_candidate(
    store: &LocalStore,
    expected: &Expected,
    bundle: &[u8],
    manifest: &[u8],
    parts: impl IntoIterator<Item = AppResult<(Vec<u8>, Vec<u8>)>>,
) -> AppResult<Candidate> {
    let decoder = Decoder::new(bundle, manifest, expected)?;
    let context = decoder.context();
    build(store, &context, decoded_parts(decoder, parts))
}
fn decoded_parts(
    mut decoder: Decoder,
    parts: impl IntoIterator<Item=AppResult<(Vec<u8>, Vec<u8>)>>,
) -> impl Iterator<Item=AppResult<RowChange>> {
    let mut parts = parts.into_iter();
    let mut queued = VecDeque::new();
    let mut finished = false;
    std::iter::from_fn(move || {
        if let Some(row) = queued.pop_front() {
            return Some(Ok(row));
        }
        if finished {
            return None;
        }
        match parts.next() {
            Some(Ok((original, positions))) => match decoder.part(&original, &positions) {
                Ok(rows) => {
                    queued.extend(rows);
                    queued.pop_front().map(Ok)
                }
                Err(error) => {
                    finished = true;
                    Some(Err(error))
                }
            },
            Some(Err(error)) => {
                finished = true;
                Some(Err(error))
            }
            None => {
                finished = true;
                decoder.finish().err().map(Err)
            }
        }
    })
}

#[cfg(test)]
mod tests;

//! Exact wire proof for retiring a conflict suffix. A retirement is not a
//! transaction acknowledgement and never advances the business revision.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

const SAFE_REVISION: i64 = 9_007_199_254_740_991;
const MAX_PROOF_BYTES: usize = 16 * 1024;

pub(crate) mod durable;

// Field order is part of the server's JSON binding hash. Keep it identical to
// parse() in lib/business-sync-retirement.ts, independently of response order.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub resolution_id: String,
    pub generation: String,
    pub capture_generation: String,
    pub first_sequence: String,
    pub last_sequence: String,
    pub base_revision: i64,
    pub receipt_sha256: String,
    pub review_id: String,
    pub decision_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    pub format: String,
    pub version: u32,
    pub resolution_id: String,
    pub proposal_sha256: String,
    pub organization_id: String,
    pub installation_id: String,
    pub generation: String,
    pub capture_generation: String,
    pub replacement_capture_generation: String,
    pub source_revision: i64,
    pub base_revision: i64,
    pub received_transaction_id: String,
    pub first_sequence: String,
    pub last_sequence: String,
    pub receipt_sha256: String,
    pub review_id: String,
    pub decision_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    format: String,
    version: u32,
    organization_id: String,
    installation_id: String,
    resolution_id: String,
    generation: String,
    capture_generation: String,
    first_sequence: String,
    last_sequence: String,
    base_revision: i64,
    receipt_sha256: String,
    review_id: String,
    decision_sha256: String,
    binding_sha256: String,
    registered_at: String,
    retired: bool,
    business_revision_changed: bool,
    transaction_acknowledged: bool,
}

fn invalid() -> AppError {
    AppError::Validation("La preuve de résolution ne correspond pas aux choix enregistrés. Le dossier reste protégé.".into())
}
fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == value)
}
fn sequence(value: &str) -> Option<i64> {
    value.parse::<i64>().ok().filter(|n| *n > 0 && n.to_string() == value)
}

impl Request {
    fn validate(&self) -> AppResult<()> {
        let first = sequence(&self.first_sequence).ok_or_else(invalid)?;
        let last = sequence(&self.last_sequence).ok_or_else(invalid)?;
        if last < first || last - first >= 200_000
            || !(2..=SAFE_REVISION).contains(&self.base_revision)
            || [&self.resolution_id, &self.generation, &self.capture_generation].iter().any(|v| !uuid(v))
            || [&self.receipt_sha256, &self.review_id, &self.decision_sha256].iter().any(|v| !hash(v))
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn binding_sha256(&self) -> AppResult<String> {
        self.validate()?;
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }
}
impl Intent {
    pub fn request(&self) -> Request {
        Request {
            resolution_id: self.resolution_id.clone(), generation: self.generation.clone(),
            capture_generation: self.capture_generation.clone(), first_sequence: self.first_sequence.clone(),
            last_sequence: self.last_sequence.clone(), base_revision: self.base_revision,
            receipt_sha256: self.receipt_sha256.clone(), review_id: self.review_id.clone(),
            decision_sha256: self.decision_sha256.clone(),
        }
    }
    pub fn read(raw: &[u8]) -> AppResult<Self> {
        if raw.len() > MAX_PROOF_BYTES { return Err(invalid()); }
        let value: Self = serde_json::from_slice(raw).map_err(|_| invalid())?;
        value.request().validate()?;
        if value.format != "zentra-conflict-application" || value.version != 1
            || !(1..SAFE_REVISION).contains(&value.source_revision)
            || value.base_revision != value.source_revision + 1
            || value.organization_id.is_empty() || value.organization_id.len() > 200
            || value.organization_id.chars().any(char::is_control)
            || !hash(&value.proposal_sha256)
            || [&value.installation_id, &value.replacement_capture_generation, &value.received_transaction_id].iter().any(|v| !uuid(v))
            || value.capture_generation == value.replacement_capture_generation
        {
            return Err(invalid());
        }
        Ok(value)
    }
}
impl Receipt {
    pub fn read(raw: &[u8], intent: &Intent) -> AppResult<Self> {
        if raw.len() > MAX_PROOF_BYTES { return Err(invalid()); }
        let value: Self = serde_json::from_slice(raw).map_err(|_| invalid())?;
        let request = Request {
            resolution_id: value.resolution_id.clone(), generation: value.generation.clone(),
            capture_generation: value.capture_generation.clone(), first_sequence: value.first_sequence.clone(),
            last_sequence: value.last_sequence.clone(), base_revision: value.base_revision,
            receipt_sha256: value.receipt_sha256.clone(), review_id: value.review_id.clone(),
            decision_sha256: value.decision_sha256.clone(),
        };
        if value.format != "zentra-conflict-retirement" || value.version != 1
            || value.organization_id != intent.organization_id || value.installation_id != intent.installation_id
            || request != intent.request() || value.binding_sha256 != request.binding_sha256()?
            || !value.retired || value.business_revision_changed || value.transaction_acknowledged
            || chrono::DateTime::parse_from_rfc3339(&value.registered_at).is_err()
        {
            return Err(invalid());
        }
        Ok(value)
    }
}

pub(super) fn register(connection: &Connection) -> AppResult<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS;
    connection.create_scalar_function("zentra_resolution_intent_valid", 1, flags, |ctx| {
        Ok(Intent::read(ctx.get::<String>(0)?.as_bytes()).is_ok())
    })?;
    connection.create_scalar_function("zentra_resolution_retirement_valid", 2, flags, |ctx| {
        let intent = ctx.get::<String>(0)?;
        let receipt = ctx.get::<String>(1)?;
        Ok(Intent::read(intent.as_bytes()).and_then(|i| Receipt::read(receipt.as_bytes(), &i)).is_ok())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests;

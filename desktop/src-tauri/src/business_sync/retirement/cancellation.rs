//! An authenticated negative proof, never inferred from a missing response.
use super::{invalid, Intent, Request, MAX_PROOF_BYTES};
use crate::error::AppResult;
use serde::Deserialize;

pub(crate) mod durable;
#[cfg(test)]
mod tests;
pub(crate) const MIGRATION_SQL: &str =
    include_str!("../../business_sync_resolution_cancellation.sql");

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
    cancelled: bool,
    retired: bool,
    business_revision_changed: bool,
    transaction_acknowledged: bool,
}
impl Receipt {
    pub(crate) fn read(raw: &[u8], intent: &Intent) -> AppResult<Self> {
        if raw.len() > MAX_PROOF_BYTES {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(raw).map_err(|_| invalid())?;
        let request = Request {
            resolution_id: value.resolution_id.clone(),
            generation: value.generation.clone(),
            capture_generation: value.capture_generation.clone(),
            first_sequence: value.first_sequence.clone(),
            last_sequence: value.last_sequence.clone(),
            base_revision: value.base_revision,
            receipt_sha256: value.receipt_sha256.clone(),
            review_id: value.review_id.clone(),
            decision_sha256: value.decision_sha256.clone(),
        };
        if value.format != "zentra-conflict-retirement-cancellation"
            || value.version != 1
            || value.organization_id != intent.organization_id
            || value.installation_id != intent.installation_id
            || request != intent.request()
            || value.binding_sha256 != request.binding_sha256()?
            || !value.cancelled
            || value.retired
            || value.business_revision_changed
            || value.transaction_acknowledged
            || chrono::DateTime::parse_from_rfc3339(&value.registered_at).is_err()
        {
            return Err(invalid());
        }
        Ok(value)
    }
}

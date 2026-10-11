//! Private A11 device wire codec. No network, IPC, admission or database access.
//! The authenticated account caller must corroborate actor/user/installation
//! and the captured local origin around its waits before using a reserved input.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    action_engine_quote::{
        ActionEngineQuoteActor, ActionEngineQuoteInput, ActionEngineQuoteReceipt,
        ActionEngineQuoteSource,
    },
    action_engine_quote_publication::ActionEngineQuoteConfirmation,
    error::{AppError, AppResult},
};

pub(crate) const PATH: &str = "/api/account/automation/quote-execution";
pub(crate) const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_PLAN_BYTES: usize = 65_536;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuoteExecutionSelection {
    pub(crate) source_id: String,
    pub(crate) proposal_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ReservedQuote {
    pub(crate) canonical_plan_json: String,
    pub(crate) proposal_id: String,
    pub(crate) fingerprint: String,
    pub(crate) reservation_id: String,
    pub(crate) source: ActionEngineQuoteSource,
    pub(crate) actor: ActionEngineQuoteActor,
    pub(crate) installation_id: String,
    pub(crate) expected_resources_hash: String,
    pub(crate) expected_context_revision: String,
    pub(crate) customer_id: String,
    pub(crate) quote_id: String,
    pub(crate) authorization_revision: String,
}

#[derive(Debug, Clone)]
pub(crate) enum ReservationResponse {
    Reserved(ReservedQuote),
    Held {
        proposal_id: String,
    },
    RecoveryRequired {
        proposal_id: String,
        reservation_id: String,
        fingerprint: String,
    },
    // Both successful branches carry the exact selectors corroborated by A7.
    // A receipt-only historical response cannot acknowledge a local outbox.
    Confirmed(ActionEngineQuoteConfirmation),
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ReservationWire {
    Reserved {
        schema_version: u32,
        canonical_plan_json: String,
        proposal_id: String,
        fingerprint: String,
        reservation_id: String,
        source: ActionEngineQuoteSource,
        actor: ActionEngineQuoteActor,
        installation_id: String,
        expected_resources_hash: String,
        expected_context_revision: String,
        customer_id: String,
        quote_id: String,
        authorization_revision: String,
    },
    Held {
        schema_version: u32,
        proposal_id: String,
    },
    RecoveryRequired {
        schema_version: u32,
        proposal_id: String,
        reservation_id: String,
        fingerprint: String,
    },
    Confirmed {
        schema_version: u32,
        source_id: String,
        proposal_id: String,
        reservation_id: String,
        publication_snapshot_id: String,
        receipt: WireReceipt,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmationWire {
    schema_version: u32,
    state: String,
    source_id: String,
    proposal_id: String,
    reservation_id: String,
    publication_snapshot_id: String,
    receipt: WireReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireReceipt {
    organization_id: String,
    proposal_id: String,
    fingerprint: String,
    customer_id: String,
    quote_id: String,
    quote_number: RequiredNull,
    status: String,
    requires_human_validation: bool,
}

// Option<String> would accept a missing quoteNumber. The A10 wire requires a
// present JSON null for the immutable original, unnumbered creation receipt.
#[derive(Debug)]
struct RequiredNull;
impl<'de> Deserialize<'de> for RequiredNull {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NullVisitor;
        impl<'de> serde::de::Visitor<'de> for NullVisitor {
            type Value = RequiredNull;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an explicit JSON null")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(RequiredNull)
            }
        }
        deserializer.deserialize_unit(NullVisitor)
    }
}

// A typed, closed parse preserves duplicate-field rejection even inside the
// canonical-plan string. It is a wire consistency check, never a replacement
// for A8 admission or the native writer's real resource/quantity checks.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePlan {
    schema_version: u32,
    engine_version: String,
    kind: String,
    organization_id: String,
    context_revision: String,
    source_id: String,
    source_revision: String,
    status: String,
    reasons: Vec<String>,
    customer: WireCustomer,
    title: String,
    currency: String,
    lines: Vec<WireLine>,
    net_cents: i64,
    confidence: f64,
    requires_human_validation: bool,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireCustomer {
    Existing {
        id: String,
        revision: String,
        name: String,
    },
    New {
        name: String,
        email: String,
    },
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireLine {
    article_id: String,
    article_revision: String,
    description: String,
    unit: String,
    quantity_milli: i64,
    unit_price_cents: i64,
    tax_rate_bp: i64,
    net_cents: i64,
    evidence: String,
}

fn invalid() -> AppError {
    AppError::Validation(
        "[action_engine:invalid_record] La réponse Automation doit être vérifiée. Vos données sont conservées."
            .into(),
    )
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'_' | b'.' | b':' | b'@' | b'-'))
        })
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value && id.get_version_num() == 4)
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn javascript_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn trimmed(value: &str) -> &str {
    value.trim_matches(javascript_whitespace)
}
fn text(value: &str, maximum: usize, required: bool) -> bool {
    value.encode_utf16().count() <= maximum
        && (!required || !trimmed(value).is_empty())
        && !value
            .chars()
            .any(|character| matches!(character, '\0' | '\u{b}' | '\u{c}' | '\u{7f}'))
}
fn email(value: &str) -> bool {
    value.len() <= 254
        && value == trimmed(value)
        && value == value.to_ascii_lowercase()
        && regex::Regex::new(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$")
            .expect("constant wire email expression")
            .is_match(value)
}
fn selection(selection: &QuoteExecutionSelection) -> AppResult<()> {
    if !valid_id(&selection.source_id) || !valid_id(&selection.proposal_id) {
        return Err(invalid());
    }
    Ok(())
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> AppResult<T> {
    if bytes.is_empty() || bytes.len() > MAX_RESPONSE_BYTES {
        return Err(invalid());
    }
    // Neither replacement decoding nor a serde Value map may erase malformed
    // bytes or duplicate struct fields before the typed, closed parse.
    std::str::from_utf8(bytes).map_err(|_| invalid())?;
    serde_json::from_slice(bytes).map_err(|_| invalid())
}
impl WireReceipt {
    fn capture(self, proposal: &str) -> AppResult<ActionEngineQuoteReceipt> {
        let RequiredNull = self.quote_number;
        if !valid_id(&self.organization_id)
            || !valid_id(&self.proposal_id)
            || self.proposal_id != proposal
            || !valid_hash(&self.fingerprint)
            || !valid_id(&self.customer_id)
            || !uuid(&self.quote_id)
            || self.status != "draft"
            || !self.requires_human_validation
        {
            return Err(invalid());
        }
        Ok(ActionEngineQuoteReceipt {
            organization_id: self.organization_id,
            proposal_id: self.proposal_id,
            fingerprint: self.fingerprint,
            customer_id: self.customer_id,
            quote_id: self.quote_id,
            quote_number: None,
            status: self.status,
            requires_human_validation: true,
        })
    }
}

fn validate_reserved(quote: &ReservedQuote) -> AppResult<()> {
    if !valid_id(&quote.proposal_id)
        || !valid_id(&quote.actor.organization_id)
        || !valid_id(&quote.actor.user_id)
        || !valid_id(&quote.expected_context_revision)
        || !valid_id(&quote.authorization_revision)
        || !valid_id(&quote.customer_id)
        || !uuid(&quote.reservation_id)
        || !uuid(&quote.installation_id)
        || !uuid(&quote.quote_id)
        || !valid_hash(&quote.fingerprint)
        || !valid_hash(&quote.expected_resources_hash)
        || quote.canonical_plan_json.len() > MAX_PLAN_BYTES
        || sha(quote.canonical_plan_json.as_bytes()) != quote.fingerprint
        || !valid_id(&quote.source.id)
        || !valid_id(&quote.source.revision)
        || quote.source.organization_id != quote.actor.organization_id
        || !email(&quote.source.sender_email)
        || !text(&quote.source.sender_name, 200, false)
        || !text(&quote.source.subject, 300, false)
        || !text(&quote.source.body, 3000, false)
    {
        return Err(invalid());
    }
    let plan: WirePlan = serde_json::from_str(&quote.canonical_plan_json).map_err(|_| invalid())?;
    let units: Vec<u16> = trimmed(&quote.source.subject)
        .encode_utf16()
        .take(160)
        .collect();
    let title = String::from_utf16(&units).map_err(|_| invalid())?;
    let title = if title.is_empty() { "Quote" } else { &title };
    if plan.schema_version != 1
        || plan.engine_version != "action-engine-quote-v1"
        || plan.kind != "prepare_quote_draft"
        || plan.organization_id != quote.actor.organization_id
        || plan.context_revision != quote.expected_context_revision
        || plan.source_id != quote.source.id
        || plan.source_revision != quote.source.revision
        || plan.status != "ready"
        || !plan.reasons.is_empty()
        || !plan.requires_human_validation
        || plan.currency != "CHF"
        || plan.title != title
        || !text(&plan.title, 160, true)
        || !plan.confidence.is_finite()
        || !(0.95..=1.0).contains(&plan.confidence)
        || plan.lines.is_empty()
        || plan.lines.len() > 8
    {
        return Err(invalid());
    }
    match plan.customer {
        WireCustomer::Existing { id, revision, name } => {
            if id != quote.customer_id || !valid_id(&revision) || !text(&name, 200, true) {
                return Err(invalid());
            }
        }
        WireCustomer::New { name, email } => {
            if !uuid(&quote.customer_id)
                || !text(&name, 200, true)
                || name != trimmed(&quote.source.sender_name)
                || email != quote.source.sender_email
            {
                return Err(invalid());
            }
        }
    }
    let mut evidence = HashSet::new();
    let mut net = 0_i128;
    for line in plan.lines {
        if !valid_id(&line.article_id)
            || !valid_id(&line.article_revision)
            || !text(&line.description, 200, true)
            || !text(&line.unit, 40, true)
            || !text(&line.evidence, 600, true)
            || !quote.source.body.contains(&line.evidence)
            || !evidence.insert(line.evidence)
            || !(1..=1_000_000).contains(&line.quantity_milli)
            || !(0..=1_000_000_000).contains(&line.unit_price_cents)
            || !(0..=10_000).contains(&line.tax_rate_bp)
        {
            return Err(invalid());
        }
        let line_net =
            (i128::from(line.quantity_milli) * i128::from(line.unit_price_cents) + 500) / 1000;
        if line_net != i128::from(line.net_cents) {
            return Err(invalid());
        }
        net += line_net;
    }
    if net > 1_000_000_000_000 || net != i128::from(plan.net_cents) {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn parse_reservation_response(
    bytes: &[u8],
    expected: &QuoteExecutionSelection,
) -> AppResult<ReservationResponse> {
    selection(expected)?;
    match decode::<ReservationWire>(bytes)? {
        ReservationWire::Reserved {
            schema_version,
            canonical_plan_json,
            proposal_id,
            fingerprint,
            reservation_id,
            source,
            actor,
            installation_id,
            expected_resources_hash,
            expected_context_revision,
            customer_id,
            quote_id,
            authorization_revision,
        } => {
            if schema_version != 1
                || proposal_id != expected.proposal_id
                || source.id != expected.source_id
            {
                return Err(invalid());
            }
            let quote = ReservedQuote {
                canonical_plan_json,
                proposal_id,
                fingerprint,
                reservation_id,
                source,
                actor,
                installation_id,
                expected_resources_hash,
                expected_context_revision,
                customer_id,
                quote_id,
                authorization_revision,
            };
            validate_reserved(&quote)?;
            Ok(ReservationResponse::Reserved(quote))
        }
        ReservationWire::Held {
            schema_version,
            proposal_id,
        } => {
            if schema_version != 1 || proposal_id != expected.proposal_id {
                return Err(invalid());
            }
            Ok(ReservationResponse::Held { proposal_id })
        }
        ReservationWire::RecoveryRequired {
            schema_version,
            proposal_id,
            reservation_id,
            fingerprint,
        } => {
            if schema_version != 1
                || proposal_id != expected.proposal_id
                || !uuid(&reservation_id)
                || !valid_hash(&fingerprint)
            {
                return Err(invalid());
            }
            Ok(ReservationResponse::RecoveryRequired {
                proposal_id,
                reservation_id,
                fingerprint,
            })
        }
        ReservationWire::Confirmed {
            schema_version,
            source_id,
            proposal_id,
            reservation_id,
            publication_snapshot_id,
            receipt,
        } => {
            if schema_version != 1
                || source_id != expected.source_id
                || proposal_id != expected.proposal_id
                || !uuid(&reservation_id)
                || !uuid(&publication_snapshot_id)
            {
                return Err(invalid());
            }
            Ok(ReservationResponse::Confirmed(
                ActionEngineQuoteConfirmation {
                    schema_version: 1,
                    state: "confirmed".into(),
                    source_id,
                    proposal_id,
                    reservation_id,
                    publication_snapshot_id,
                    receipt: receipt.capture(&expected.proposal_id)?,
                },
            ))
        }
    }
}

pub(crate) fn parse_confirmation_response(
    bytes: &[u8],
    expected: &QuoteExecutionSelection,
    reservation_id: &str,
    snapshot_id: &str,
) -> AppResult<ActionEngineQuoteConfirmation> {
    selection(expected)?;
    if !uuid(reservation_id) || !uuid(snapshot_id) {
        return Err(invalid());
    }
    let wire: ConfirmationWire = decode(bytes)?;
    if wire.schema_version != 1
        || wire.state != "confirmed"
        || wire.source_id != expected.source_id
        || wire.proposal_id != expected.proposal_id
        || wire.reservation_id != reservation_id
        || wire.publication_snapshot_id != snapshot_id
    {
        return Err(invalid());
    }
    Ok(ActionEngineQuoteConfirmation {
        schema_version: 1,
        state: "confirmed".into(),
        source_id: wire.source_id,
        proposal_id: wire.proposal_id,
        reservation_id: wire.reservation_id,
        publication_snapshot_id: wire.publication_snapshot_id,
        receipt: wire.receipt.capture(&expected.proposal_id)?,
    })
}

pub(crate) fn reserve_request(expected: &QuoteExecutionSelection) -> AppResult<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        schema_version: u32,
        operation: &'static str,
        source_id: &'a str,
        proposal_id: &'a str,
    }
    selection(expected)?;
    serde_json::to_vec(&Request {
        schema_version: 1,
        operation: "reserve",
        source_id: &expected.source_id,
        proposal_id: &expected.proposal_id,
    })
    .map_err(|_| invalid())
}

pub(crate) fn confirmation_request(
    expected: &QuoteExecutionSelection,
    reservation_id: &str,
    snapshot_id: &str,
) -> AppResult<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        schema_version: u32,
        operation: &'static str,
        source_id: &'a str,
        proposal_id: &'a str,
        reservation_id: &'a str,
        publication_snapshot_id: &'a str,
    }
    selection(expected)?;
    if !uuid(reservation_id) || !uuid(snapshot_id) {
        return Err(invalid());
    }
    serde_json::to_vec(&Request {
        schema_version: 1,
        operation: "confirm",
        source_id: &expected.source_id,
        proposal_id: &expected.proposal_id,
        reservation_id,
        publication_snapshot_id: snapshot_id,
    })
    .map_err(|_| invalid())
}

impl ReservedQuote {
    pub(crate) fn into_input(
        self,
        expected_workspace_scope: String,
        expected_member_context_nonce: String,
    ) -> AppResult<ActionEngineQuoteInput> {
        validate_reserved(&self)?;
        if !uuid(&expected_workspace_scope)
            || expected_member_context_nonce.len() != 32
            || !expected_member_context_nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }
        // The authorization revision is a checked opaque server fact. It is
        // not the planning context, a local generation or remote permission.
        Ok(ActionEngineQuoteInput {
            canonical_plan_json: self.canonical_plan_json,
            proposal_id: self.proposal_id,
            fingerprint: self.fingerprint,
            reservation_id: self.reservation_id,
            source: self.source,
            actor: self.actor,
            installation_id: self.installation_id,
            expected_workspace_scope,
            expected_member_context_nonce,
            expected_resources_hash: self.expected_resources_hash,
            expected_context_revision: self.expected_context_revision,
            customer_id: self.customer_id,
            quote_id: self.quote_id,
        })
    }
}

#[cfg(test)]
#[path = "action_engine_device_protocol_tests.rs"]
mod tests;

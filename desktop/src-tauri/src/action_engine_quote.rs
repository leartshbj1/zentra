//! Private Action Engine adapter. No IPC, network, issue, send or posting path.
//!
//! A future authenticated caller MUST fetch the current central reservation and
//! admission before supplying this closed input. Local identity/licence checks
//! do not establish a remote Automation entitlement or source/publication age.
use std::collections::HashSet;

use chrono::{Days, Local};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::{
    action_engine_resources::{
        article_revision, customer_revision, export_resources, resource_hash,
    },
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{AppError, AppResult},
};

// The production writer checks this under its IMMEDIATE transaction, after
// exact historical replay. Errors are errors; an orphan or unexpected state
// must not be filtered into permission to create another local draft.
const RECOVERY_PENDING_SQL: &str = r#"SELECT EXISTS(SELECT 1 FROM company_local_action_engine_quote_outbox WHERE organization_id=? AND state<>'confirmed') AS recovery_pending"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteActor {
    pub(crate) organization_id: String,
    pub(crate) user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteSource {
    pub(crate) id: String,
    pub(crate) revision: String,
    pub(crate) organization_id: String,
    pub(crate) sender_email: String,
    pub(crate) sender_name: String,
    pub(crate) subject: String,
    pub(crate) body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteInput {
    pub(crate) canonical_plan_json: String,
    pub(crate) proposal_id: String,
    pub(crate) fingerprint: String,
    pub(crate) reservation_id: String,
    pub(crate) source: ActionEngineQuoteSource,
    pub(crate) actor: ActionEngineQuoteActor,
    pub(crate) installation_id: String,
    pub(crate) expected_workspace_scope: String,
    pub(crate) expected_member_context_nonce: String,
    pub(crate) expected_resources_hash: String,
    pub(crate) expected_context_revision: String,
    pub(crate) customer_id: String,
    pub(crate) quote_id: String,
}

/// The original creation fact stays unnumbered/draft even after later editing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteReceipt {
    pub(crate) organization_id: String,
    pub(crate) proposal_id: String,
    pub(crate) fingerprint: String,
    pub(crate) customer_id: String,
    pub(crate) quote_id: String,
    pub(crate) quote_number: Option<String>,
    pub(crate) status: String,
    pub(crate) requires_human_validation: bool,
}

/// Recovery selectors, not a write input or remote permission. The caller must
/// capture the physical workspace/member generations before any network wait.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEngineQuoteRecoverySelection {
    pub(crate) source_id: String,
    pub(crate) proposal_id: String,
    pub(crate) reservation_id: String,
    pub(crate) fingerprint: String,
    pub(crate) actor: ActionEngineQuoteActor,
    pub(crate) installation_id: String,
    pub(crate) expected_workspace_scope: String,
    pub(crate) expected_member_context_nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActionEngineLocalQuoteOutboxState {
    Pending,
    Uncertain,
    Confirmed,
}

/// A local historical fact only. Even local_outbox_state=Confirmed does not
/// certify A7 evidence, grant an execution, or describe the current document.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionEngineRecoveredQuote {
    pub(crate) receipt: ActionEngineQuoteReceipt,
    pub(crate) reservation_id: String,
    pub(crate) receipt_sha256: String,
    pub(crate) local_outbox_state: ActionEngineLocalQuoteOutboxState,
    pub(crate) attempt_count: i64,
}

// Unlike Option<String>, this field cannot silently deserialize a missing
// quoteNumber. A recovery record must contain the explicit original JSON null.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryReceipt {
    organization_id: String,
    proposal_id: String,
    fingerprint: String,
    customer_id: String,
    quote_id: String,
    quote_number: RequiredNull,
    status: String,
    requires_human_validation: bool,
}
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
impl RecoveryReceipt {
    fn receipt(self) -> AppResult<ActionEngineQuoteReceipt> {
        let RequiredNull = self.quote_number;
        if self.status != "draft" || !self.requires_human_validation {
            return Err(recovery_uncertain());
        }
        Ok(ActionEngineQuoteReceipt {
            organization_id: self.organization_id,
            proposal_id: self.proposal_id,
            fingerprint: self.fingerprint,
            customer_id: self.customer_id,
            quote_id: self.quote_id,
            quote_number: None,
            status: self.status,
            requires_human_validation: self.requires_human_validation,
        })
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryOutboxPayload {
    organization_id: String,
    proposal_id: String,
    reservation_id: String,
    fingerprint: String,
    customer_id: String,
    quote_id: String,
    receipt_sha256: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryAuditPayload {
    receipt: RecoveryReceipt,
    reservation_id: String,
    request_sha256: String,
    quantity_milli: Vec<i64>,
    net_cents: i64,
    vat_cents: i64,
    total_cents: i64,
    creation_json: String,
    creation_sha256: String,
}

struct RecoveryRecord {
    organization_id: String,
    source_id: String,
    action_kind: String,
    proposal_id: String,
    reservation_id: String,
    fingerprint: String,
    request_sha256: String,
    resources_sha256: String,
    context_revision: String,
    actor_user_id: String,
    installation_id: String,
    customer_id: String,
    quote_id: String,
    plan_json: String,
    receipt_json: String,
    receipt_sha256: String,
    created_at: String,
}
struct VerifiedRecoveryRecord {
    receipt: ActionEngineQuoteReceipt,
    creation: QuoteCreation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotePlan {
    schema_version: i64,
    engine_version: String,
    kind: String,
    organization_id: String,
    context_revision: String,
    source_id: String,
    source_revision: String,
    status: String,
    reasons: Vec<String>,
    customer: Option<PlannedCustomer>,
    title: String,
    currency: String,
    lines: Vec<PlannedLine>,
    net_cents: i64,
    confidence: Option<f64>,
    requires_human_validation: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum PlannedCustomer {
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlannedLine {
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

/// Canonical creation evidence is serialized directly from these typed structs,
/// in declaration order, with compact serde JSON. Its exact UTF-8 bytes are
/// stored as creationJson in the append-only audit event, never reserialized
/// through a Value/map to produce creationSha256. Only this allowlist is shared;
/// no private notes, bank data, local generation or raw source mail is included.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuoteCreation {
    version: u8,
    source_canonical_sha256: String,
    customer_created: bool,
    customer: CreationCustomer,
    quote: CreationQuote,
    lines: Vec<CreationLine>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreationCustomer {
    id: String,
    name: String,
    email: Option<String>,
    country: String,
    archived_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreationQuote {
    id: String,
    client_id: String,
    project_id: Option<String>,
    number: Option<String>,
    title: String,
    status: String,
    issue_date: String,
    valid_until: String,
    currency: String,
    subtotal_cents: i64,
    discount_cents: i64,
    vat_cents: i64,
    total_cents: i64,
    notes: Option<String>,
    terms: Option<String>,
    snapshot_json: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreationLine {
    id: String,
    quote_id: String,
    catalog_item_id: String,
    position: i64,
    description: String,
    quantity_milli: i64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    line_net_cents: i64,
    line_vat_cents: i64,
    line_total_cents: i64,
    created_at: String,
    updated_at: String,
}

fn reject(code: &str) -> AppError {
    AppError::Validation(format!(
        "[action_engine:{code}] L’action privée doit être vérifiée avant de continuer."
    ))
}
fn recovery_uncertain() -> AppError {
    reject("recovery_uncertain")
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_alphanumeric() || (i > 0 && matches!(c, b'_' | b'.' | b':' | b'@' | b'-'))
        })
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value && id.get_version_num() == 4)
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
            .any(|c| matches!(c, '\0' | '\u{b}' | '\u{c}' | '\u{7f}'))
}
fn sha(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn normalized_email(value: &str) -> String {
    trimmed(value).to_ascii_lowercase()
}
fn valid_email(value: &str) -> bool {
    value.len() <= 254 && regex::Regex::new(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$")
        .expect("constant email expression").is_match(value)
}
fn title(subject: &str) -> AppResult<String> {
    let units: Vec<u16> = trimmed(subject).encode_utf16().take(160).collect();
    let result = String::from_utf16(&units).map_err(|_| reject("invalid_record"))?;
    Ok(if result.is_empty() {
        "Quote".into()
    } else {
        result
    })
}
fn amount(quantity: i64, price: i64, tax_bp: i64) -> AppResult<(i64, i64, i64)> {
    if !(1..=1_000_000).contains(&quantity)
        || !(0..=1_000_000_000).contains(&price)
        || !(0..=10_000).contains(&tax_bp)
    {
        return Err(reject("invalid_record"));
    }
    let net = (i128::from(quantity) * i128::from(price) + 500) / 1000;
    let tax = (net * i128::from(tax_bp) + 5000) / 10_000;
    let total = net + tax;
    if total > 1_000_000_000_000 {
        return Err(reject("invalid_record"));
    }
    Ok((net as i64, tax as i64, total as i64))
}
fn normalized_words(value: &str) -> String {
    value
        .nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn number_word(word: &str) -> Option<i64> {
    Some(match word {
        "un" | "une" | "one" | "eins" | "ein" | "eine" | "einen" | "einem" | "eines" | "uno"
        | "una" => 1,
        "deux" | "two" | "zwei" | "due" => 2,
        "trois" | "three" | "drei" | "tre" => 3,
        "quatre" | "four" | "vier" | "quattro" => 4,
        "cinq" | "five" | "funf" | "cinque" => 5,
        "six" | "sechs" | "sei" => 6,
        "sept" | "seven" | "sieben" | "sette" => 7,
        "huit" | "eight" | "acht" | "otto" => 8,
        "neuf" | "nine" | "neun" | "nove" => 9,
        "dix" | "ten" | "zehn" | "dieci" => 10,
        "onze" | "eleven" | "elf" | "undici" => 11,
        "douze" | "twelve" | "zwolf" | "dodici" => 12,
        _ => return None,
    })
}
/// Bounded counterpart of core parseQuoteQuantity. No locale or model may
/// resolve a thousands separator, multiple quantities or absent evidence.
fn parse_quantity(evidence: &str, skus: &[&str]) -> Option<i64> {
    let mut remaining = evidence.to_owned();
    for sku in skus {
        if sku.is_empty()
            || !sku.chars().any(char::is_alphabetic)
            || !remaining.to_lowercase().contains(&sku.to_lowercase())
        {
            continue;
        }
        let expression = regex::RegexBuilder::new(&regex::escape(sku))
            .case_insensitive(true)
            .build()
            .ok()?;
        let mut masked = String::new();
        let mut at = 0;
        for found in expression.find_iter(&remaining) {
            if remaining[..found.start()]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric)
                || remaining[found.end()..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphanumeric)
            {
                continue;
            }
            masked.push_str(&remaining[at..found.start()]);
            masked.push_str(&" ".repeat(found.len()));
            at = found.end();
        }
        masked.push_str(&remaining[at..]);
        remaining = masked;
    }
    let expression =
        regex::Regex::new(r"[+-]?(?:[0-9]+(?:[.,][0-9]+)?|[.,][0-9]+)(?:[eE][+-]?[0-9]+)?")
            .expect("constant number expression");
    let canonical = regex::Regex::new(r"^(?:0|[1-9][0-9]*)(?:[.,][0-9]{1,3})?$")
        .expect("constant decimal expression");
    let ambiguous =
        regex::Regex::new(r"^[1-9][0-9]{0,2}[.,][0-9]{3}$").expect("constant grouping expression");
    let mut values = Vec::new();
    for found in expression.find_iter(&remaining) {
        let boundary = |c: char| c.is_alphanumeric() || c == '_';
        if remaining[..found.start()]
            .chars()
            .next_back()
            .is_some_and(boundary)
            || remaining[found.end()..]
                .chars()
                .next()
                .is_some_and(boundary)
        {
            continue;
        }
        let literal = found.as_str();
        if !canonical.is_match(literal) || ambiguous.is_match(literal) {
            values.push(None);
            continue;
        }
        let dotted = literal.replace(',', '.');
        let mut parts = dotted.split('.');
        let whole = parts.next()?.parse::<i128>().ok();
        let fraction = parts.next().unwrap_or("");
        let fractional = format!("{fraction:0<3}").parse::<i128>().ok();
        let milli = whole
            .zip(fractional)
            .and_then(|(w, f)| w.checked_mul(1000)?.checked_add(f));
        values.push(
            milli
                .filter(|m| (1..=1_000_000).contains(m))
                .map(|m| m as i64),
        );
    }
    let words = regex::Regex::new(r"\p{L}+").expect("constant word expression");
    for found in words.find_iter(&remaining) {
        let word = normalized_words(found.as_str());
        let Some(number) = number_word(&word) else {
            continue;
        };
        let after = normalized_words(&remaining[found.end()..]);
        if number == 1
            && after.split_whitespace().next().is_some_and(|w| {
                matches!(
                    w,
                    "devis"
                        | "offre"
                        | "quote"
                        | "quotation"
                        | "estimate"
                        | "angebot"
                        | "offerte"
                        | "kostenvoranschlag"
                        | "preventivo"
                        | "offerta"
                )
            })
        {
            continue;
        }
        values.push(Some(number * 1000));
    }
    if values.len() == 1 {
        values[0]
    } else {
        None
    }
}
fn validate_input(input: &ActionEngineQuoteInput) -> AppResult<QuotePlan> {
    for id in [
        &input.proposal_id,
        &input.source.id,
        &input.source.revision,
        &input.actor.organization_id,
        &input.actor.user_id,
        &input.expected_context_revision,
        &input.customer_id,
    ] {
        if !valid_id(id) {
            return Err(reject("invalid_record"));
        }
    }
    if !canonical_uuid(&input.reservation_id)
        || !canonical_uuid(&input.quote_id)
        || !canonical_uuid(&input.installation_id)
        || !canonical_uuid(&input.expected_workspace_scope)
        || input.expected_member_context_nonce.len() != 32
        || !input
            .expected_member_context_nonce
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || !valid_hash(&input.fingerprint)
        || !valid_hash(&input.expected_resources_hash)
        || input.canonical_plan_json.len() > 65_536
        || sha(input.canonical_plan_json.as_bytes()) != input.fingerprint
        || input.source.organization_id != input.actor.organization_id
        || normalized_email(&input.source.sender_email) != input.source.sender_email
        || !valid_email(&input.source.sender_email)
        || !text(&input.source.sender_name, 200, false)
        || !text(&input.source.subject, 300, false)
        || !text(&input.source.body, 3000, false)
    {
        return Err(reject("invalid_record"));
    }
    // Typed deserialization rejects duplicate struct fields and unknown keys.
    // Hash the original TS canonical bytes, never a serde Value reserialization.
    let plan: QuotePlan =
        serde_json::from_str(&input.canonical_plan_json).map_err(|_| reject("invalid_record"))?;
    if plan.schema_version != 1
        || plan.engine_version != "action-engine-quote-v1"
        || plan.kind != "prepare_quote_draft"
        || plan.organization_id != input.actor.organization_id
        || plan.context_revision != input.expected_context_revision
        || plan.source_id != input.source.id
        || plan.source_revision != input.source.revision
        || plan.currency != "CHF"
        || !plan.requires_human_validation
        || plan.title != title(&input.source.subject)?
        || !text(&plan.title, 160, true)
    {
        return Err(reject("invalid_record"));
    }
    if plan.status != "ready" {
        return Err(reject("review_required"));
    }
    if !plan.reasons.is_empty()
        || plan.customer.is_none()
        || plan.lines.is_empty()
        || plan.lines.len() > 8
        || !plan
            .confidence
            .is_some_and(|c| c.is_finite() && (0.95..=1.0).contains(&c))
    {
        return Err(reject("invalid_record"));
    }
    match plan.customer.as_ref().unwrap() {
        PlannedCustomer::Existing { id, revision, name } => {
            if id != &input.customer_id || !valid_id(revision) || !text(name, 200, true) {
                return Err(reject("invalid_record"));
            }
        }
        PlannedCustomer::New { name, email } => {
            if !canonical_uuid(&input.customer_id)
                || !text(name, 200, true)
                || name != trimmed(&input.source.sender_name)
                || email != &input.source.sender_email
            {
                return Err(reject("invalid_record"));
            }
        }
    }
    let mut evidence = HashSet::new();
    let mut net = 0_i128;
    for line in &plan.lines {
        if !valid_id(&line.article_id)
            || !valid_id(&line.article_revision)
            || !text(&line.description, 200, true)
            || !text(&line.unit, 40, true)
            || !text(&line.evidence, 600, true)
            || !input.source.body.contains(&line.evidence)
            || !evidence.insert(line.evidence.as_str())
        {
            return Err(reject("invalid_record"));
        }
        let calculated = amount(line.quantity_milli, line.unit_price_cents, line.tax_rate_bp)?;
        if calculated.0 != line.net_cents {
            return Err(reject("invalid_record"));
        }
        net += i128::from(calculated.0);
    }
    if net > 1_000_000_000_000 || net != i128::from(plan.net_cents) {
        return Err(reject("invalid_record"));
    }
    Ok(plan)
}

/// The disposable local origin generations are fresh guards, not part of the
/// permanent request identity. Neither nonce nor full mail is persisted here.
fn request_hash(input: &ActionEngineQuoteInput) -> AppResult<String> {
    let source_hash = source_canonical_hash(&input.source)?;
    Ok(sha(&serde_json::to_vec(&json!([
        1,
        input.actor.organization_id,
        input.actor.user_id,
        input.installation_id,
        input.proposal_id,
        input.reservation_id,
        input.fingerprint,
        source_hash,
        input.expected_resources_hash,
        input.expected_context_revision,
        input.customer_id,
        input.quote_id
    ]))?))
}

/// ActionEngineQuoteSource declaration order is part of this cross-language
/// contract: id, revision, organizationId, senderEmail, senderName, subject, body.
fn source_canonical_hash(source: &ActionEngineQuoteSource) -> AppResult<String> {
    Ok(sha(&serde_json::to_vec(source)?))
}
fn require_origin(
    tx: &Transaction<'_>,
    store: &LocalStore,
    input: &ActionEngineQuoteInput,
) -> AppResult<()> {
    require_local_quote_origin(
        tx,
        store,
        &input.actor,
        &input.installation_id,
        &input.expected_workspace_scope,
        &input.expected_member_context_nonce,
    )
}
pub(crate) fn require_local_quote_origin(
    tx: &Transaction<'_>,
    store: &LocalStore,
    actor: &ActionEngineQuoteActor,
    installation_id: &str,
    workspace_scope: &str,
    member_context_nonce: &str,
) -> AppResult<()> {
    if installation_id != store.installation_id
        || crate::work_notes::workspace_scope(tx)? != workspace_scope
    {
        return Err(reject("forbidden"));
    }
    crate::member_context::require_unchanged(tx, Some(member_context_nonce))
        .map_err(|_| reject("forbidden"))?;
    let identity: Option<(String, String, String)> = tx
        .query_row(
            "SELECT organization_id,user_id,role FROM company_local_identity WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if !identity.is_some_and(|(org, user, role)| {
        org == actor.organization_id
            && user == actor.user_id
            && matches!(role.as_str(), "owner" | "admin" | "accountant" | "member")
    }) {
        return Err(reject("forbidden"));
    }
    Ok(())
}
fn read_receipt(
    tx: &Transaction<'_>,
    input: &ActionEngineQuoteInput,
    request_sha: &str,
) -> AppResult<Option<ActionEngineQuoteReceipt>> {
    struct Previous {
        proposal: String,
        reservation: String,
        fingerprint: String,
        request: String,
        plan: String,
        receipt: String,
        receipt_sha: String,
        resources_sha: String,
        context: String,
        user: String,
        installation: String,
        customer: String,
        quote: String,
    }
    let previous: Option<Previous> = tx.query_row(
        "SELECT proposal_id,reservation_id,fingerprint,request_sha256,plan_json,receipt_json,receipt_sha256,
            resources_sha256,context_revision,actor_user_id,installation_id,customer_id,quote_id
         FROM action_engine_quote_receipts WHERE organization_id=? AND source_id=? AND action_kind='prepare_quote_draft'",
        params![input.actor.organization_id, input.source.id],
        |row| Ok(Previous { proposal: row.get(0)?, reservation: row.get(1)?, fingerprint: row.get(2)?,
            request: row.get(3)?, plan: row.get(4)?, receipt: row.get(5)?, receipt_sha: row.get(6)?,
            resources_sha: row.get(7)?, context: row.get(8)?, user: row.get(9)?, installation: row.get(10)?,
            customer: row.get(11)?, quote: row.get(12)? }),
    ).optional()?;
    let Some(previous) = previous else {
        return Ok(None);
    };
    if previous.proposal != input.proposal_id
        || previous.reservation != input.reservation_id
        || previous.fingerprint != input.fingerprint
        || previous.request != request_sha
        || previous.plan != input.canonical_plan_json
    {
        return Err(reject("conflict"));
    }
    let receipt: ActionEngineQuoteReceipt =
        serde_json::from_str(&previous.receipt).map_err(|_| reject("invalid_record"))?;
    if sha(previous.plan.as_bytes()) != previous.fingerprint
        || sha(previous.receipt.as_bytes()) != previous.receipt_sha
        || previous.resources_sha != input.expected_resources_hash
        || previous.context != input.expected_context_revision
        || previous.user != input.actor.user_id
        || previous.installation != input.installation_id
        || previous.customer != input.customer_id
        || previous.quote != input.quote_id
        || receipt.organization_id != input.actor.organization_id
        || receipt.proposal_id != previous.proposal
        || receipt.fingerprint != previous.fingerprint
        || receipt.customer_id != input.customer_id
        || receipt.quote_id != input.quote_id
        || receipt.quote_number.is_some()
        || receipt.status != "draft"
        || !receipt.requires_human_validation
    {
        return Err(reject("invalid_record"));
    }
    Ok(Some(receipt))
}

// Read borrowed SQLite text only after checking its storage class/byte budget.
// No corruption is repaired, coerced, or mistaken for a missing local commit.
fn recovery_text(row: &rusqlite::Row<'_>, at: usize, max: usize) -> AppResult<String> {
    match row.get_ref(at)? {
        rusqlite::types::ValueRef::Text(bytes) if !bytes.is_empty() && bytes.len() <= max => {
            std::str::from_utf8(bytes)
                .map(str::to_owned)
                .map_err(|_| recovery_uncertain())
        }
        _ => Err(recovery_uncertain()),
    }
}
fn recovery_time(value: &str) -> AppResult<chrono::DateTime<chrono::FixedOffset>> {
    if !text(value, 128, true) {
        return Err(recovery_uncertain());
    }
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| recovery_uncertain())
}
fn read_recovery_record(
    connection: &rusqlite::Connection,
    organization_id: &str,
    proposal_id: &str,
) -> AppResult<Option<RecoveryRecord>> {
    let mut statement = connection.prepare(
        "SELECT organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,
          request_sha256,resources_sha256,context_revision,actor_user_id,installation_id,
          customer_id,quote_id,plan_json,receipt_json,receipt_sha256,created_at
         FROM action_engine_quote_receipts WHERE organization_id=? AND proposal_id=? LIMIT 2",
    )?;
    let mut rows = statement.query(params![organization_id, proposal_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let record = RecoveryRecord {
        organization_id: recovery_text(row, 0, 160)?,
        source_id: recovery_text(row, 1, 160)?,
        action_kind: recovery_text(row, 2, 32)?,
        proposal_id: recovery_text(row, 3, 160)?,
        reservation_id: recovery_text(row, 4, 36)?,
        fingerprint: recovery_text(row, 5, 64)?,
        request_sha256: recovery_text(row, 6, 64)?,
        resources_sha256: recovery_text(row, 7, 64)?,
        context_revision: recovery_text(row, 8, 160)?,
        actor_user_id: recovery_text(row, 9, 160)?,
        installation_id: recovery_text(row, 10, 36)?,
        customer_id: recovery_text(row, 11, 160)?,
        quote_id: recovery_text(row, 12, 36)?,
        plan_json: recovery_text(row, 13, 65_536)?,
        receipt_json: recovery_text(row, 14, 4096)?,
        receipt_sha256: recovery_text(row, 15, 64)?,
        created_at: recovery_text(row, 16, 128)?,
    };
    if rows.next()?.is_some() {
        return Err(recovery_uncertain());
    }
    Ok(Some(record))
}

/// Verify immutable local history without consulting today's catalogue,
/// customers or document. The checksums are not a canonical server authority.
fn verify_recovery_record(
    connection: &rusqlite::Connection,
    record: &RecoveryRecord,
) -> AppResult<VerifiedRecoveryRecord> {
    if [
        &record.organization_id,
        &record.source_id,
        &record.proposal_id,
        &record.context_revision,
        &record.actor_user_id,
        &record.customer_id,
    ].iter().any(|value| !valid_id(value))
        || [&record.reservation_id, &record.installation_id, &record.quote_id]
            .iter().any(|value| !canonical_uuid(value))
        || [&record.fingerprint, &record.request_sha256, &record.resources_sha256, &record.receipt_sha256]
            .iter().any(|value| !valid_hash(value))
        || record.action_kind != "prepare_quote_draft"
        || sha(record.plan_json.as_bytes()) != record.fingerprint
        || sha(record.receipt_json.as_bytes()) != record.receipt_sha256
    {
        return Err(recovery_uncertain());
    }
    recovery_time(&record.created_at)?;
    let receipt = serde_json::from_str::<RecoveryReceipt>(&record.receipt_json)
        .map_err(|_| recovery_uncertain())?.receipt()?;
    if receipt.organization_id != record.organization_id
        || receipt.proposal_id != record.proposal_id
        || receipt.fingerprint != record.fingerprint
        || receipt.customer_id != record.customer_id
        || receipt.quote_id != record.quote_id
        || serde_json::to_string(&receipt)? != record.receipt_json
    {
        return Err(recovery_uncertain());
    }
    let plan: QuotePlan = serde_json::from_str(&record.plan_json).map_err(|_| recovery_uncertain())?;
    if plan.schema_version != 1 || plan.engine_version != "action-engine-quote-v1"
        || plan.kind != record.action_kind || plan.organization_id != record.organization_id
        || plan.source_id != record.source_id || !valid_id(&plan.source_revision)
        || plan.context_revision != record.context_revision || plan.status != "ready"
        || !plan.reasons.is_empty() || !plan.requires_human_validation || plan.currency != "CHF"
        || !text(&plan.title, 160, true) || plan.lines.is_empty() || plan.lines.len() > 8
        || !plan.confidence.is_some_and(|v| v.is_finite() && (0.95..=1.0).contains(&v))
    {
        return Err(recovery_uncertain());
    }
    let mut statement = connection.prepare(
        "SELECT id,occurred_at,actor,payload_json,previous_hash,entry_hash FROM audit_log
         WHERE action='create' AND entity_type='action_engine_quote' AND entity_id=? LIMIT 2",
    )?;
    let mut rows = statement.query([&record.quote_id])?;
    let row = rows.next()?.ok_or_else(recovery_uncertain)?;
    let audit_id = recovery_text(row, 0, 36)?;
    let occurred_at = recovery_text(row, 1, 128)?;
    let actor = recovery_text(row, 2, 160)?;
    // Native creationJson is <=64KiB; string escaping can double its bytes.
    let payload_json = recovery_text(row, 3, 2 * 65_536 + 8192)?;
    let previous_hash = match row.get_ref(4)? {
        rusqlite::types::ValueRef::Null => None,
        _ => Some(recovery_text(row, 4, 64)?),
    };
    let entry_hash = recovery_text(row, 5, 64)?;
    // Audit time is recorded by a separate native clock read; an OS clock
    // correction does not invalidate an otherwise exact creation receipt.
    recovery_time(&occurred_at)?;
    if rows.next()?.is_some() || !canonical_uuid(&audit_id) || actor != "local_user"
        || !valid_hash(&entry_hash) || previous_hash.as_ref().is_some_and(|v| !valid_hash(v))
        || sha(format!("{}\n{}\n{}\n{}\ncreate\naction_engine_quote\n{}\n{}",
            previous_hash.as_deref().unwrap_or(""), audit_id, occurred_at, actor,
            record.quote_id, payload_json).as_bytes()) != entry_hash
    {
        return Err(recovery_uncertain());
    }
    let payload: RecoveryAuditPayload = serde_json::from_str(&payload_json)
        .map_err(|_| recovery_uncertain())?;
    if payload.creation_json.len() > 65_536 || !valid_hash(&payload.creation_sha256)
        || sha(payload.creation_json.as_bytes()) != payload.creation_sha256
        || payload.receipt.receipt()? != receipt || payload.reservation_id != record.reservation_id
        || payload.request_sha256 != record.request_sha256
    {
        return Err(recovery_uncertain());
    }
    let creation: QuoteCreation = serde_json::from_str(&payload.creation_json)
        .map_err(|_| recovery_uncertain())?;
    // Round-trip checks require all explicit null fields and native typed order.
    if serde_json::to_string(&creation)? != payload.creation_json
        || creation.version != 1 || !valid_hash(&creation.source_canonical_sha256)
        || creation.customer.id != record.customer_id || creation.customer.archived_at.is_some()
        || !text(&creation.customer.name, 200, true)
        || !creation.customer.email.as_deref().is_some_and(|email| valid_email(&normalized_email(email)))
        || creation.quote.id != record.quote_id || creation.quote.client_id != record.customer_id
        || creation.quote.project_id.is_some() || creation.quote.number.is_some()
        || creation.quote.status != "brouillon" || creation.quote.title != plan.title
        || creation.quote.currency != "CHF" || creation.quote.discount_cents != 0
        || creation.quote.notes.is_some() || creation.quote.terms.is_some()
        || creation.quote.snapshot_json.is_some() || creation.quote.created_at != record.created_at
        || creation.quote.updated_at != record.created_at || creation.lines.len() != plan.lines.len()
    {
        return Err(recovery_uncertain());
    }
    match plan.customer.as_ref().ok_or_else(recovery_uncertain)? {
        PlannedCustomer::Existing { id, revision, name } => {
            if creation.customer_created || id != &record.customer_id || !valid_id(revision)
                || name != &creation.customer.name {
                return Err(recovery_uncertain());
            }
        }
        PlannedCustomer::New { name, email } => {
            if !creation.customer_created || !canonical_uuid(&record.customer_id)
                || name != &creation.customer.name || !valid_email(email)
                || normalized_email(email) != *email || creation.customer.email.as_deref() != Some(email.as_str())
                || creation.customer.country != "CH"
                || creation.customer.created_at != record.created_at || creation.customer.updated_at != record.created_at {
                return Err(recovery_uncertain());
            }
        }
    }
    let request_sha = sha(&serde_json::to_vec(&json!([
        1, record.organization_id, record.actor_user_id, record.installation_id,
        record.proposal_id, record.reservation_id, record.fingerprint,
        creation.source_canonical_sha256, record.resources_sha256,
        record.context_revision, record.customer_id, record.quote_id,
    ]))?);
    if request_sha != record.request_sha256 {
        return Err(recovery_uncertain());
    }
    let mut totals = (0_i128, 0_i128, 0_i128);
    let mut evidence = HashSet::new();
    for (position, (line, planned)) in creation.lines.iter().zip(&plan.lines).enumerate() {
        let calculated = amount(planned.quantity_milli, planned.unit_price_cents, planned.tax_rate_bp)
            .map_err(|_| recovery_uncertain())?;
        if !valid_id(&planned.article_id) || !valid_id(&planned.article_revision)
            || !text(&planned.description, 200, true) || !text(&planned.unit, 40, true)
            || !text(&planned.evidence, 600, true) || !evidence.insert(&planned.evidence)
            || planned.net_cents != calculated.0
            || line.id != line_id_values(&record.proposal_id, &record.fingerprint, &record.quote_id, position)
            || line.quote_id != record.quote_id || line.catalog_item_id != planned.article_id
            || line.position != position as i64 || line.description != planned.description
            || line.quantity_milli != planned.quantity_milli || line.unit != planned.unit
            || line.unit_price_cents != planned.unit_price_cents || line.discount_bp != 0
            || line.vat_bp != planned.tax_rate_bp || line.line_net_cents != calculated.0
            || line.line_vat_cents != calculated.1 || line.line_total_cents != calculated.2
            || line.created_at != record.created_at || line.updated_at != record.created_at
        {
            return Err(recovery_uncertain());
        }
        totals.0 += i128::from(calculated.0);
        totals.1 += i128::from(calculated.1);
        totals.2 += i128::from(calculated.2);
    }
    if totals.2 > 1_000_000_000_000 || i128::from(plan.net_cents) != totals.0
        || i128::from(creation.quote.subtotal_cents) != totals.0
        || i128::from(creation.quote.vat_cents) != totals.1 || i128::from(creation.quote.total_cents) != totals.2
        || payload.quantity_milli != plan.lines.iter().map(|v| v.quantity_milli).collect::<Vec<_>>()
        || i128::from(payload.net_cents) != totals.0 || i128::from(payload.vat_cents) != totals.1
        || i128::from(payload.total_cents) != totals.2
    {
        return Err(recovery_uncertain());
    }
    Ok(VerifiedRecoveryRecord { receipt, creation })
}

fn line_id(input: &ActionEngineQuoteInput, position: usize) -> String {
    line_id_values(&input.proposal_id, &input.fingerprint, &input.quote_id, position)
}
fn line_id_values(proposal_id: &str, fingerprint: &str, quote_id: &str, position: usize) -> String {
    let material = format!(
        "action-engine-quote-line-v1\n{}\n{}\n{}\n{}",
        proposal_id, fingerprint, quote_id, position
    );
    let digest = Sha256::digest(material.as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

/// Read back actual stored business values in the same IMMEDIATE transaction.
/// The current rows may later be edited, issued or deleted; this creation event
/// will not change, and a historical replay must never fabricate another one.
fn quote_creation_json(
    tx: &Transaction<'_>,
    input: &ActionEngineQuoteInput,
    plan: &QuotePlan,
    customer_created: bool,
) -> AppResult<String> {
    let customer = tx.query_row(
        "SELECT id,name,email,country,archived_at,created_at,updated_at FROM clients WHERE id=?",
        [&input.customer_id],
        |row| Ok(CreationCustomer {
            id: row.get(0)?, name: row.get(1)?, email: row.get(2)?, country: row.get(3)?,
            archived_at: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?,
        }),
    )?;
    let quote = tx.query_row(
        "SELECT id,client_id,project_id,number,title,status,issue_date,valid_until,currency,
            subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,snapshot_json,created_at,updated_at
         FROM quotes WHERE id=?",
        [&input.quote_id],
        |row| Ok(CreationQuote {
            id: row.get(0)?, client_id: row.get(1)?, project_id: row.get(2)?, number: row.get(3)?,
            title: row.get(4)?, status: row.get(5)?, issue_date: row.get(6)?, valid_until: row.get(7)?,
            currency: row.get(8)?, subtotal_cents: row.get(9)?, discount_cents: row.get(10)?,
            vat_cents: row.get(11)?, total_cents: row.get(12)?, notes: row.get(13)?,
            terms: row.get(14)?, snapshot_json: row.get(15)?, created_at: row.get(16)?, updated_at: row.get(17)?,
        }),
    )?;
    let mut statement = tx.prepare(
        "SELECT id,quote_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,
            discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at
         FROM quote_items WHERE quote_id=? ORDER BY position,id COLLATE BINARY",
    )?;
    let rows = statement.query_map([&input.quote_id], |row| {
        Ok((CreationLine {
            id: row.get(0)?, quote_id: row.get(1)?, catalog_item_id: row.get(2)?, position: row.get(3)?,
            description: row.get(4)?, quantity_milli: 0, unit: row.get(6)?, unit_price_cents: row.get(7)?,
            discount_bp: row.get(8)?, vat_bp: row.get(9)?, line_net_cents: row.get(10)?,
            line_vat_cents: row.get(11)?, line_total_cents: row.get(12)?, created_at: row.get(13)?, updated_at: row.get(14)?,
        }, row.get::<_, f64>(5)?))
    })?.collect::<Result<Vec<_>, _>>()?;
    let expected_name = match plan.customer.as_ref().ok_or_else(|| reject("invalid_record"))? {
        PlannedCustomer::Existing { name, .. } | PlannedCustomer::New { name, .. } => name,
    };
    if customer.id != input.customer_id || customer.name != *expected_name
        || customer.archived_at.is_some()
        || customer.email.as_deref().map(normalized_email).as_deref() != Some(input.source.sender_email.as_str())
        || quote.id != input.quote_id || quote.client_id != input.customer_id
        || quote.project_id.is_some() || quote.number.is_some() || quote.status != "brouillon"
        || quote.title != plan.title || quote.currency != "CHF" || quote.discount_cents != 0
        || quote.notes.is_some() || quote.terms.is_some() || quote.snapshot_json.is_some()
        || rows.len() != plan.lines.len()
    {
        return Err(reject("invalid_record"));
    }
    let mut lines = Vec::with_capacity(rows.len());
    let mut totals = (0_i128, 0_i128, 0_i128);
    for (position, ((mut actual, quantity), planned)) in rows.into_iter().zip(&plan.lines).enumerate() {
        let calculated = amount(planned.quantity_milli, planned.unit_price_cents, planned.tax_rate_bp)?;
        if !quantity.is_finite() || quantity != planned.quantity_milli as f64 / 1000.0
            || actual.id != line_id(input, position) || actual.quote_id != input.quote_id
            || actual.catalog_item_id != planned.article_id || actual.position != position as i64
            || actual.description != planned.description || actual.unit != planned.unit
            || actual.unit_price_cents != planned.unit_price_cents || actual.discount_bp != 0
            || actual.vat_bp != planned.tax_rate_bp || actual.line_net_cents != calculated.0
            || actual.line_vat_cents != calculated.1 || actual.line_total_cents != calculated.2
        {
            return Err(reject("invalid_record"));
        }
        actual.quantity_milli = planned.quantity_milli;
        totals.0 += i128::from(actual.line_net_cents);
        totals.1 += i128::from(actual.line_vat_cents);
        totals.2 += i128::from(actual.line_total_cents);
        lines.push(actual);
    }
    if i128::from(quote.subtotal_cents) != totals.0 || i128::from(quote.vat_cents) != totals.1
        || i128::from(quote.total_cents) != totals.2
    {
        return Err(reject("invalid_record"));
    }
    let json = serde_json::to_string(&QuoteCreation {
        version: 1, source_canonical_sha256: source_canonical_hash(&input.source)?,
        customer_created, customer, quote, lines,
    })?;
    if json.len() > 65_536 {
        return Err(reject("invalid_record"));
    }
    Ok(json)
}

fn frozen_creation_rows_match(
    connection: &rusqlite::Connection,
    creation: &QuoteCreation,
) -> AppResult<bool> {
    let customer = connection.query_row(
        "SELECT id,name,email,country,archived_at,created_at,updated_at FROM clients WHERE id=?",
        [&creation.customer.id],
        |row| Ok(CreationCustomer {
            id: row.get(0)?, name: row.get(1)?, email: row.get(2)?, country: row.get(3)?,
            archived_at: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?,
        }),
    ).optional()?;
    if customer.as_ref() != Some(&creation.customer) {
        return Ok(false);
    }
    let quote = connection.query_row(
        "SELECT id,client_id,project_id,number,title,status,issue_date,valid_until,currency,
         subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,snapshot_json,created_at,updated_at
         FROM quotes WHERE id=?",
        [&creation.quote.id],
        |row| Ok(CreationQuote {
            id: row.get(0)?, client_id: row.get(1)?, project_id: row.get(2)?, number: row.get(3)?,
            title: row.get(4)?, status: row.get(5)?, issue_date: row.get(6)?, valid_until: row.get(7)?,
            currency: row.get(8)?, subtotal_cents: row.get(9)?, discount_cents: row.get(10)?,
            vat_cents: row.get(11)?, total_cents: row.get(12)?, notes: row.get(13)?, terms: row.get(14)?,
            snapshot_json: row.get(15)?, created_at: row.get(16)?, updated_at: row.get(17)?,
        }),
    ).optional()?;
    if quote.as_ref() != Some(&creation.quote) {
        return Ok(false);
    }
    let mut statement = connection.prepare(
        "SELECT id,quote_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,
         discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at
         FROM quote_items WHERE quote_id=? ORDER BY position,id COLLATE BINARY LIMIT 9",
    )?;
    let rows = statement.query_map([&creation.quote.id], |row| {
        Ok((CreationLine {
            id: row.get(0)?, quote_id: row.get(1)?, catalog_item_id: row.get(2)?, position: row.get(3)?,
            description: row.get(4)?, quantity_milli: 0, unit: row.get(6)?, unit_price_cents: row.get(7)?,
            discount_bp: row.get(8)?, vat_bp: row.get(9)?, line_net_cents: row.get(10)?,
            line_vat_cents: row.get(11)?, line_total_cents: row.get(12)?, created_at: row.get(13)?,
            updated_at: row.get(14)?,
        }, row.get::<_, f64>(5)?))
    })?.collect::<Result<Vec<_>, _>>()?;
    if rows.len() != creation.lines.len() {
        return Ok(false);
    }
    for ((mut actual, quantity), original) in rows.into_iter().zip(&creation.lines) {
        if !quantity.is_finite() || quantity != original.quantity_milli as f64 / 1000.0 {
            return Ok(false);
        }
        actual.quantity_milli = original.quantity_milli;
        if actual != *original {
            return Ok(false);
        }
    }
    Ok(true)
}

/// First-link eligibility on an already frozen, read-only archive connection.
/// False means an older archive or changed/deleted initial business rows, NOT
/// absence of a local commit. Corrupt receipt/audit/type/hash data is an error.
/// This local comparison is not the A6/A7 canonical server confirmation.
pub(crate) fn frozen_quote_publication_matches(
    connection: &rusqlite::Connection,
    organization_id: &str,
    proposal_id: &str,
    reservation_id: &str,
    fingerprint: &str,
    quote_id: &str,
    receipt_sha256: &str,
) -> AppResult<bool> {
    if !valid_id(organization_id) || !valid_id(proposal_id) || !canonical_uuid(reservation_id)
        || !valid_hash(fingerprint) || !canonical_uuid(quote_id) || !valid_hash(receipt_sha256) {
        return Err(reject("invalid_record"));
    }
    let checked = (|| -> AppResult<bool> {
        let Some(record) = read_recovery_record(connection, organization_id, proposal_id)? else {
            return Ok(false);
        };
        if record.organization_id != organization_id || record.proposal_id != proposal_id
            || record.reservation_id != reservation_id || record.fingerprint != fingerprint
            || record.quote_id != quote_id || record.receipt_sha256 != receipt_sha256 {
            return Err(recovery_uncertain());
        }
        let history = verify_recovery_record(connection, &record)?;
        frozen_creation_rows_match(connection, &history.creation)
    })();
    checked.map_err(|_| recovery_uncertain())
}

fn validate_recovery_selection(selection: &ActionEngineQuoteRecoverySelection) -> AppResult<()> {
    if [&selection.source_id, &selection.proposal_id, &selection.actor.organization_id,
        &selection.actor.user_id].iter().any(|value| !valid_id(value))
        || !canonical_uuid(&selection.reservation_id) || !valid_hash(&selection.fingerprint)
        || !canonical_uuid(&selection.installation_id)
        || !canonical_uuid(&selection.expected_workspace_scope)
        || selection.expected_member_context_nonce.len() != 32
        || !selection.expected_member_context_nonce.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return Err(reject("invalid_record"));
    }
    Ok(())
}

/// The caller owns this LocalStore's mutex and its IMMEDIATE transaction.
/// Reuse the exact historical recovery checks within an ACK/list transaction;
/// never acquire another lock, commit, write, repair, or consult current facts.
/// No canonical confirmation or remote authority is established by this read.
pub(crate) fn recover_action_engine_quote_receipt_in_transaction(
    tx: &Transaction<'_>,
    store: &LocalStore,
    selection: &ActionEngineQuoteRecoverySelection,
) -> AppResult<ActionEngineRecoveredQuote> {
    validate_recovery_selection(selection)?;
    store.require_onboarding(tx)?;
    require_local_quote_origin(tx, store, &selection.actor, &selection.installation_id,
        &selection.expected_workspace_scope, &selection.expected_member_context_nonce)?;
    let recovered = (|| -> AppResult<ActionEngineRecoveredQuote> {
        let record = read_recovery_record(tx, &selection.actor.organization_id, &selection.proposal_id)?
            .ok_or_else(recovery_uncertain)?;
        if record.organization_id != selection.actor.organization_id || record.source_id != selection.source_id
            || record.proposal_id != selection.proposal_id || record.reservation_id != selection.reservation_id
            || record.fingerprint != selection.fingerprint || record.actor_user_id != selection.actor.user_id
            || record.installation_id != selection.installation_id {
            return Err(recovery_uncertain());
        }
        let history = verify_recovery_record(tx, &record)?;
        let mut statement = tx.prepare(
            "SELECT organization_id,proposal_id,quote_id,fingerprint,payload_json,payload_sha256,
             state,attempt_count,created_at,updated_at FROM company_local_action_engine_quote_outbox
             WHERE organization_id=? AND proposal_id=? LIMIT 2",
        )?;
        let mut rows = statement.query(params![record.organization_id, record.proposal_id])?;
        let row = rows.next()?.ok_or_else(recovery_uncertain)?;
        let organization_id = recovery_text(row, 0, 160)?;
        let proposal_id = recovery_text(row, 1, 160)?;
        let quote_id = recovery_text(row, 2, 36)?;
        let fingerprint = recovery_text(row, 3, 64)?;
        let payload_json = recovery_text(row, 4, 4096)?;
        let payload_sha256 = recovery_text(row, 5, 64)?;
        let state = match recovery_text(row, 6, 16)?.as_str() {
            "pending" => ActionEngineLocalQuoteOutboxState::Pending,
            "uncertain" => ActionEngineLocalQuoteOutboxState::Uncertain,
            "confirmed" => ActionEngineLocalQuoteOutboxState::Confirmed,
            _ => return Err(recovery_uncertain()),
        };
        let attempt_count = match row.get_ref(7)? {
            rusqlite::types::ValueRef::Integer(value) if (0..=1_000_000).contains(&value) => value,
            _ => return Err(recovery_uncertain()),
        };
        let created_at = recovery_text(row, 8, 128)?;
        let updated_at = recovery_text(row, 9, 128)?;
        if rows.next()?.is_some() || organization_id != record.organization_id
            || proposal_id != record.proposal_id || quote_id != record.quote_id
            || fingerprint != record.fingerprint || !valid_hash(&payload_sha256)
            || sha(payload_json.as_bytes()) != payload_sha256 || created_at != record.created_at
            || recovery_time(&updated_at)? < recovery_time(&created_at)? {
            return Err(recovery_uncertain());
        }
        let payload: RecoveryOutboxPayload = serde_json::from_str(&payload_json)
            .map_err(|_| recovery_uncertain())?;
        if payload.organization_id != record.organization_id || payload.proposal_id != record.proposal_id
            || payload.reservation_id != record.reservation_id || payload.fingerprint != record.fingerprint
            || payload.customer_id != record.customer_id || payload.quote_id != record.quote_id
            || payload.receipt_sha256 != record.receipt_sha256 {
            return Err(recovery_uncertain());
        }
        Ok(ActionEngineRecoveredQuote {
            receipt: history.receipt, reservation_id: record.reservation_id,
            receipt_sha256: record.receipt_sha256, local_outbox_state: state, attempt_count,
        })
    })().map_err(|_| recovery_uncertain())?;
    Ok(recovered)
}

impl LocalStore {
    /// Recover an already-engaged execution using selectors only. Owns the
    /// mutex and an IMMEDIATE read transaction, so identity and receipt/outbox
    /// cannot be swapped between reads. No write, repair, retry or backfill.
    pub(crate) fn recover_action_engine_quote_receipt(
        &self,
        selection: ActionEngineQuoteRecoverySelection,
    ) -> AppResult<ActionEngineRecoveredQuote> {
        // Preserve malformed-selector rejection before any lock/database work.
        validate_recovery_selection(&selection)?;
        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recovered = recover_action_engine_quote_receipt_in_transaction(&tx, self, &selection)?;
        tx.commit()?;
        Ok(recovered)
    }

    /// Fixture-only entry point for existing multi-receipt repository tests.
    /// Production must use the strict recovery-first method below.
    #[cfg(test)]
    pub(crate) fn commit_action_engine_quote_draft(
        &self,
        input: ActionEngineQuoteInput,
    ) -> AppResult<ActionEngineQuoteReceipt> {
        self.commit_action_engine_quote_draft_impl(input, false)
    }

    /// Owns the one local mutex. The central permanent reservation is required
    /// caller-supplied evidence, not re-admitted here. An exact historical replay
    /// precedes the atomic guard; a new draft requires all local recovery done.
    pub(crate) fn commit_action_engine_quote_draft_after_recovery(
        &self,
        input: ActionEngineQuoteInput,
    ) -> AppResult<ActionEngineQuoteReceipt> {
        self.commit_action_engine_quote_draft_impl(input, true)
    }

    fn commit_action_engine_quote_draft_impl(
        &self,
        input: ActionEngineQuoteInput,
        recovery_first: bool,
    ) -> AppResult<ActionEngineQuoteReceipt> {
        let plan = validate_input(&input)?;
        let request_sha = request_hash(&input)?;
        let _guard = self.lock()?;
        self.require_write_access()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_onboarding(&tx)?;
        require_origin(&tx, self, &input)?;
        if let Some(receipt) = read_receipt(&tx, &input, &request_sha)? {
            tx.commit()?;
            return Ok(receipt);
        }
        if recovery_first {
            let pending: bool = tx.query_row(RECOVERY_PENDING_SQL,
                [&input.actor.organization_id], |row| row.get(0))?;
            if pending { return Err(reject("recovery_pending")); }
        }
        crate::company_collaboration::require_action_engine_quote_write_ready(
            self, &input.actor.organization_id,
        )?;
        let resources = export_resources(&tx)?;
        if resource_hash(&resources) != input.expected_resources_hash {
            return Err(reject("stale_plan"));
        }
        if resources.company.country != "CH"
            || resources.company.currency != "CHF"
            || !resources.company.onboarding_complete
        {
            return Err(reject("stale_plan"));
        }
        let matches: Vec<_> = resources
            .customers
            .iter()
            .filter(|c| {
                c.email
                    .as_deref()
                    .is_some_and(|email| normalized_email(email) == input.source.sender_email)
            })
            .collect();
        let active: Vec<_> = matches.iter().copied().filter(|c| !c.archived).collect();
        let create_customer = match plan.customer.as_ref().unwrap() {
            PlannedCustomer::Existing { id, revision, name } => {
                if active.len() != 1
                    || active[0].id != *id
                    || customer_revision(active[0]) != *revision
                    || active[0].name != *name
                {
                    return Err(reject("stale_plan"));
                }
                false
            }
            PlannedCustomer::New { .. } => {
                if !matches.is_empty() {
                    return Err(reject("stale_plan"));
                }
                true
            }
        };
        let collision: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM quotes WHERE id=?1) OR EXISTS(SELECT 1 FROM action_engine_quote_receipts WHERE organization_id=?2 AND (quote_id=?1 OR proposal_id=?3 OR reservation_id=?4))",
            params![input.quote_id, input.actor.organization_id, input.proposal_id, input.reservation_id], |r| r.get(0))?;
        if collision {
            return Err(reject("conflict"));
        }
        let mut totals = (0_i128, 0_i128, 0_i128);
        let mut amounts = Vec::new();
        let known_skus: Vec<&str> = resources
            .articles
            .iter()
            .filter(|a| !a.archived)
            .filter_map(|a| a.sku.as_deref())
            .collect();
        for line in &plan.lines {
            let article = resources
                .articles
                .iter()
                .find(|a| a.id == line.article_id)
                .ok_or_else(|| reject("stale_plan"))?;
            let effective_tax = if resources.company.vat_registered {
                article.tax_rate_bp
            } else {
                0
            };
            if article.archived
                || article_revision(article) != line.article_revision
                || article.name != line.description
                || article.unit != line.unit
                || article.unit_price_cents != line.unit_price_cents
                || effective_tax != line.tax_rate_bp
            {
                return Err(reject("stale_plan"));
            }
            if parse_quantity(&line.evidence, &known_skus) != Some(line.quantity_milli) {
                return Err(reject("invalid_record"));
            }
            let calculated = amount(line.quantity_milli, line.unit_price_cents, line.tax_rate_bp)?;
            totals.0 += i128::from(calculated.0);
            totals.1 += i128::from(calculated.1);
            totals.2 += i128::from(calculated.2);
            amounts.push(calculated);
        }
        if totals.0 != i128::from(plan.net_cents) || totals.2 > 1_000_000_000_000 {
            return Err(reject("invalid_record"));
        }
        let now = now_iso();
        // Ordinary CH-profile draft defaults use the device's local date, like
        // existing native drafts. A human must verify dates before any issue.
        let issue_date = Local::now().date_naive();
        let valid_until = issue_date
            .checked_add_days(Days::new(resources.company.quote_validity_days as u64))
            .ok_or_else(|| reject("invalid_record"))?;
        if create_customer {
            let PlannedCustomer::New { name, email } = plan.customer.as_ref().unwrap() else {
                unreachable!()
            };
            tx.execute("INSERT INTO clients(id,name,email,country,created_at,updated_at) VALUES(?,?,?,'CH',?,?)",
                params![input.customer_id, name, email, now, now])?;
            append_audit(
                &tx,
                "create",
                "clients",
                &input.customer_id,
                &json!({"source":"action_engine","proposalId":input.proposal_id,"name":name,"email":email}),
            )?;
        }
        tx.execute("INSERT INTO quotes(id,client_id,number,title,status,currency,issue_date,valid_until,subtotal_cents,discount_cents,vat_cents,total_cents,created_at,updated_at)
            VALUES(?,?,NULL,?,'brouillon','CHF',?,?,?,0,?,?,?,?)",
            params![input.quote_id, input.customer_id, plan.title,issue_date.to_string(),valid_until.to_string(),totals.0 as i64, totals.1 as i64, totals.2 as i64, now, now])?;
        for (position, (line, calculated)) in plan.lines.iter().zip(amounts).enumerate() {
            // REAL is an existing UI storage column only. Proof and every amount
            // above use integer thousandths/i128, never this representation.
            let display_quantity = line.quantity_milli as f64 / 1000.0;
            tx.execute("INSERT INTO quote_items(id,quote_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)",
                params![line_id(&input, position), input.quote_id, line.article_id, position as i64, line.description,
                    display_quantity, line.unit, line.unit_price_cents, line.tax_rate_bp, calculated.0, calculated.1, calculated.2, now, now])?;
        }
        let receipt = ActionEngineQuoteReceipt {
            organization_id: input.actor.organization_id.clone(),
            proposal_id: input.proposal_id.clone(),
            fingerprint: input.fingerprint.clone(),
            customer_id: input.customer_id.clone(),
            quote_id: input.quote_id.clone(),
            quote_number: None,
            status: "draft".into(),
            requires_human_validation: true,
        };
        let receipt_json = serde_json::to_string(&receipt)?;
        let receipt_sha = sha(receipt_json.as_bytes());
        tx.execute("INSERT INTO action_engine_quote_receipts(organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,request_sha256,resources_sha256,context_revision,actor_user_id,installation_id,customer_id,quote_id,plan_json,receipt_json,receipt_sha256,created_at)
            VALUES(?,?,'prepare_quote_draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![input.actor.organization_id, input.source.id, input.proposal_id, input.reservation_id,
                input.fingerprint, request_sha, input.expected_resources_hash, input.expected_context_revision,
                input.actor.user_id, input.installation_id, input.customer_id, input.quote_id,
                input.canonical_plan_json, receipt_json, receipt_sha, now])?;
        let creation_json = quote_creation_json(&tx, &input, &plan, create_customer)?;
        let creation_sha = sha(creation_json.as_bytes());
        append_audit(
            &tx,
            "create",
            "action_engine_quote",
            &input.quote_id,
            &json!({"receipt":receipt,"reservationId":input.reservation_id,"requestSha256":request_sha,
                "quantityMilli":plan.lines.iter().map(|l|l.quantity_milli).collect::<Vec<_>>(),
                "netCents":totals.0 as i64,"vatCents":totals.1 as i64,"totalCents":totals.2 as i64,
                "creationJson":creation_json,"creationSha256":creation_sha}),
        )?;
        // No nonce, token, name, email, mail body or price is queued.
        let outbox = json!({"organizationId":input.actor.organization_id,"proposalId":input.proposal_id,
            "reservationId":input.reservation_id,"fingerprint":input.fingerprint,
            "customerId":input.customer_id,"quoteId":input.quote_id,"receiptSha256":receipt_sha});
        tx.execute("INSERT INTO company_local_action_engine_quote_outbox(organization_id,proposal_id,quote_id,fingerprint,payload_json,payload_sha256,state,attempt_count,created_at,updated_at)
            VALUES(?,?,?,?,?,?,'pending',0,?,?)",
            params![input.actor.organization_id,input.proposal_id,input.quote_id,input.fingerprint,
                serde_json::to_string(&outbox)?,sha(&serde_json::to_vec(&outbox)?),now,now])?;
        tx.commit()?;
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "action_engine_quote_tests.rs"]
mod tests;

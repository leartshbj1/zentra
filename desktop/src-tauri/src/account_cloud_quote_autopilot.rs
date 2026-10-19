//! Product IPC boundary. The work round and protected account stamp never leave
//! native memory. Opening this compile-time gate requires a reviewed release;
//! neither environment variables nor WebView input can open it.
use super::*;
use futures_util::lock::Mutex;
use std::sync::Arc;

// Explicit build capability; all native and server authority checks still apply.
const PRODUCT_ENABLED: bool = cfg!(all(target_os = "windows", feature = "quote-autopilot-product"));
const CONSENT_PATH: &str = "/api/account/automation/quote-consent";
const ACTIVITY_PATH: &str = "/api/account/automation/quote-activity";
const REVIEW_PATH: &str = "/api/account/automation/quote-review";
const ALIAS_PATH: &str = "/api/account/automation/quote-alias";
const ACCEPT_PATH: &str = "/api/account/automation/quote-acceptances";
const SIGNALS_PATH: &str = "/api/account/automation/mail-signals";
const CONSENT_VERSION: &str = "action-engine-quote-draft-customer-2026-10-11";

#[derive(Default)]
pub(crate) struct Supervisor {
    round: Arc<Mutex<Option<QuoteWorkRound>>>,
    consent_write: Arc<Mutex<()>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Origin {
    expected_workspace_scope: String,
    expected_member_context_nonce: String,
    #[cfg(all(test, windows))]
    #[serde(skip)]
    test_frontdoor: Option<Arc<live_frontdoor::Grant>>,
}
impl Origin {
    fn valid(&self) -> bool {
        id(&self.expected_workspace_scope)
            && self.expected_member_context_nonce.len() == 32
            && self.expected_member_context_nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    fn matches(&self, stamp: &ActionStamp) -> bool {
        self.expected_workspace_scope == stamp.inbox.workspace_scope
            && self.expected_member_context_nonce == stamp.member_nonce
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    schema_version: u8,
    status: &'static str,
    code: &'static str,
    organization_id: Option<String>,
    workspace_scope: Option<String>,
    member_context_nonce: Option<String>,
}
impl Scope {
    fn refused(code: &'static str) -> Self {
        Self { schema_version: 1, status: match code {
            "product_gate_closed" => "unavailable", "context_changed" => "context_changed",
            "busy" => "busy", _ => "error",
        }, code, organization_id: None, workspace_scope: None, member_context_nonce: None }
    }
    fn admitted(status: &'static str, stamp: &ActionStamp) -> Self {
        Self { schema_version: 1, status, code: "none",
            organization_id: Some(stamp.inbox.session.organization_id.clone()),
            workspace_scope: Some(stamp.inbox.workspace_scope.clone()),
            member_context_nonce: Some(stamp.member_nonce.clone()) }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateReply { #[serde(flatten)] scope: Scope, can_manage: bool }
#[derive(Serialize)]
pub(crate) struct ReadReply { #[serde(flatten)] scope: Scope, data: Option<serde_json::Value> }
impl ReadReply {
    fn refused(code: &'static str) -> Self { Self { scope: Scope::refused(code), data: None } }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts { confirmed: usize, held: usize, review_required: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TickReply {
    #[serde(flatten)] scope: Scope,
    phase: &'static str,
    counts: Option<Counts>,
    round_complete: bool,
    has_more: bool,
    pending_recovery: bool,
}
impl TickReply {
    fn refused(code: &'static str) -> Self {
        Self { scope: Scope::refused(code), phase: "none", counts: None,
            round_complete: false, has_more: false, pending_recovery: false }
    }
    fn outcome(outcome: QuoteWorkBatchOutcome, stamp: &ActionStamp) -> Self {
        match outcome {
            QuoteWorkBatchOutcome::Recovery { confirmed, still_pending, has_more } => Self {
                scope: Scope::admitted(if confirmed > 0 { "progress" } else if still_pending || has_more { "held" } else { "idle" }, stamp),
                phase: "recovery", counts: Some(Counts { confirmed, held: 0, review_required: 0 }),
                round_complete: false, has_more, pending_recovery: still_pending,
            },
            QuoteWorkBatchOutcome::Page { confirmed, held, review_required, round_complete } => Self {
                scope: Scope::admitted(if review_required > 0 { "needs_review" } else if held > 0 { "held" } else if confirmed > 0 { "progress" } else { "idle" }, stamp),
                phase: "page", counts: Some(Counts { confirmed, held, review_required }),
                round_complete, has_more: !round_complete, pending_recovery: false,
            },
        }
    }
}

// Fixed order: the build gate is checked before origin parsing, disk or HTTPS.
fn admission(origin: &Origin) -> Result<(), &'static str> {
    let enabled = PRODUCT_ENABLED;
    #[cfg(all(test, windows))]
    let enabled = enabled || live_frontdoor::allows(origin);
    if !enabled { return Err("product_gate_closed"); }
    if !origin.valid() { return Err("invalid_request"); }
    Ok(())
}
async fn admitted_stamp(store: &LocalStore, origin: &Origin) -> Result<ActionStamp, &'static str> {
    #[cfg(all(test, windows))]
    live_frontdoor::require_store(origin, store)?;
    let stamp = capture(store).await.map_err(|_| "context_changed")?;
    #[cfg(all(test, windows))]
    live_frontdoor::require_stamp(origin, &stamp)?;
    if !origin.matches(&stamp) { return Err("context_changed"); }
    Ok(stamp)
}
async fn current(store: &LocalStore, origin: &Origin, stamp: &ActionStamp) -> bool {
    #[cfg(all(test, windows))]
    if !live_frontdoor::current(origin, store, stamp) { return false; }
    let unchanged = origin.matches(stamp) && check(store, stamp).await.is_ok();
    #[cfg(all(test, windows))]
    return unchanged && live_frontdoor::current(origin, store, stamp);
    #[cfg(not(all(test, windows)))]
    unchanged
}
fn status_code(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "invalid_request", 401 | 403 => "forbidden", 404 => "product_gate_closed",
        409 => "conflict", 429 => "rate_limited", _ => "service_unavailable",
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MonthlyQuotaRefusal { schema_version: u8, state: String, code: String, message: String }
pub(super) fn monthly_quota_refusal(bytes: &[u8]) -> bool {
    if bytes.len() > 4096 { return false; }
    serde_json::from_slice::<MonthlyQuotaRefusal>(bytes).ok().is_some_and(|v|
        v.schema_version == 1 && v.state == "error" && v.code == "quota_exhausted"
        && !v.message.is_empty() && v.message.len() <= 2048)
}
fn cycle_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::Automation(crate::error::AutomationErrorCode::QuotaExhausted) => "quota_exhausted",
        AppError::Automation(crate::error::AutomationErrorCode::RateLimited) => "rate_limited",
        _ => "service_unavailable",
    }
}
fn stale_round(round: &Option<QuoteWorkRound>, stamp: &ActionStamp) -> bool {
    round.as_ref().is_some_and(|round| round.original != *stamp)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsentInput {
    schema_version: u8, enabled: bool,
    #[serde(deserialize_with = "required_nullable")]
    consent_version: Option<String>, expected_revision: u32,
}
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> { Option::<T>::deserialize(deserializer) }
/// The person's choice: this request line means this catalogue article.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArticleChoiceInput { phrase: String, article_id: String }
impl ArticleChoiceInput {
    fn valid(&self) -> bool { text(&self.phrase, 200) && id(&self.article_id) }
    fn body(&self) -> serde_json::Value { serde_json::json!({ "schemaVersion": 1, "phrase": self.phrase, "articleId": self.article_id }) }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArticleChoice { schema_version: u8, term: String, article_id: String }
impl ConsentInput {
    fn valid(&self) -> bool {
        self.schema_version == 1 && self.expected_revision <= i32::MAX as u32
            && if self.enabled { self.consent_version.as_deref() == Some(CONSENT_VERSION) } else { self.consent_version.is_none() }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Consent {
    schema_version: u8, enabled: bool, revision: u32,
    #[serde(deserialize_with = "required_nullable")]
    consent_version: Option<String>, required_consent_version: String,
}
impl Consent {
    fn valid(&self) -> bool {
        self.schema_version == 1 && self.revision <= i32::MAX as u32
            && self.required_consent_version == CONSENT_VERSION
            && self.consent_version.as_ref().is_none_or(|v| !v.is_empty() && v.len() <= 160 && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
            && (!self.enabled || self.revision > 0 && self.consent_version.as_deref() == Some(CONSENT_VERSION))
            && (self.revision != 0 || self.consent_version.is_none())
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageInput { limit: usize, #[serde(deserialize_with = "required_nullable")] cursor: Option<String> }
fn cursor(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|v| !v.is_empty() && v.len() <= 4096 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}
impl PageInput { fn valid(&self) -> bool { (1..=50).contains(&self.limit) && cursor(&self.cursor) } }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityItem {
    activity_id: String, proposal_id: String, quote_id: String, confirmed_at: u64,
    kind: String, requires_human_validation: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewItem {
    proposal_id: String, source_id: String, created_at: u64,
    disposition: String, reasons: Vec<String>, requires_human_validation: bool,
    // Read-only draft prepared by Autopilote (details=1). A person opens it in
    // the ordinary quote form and saves it; nothing is created from it here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suggestion: Option<Suggestion>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuggestionCustomer { kind: String, name: String }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuggestionLine {
    article_id: String, description: String, unit: String, quantity_milli: u64,
    unit_price_cents: u64, tax_rate_bp: u32, net_cents: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Suggestion {
    #[serde(deserialize_with = "required_nullable")]
    customer: Option<SuggestionCustomer>,
    currency: String, net_cents: u64, lines: Vec<SuggestionLine>,
    /// Request lines without a catalogue article yet (details=2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unmatched: Option<Vec<String>>,
    /// Who wrote the request (details=3), read from the signature or the
    /// sender address. Kept raw here and checked on its own, so a malformed
    /// sender only loses the client hint, never the suggestion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sender: Option<serde_json::Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuggestionSender {
    email: String,
    #[serde(deserialize_with = "required_nullable")] name: Option<String>,
    #[serde(deserialize_with = "required_nullable")] company: Option<String>,
    #[serde(deserialize_with = "required_nullable")] phone: Option<String>,
    #[serde(deserialize_with = "required_nullable")] street: Option<String>,
    #[serde(deserialize_with = "required_nullable")] postcode: Option<String>,
    #[serde(deserialize_with = "required_nullable")] city: Option<String>,
    source: String,
}
impl SuggestionSender {
    fn valid(&self) -> bool {
        let email = self.email.is_empty() || (self.email.chars().count() <= 254 && self.email.contains('@')
            && !self.email.chars().any(|c| c.is_whitespace() || c.is_control()) && self.email == self.email.to_lowercase());
        let field = |value: &Option<String>, max: usize| value.as_deref().is_none_or(|v| text(v, max));
        email && matches!(self.source.as_str(), "signature" | "envelope" | "none")
            && field(&self.name, 200) && field(&self.company, 200) && field(&self.phone, 40)
            && field(&self.street, 200) && field(&self.postcode, 16) && field(&self.city, 120)
    }
}
fn sender(value: serde_json::Value) -> Option<serde_json::Value> {
    let sender: SuggestionSender = serde_json::from_value(value).ok()?;
    sender.valid().then(|| serde_json::to_value(sender).ok()).flatten()
}
const MONEY_LIMIT: u64 = 100_000_000_000;
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
impl Suggestion {
    fn valid(&self) -> bool {
        matches!(self.currency.as_str(), "CHF" | "EUR") && self.net_cents <= MONEY_LIMIT
            && self.lines.len() <= 8
            && self.customer.as_ref().is_none_or(|c| matches!(c.kind.as_str(), "existing" | "new") && text(&c.name, 200))
            && self.lines.iter().all(|l| id(&l.article_id) && text(&l.description, 500) && text(&l.unit, 32)
                && (1..=1_000_000_000).contains(&l.quantity_milli) && l.unit_price_cents <= MONEY_LIMIT
                && l.tax_rate_bp <= 10_000 && l.net_cents <= MONEY_LIMIT)
            && self.unmatched.as_ref().is_none_or(|rows| rows.len() <= 8 && rows.iter().all(|row| text(row, 200)))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page<T> { organization_id: String, items: Vec<T>, #[serde(deserialize_with = "required_nullable")] next_cursor: Option<String> }
fn reason(value: &str) -> bool {
    matches!(value, "missing_customer_name" | "ambiguous_customer" | "archived_customer" |
        "missing_quantity" | "ambiguous_quantity" | "unsupported_quantity" | "missing_article" |
        "too_many_candidates" | "source_too_long" | "low_confidence" | "not_quote_request" |
        "invalid_decision" | "provider_unavailable")
}
fn timestamp(value: u64) -> bool { (1..=253402300799).contains(&value) }
/// Mails of the last 30 days in which a client accepts a quote. The server
/// does not know local quotes; the app matches them and a person confirms.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptancePage { organization_id: String, items: Vec<Acceptance> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acceptance {
    source_id: String, received_at: u64,
    #[serde(deserialize_with = "required_nullable")] quote_reference: Option<String>,
    evidence: String,
    /// Checked on its own; a malformed sender becomes null, the item stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sender: Option<serde_json::Value>,
    requires_human_validation: bool,
}
const ACCEPT_LIMIT: usize = 200;
/// One typed signal per client or supplier mail (last 30 days). Nothing runs
/// from it: the app proposes the matching action and a person clicks.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignalPage { schema_version: u8, organization_id: String, items: Vec<MailSignal> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MailSignal {
    kind: String, source_id: String, received_at: u64, subject: String, evidence: String,
    #[serde(deserialize_with = "required_nullable")] quote_reference: Option<String>,
    #[serde(deserialize_with = "required_nullable")] invoice_reference: Option<String>,
    #[serde(deserialize_with = "required_nullable")] amount_cents: Option<u64>,
    #[serde(deserialize_with = "required_nullable")] currency: Option<String>,
    #[serde(deserialize_with = "required_nullable")] document_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sender: Option<serde_json::Value>,
    requires_human_validation: bool,
}
const SIGNAL_LIMIT: usize = 50;
impl MailSignal {
    fn valid(&self) -> bool {
        matches!(self.kind.as_str(), "quote_accepted" | "quote_declined" | "supplier_document" | "supplier_order" | "payment_announced" | "payment_promised" | "contact_update" | "follow_up")
            && id(&self.source_id) && timestamp(self.received_at) && self.requires_human_validation
            && self.subject.chars().count() <= 300 && !self.subject.chars().any(char::is_control)
            && text(&self.evidence, 1000)
            && self.quote_reference.as_deref().is_none_or(|r| text(r, 64))
            && self.invoice_reference.as_deref().is_none_or(|r| text(r, 64))
            && self.amount_cents.is_none_or(|a| a <= MONEY_LIMIT)
            && self.currency.as_deref().is_none_or(|c| matches!(c, "CHF" | "EUR"))
            && self.document_type.as_deref().is_none_or(|d| matches!(d, "supplier_invoice" | "payment_reminder" | "credit_note" | "receipt"))
    }
}
fn unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = HashSet::new(); values.into_iter().all(|v| seen.insert(v))
}
fn parse_public(bytes: &[u8], path: &str, stamp: &ActionStamp, limit: usize) -> Option<serde_json::Value> {
    if bytes.len() > 65536 { return None; }
    if path == ALIAS_PATH {
        let data: ArticleChoice = serde_json::from_slice(bytes).ok()?;
        return (data.schema_version == 1 && text(&data.term, 200) && id(&data.article_id)).then(|| serde_json::to_value(data).ok()).flatten();
    }
    if path == CONSENT_PATH {
        let data: Consent = serde_json::from_slice(bytes).ok()?;
        return data.valid().then(|| serde_json::to_value(data).ok()).flatten();
    }
    if path == SIGNALS_PATH {
        let mut data: SignalPage = serde_json::from_slice(bytes).ok()?;
        for item in &mut data.items { item.sender = item.sender.take().and_then(sender); }
        // A signal the app cannot read is left out; the others stay usable.
        data.items.retain(MailSignal::valid);
        if data.schema_version != 1 || data.organization_id != stamp.inbox.session.organization_id || data.items.len() > SIGNAL_LIMIT
            || !unique(data.items.iter().map(|v| v.source_id.as_str())) { return None; }
        return serde_json::to_value(data).ok();
    }
    if path == ACCEPT_PATH {
        let mut data: AcceptancePage = serde_json::from_slice(bytes).ok()?;
        for item in &mut data.items { item.sender = item.sender.take().and_then(sender); }
        if data.organization_id != stamp.inbox.session.organization_id || data.items.len() > ACCEPT_LIMIT
            || !unique(data.items.iter().map(|v| v.source_id.as_str())) || data.items.iter().any(|v| {
                !id(&v.source_id) || !timestamp(v.received_at) || !text(&v.evidence, 1000) || !v.requires_human_validation
                    || v.quote_reference.as_deref().is_some_and(|r| !text(r, 64))
            }) { return None; }
        return serde_json::to_value(data).ok();
    }
    if path == ACTIVITY_PATH {
        let data: Page<ActivityItem> = serde_json::from_slice(bytes).ok()?;
        if data.organization_id != stamp.inbox.session.organization_id || data.items.len() > limit || !cursor(&data.next_cursor)
            || !unique(data.items.iter().map(|v| v.activity_id.as_str())) || !unique(data.items.iter().map(|v| v.proposal_id.as_str()))
            || !unique(data.items.iter().map(|v| v.quote_id.as_str())) || data.items.iter().any(|v| {
                !id(&v.activity_id) || !id(&v.proposal_id) || !timestamp(v.confirmed_at) || v.kind != "quote_draft_created" || !v.requires_human_validation
                    || Uuid::parse_str(&v.quote_id).ok().is_none_or(|u| u.get_version() != Some(Version::Random) || u.get_variant() != uuid::Variant::RFC4122 || u.to_string() != v.quote_id)
            }) { return None; }
        return serde_json::to_value(data).ok();
    }
    if path != REVIEW_PATH { return None; }
    let mut data: Page<ReviewItem> = serde_json::from_slice(bytes).ok()?;
    // An unusable suggestion only loses the shortcut, never the review itself.
    for item in &mut data.items {
        if let Some(found) = item.suggestion.as_mut() { found.sender = found.sender.take().and_then(sender); }
        if item.suggestion.as_ref().is_some_and(|s| !s.valid()) { item.suggestion = None; }
    }
    if data.organization_id != stamp.inbox.session.organization_id || data.items.len() > limit || !cursor(&data.next_cursor)
        || !unique(data.items.iter().map(|v| v.proposal_id.as_str())) || data.items.iter().any(|v| {
            !id(&v.proposal_id) || !id(&v.source_id) || !timestamp(v.created_at) || v.disposition != "needs_review" || !v.requires_human_validation
                || v.reasons.is_empty() || v.reasons.len() > 13 || !unique(v.reasons.iter().map(String::as_str)) || v.reasons.iter().any(|r| !reason(r))
        }) { return None; }
    serde_json::to_value(data).ok()
}

// These are the only transport routes of this IPC boundary. Body, bearer,
// origin, query encoding, timeout and response limit are native-owned.
async fn read_at(store: &LocalStore, origin: &Origin, path: &'static str, page: Option<PageInput>, input: Option<serde_json::Value>) -> (ReadReply, Option<ActionStamp>) {
    let stamp = match admitted_stamp(store, origin).await { Ok(v) => v, Err(c) => return (ReadReply::refused(c), None) };
    if (path == CONSENT_PATH || path == ALIAS_PATH) && !matches!(stamp.role.as_str(), "owner" | "admin") {
        return (ReadReply::refused("forbidden"), Some(stamp));
    }
    let mut url = match endpoint(path) { Ok(v) => v, Err(_) => return (ReadReply::refused("service_unavailable"), Some(stamp)) };
    let limit = page.as_ref().map_or(50, |v| v.limit);
    if let Some(page) = page {
        let mut query = url.query_pairs_mut(); query.append_pair("limit", &page.limit.to_string());
        if let Some(cursor) = page.cursor { query.append_pair("cursor", &cursor); }
        if path == REVIEW_PATH { query.append_pair("details", "3"); }
    }
    let write = input.is_some();
    let body = match input.map(|v| serde_json::to_vec(&v)).transpose() {
        Ok(v) => v, Err(_) => return (ReadReply::refused("invalid_request"), Some(stamp)),
    };
    if !current(store, origin, &stamp).await { return (ReadReply::refused("context_changed"), None); }
    let result = account_request_url(if write { Method::POST } else { Method::GET }, url, body, Some(&stamp.inbox.session.session_token), TOTAL_TIMEOUT).await;
    if !current(store, origin, &stamp).await { return (ReadReply::refused("context_changed"), None); }
    let reply = match result {
        Ok((status, bytes)) if status == StatusCode::OK => match parse_public(&bytes, path, &stamp, limit) {
            Some(data) => ReadReply { scope: Scope::admitted("available", &stamp), data: Some(data) },
            None => ReadReply::refused("service_unavailable"),
        },
        Ok((status, _)) => ReadReply::refused(if write && status == StatusCode::CONFLICT { "revision_conflict" } else { status_code(status) }),
        Err(_) => ReadReply::refused("service_unavailable"),
    };
    (reply, Some(stamp))
}
async fn deliver_read(store: LocalStore, origin: Origin, task: tauri::async_runtime::JoinHandle<(ReadReply, Option<ActionStamp>)>) -> ReadReply {
    match task.await {
        Ok((reply, Some(stamp))) if current(&store, &origin, &stamp).await => reply,
        Ok((reply, None)) => reply,
        Ok(_) => ReadReply::refused("context_changed"),
        Err(_) => ReadReply::refused("service_unavailable"),
    }
}

#[tauri::command]
pub(crate) async fn quote_autopilot_state(store: State<'_, LocalStore>, origin: Origin) -> Result<StateReply, String> {
    if let Err(code) = admission(&origin) { return Ok(StateReply { scope: Scope::refused(code), can_manage: false }); }
    Ok(match admitted_stamp(&store, &origin).await {
        Ok(stamp) if current(&store, &origin, &stamp).await => StateReply { scope: Scope::admitted("available", &stamp), can_manage: matches!(stamp.role.as_str(), "owner" | "admin") },
        _ => StateReply { scope: Scope::refused("context_changed"), can_manage: false },
    })
}
#[tauri::command]
pub(crate) async fn quote_autopilot_consent(store: State<'_, LocalStore>, origin: Origin) -> Result<ReadReply, String> {
    if let Err(code) = admission(&origin) { return Ok(ReadReply::refused(code)); }
    let owned = store.inner().clone(); let captured = origin.clone(); let worker = owned.clone();
    let task = tauri::async_runtime::spawn(async move { read_at(&worker, &captured, CONSENT_PATH, None, None).await });
    Ok(deliver_read(owned, origin, task).await)
}
#[tauri::command]
pub(crate) async fn set_quote_autopilot_consent(store: State<'_, LocalStore>, supervisor: State<'_, Supervisor>, origin: Origin, input: ConsentInput) -> Result<ReadReply, String> {
    if let Err(code) = admission(&origin) { return Ok(ReadReply::refused(code)); }
    if !input.valid() { return Ok(ReadReply::refused("invalid_request")); }
    let Some(flight) = supervisor.consent_write.try_lock_owned() else { return Ok(ReadReply::refused("conflict")); };
    let owned = store.inner().clone(); let worker = owned.clone(); let captured = origin.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _flight = flight;
        read_at(&worker, &captured, CONSENT_PATH, None, serde_json::to_value(input).ok()).await
    });
    Ok(deliver_read(owned, origin, task).await)
}
#[tauri::command]
pub(crate) async fn set_quote_autopilot_article_choice(store: State<'_, LocalStore>, origin: Origin, input: ArticleChoiceInput) -> Result<ReadReply, String> {
    if let Err(code) = admission(&origin) { return Ok(ReadReply::refused(code)); }
    if !input.valid() { return Ok(ReadReply::refused("invalid_request")); }
    let owned = store.inner().clone(); let worker = owned.clone(); let captured = origin.clone();
    let task = tauri::async_runtime::spawn(async move { read_at(&worker, &captured, ALIAS_PATH, None, Some(input.body())).await });
    Ok(deliver_read(owned, origin, task).await)
}
#[tauri::command]
pub(crate) async fn quote_autopilot_mail_signals(store: State<'_, LocalStore>, origin: Origin) -> Result<ReadReply, String> {
    if let Err(code) = admission(&origin) { return Ok(ReadReply::refused(code)); }
    let owned = store.inner().clone(); let worker = owned.clone(); let captured = origin.clone();
    let task = tauri::async_runtime::spawn(async move { read_at(&worker, &captured, SIGNALS_PATH, None, None).await });
    Ok(deliver_read(owned, origin, task).await)
}
#[tauri::command]
pub(crate) async fn quote_autopilot_acceptances(store: State<'_, LocalStore>, origin: Origin) -> Result<ReadReply, String> {
    if let Err(code) = admission(&origin) { return Ok(ReadReply::refused(code)); }
    let owned = store.inner().clone(); let worker = owned.clone(); let captured = origin.clone();
    let task = tauri::async_runtime::spawn(async move { read_at(&worker, &captured, ACCEPT_PATH, None, None).await });
    Ok(deliver_read(owned, origin, task).await)
}
async fn read_page(store: &LocalStore, origin: Origin, input: PageInput, path: &'static str) -> ReadReply {
    if let Err(code) = admission(&origin) { return ReadReply::refused(code); }
    if !input.valid() { return ReadReply::refused("invalid_request"); }
    let owned = store.clone(); let worker = owned.clone(); let captured = origin.clone();
    let task = tauri::async_runtime::spawn(async move { read_at(&worker, &captured, path, Some(input), None).await });
    deliver_read(owned, origin, task).await
}
#[tauri::command]
pub(crate) async fn quote_autopilot_activity(store: State<'_, LocalStore>, origin: Origin, input: PageInput) -> Result<ReadReply, String> { Ok(read_page(&store, origin, input, ACTIVITY_PATH).await) }
#[tauri::command]
pub(crate) async fn quote_autopilot_review(store: State<'_, LocalStore>, origin: Origin, input: PageInput) -> Result<ReadReply, String> { Ok(read_page(&store, origin, input, REVIEW_PATH).await) }

#[tauri::command]
pub(crate) async fn quote_autopilot_tick(store: State<'_, LocalStore>, supervisor: State<'_, Supervisor>, origin: Origin) -> Result<TickReply, String> {
    if let Err(code) = admission(&origin) { return Ok(TickReply::refused(code)); }
    let Some(mut flight) = supervisor.round.try_lock_owned() else { return Ok(TickReply::refused("busy")); };
    let owned = store.inner().clone(); let worker = owned.clone(); let captured = origin.clone();
    // The owned lock lives in this detached task, not in the IPC waiter. A
    // cancelled WebView request cannot admit a second physical producer.
    let task = tauri::async_runtime::spawn(async move {
        let stamp = match admitted_stamp(&worker, &captured).await { Ok(v) => v, Err(c) => { *flight = None; return (TickReply::refused(c), None); } };
        if stale_round(&flight, &stamp) {
            *flight = None; return (TickReply::refused("context_changed"), None);
        }
        if flight.as_ref().is_none_or(|r| r.complete) {
            let round = begin_quote_work_round(&worker).await;
            if !current(&worker, &captured, &stamp).await { *flight = None; return (TickReply::refused("context_changed"), None); }
            match round {
                Ok(round) if round.original == stamp => *flight = Some(round),
                _ => return (TickReply::refused("service_unavailable"), Some(stamp)),
            }
        }
        // Exactly one advance. The existing consumer prioritises the durable
        // outbox before discovery and never executes a needs_review proposal.
        let Some(round) = flight.as_mut() else { return (TickReply::refused("service_unavailable"), Some(stamp)); };
        let result = advance_quote_work_round(&worker, round).await;
        if !current(&worker, &captured, &stamp).await { *flight = None; return (TickReply::refused("context_changed"), None); }
        let reply = match result { Ok(outcome) => TickReply::outcome(outcome, &stamp), Err(error) => TickReply::refused(cycle_error_code(&error)) };
        // Failure keeps the opaque round. Server intake/ledger states remain
        // the retry authority; no IPC operation resets started/uncertain rows.
        (reply, Some(stamp))
    });
    Ok(match task.await {
        Ok((reply, Some(stamp))) if current(&owned, &origin, &stamp).await => reply,
        Ok((reply, None)) => reply,
        Ok(_) => TickReply::refused("context_changed"),
        Err(_) => TickReply::refused("service_unavailable"),
    })
}

#[cfg(all(test, windows))]
#[path = "account_cloud_quote_autopilot_live_frontdoor.rs"]
pub(crate) mod live_frontdoor;

#[cfg(test)]
#[path = "account_cloud_quote_autopilot_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows", feature = "quote-autopilot-product"))]
#[path = "account_cloud_quote_autopilot_on_tests.rs"]
mod on_tests;

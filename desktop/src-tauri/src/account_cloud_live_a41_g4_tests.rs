//! TEST-ONLY Windows child of account_cloud for the isolated A41 G4 recipe.
//! Requires a fresh compilation containing both G4 modules. A50/91a, b502
//! and ad57 do not contain or prove this G4 test.
use super::*;
use crate::company_collaboration::live_a41_g4_support as collaboration;
use crate::action_engine_device_protocol as protocol;
use crate::action_engine_quote::{ActionEngineQuoteActor, ActionEngineQuoteReceipt};
use crate::action_engine_quote_publication::ActionEngineQuoteRecoveryOrigin;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const PROFILE_SHA: &str = "2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf";
const SITE: &str = "https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site";
const OWNER: &str = "1f0d9981-607b-4848-9374-587035cdfd89";
const ORGANIZATION: &str = "org_trial_345a3d1f68056cf7e709d4af4fc229a4";
const CONSENT_PATH: &str = "/api/account/automation/quote-consent";
const CONSENT_VERSION: &str = "action-engine-quote-draft-customer-2026-10-11";
const MAX_MESSAGE: usize = 32 * 1024;
type RecipeResult<T> = Result<T, ()>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountBaseline {
    installation_id: String,
    license_id: String,
    account_session_id: String,
    jti: String,
    license_sha256: String,
}

// No Debug or Serialize; this is never an artifact or diagnostic.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateInput {
    format: String,
    sites_service_token: String,
    root_dir: String,
    installations: Vec<AccountBaseline>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge { challenge: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceReady { event: String, source_id: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Consent {
    schema_version: u32,
    enabled: bool,
    revision: u64,
    consent_version: Option<String>,
    required_consent_version: String,
}

struct Pipe(std::fs::File);
impl Pipe {
    fn read<T: DeserializeOwned>(&mut self) -> RecipeResult<T> { read_message(&mut self.0) }
    // Only literal steps and bounded device indices. No application error,
    // source content, identifiers, paths or credentials cross this diagnostic.
    fn checkpoint(&mut self, step: &'static str, index: usize) -> RecipeResult<()> {
        self.write(json!({"event":"checkpoint","step":step,"index":index}))
    }
    fn write(&mut self, value: Value) -> RecipeResult<()> {
        let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
        if bytes.len() > MAX_MESSAGE { return Err(()); }
        self.0.write_all(&bytes).map_err(|_| ())?;
        self.0.write_all(b"\n").map_err(|_| ())?;
        self.0.flush().map_err(|_| ())
    }
}
fn read_message<T: DeserializeOwned>(stream: &mut impl Read) -> RecipeResult<T> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte).map_err(|_| ())?;
        if byte[0] == b'\n' { break; }
        if bytes.len() == MAX_MESSAGE { return Err(()); }
        bytes.push(byte[0]);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn closed_guard() -> RecipeResult<()> {
    // Before the private pipe, filesystem, LocalStore::initialize or transport.
    if !cfg!(target_os = "windows")
        || option_env!("ZENTRA_ACTION_NATIVE_TEST_CONTEXT") != Some("live-sandbox-a41")
        || std::env::var("CIRCLECI").as_deref() != Ok("true")
        || std::env::var("CIRCLE_BRANCH").as_deref() != Ok("codex/action-engine-native-live-a41")
        || std::env::var("ZENTRA_RUN_LIVE_G4_RECIPE").as_deref() != Ok("true") { return Err(()); }
    let profile = crate::native_test_profile::require().map_err(|_| ())?;
    if profile.sha256() != PROFILE_SHA || profile.site_origin() != SITE
        || profile.license_kid() != "sandbox-action-engine-a41"
        || base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.license_key())
            != "hLFfY6E43JD0Sz-gUOrhOHY8mxQHqyu2875H2oXPQb0" { return Err(()); }
    Ok(())
}

fn admitted_input() -> RecipeResult<(Pipe, PrivateInput)> {
    closed_guard()?;
    let challenge: Challenge = read_message(&mut std::io::stdin().lock())?;
    if challenge.challenge.len() != 43
        || !challenge.challenge.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err(()); }
    let name = std::env::var("ZENTRA_A41_G4_PRIVATE_PIPE").map_err(|_| ())?;
    let suffix = name.strip_prefix(r"\\.\pipe\zentra-a41-g4-").ok_or(())?;
    let uuid = Uuid::parse_str(suffix).map_err(|_| ())?;
    if uuid.get_version() != Some(Version::Random) || uuid.to_string() != suffix { return Err(()); }
    let file = std::fs::OpenOptions::new().read(true).write(true).open(name).map_err(|_| ())?;
    let mut pipe = Pipe(file);
    pipe.write(json!({"event":"hello","challenge":challenge.challenge}))?;
    let input: PrivateInput = pipe.read()?;
    if input.format != "zentra-a41-g4-private-v1" || input.installations.len() != 2
        || input.installations[0].installation_id == input.installations[1].installation_id { return Err(()); }
    crate::native_test_profile::install_sites_access_token(&input.sites_service_token).map_err(|_| ())?;
    Ok((pipe, input))
}

fn retained_root(value: &str) -> RecipeResult<PathBuf> {
    let root = Path::new(value);
    if !root.is_absolute() || std::fs::symlink_metadata(root).map_err(|_| ())?.file_type().is_symlink() { return Err(()); }
    let root = std::fs::canonicalize(root).map_err(|_| ())?;
    let temporary = std::fs::canonicalize(std::env::temp_dir()).map_err(|_| ())?;
    if root.parent() != Some(temporary.as_path())
        || !root.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("zentra-a41-native-")) { return Err(()); }
    Ok(root)
}

fn open_existing(root: &Path, name: &str) -> RecipeResult<LocalStore> {
    let directory = root.join(name);
    let metadata = std::fs::symlink_metadata(&directory).map_err(|_| ())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink()
        || std::fs::canonicalize(&directory).map_err(|_| ())?.parent() != Some(root) { return Err(()); }
    for file in ["helvichantier.sqlite3", "installation-identity.dpapi", "cloud-account-session.protected",
        "license-token.dpapi", "license-clock.dpapi", "license-installation.dpapi"] {
        let metadata = std::fs::symlink_metadata(directory.join(file)).map_err(|_| ())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(()); }
    }
    for file in ["cloud-account-link.protected", "cloud-account-exchange.protected", "license-clock-pending.dpapi"] {
        if directory.join(file).try_exists().map_err(|_| ())? { return Err(()); }
    }
    LocalStore::initialize(directory).map_err(|_| ())
}

async fn strict_account(store: &LocalStore, expected: &AccountBaseline) -> RecipeResult<()> {
    let session = read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    validate_session_for_installation(&session, &store.installation_id).map_err(|_| ())?;
    if store.installation_id != expected.installation_id || session.organization_id != ORGANIZATION || session.role != "owner" { return Err(()); }
    let (status, bytes) = account_request(Method::GET, ME_PATH, None, Some(&session.session_token)).await.map_err(|_| ())?;
    if status != StatusCode::OK { return Err(()); }
    let me: MeResponse = parse_json(&bytes, "recette").map_err(|_| ())?;
    if me.user_id != OWNER || me.organization.id != ORGANIZATION || me.organization.role != "owner"
        || me.installation_id != store.installation_id
        || parse_future_or_past_date(&me.entitlement_valid_until, "recette").map_err(|_| ())? <= Utc::now() { return Err(()); }
    let _local = store.lock().map_err(|_| ())?;
    let state = store.get_license_state().map_err(|_| ())?;
    let token = store.read_test_protected_license_token().map_err(|_| ())?.ok_or(())?;
    if state["enforcement_configured"] != true || state["status"] != "valid" || state["read_only"] != false
        || state["installation_id"] != store.installation_id || state["license_id"] != expected.license_id
        || format!("{:x}",Sha256::digest(token.trim().as_bytes())) != expected.license_sha256 { return Err(()); }
    let payload: crate::models::LicenseTokenPayload = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').next().ok_or(())?).map_err(|_| ())?).map_err(|_| ())?;
    if payload.kid != "sandbox-action-engine-a41" || payload.account_user_id.as_deref() != Some(OWNER)
        || payload.account_session_id.as_deref() != Some(expected.account_session_id.as_str())
        || payload.jti != expected.jti || payload.installation_id != store.installation_id { return Err(()); }
    Ok(())
}

async fn paid_consent(store: &LocalStore) -> RecipeResult<u64> {
    let session = read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    // A future TEST-ONLY endpoint, fixed by the compiled profile. endpoint() in
    // production is unchanged. This real handler must admit paid Complete,
    // current activation + membership/seat; it is not a caller-supplied flag.
    let mut url = Url::parse(crate::native_test_profile::require().map_err(|_| ())?.site_origin()).map_err(|_| ())?;
    if url.origin().ascii_serialization() != SITE { return Err(()); }
    url.set_path(CONSENT_PATH);
    let (status, bytes) = account_request_url(Method::GET, url, None, Some(&session.session_token), TOTAL_TIMEOUT).await.map_err(|_| ())?;
    if status != StatusCode::OK { return Err(()); }
    let consent: Consent = parse_json(&bytes, "recette").map_err(|_| ())?;
    if consent.schema_version != 1 || !consent.enabled || consent.revision < 1
        || consent.consent_version.as_deref() != Some(CONSENT_VERSION)
        || consent.required_consent_version != CONSENT_VERSION { return Err(()); }
    Ok(consent.revision)
}

fn seed(store: &LocalStore) -> RecipeResult<(String, String)> {
    let _local = store.lock().map_err(|_| ())?;
    store.require_write_access().map_err(|_| ())?;
    crate::cloud_backup::require_empty_company(store).map_err(|_| ())?;
    if store.app_state(env!("CARGO_PKG_VERSION")).map_err(|_| ())?.onboarding_completed { return Err(()); }
    // Fictitious business records through the ordinary native validation/audit
    // methods. No direct SQL writes, licence fixture or canonical-plan fixture.
    let onboarding: crate::models::OnboardingInput = serde_json::from_value(json!({
        "company_name":"Recette A41 fictive", "legal_form":"Sàrl", "owner_name":"Responsable fictif A41",
        "email":"owner-a41@example.invalid", "address_line1":"Adresse fictive", "postal_code":"1000",
        "city":"Lausanne", "canton":"VD", "country":"CH", "noga_section":"F", "noga_division":"43",
        "noga_detailed_code":"432100", "activity_description":"Installation électrique fictive",
        "vat_registered":false, "default_vat_bp":0, "iban":"CH44 3199 9123 0008 8901 2", "currency":"CHF", "quote_prefix":"D", "invoice_prefix":"F",
        "credit_note_prefix":"A", "quote_start_number":1, "invoice_start_number":1, "credit_note_start_number":1,
        "payment_terms_days":30, "quote_validity_days":30, "default_hourly_rate_cents":0,
        "extra_settings_json":{"organization":{"address":{"buildingNumber":"1"}},"payroll":{"enabled":false}}
    })).map_err(|_| ())?;
    store.complete_onboarding(onboarding, env!("CARGO_PKG_VERSION")).map_err(|_| ())?;
    let customer = store.create_record("clients", json!({"name":"Camille Recette A41", "email":"camille-a41@example.invalid", "country":"CH"})).map_err(|_| ())?;
    let article = store.create_record("catalog_items", json!({"kind":"product", "sku":"A41-RAD-100", "name":"Radiateur A41",
        "description":"Radiateur fictif A41", "unit":"pièce", "sales_price_cents":19900,"vat_bp":0})).map_err(|_| ())?;
    Ok((customer["id"].as_str().ok_or(())?.into(), article["id"].as_str().ok_or(())?.into()))
}

fn origin(store: &LocalStore) -> RecipeResult<ActionEngineQuoteRecoveryOrigin> {
    let db = store.connect().map_err(|_| ())?;
    Ok(ActionEngineQuoteRecoveryOrigin { actor:ActionEngineQuoteActor { organization_id:ORGANIZATION.into(),user_id:OWNER.into() },
        installation_id:store.installation_id.clone(), expected_workspace_scope:crate::work_notes::workspace_scope(&db).map_err(|_| ())?,
        expected_member_context_nonce:crate::member_context::read(&db).map_err(|_| ())? })
}

async fn discovery(store: &LocalStore) -> RecipeResult<protocol::QuoteWorkDiscovery> {
    let session = read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    let selection = protocol::WorkDiscoverySelection { limit:20,cursor:None };
    let (status, bytes) = account_request(Method::POST, protocol::WORK_PATH, Some(protocol::discovery_request(&selection).map_err(|_| ())?),
        Some(&session.session_token)).await.map_err(|_| ())?;
    if status != StatusCode::OK { return Err(()); }
    protocol::parse_discovery_response(&bytes, &selection).map_err(|_| ())
}

async fn round(store: &LocalStore, pipe: &mut Pipe, index: usize) -> RecipeResult<usize> {
    let mut round = action_engine::begin_quote_work_round(store).await.map_err(|_| ())?;
    let mut total = 0;
    // Bounded test execution, never a product scheduler. One opaque stamp is
    // retained until this actual round completes; no recapture after an await.
    for _ in 0..8 {
        match action_engine::advance_quote_work_round(store, &mut round).await.map_err(|_| ())? {
            action_engine::QuoteWorkBatchOutcome::Recovery { confirmed, still_pending, has_more } => {
                total += confirmed;
                if still_pending || has_more { return Err(()); }
            }
            action_engine::QuoteWorkBatchOutcome::Page { confirmed, held, review_required, round_complete } => {
                if review_required != 0 {
                    // Observe the one real consumer result. No extra prepare,
                    // decision read, retry or promotion into nominal G4 success.
                    pipe.write(json!({"event":"review-required","index":index,"confirmed":confirmed,
                        "held":held,"reviewRequired":review_required}))?;
                    return Err(());
                }
                if held != 0 { return Err(()); }
                total += confirmed;
                if round_complete { return Ok(total); }
            }
        }
    }
    Err(())
}

fn quote_proof(store: &LocalStore, source: &str, customer: &str, article: &str) -> RecipeResult<Value> {
    let _local = store.lock().map_err(|_| ())?;
    let db = store.connect().map_err(|_| ())?;
    let receipts = crate::database::query_all(&db, "SELECT source_id,proposal_id,reservation_id,fingerprint,quote_id,receipt_json,receipt_sha256
        FROM action_engine_quote_receipts WHERE organization_id=? ORDER BY proposal_id", [ORGANIZATION]).map_err(|_| ())?;
    if receipts.len() != 1 || receipts[0]["source_id"] != source { return Err(()); }
    let row = &receipts[0];
    let receipt: ActionEngineQuoteReceipt = serde_json::from_str(row["receipt_json"].as_str().ok_or(())?).map_err(|_| ())?;
    if receipt.organization_id != ORGANIZATION || receipt.customer_id != customer || receipt.quote_number.is_some()
        || receipt.status != "draft" || !receipt.requires_human_validation { return Err(()); }
    // Check the actual business result of this fixture, independently of the
    // provider's plan: three seeded radiators at CHF 199.00, without tax/discount.
    // Money stays in integer cents; the existing REAL quantity must be exactly 3.
    const EXPECTED_UNIT_PRICE_CENTS: i64 = 19_900;
    const EXPECTED_TOTAL_CENTS: i64 = 59_700;
    let quote = crate::database::query_all(&db, "SELECT id,client_id,number,status,currency,
        subtotal_cents,discount_cents,vat_cents,total_cents FROM quotes ORDER BY id", []).map_err(|_| ())?;
    if quote.len() != 1 || quote[0]["id"] != receipt.quote_id || quote[0]["client_id"] != customer
        || !quote[0]["number"].is_null() || quote[0]["status"] != "brouillon" || quote[0]["currency"] != "CHF"
        || quote[0]["subtotal_cents"].as_i64() != Some(EXPECTED_TOTAL_CENTS)
        || quote[0]["discount_cents"].as_i64() != Some(0) || quote[0]["vat_cents"].as_i64() != Some(0)
        || quote[0]["total_cents"].as_i64() != Some(EXPECTED_TOTAL_CENTS) { return Err(()); }
    let lines = crate::database::query_all(&db, "SELECT id,catalog_item_id,position,quantity,unit,unit_price_cents,
        discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents
        FROM quote_items WHERE quote_id=? ORDER BY position", [&receipt.quote_id]).map_err(|_| ())?;
    if lines.len() != 1 || lines.iter().any(|line| line["catalog_item_id"] != article
        || line["position"].as_i64() != Some(0) || line["quantity"].as_f64() != Some(3.0) || line["unit"] != "pièce"
        || line["unit_price_cents"].as_i64() != Some(EXPECTED_UNIT_PRICE_CENTS)
        || line["discount_bp"].as_i64() != Some(0) || line["vat_bp"].as_i64() != Some(0)
        || line["line_net_cents"].as_i64() != Some(EXPECTED_TOTAL_CENTS) || line["line_vat_cents"].as_i64() != Some(0)
        || line["line_total_cents"].as_i64() != Some(EXPECTED_TOTAL_CENTS)) { return Err(()); }
    let field = |name: &str| row[name].as_str().ok_or(());
    if !crate::action_engine_quote::frozen_quote_publication_matches(&db, ORGANIZATION, field("proposal_id")?, field("reservation_id")?,
        field("fingerprint")?, &receipt.quote_id, field("receipt_sha256")?).map_err(|_| ())?
        || store.verify_audit_log().map_err(|_| ())?["valid"] != true { return Err(()); }
    Ok(json!({"sourceId":source,"proposalId":receipt.proposal_id,"reservationId":field("reservation_id")?,
        "fingerprint":receipt.fingerprint,"quoteId":receipt.quote_id,"customerId":customer,"articleId":article,
        "receiptSha256":field("receipt_sha256")?,"lineIds":lines.iter().map(|line|line["id"].clone()).collect::<Vec<_>>(),
        "quoteCount":1,"receiptCount":1,"quoteNumber":Value::Null,"status":"draft","requiresHumanValidation":true,
        "nativeFrozenCreationVerified":true,"auditChainValid":true}))
}

async fn execute() -> RecipeResult<()> {
    let (mut pipe, input) = admitted_input()?;
    pipe.checkpoint("input_admitted", 0)?;
    pipe.checkpoint("retained_root", 0)?;
    let root = retained_root(&input.root_dir)?;
    pipe.checkpoint("open_store", 0)?;
    let a = open_existing(&root, "device-a")?;
    pipe.checkpoint("open_store", 1)?;
    let b = open_existing(&root, "device-b")?;
    pipe.checkpoint("strict_account", 0)?;
    strict_account(&a, &input.installations[0]).await?;
    pipe.checkpoint("strict_account", 1)?;
    strict_account(&b, &input.installations[1]).await?;
    // Both real paid/activation/seat+AE-consent HTTP checks precede fictitious
    // business writes. Work/A8/A7 recheck all actual progression predicates.
    pipe.checkpoint("paid_consent", 0)?;
    let consent_a = paid_consent(&a).await?;
    pipe.checkpoint("paid_consent", 1)?;
    let consent_b = paid_consent(&b).await?;
    pipe.checkpoint("fresh_remote", 0)?;
    collaboration::require_fresh_remote(&a).await.map_err(|_| ())?;
    pipe.checkpoint("seed", 0)?;
    let (customer, article) = seed(&a)?;
    pipe.checkpoint("publish_initial", 0)?;
    let initial = collaboration::publish_initial(&a).await.map_err(|_| ())?;
    pipe.checkpoint("receive_initial", 1)?;
    collaboration::receive_exact(&b, &initial, true).await.map_err(|_| ())?;
    pipe.write(json!({"event":"initial-publication","publication":initial.public_proof().map_err(|_| ())?,
        "customerId":customer,"articleId":article,"consentRevisions":[consent_a,consent_b]}))?;
    // Coordinator may now provision a REAL delegated fictitious Support source
    // through the existing service. Only its selector crosses this channel;
    // never a plan, proposal, reservation, ID for a quote or provider result.
    let source: SourceReady = pipe.read()?;
    if source.event != "source-ready" || source.source_id.is_empty() || source.source_id.len() > 160
        || !source.source_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'_'|b'-'|b'.'|b':'|b'@')) { return Err(()); }
    pipe.checkpoint("source_ready", 0)?;
    pipe.checkpoint("discovery", 0)?;
    let found = discovery(&a).await?;
    if found.source_ids != vec![source.source_id.clone()] || found.next_cursor.is_some() { return Err(()); }
    pipe.checkpoint("round", 0)?;
    if round(&a, &mut pipe, 0).await? != 1 { return Err(()); }
    pipe.checkpoint("quote_proof", 0)?;
    let proof_a = quote_proof(&a, &source.source_id, &customer, &article)?;
    pipe.checkpoint("local_activity", 0)?;
    let activity = a.read_action_engine_quote_activity(origin(&a)?, None, 50).map_err(|_| ())?;
    if activity.entries.len() != 1 || activity.next_after_proposal_id.is_some()
        || activity.entries[0].quote_id != proof_a["quoteId"].as_str().ok_or(())? { return Err(()); }
    pipe.checkpoint("canonical_publication", 0)?;
    let canonical = collaboration::acknowledged_publication(&a, proof_a["proposalId"].as_str().ok_or(())?).map_err(|_| ())?;
    if canonical.revision <= initial.revision { return Err(()); }
    pipe.checkpoint("corroborate_writer", 0)?;
    collaboration::corroborate_writer(&a, &canonical).await.map_err(|_| ())?;
    pipe.checkpoint("receive_canonical", 1)?;
    collaboration::receive_exact(&b, &canonical, false).await.map_err(|_| ())?;
    pipe.checkpoint("quote_proof", 1)?;
    let proof_b = quote_proof(&b, &source.source_id, &customer, &article)?;
    if proof_a != proof_b { return Err(()); }
    // Confirmed work disappears from discovery. The second real installation
    // still runs the consumer but neither creates a second quote nor forges the
    // writer's private ACK/activity marker while receiving the shared receipt.
    pipe.checkpoint("discovery", 1)?;
    let remaining = discovery(&b).await?;
    if !remaining.source_ids.is_empty() || remaining.next_cursor.is_some() { return Err(()); }
    pipe.checkpoint("round", 1)?;
    if round(&b, &mut pipe, 1).await? != 0 { return Err(()); }
    pipe.checkpoint("quote_proof", 1)?;
    if quote_proof(&b, &source.source_id, &customer, &article)? != proof_a { return Err(()); }
    pipe.checkpoint("local_activity", 1)?;
    let b_activity = b.read_action_engine_quote_activity(origin(&b)?, None, 50).map_err(|_| ())?;
    if !b_activity.entries.is_empty() || b_activity.next_after_proposal_id.is_some() { return Err(()); }
    pipe.checkpoint("corroborate_writer", 0)?;
    collaboration::corroborate_writer(&a, &canonical).await.map_err(|_| ())?;
    pipe.checkpoint("quote_proof", 0)?;
    if quote_proof(&a, &source.source_id, &customer, &article)? != proof_a { return Err(()); }
    pipe.checkpoint("strict_account", 0)?;
    strict_account(&a, &input.installations[0]).await?;
    pipe.checkpoint("strict_account", 1)?;
    strict_account(&b, &input.installations[1]).await?;
    pipe.write(json!({"event":"complete","profileSha256":PROFILE_SHA,"organizationId":ORGANIZATION,
        "initialPublication":initial.public_proof().map_err(|_| ())?,"canonicalPublication":canonical.public_proof().map_err(|_| ())?,
        "quote":proof_a,"secondStoreExactCreation":true,"secondRoundConfirmed":0,"writerActivityCount":1,
        "secondStoreActivityCount":0,"strictMeHttp200Both":true,"automaticCleanup":false}))
}

#[test]
#[ignore = "Future same-job A41 G4: genuine paid Complete + two sessions + consent + delegated Support; never ordinary tests"]
fn canonical_quote_round_across_two_native_stores() {
    if tauri::async_runtime::block_on(execute()).is_err() { panic!("ZENTRA_A41_NATIVE_G4_REFUSED"); }
}
